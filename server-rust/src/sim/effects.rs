// Powerup pickup spawning + activation, food/pickup collection during a
// movement step (trails, growth, kill bonuses), and sim-clock expiry.
use super::collisions::DiedMap;
use crate::powerups::{food_growth_multiplier, kill_bonus_growth_bonus, PowerupType, POWERUP_TYPES};
use crate::state::{BlueShell, Cell, Game, Pickup, Trail};
use rand::Rng;
use std::collections::{HashMap, HashSet};

// Powerup pickup spawner: interval-gated, player-scaled cap, weighted type
// roll (blue shell gated + pressure-weighted), rejection-sampled cell.
pub(crate) fn maybe_spawn_powerup_pickup(game: &mut Game, now: i64) {
    if game.last_powerup_spawn_at.is_none() {
        game.last_powerup_spawn_at = Some(now);
    }
    let mut enabled: Vec<PowerupType> = POWERUP_TYPES
        .iter()
        .copied()
        .filter(|t| game.cfg.powerups.enabled(*t))
        .collect();
    // Presence gate: no blue shell with fewer than two people still in the
    // game. Runs BEFORE shell pressure, so pressure can never re-add it.
    if game.player_seat_count() < 2 {
        enabled.retain(|t| *t != PowerupType::BlueShell);
    }
    // Equal-length gate (v3.6.0).
    if game.all_equal_length() {
        enabled.retain(|t| *t != PowerupType::BlueShell);
    }
    // Longest & second-longest living snake -- drives shell pressure and the
    // shell spawn weight.
    let mut best = 0usize;
    let mut second = 0usize;
    for s in game.slots.iter().flatten() {
        if !s.alive {
            continue;
        }
        let len = s.body.len();
        if len > best {
            second = best;
            best = len;
        } else if len > second {
            second = len;
        }
    }
    let sp = &game.cfg.rubberband.shell_pressure;
    let pressure = sp.enabled
        && enabled.contains(&PowerupType::BlueShell)
        && second > 0
        && best as f64 >= sp.lead_ratio * second as f64;
    let effective_interval = game.cfg.powerups.spawn_interval_ms * if pressure { sp.interval_scale } else { 1.0 };
    if ((now - game.last_powerup_spawn_at.unwrap()) as f64) < effective_interval {
        return;
    }
    if game.powerup_pickups.len() >= game.pickup_cap() {
        return;
    }
    if enabled.is_empty() {
        game.last_powerup_spawn_at = Some(now);
        return;
    }
    // Weighted type pick: shell weight is 1, x typeWeight under pressure,
    // x shortLeaderFactor while the leader is short; all others weight 1.
    let bs = &game.cfg.powerups.blue_shell;
    let mut shell_weight = 1.0;
    if pressure {
        shell_weight = sp.type_weight;
    }
    if best < bs.short_leader_length {
        shell_weight *= bs.short_leader_factor;
    }
    let weight = |t: PowerupType| if t == PowerupType::BlueShell { shell_weight } else { 1.0 };
    let total_w: f64 = enabled.iter().map(|t| weight(*t)).sum();
    let mut rng = rand::rng();
    let mut roll = rng.random::<f64>() * total_w;
    let mut ptype = *enabled.last().unwrap();
    for t in &enabled {
        roll -= weight(*t);
        if roll < 0.0 {
            ptype = *t;
            break;
        }
    }
    let mut x;
    let mut y;
    let mut attempts = 0;
    loop {
        x = rng.random_range(0..game.cfg.grid.cols);
        y = rng.random_range(0..game.cfg.grid.rows);
        attempts += 1;
        let occupied = !game.cell_free(x, y, None)
            || game.foods.iter().any(|f| f.x == x && f.y == y)
            || game.powerup_pickups.iter().any(|p| p.x == x && p.y == y);
        if attempts >= 200 || !occupied {
            break;
        }
    }
    if attempts >= 200 {
        game.last_powerup_spawn_at = Some(now);
        return; // board too crowded, try again next interval
    }
    let id = game.next_powerup_id;
    game.next_powerup_id += 1;
    game.powerup_pickups.push(Pickup { id, ptype, x, y });
    game.last_powerup_spawn_at = Some(now);
    game.dlog(&format!("powerup spawned type={} x={} y={}", ptype.as_str(), x, y));
}

