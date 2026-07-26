// Per-step movement: momentum/ramp advance, boost drift, turn consumption,
// new-head projection, and the one-step orchestrator (movement_step) that
// wires collision resolution + food/effects + death handling together.
use super::collisions::{clear_mutual_kills, resolve_self_collisions, resolve_snake_collisions, resolve_wall_collisions, DiedMap};
use super::effects::{apply_kill_bonuses, apply_movement_and_food};
use crate::config::now_ms;
use crate::lifecycle::handle_death;
use crate::state::{hits_body, Cell, Game};
use std::collections::{HashMap, HashSet};

// Advance one snake's momentum by dt ms (JS updateMomentum): climbs over
// rampMs while the hold is engaged (past holdGraceMs), decays over decelMs
// otherwise.
pub(crate) fn update_momentum(game: &mut Game, i: usize, now: i64, dt: f64) {
    let boost_cfg = &game.cfg.boost;
    // `game.slots[i]` is `Option<Snake>`; `.as_mut().unwrap()` borrows the
    // snake mutably, assuming this slot is occupied (checked by the
    // caller) -- see RUST-CHEATSHEET.md "Vec<Option<T>>".
    let s = game.slots[i].as_mut().unwrap();
    // Boost only "engages" (starts ramping speed up) after the player has
    // held it past hold_grace_ms -- a short tap doesn't commit to a full
    // speed ramp, avoiding accidental boosts from a twitchy key press.
    // `.map_or(false, ...)` -- see RUST-CHEATSHEET.md "Option<T>": if
    // boost_since is None (never started boosting) the whole thing is
    // false; otherwise run the closure on the held value.
    let engaged = boost_cfg.enabled
        && s.boost
        && s.boost_since.map_or(false, |b| (now - b) as f64 > boost_cfg.hold_grace_ms);
    let mut p = s.ramp_progress;
    if engaged {
        // Ramp speed up linearly over ramp_ms, capped at fully ramped (1.0).
        p = if boost_cfg.ramp_ms > 0.0 { (p + dt / boost_cfg.ramp_ms).min(1.0) } else { 1.0 };
    } else {
        // Not engaged: decay back down over decel_ms instead of snapping
        // to normal speed, so releasing boost feels smooth.
        p = if boost_cfg.decel_ms > 0.0 { (p - dt / boost_cfg.decel_ms).max(0.0) } else { 0.0 };
    }
    s.ramp_progress = p;
}

// The orchestrator for one movement step: figures out where every mover's
// new head would land, resolves all three collision types in a fixed
// order (wall/obstacle first, then self, then other snakes), then applies
// food/effects and finally kills off anyone who didn't survive. Order
// matters here -- e.g. a snake already flagged as stalled by the wall
// check is skipped by the later checks.
pub(crate) fn movement_step(game: &mut Game, movers: &[usize]) {
    let all_alive: Vec<usize> = (0..game.slots.len())
        .filter(|&i| matches!(&game.slots[i], Some(s) if s.alive))
        .collect();
    apply_drift_slides(game, movers);
    let mut new_heads = compute_new_heads(game, movers);
    let mut died = DiedMap::new();
    let mut stalled: HashSet<usize> = HashSet::new();
    resolve_wall_collisions(game, movers, &mut new_heads, &mut died, &mut stalled);
    resolve_self_collisions(game, movers, &mut new_heads, &mut died, &mut stalled);
    resolve_snake_collisions(game, movers, &new_heads, &mut died, &mut stalled, &all_alive);
    clear_mutual_kills(&mut died);
    apply_movement_and_food(game, movers, &new_heads, &died, &stalled);
    apply_kill_bonuses(game, &died);
    // `std::mem::take` swaps `died.entries` out for an empty Vec and hands
    // back the original contents -- lets us consume/loop over the deaths
    // while still being able to pass `game` (which no longer conflicts
    // with a borrow of `died`) into handle_death below.
    for (victim, info) in std::mem::take(&mut died.entries) {
        handle_death(game, victim, &info);
    }
    super::effects::expire_powerups_and_trails(game);
    game.move_seq += 1;
}