// Activation effect: blueShell launches a projectile; everything else is a
// timed self-buff. Shared by the pickup path and the activate message.
pub fn fire_powerup(game: &mut Game, slot_index: usize, ptype: PowerupType) {
    if ptype == PowerupType::BlueShell {
        let head = game.slots[slot_index].as_ref().unwrap().head();
        let id = game.next_powerup_id;
        game.next_powerup_id += 1;
        // step_axis_x=false seeds the staircase alternator ("y" in JS: the
        // first off-axis diagonal step flips to horizontal-first).
        game.blue_shells.push(BlueShell {
            id,
            x: head.x,
            y: head.y,
            owner_slot: slot_index,
            move_accum_ms: 0.0,
            step_axis_x: false,
        });
        game.dlog(&format!("blueShell launched slot={} x={} y={}", slot_index, head.x, head.y));
    } else {
        let duration_ms = game.cfg.powerups.duration_ms(ptype);
        let total = (duration_ms / game.current_move_interval_ms()).ceil() as i64;
        let s = game.slots[slot_index].as_mut().unwrap();
        s.active_powerup = Some(crate::state::ActivePowerup {
            ptype,
            start_tick: game.move_seq,
            expires_at_tick: game.move_seq + total,
        });
        game.dlog(&format!("powerup activated slot={} type={}", slot_index, ptype.as_str()));
    }
    // onActivate hook: only helloWorld implements one (it says hello).
    if ptype == PowerupType::HelloWorld {
        game.dlog(&format!("Hello World! slot={}", slot_index));
    }
    game.slots[slot_index].as_mut().unwrap().activated_fx = Some(ptype);
}

pub(crate) fn apply_movement_and_food(
    game: &mut Game,
    movers: &[usize],
    new_heads: &HashMap<usize, Cell>,
    died: &DiedMap,
    stalled: &HashSet<usize>,
) {
    // Settled-length snapshot BEFORE any head is unshifted (the correct
    // "moment of fire evaluation" for the blue-shell equal-length rule).
    let equal_lengths = game.all_equal_length();
    for &i in movers {
        if died.has(i) || stalled.contains(&i) {
            continue;
        }
        let h = new_heads[&i];
        game.slots[i].as_mut().unwrap().body.insert(0, h);
        let mut grew = false;
        // Multi-food: remove the eaten cell; ensureFoods tops back up.
        if let Some(fi) = game.foods.iter().position(|f| f.x == h.x && f.y == h.y) {
            game.slots[i].as_mut().unwrap().score += 1;
            game.bump_food_rate_points(i, 1);
            let mult = food_growth_multiplier(game.slots[i].as_ref().unwrap(), &game.cfg.powerups);
            for _ in 1..mult {
                grow_segment(game, i);
            }
            game.foods.remove(fi);
            game.ensure_foods();
            grew = true;
        }
        // Powerup pickup collection: wormhole arms the charge, HELD types
        // occupy the held slot, everything else auto-fires; a wasted pickup
        // falls back to the food-like +1 segment.
        if let Some(pi) = game.powerup_pickups.iter().position(|p| p.x == h.x && p.y == h.y) {
            let ptype = game.powerup_pickups[pi].ptype;
            let blocked;
            if ptype == PowerupType::Wormhole {
                let s = game.slots[i].as_mut().unwrap();
                blocked = s.wormhole_charge;
                if !blocked {
                    s.wormhole_charge = true;
                }
            } else if ptype == PowerupType::Scissors {
                let s = game.slots[i].as_mut().unwrap();
                blocked = s.scissors_charge;
                if !blocked {
                    s.scissors_charge = true;
                }
            } else if ptype.requires_activation() {
                let s = game.slots[i].as_mut().unwrap();
                blocked = s.held_powerup.is_some() || s.active_powerup_is(ptype);
                if !blocked {
                    s.held_powerup = Some(ptype);
                }
            } else {
                // Auto-fire; a same-type buff already running is wasted, and
                // a blueShell fizzles with nobody meaningful to aim at
                // (fewer than two people, or all-equal lengths) -- evaluated
                // HERE at fire time.
                let s = game.slots[i].as_ref().unwrap();
                blocked = s.active_powerup_is(ptype)
                    || (ptype == PowerupType::BlueShell
                        && (game.player_seat_count() < 2 || equal_lengths));
                if !blocked {
                    fire_powerup(game, i, ptype);
                }
            }
            // +1 fallback WITHOUT grew=true: the unshifted head still pops
            // below, netting exactly +1 like food.
            if blocked {
                grow_segment(game, i);
            }
            game.powerup_pickups.remove(pi);
            game.dlog(&format!(
                "powerup collected slot={} type={} blocked={} auto={}",
                i,
                ptype.as_str(),
                blocked,
                ptype != PowerupType::Wormhole && !ptype.requires_activation()
            ));
        }
        // Capture the vacated tail cell BEFORE the pop (trails stream out
        // from behind the snake).
        let vacated_tail = *game.slots[i].as_ref().unwrap().body.last().unwrap();
        if !grew {
            game.slots[i].as_mut().unwrap().body.pop();
            // Threading: a real step drained one in-transit tail segment.
            let s = game.slots[i].as_mut().unwrap();
            if s.teleport_drain > 0 {
                s.teleport_drain -= 1;
            }
        }
        // Trail crossing: the layer is NOT immune to its own trail.
        let crossed = game.trails.iter().find(|t| t.x == h.x && t.y == h.y).map(|t| t.ptype);
        if let Some(tt) = crossed {
            match tt {
                PowerupType::IceTrail => {
                    let ticks = (game.cfg.powerups.ice_trail.slow_duration_ms
                        / game.current_move_interval_ms())
                    .ceil() as i64;
                    let move_seq = game.move_seq;
                    let s = game.slots[i].as_mut().unwrap();
                    s.ice_stacks += 1;
                    s.ice_expires_at_tick = move_seq + ticks;
                    let stacks = s.ice_stacks;
                    game.dlog(&format!("ice trail crossed slot={} stacks={}", i, stacks));
                }
                PowerupType::PoisonTrail => {
                    let min_len = game.cfg.min_snake_length;
                    let s = game.slots[i].as_mut().unwrap();
                    if s.body.len() > min_len {
                        s.body.pop();
                        let len = s.body.len();
                        game.dlog(&format!("poison trail crossed slot={} length={}", i, len));
                    }
                }
                PowerupType::BananaTrail => {
                    let ticks = (game.cfg.powerups.banana_trail.invert_duration_ms
                        / game.current_move_interval_ms())
                    .ceil() as i64;
                    let until = game.move_seq + ticks;
                    game.slots[i].as_mut().unwrap().invert_until_tick = until;
                    game.dlog(&format!("banana trail crossed slot={} untilTick={}", i, until));
                }
                _ => {}
            }
        }
        // Trail laying: one tile per movement step while a trail powerup is
        // active, laid at the just-vacated tail cell, with the gap-filling
        // walk (x first, then y) so a fast/drifting tail never leaves a
        // dashed line.
        let laying = game.slots[i].as_ref().unwrap().active_powerup.map(|a| a.ptype).filter(|t| t.is_trail());
        if let Some(tt) = laying {
            let lay_cell = vacated_tail;
            let expires_at_tick = game.move_seq
                + (game.cfg.powerups.tile_duration_ms(tt) / game.current_move_interval_ms()).ceil() as i64;
            let prev = game.slots[i].as_ref().unwrap().last_trail_cell;
            let mut cells: Vec<Cell> = Vec::new();
            match prev {
                Some(p) if p.x != lay_cell.x || p.y != lay_cell.y => {
                    let mut cx = p.x;
                    let mut cy = p.y;
                    let sx = (lay_cell.x - cx).signum();
                    let sy = (lay_cell.y - cy).signum();
                    // Cap the walk so a pathological jump can never paint a
                    // full line across the board.
                    let mut walk_guard = game.cfg.grid.cols + game.cfg.grid.rows;
                    while (cx != lay_cell.x || cy != lay_cell.y) && walk_guard > 0 {
                        walk_guard -= 1;
                        if cx != lay_cell.x {
                            cx += sx;
                        } else {
                            cy += sy;
                        }
                        cells.push(Cell { x: cx, y: cy });
                    }
                }
                _ => cells.push(lay_cell),
            }
            for c in cells {
                game.trails.retain(|t| !(t.x == c.x && t.y == c.y));
                let id = game.next_powerup_id;
                game.next_powerup_id += 1;
                game.trails.push(Trail {
                    id,
                    ptype: tt,
                    x: c.x,
                    y: c.y,
                    owner_slot: i,
                    expires_at_tick,
                });
            }
            game.slots[i].as_mut().unwrap().last_trail_cell = Some(lay_cell);
        } else {
            // Not laying: drop the anchor so the next activation starts
            // fresh.
            game.slots[i].as_mut().unwrap().last_trail_cell = None;
        }
        game.slots[i].as_mut().unwrap().wall_stalls = 0;
        game.slots[i].as_mut().unwrap().self_stalls = 0;
    }
}