// Consume the earliest queued turn whose next cell is in bounds and not a
// solid wall (skipping reversals); acks everything up to it. NOTE: a turn
// consumed here starts no drift (head jammed against a wall).
pub(crate) fn consume_inbounds_turn(game: &mut Game, i: usize, now: i64) -> Option<Cell> {
    let pick = {
        let s = game.slots[i].as_ref().unwrap();
        let head = s.head();
        let mut found: Option<(usize, Cell)> = None;
        for (k, d) in s.input_queue.iter().enumerate() {
            if d.x == -s.dir.x && d.y == -s.dir.y {
                continue;
            }
            let c = Cell { x: head.x + d.x, y: head.y + d.y };
            if game.in_bounds(c) && !game.is_solid_wall_cell(c.x, c.y, now) {
                found = Some((k, Cell { x: d.x, y: d.y }));
                break;
            }
        }
        found
    };
    // `?` also works on `Option`, not just `Result` (see RUST-CHEATSHEET.md
    // "Result<T, E>"): if `pick` is None, return None from this function
    // right here; otherwise unwrap it into `(k, dir)`.
    let (k, dir) = pick?;
    let s = game.slots[i].as_mut().unwrap();
    for j in 0..=k {
        if let Some(seq) = s.input_queue[j].seq {
            s.last_ack = seq;
        }
    }
    s.input_queue.drain(0..=k);
    Some(dir)
}

// Boost drift: rigid whole-body translation in the previous travel
// direction, clamping at obstacles (board edge, solid walls, other
// snakes). Never kills the drifting snake by itself.
fn apply_drift_slides(game: &mut Game, movers: &[usize]) {
    let now = now_ms();
    for &i in movers {
        // `continue` in the None arm is valid here even though the other
        // arm produces a tuple: `continue` never "returns" a value (it
        // jumps straight to the next loop iteration), so the compiler
        // doesn't need it to match the tuple's type.
        let (d, expired) = {
            let s = game.slots[i].as_ref().unwrap();
            match s.drift_dir {
                None => continue,
                Some(d) => (d, now >= s.drift_until_ms),
            }
        };
        if expired {
            game.slots[i].as_mut().unwrap().drift_dir = None;
            continue;
        }
        let blocked = {
            let s = game.slots[i].as_ref().unwrap();
            let mut blocked = false;
            // `'outer:` labels this loop so the inner loop's `break 'outer`
            // below can exit both loops at once, not just the inner one.
            'outer: for seg in &s.body {
                let c = Cell { x: seg.x + d.x, y: seg.y + d.y };
                if !game.in_bounds(c) || game.is_solid_wall_cell(c.x, c.y, now) {
                    blocked = true;
                    break;
                }
                for (j, other) in game.slots.iter().enumerate() {
                    let Some(other) = other else { continue };
                    if j == i || !other.alive {
                        continue;
                    }
                    if hits_body(&other.body, c, false) {
                        blocked = true;
                        break 'outer;
                    }
                }
            }
            blocked
        };
        if blocked {
            continue;
        }
        let s = game.slots[i].as_mut().unwrap();
        for seg in &mut s.body {
            seg.x += d.x;
            seg.y += d.y;
        }
    }
}

fn compute_new_heads(game: &mut Game, movers: &[usize]) -> HashMap<usize, Cell> {
    let mut new_heads = HashMap::new();
    let drift_ms = game.cfg.boost.drift_ms;
    for &i in movers {
        let s = game.slots[i].as_mut().unwrap();
        if !s.input_queue.is_empty() {
            let inp = s.input_queue.remove(0);
            let prev_dir = s.dir;
            s.dir = Cell { x: inp.x, y: inp.y };
            if let Some(seq) = inp.seq {
                s.last_ack = seq;
            }
            // A boosted turn starts the body drift in the direction the
            // snake WAS traveling, scaled by ramp progress at keypress.
            if inp.drift > 0.0 {
                s.drift_dir = Some(prev_dir);
                s.drift_until_ms = now_ms() + (drift_ms * inp.drift) as i64;
            }
        }
        let head = s.head();
        new_heads.insert(i, Cell { x: head.x + s.dir.x, y: head.y + s.dir.y });
    }
    new_heads
}