fn grow_segment(game: &mut Game, i: usize) {
    let s = game.slots[i].as_mut().unwrap();
    if let Some(tail) = s.body.last().copied() {
        s.body.push(tail);
    }
}

pub(crate) fn apply_kill_bonuses(game: &mut Game, died: &DiedMap) {
    for (_, info) in &died.entries {
        let Some(killer_index) = info.killer else { continue };
        let killer_alive = matches!(&game.slots[killer_index], Some(s) if s.alive);
        if !killer_alive {
            continue;
        }
        game.slots[killer_index].as_mut().unwrap().score += game.cfg.kill_bonus_score;
        game.bump_food_rate_points(killer_index, game.cfg.kill_bonus_score);
        let growth = game.cfg.kill_bonus_growth
            + kill_bonus_growth_bonus(game.slots[killer_index].as_ref().unwrap(), &game.cfg.powerups);
        let s = game.slots[killer_index].as_mut().unwrap();
        if let Some(tail) = s.body.last().copied() {
            for _ in 0..growth {
                s.body.push(tail);
            }
        }
    }
}

// Sim-clock expiry for trails, bounty food, timed powerups, and ice slow.
pub(crate) fn expire_powerups_and_trails(game: &mut Game) {
    let seq = game.move_seq;
    if game.trails.iter().any(|t| seq >= t.expires_at_tick) {
        game.trails.retain(|t| seq < t.expires_at_tick);
    }
    if game.foods.iter().any(|f| f.bounty && seq >= f.expires_at_tick) {
        game.foods.retain(|f| !(f.bounty && seq >= f.expires_at_tick));
    }
    for s in game.slots.iter_mut().flatten() {
        if let Some(a) = s.active_powerup {
            if seq >= a.expires_at_tick {
                if game.cfg.enable_debug {
                    println!("[debug] powerup expired type={}", a.ptype.as_str());
                }
                s.active_powerup = None;
            }
        }
        if s.ice_stacks > 0 && seq >= s.ice_expires_at_tick {
            s.ice_stacks = 0;
        }
    }
}
