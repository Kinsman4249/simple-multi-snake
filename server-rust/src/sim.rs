// ============================================================
// Simulation (port of server/sim.js): per-snake movement cadence, drift
// slides, collision resolution (wall/self/snake + wormhole interception),
// food/pickup collection, trails, kill bonuses, expiry, blue shells, and
// the pickup/wall spawners. sim_tick is the body of the JS simLoop; the
// scheduling (absolute next-tick anchoring) lives in main.rs.
// ============================================================
use crate::config::now_ms;
use crate::lifecycle::{handle_death, lifecycle_sweep, KillInfo};
use crate::net::broadcast_state;
use crate::powerups::{
    attempt_wormhole, food_growth_multiplier, kill_bonus_growth_bonus, segments_lost,
    speed_multiplier, PowerupType, POWERUP_TYPES,
};
use crate::state::{hits_body, BlueShell, Cell, Game, Pickup, PortalFx, Trail, Wall};
use rand::Rng;
use std::collections::{HashMap, HashSet};

// The JS `died` Map: insertion-ordered victim -> {killer, cause}.
pub struct DiedMap {
    entries: Vec<(usize, KillInfo)>,
}
impl DiedMap {
    fn new() -> DiedMap {
        DiedMap { entries: Vec::new() }
    }
    fn has(&self, i: usize) -> bool {
        self.entries.iter().any(|(v, _)| *v == i)
    }
    fn get_killer(&self, i: usize) -> Option<Option<usize>> {
        self.entries.iter().find(|(v, _)| *v == i).map(|(_, k)| k.killer)
    }
    fn set(&mut self, i: usize, info: KillInfo) {
        if let Some(e) = self.entries.iter_mut().find(|(v, _)| *v == i) {
            e.1 = info;
        } else {
            self.entries.push((i, info));
        }
    }
}

// Powerup pickup spawner: interval-gated, player-scaled cap, weighted type
// roll (blue shell gated + pressure-weighted), rejection-sampled cell.
fn maybe_spawn_powerup_pickup(game: &mut Game, now: i64) {
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

// Grid decay / anti-turtling obstacle spawner (v3.8.0). Returns true when a
// wall was telegraphed this call.
fn maybe_spawn_wall(game: &mut Game, now: i64) -> bool {
    let w = &game.cfg.walls;
    if !w.enabled {
        return false;
    }
    if game.last_wall_spawn_at.is_none() {
        game.last_wall_spawn_at = Some(now);
    }
    if game.player_seat_count() < w.min_players {
        game.last_wall_spawn_at = Some(now);
        return false;
    }
    if now - game.last_wall_spawn_at.unwrap() < w.spawn_interval_ms {
        return false;
    }
    if game.walls.len() >= w.max_concurrent {
        return false;
    }
    let target = game
        .current_leader_index()
        .map(|li| game.slots[li].as_ref().unwrap().head());
    let lb = &game.cfg.walls.leader_bias;
    let mut chosen: Option<Cell> = None;
    let mut rng = rand::rng();
    for _ in 0..200 {
        if chosen.is_some() {
            break;
        }
        let x = rng.random_range(0..game.cfg.grid.cols);
        let y = rng.random_range(0..game.cfg.grid.rows);
        if !game.cell_free(x, y, None) || game.cell_has_entity(x, y) {
            continue;
        }
        // Anti-sealing guard: never orthogonally touching another wall.
        if game.walls.iter().any(|ow| (ow.x - x).abs() + (ow.y - y).abs() <= 1) {
            continue;
        }
        // Never within minHeadDistance of a living head.
        let too_close = game.slots.iter().flatten().any(|s| {
            s.alive && {
                let h = s.head();
                (h.x - x).abs().max((h.y - y).abs()) < w.min_head_distance
            }
        });
        if too_close {
            continue;
        }
        if let Some(t) = target {
            if lb.enabled {
                let d = (x - t.x).abs().max((y - t.y).abs());
                if d > lb.radius && rng.random::<f64>() >= 1.0 / lb.strength {
                    continue;
                }
            }
        }
        chosen = Some(Cell { x, y });
    }
    game.last_wall_spawn_at = Some(now);
    let Some(c) = chosen else { return false };
    let id = game.next_powerup_id;
    game.next_powerup_id += 1;
    game.walls.push(Wall {
        id,
        x: c.x,
        y: c.y,
        telegraph_until: now + w.telegraph_ms,
        solid_until: now + w.telegraph_ms + w.lifetime_ms,
    });
    game.dlog(&format!("wall telegraphed x={} y={}", c.x, c.y));
    true
}

// Wormhole portal lifecycle: a portal pair stays open while its owner's
// tail is still threading through (teleport_drain > 0). The moment the
// drain finishes -- or the owner died / left the slot -- a short linger
// window is stamped so the closing is visible, then the portal is
// dropped. Returns true if any portal was removed (forces a broadcast so
// clients see them disappear even on an otherwise quiet tick).
const PORTAL_LINGER_MS: i64 = 600;
fn sweep_portal_fx(game: &mut Game, now: i64) -> bool {
    if game.portal_fx.is_empty() {
        return false;
    }
    // Stamp expiry on portals whose owner is done draining (immutable
    // peek at the slot per portal, then mutate the portal).
    for k in 0..game.portal_fx.len() {
        if game.portal_fx[k].expires_ms.is_some() {
            continue;
        }
        let owner = game.portal_fx[k].owner_slot;
        let draining = matches!(
            game.slots.get(owner).and_then(|s| s.as_ref()),
            Some(s) if s.alive && s.teleport_drain > 0
        );
        if !draining {
            game.portal_fx[k].expires_ms = Some(now + PORTAL_LINGER_MS);
        }
    }
    let before = game.portal_fx.len();
    game.portal_fx.retain(|p| p.expires_ms.map_or(true, |e| now < e));
    game.portal_fx.len() != before
}

// Drops walls past their despawn time; true if any were removed.
fn sweep_walls(game: &mut Game, now: i64) -> bool {
    if game.walls.is_empty() {
        return false;
    }
    let before = game.walls.len();
    game.walls.retain(|w| now < w.solid_until);
    game.walls.len() != before
}

// Advance one snake's momentum by dt ms (JS updateMomentum): climbs over
// rampMs while the hold is engaged (past holdGraceMs), decays over decelMs
// otherwise.
fn update_momentum(game: &mut Game, i: usize, now: i64, dt: f64) {
    let boost_cfg = &game.cfg.boost;
    let s = game.slots[i].as_mut().unwrap();
    let engaged = boost_cfg.enabled
        && s.boost
        && s.boost_since.map_or(false, |b| (now - b) as f64 > boost_cfg.hold_grace_ms);
    let mut p = s.ramp_progress;
    if engaged {
        p = if boost_cfg.ramp_ms > 0.0 { (p + dt / boost_cfg.ramp_ms).min(1.0) } else { 1.0 };
    } else {
        p = if boost_cfg.decel_ms > 0.0 { (p - dt / boost_cfg.decel_ms).max(0.0) } else { 0.0 };
    }
    s.ramp_progress = p;
}

// One fixed-rate sim tick: lifecycle sweeps, speed easing, food top-up,
// spawners, food-rate timers, the per-snake movement accumulator loop, blue
// shells, and the broadcast when anything moved.
pub fn sim_tick(game: &mut Game) {
    let now = now_ms();
    let dt = match game.last_sim_at {
        None => game.cfg.sim_ms,
        Some(last) => ((now - last) as f64).min(250.0),
    };
    game.last_sim_at = Some(now);
    lifecycle_sweep(game);
    game.advance_global_speed(dt);
    game.ensure_foods();
    maybe_spawn_powerup_pickup(game, now);
    let walls_changed =
        maybe_spawn_wall(game, now) | sweep_walls(game, now) | sweep_portal_fx(game, now);
    game.advance_food_rate_timers(dt);
    let interval = game.current_move_interval_ms();

    let mut moved = walls_changed;
    let mut guard = 0;
    loop {
        let mut movers: Vec<usize> = Vec::new();
        for i in 0..game.slots.len() {
            let alive = matches!(&game.slots[i], Some(s) if s.alive);
            if !alive {
                continue;
            }
            if guard == 0 {
                update_momentum(game, i, now, dt);
                let mut mult = {
                    let s = game.slots[i].as_ref().unwrap();
                    1.0 + (game.cfg.boost.boost_speed - 1.0) * s.ramp_progress
                };
                for t in POWERUP_TYPES {
                    if t.has_speed_multiplier() {
                        let s = game.slots[i].as_ref().unwrap();
                        mult *= speed_multiplier(t, s, &game.cfg.powerups);
                    }
                }
                game.slots[i].as_mut().unwrap().move_accum_ms += dt * mult;
            }
            let s = game.slots[i].as_mut().unwrap();
            if s.move_accum_ms >= interval {
                s.move_accum_ms -= interval;
                movers.push(i);
            }
        }
        if movers.is_empty() {
            break;
        }
        if game.cfg.perf {
            let t0 = std::time::Instant::now();
            movement_step(game, &movers);
            let d = t0.elapsed().as_nanos();
            game.perf.mv_ns += d;
            game.perf.mv_calls += 1;
            if d > game.perf.mv_max_ns {
                game.perf.mv_max_ns = d;
            }
        } else {
            movement_step(game, &movers);
        }
        moved = true;
        guard += 1;
        if guard >= 5 {
            break; // a huge dt (stall) can owe several steps
        }
    }
    if update_blue_shells(game, dt) {
        moved = true;
    }
    if moved {
        broadcast_state(game);
    }
}

fn movement_step(game: &mut Game, movers: &[usize]) {
    let all_alive: Vec<usize> = (0..game.slots.len())
        .filter(|&i| matches!(&game.slots[i], Some(s) if s.alive))
        .collect();
    apply_drift_slides(game, movers);
    let mut new_heads = compute_new_heads(game, movers);
    let mut died = DiedMap::new();
    let mut stalled: HashSet<usize> = HashSet::new();
    resolve_wall_collisions(game, movers, &mut new_heads, &mut died, &mut stalled);
    resolve_self_collisions(game, movers, &new_heads, &mut died, &mut stalled);
    resolve_snake_collisions(game, movers, &new_heads, &mut died, &mut stalled, &all_alive);
    clear_mutual_kills(&mut died);
    apply_movement_and_food(game, movers, &new_heads, &died, &stalled);
    apply_kill_bonuses(game, &died);
    for (victim, info) in std::mem::take(&mut died.entries) {
        handle_death(game, victim, &info);
    }
    expire_powerups_and_trails(game);
    game.move_seq += 1;
}

// Consume the earliest queued turn whose next cell is in bounds and not a
// solid wall (skipping reversals); acks everything up to it. NOTE: a turn
// consumed here starts no drift (head jammed against a wall).
fn consume_inbounds_turn(game: &mut Game, i: usize, now: i64) -> Option<Cell> {
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

// Wormhole interception (see the JS state-machine comment): the ONLY
// transition out of ARMED is a fatal collision this step; firing always
// consumes the charge, and a failed landing dies normally.
fn try_wormhole_or_die(
    game: &mut Game,
    idx: usize,
    killer: Option<usize>,
    cause: &'static str,
    died: &mut DiedMap,
    stalled: &mut HashSet<usize>,
    new_heads: &HashMap<usize, Cell>,
) {
    let armed = matches!(&game.slots[idx], Some(s) if s.wormhole_charge);
    if armed {
        let (own_dir, own_head) = {
            let s = game.slots[idx].as_ref().unwrap();
            (s.dir, s.head())
        };
        // A split-step head-on can kill a snake not moving this step: its
        // fatal contact point is its own stationary head cell.
        let fatal_head = new_heads.get(&idx).copied().unwrap_or(own_head);
        // Directional phasing (2026-07-20 rework): one spatial lookahead
        // walks the movement vector through board edges (wrap), dynamic
        // walls, own body, and other snakes alike -- see powerups.rs.
        let result = attempt_wormhole(
            game,
            own_dir,
            own_head,
            fatal_head,
            game.cfg.powerups.wormhole.lookahead_depth,
        );
        game.slots[idx].as_mut().unwrap().wormhole_charge = false;
        if let Some(r) = result {
            // Per-segment threading: only the head exits at the landing;
            // the tail drains through the entry over the next
            // (body.len - 1) steps, with wall/self collision exempt until
            // the drain completes.
            let s = game.slots[idx].as_mut().unwrap();
            s.body.insert(0, r.landing);
            s.body.pop();
            s.dir = r.dir;
            s.teleported_this_tick = true;
            s.teleport_drain = s.body.len().saturating_sub(1);
            stalled.insert(idx); // normal movement/food skipped this step
            // Purple portal markers at both ends of the phase. They stay
            // up until this snake's tail finishes threading through
            // (sweep_portal_fx watches teleport_drain), so the entry
            // visibly "swallows" the whole body before closing.
            for c in [r.entry_portal, r.exit_portal] {
                let id = game.next_powerup_id;
                game.next_powerup_id += 1;
                game.portal_fx.push(PortalFx {
                    id,
                    x: c.x,
                    y: c.y,
                    owner_slot: idx,
                    expires_ms: None,
                });
            }
            let landing = r.landing;
            game.dlog(&format!(
                "wormhole fired slot={} entry=({},{}) landing=({},{})",
                idx, r.entry_portal.x, r.entry_portal.y, landing.x, landing.y
            ));
            return;
        }
        game.dlog(&format!("wormhole fizzled, no landing slot={}", idx));
    }
    died.set(idx, KillInfo { killer, cause });
}

fn resolve_wall_collisions(
    game: &mut Game,
    movers: &[usize],
    new_heads: &mut HashMap<usize, Cell>,
    died: &mut DiedMap,
    stalled: &mut HashSet<usize>,
) {
    let now = now_ms();
    for &i in movers {
        if died.has(i) {
            continue;
        }
        let h = new_heads[&i];
        let obstacle = game.in_bounds(h) && game.is_solid_wall_cell(h.x, h.y, now);
        if game.in_bounds(h) && !obstacle {
            game.slots[i].as_mut().unwrap().wall_stalls = 0;
            continue;
        }
        // Wormhole threading: never die at a wall mid-drain; hold in place.
        if game.slots[i].as_ref().unwrap().teleport_drain > 0 {
            stalled.insert(i);
            let head = game.slots[i].as_ref().unwrap().head();
            new_heads.insert(i, head);
            continue;
        }
        if let Some(saved) = consume_inbounds_turn(game, i, now) {
            let s = game.slots[i].as_mut().unwrap();
            s.dir = saved;
            let head = s.head();
            new_heads.insert(i, Cell { x: head.x + saved.x, y: head.y + saved.y });
            s.wall_stalls = 0;
            continue;
        }
        // No wall grace while boosting: a boosted head aimed at a wall with
        // no saving turn dies without the stall tick.
        let (wall_stalls, ramp) = {
            let s = game.slots[i].as_ref().unwrap();
            (s.wall_stalls, s.ramp_progress)
        };
        if wall_stalls < game.cfg.wall_grace_ticks && ramp == 0.0 {
            let s = game.slots[i].as_mut().unwrap();
            s.wall_stalls += 1;
            stalled.insert(i);
            let head = s.head();
            new_heads.insert(i, head);
            continue;
        }
        try_wormhole_or_die(game, i, None, if obstacle { "obstacle" } else { "wall" }, died, stalled, new_heads);
        game.slots[i].as_mut().unwrap().wall_stalls = 0;
    }
}

fn resolve_self_collisions(
    game: &mut Game,
    movers: &[usize],
    new_heads: &HashMap<usize, Cell>,
    died: &mut DiedMap,
    stalled: &mut HashSet<usize>,
) {
    for &i in movers {
        if died.has(i) || stalled.contains(&i) {
            continue;
        }
        // Threading: exempt from self-collision until the drain completes.
        if game.slots[i].as_ref().unwrap().teleport_drain > 0 {
            continue;
        }
        let hit = hits_body(&game.slots[i].as_ref().unwrap().body, new_heads[&i], true);
        if hit {
            try_wormhole_or_die(game, i, None, "self", died, stalled, new_heads);
        }
    }
}

// Movers are checked against EVERY living snake; head-ons (same-step and
// split-step) kill both with no credit; a body hit credits the owner. See
// the extensive JS comments for the shapes.
fn resolve_snake_collisions(
    game: &mut Game,
    movers: &[usize],
    new_heads: &HashMap<usize, Cell>,
    died: &mut DiedMap,
    stalled: &mut HashSet<usize>,
    all_alive: &[usize],
) {
    for &i in movers {
        if died.has(i) || stalled.contains(&i) {
            continue;
        }
        let h = new_heads[&i];
        for &j in all_alive {
            if j == i {
                continue;
            }
            enum Action {
                HeadOnBoth,
                BodyHit,
            }
            let action = {
                let me_dir = game.slots[i].as_ref().unwrap().dir;
                let other = game.slots[j].as_ref().unwrap();
                let other_head_new = new_heads.get(&j);
                let j_moves = other_head_new.is_some() && !stalled.contains(&j) && !died.has(j);
                if j_moves {
                    let oh = *other_head_new.unwrap();
                    if h.x == oh.x && h.y == oh.y {
                        Some(Action::HeadOnBoth)
                    } else if hits_body(&other.body, h, true) {
                        Some(Action::BodyHit)
                    } else {
                        None
                    }
                } else {
                    // Split-step head-on: j stationary, mover lands exactly
                    // on j's head while the two face each other.
                    let oh = other.body.first().copied();
                    if !died.has(j)
                        && oh.map_or(false, |oh| h.x == oh.x && h.y == oh.y)
                        && other.dir.x == -me_dir.x
                        && other.dir.y == -me_dir.y
                    {
                        Some(Action::HeadOnBoth)
                    } else if hits_body(&other.body, h, false) {
                        Some(Action::BodyHit)
                    } else {
                        None
                    }
                }
            };
            match action {
                Some(Action::HeadOnBoth) => {
                    // Each side checked independently for a wormhole charge.
                    try_wormhole_or_die(game, i, None, "headon", died, stalled, new_heads);
                    try_wormhole_or_die(game, j, None, "headon", died, stalled, new_heads);
                    if died.has(i) || stalled.contains(&i) {
                        break;
                    }
                    continue;
                }
                Some(Action::BodyHit) => {
                    try_wormhole_or_die(game, i, Some(j), "body", died, stalled, new_heads);
                    break; // i resolved (died or teleported)
                }
                None => {}
            }
        }
    }
}

// A head-on SWAP records each as the other's killer via the body-hit
// branch; nobody survived, so strip the mutual credit.
fn clear_mutual_kills(died: &mut DiedMap) {
    let mutual: Vec<usize> = died
        .entries
        .iter()
        .filter(|(victim, info)| {
            info.killer
                .and_then(|k| died.get_killer(k))
                .map_or(false, |kk| kk == Some(*victim))
        })
        .map(|(v, _)| *v)
        .collect();
    for v in mutual {
        died.set(v, KillInfo { killer: None, cause: "headon" });
    }
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

fn apply_movement_and_food(
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
    }
}

fn grow_segment(game: &mut Game, i: usize) {
    let s = game.slots[i].as_mut().unwrap();
    if let Some(tail) = s.body.last().copied() {
        s.body.push(tail);
    }
}

fn apply_kill_bonuses(game: &mut Game, died: &DiedMap) {
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
fn expire_powerups_and_trails(game: &mut Game) {
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

// Advance every in-flight blue shell one cell toward the CURRENT leader's
// head (staircase when off-axis on both), detonating only on the head cell.
fn update_blue_shells(game: &mut Game, dt: f64) -> bool {
    let mut moved = false;
    let shell_interval = game.current_move_interval_ms() * game.cfg.powerups.blue_shell.speed_ratio;
    let mut k = 0;
    while k < game.blue_shells.len() {
        game.blue_shells[k].move_accum_ms += dt;
        if game.blue_shells[k].move_accum_ms < shell_interval {
            k += 1;
            continue;
        }
        game.blue_shells[k].move_accum_ms -= shell_interval;
        let Some(target_idx) = game.current_leader_index() else {
            game.blue_shells.remove(k);
            continue;
        };
        let target_head = game.slots[target_idx].as_ref().unwrap().head();
        let shell = &mut game.blue_shells[k];
        let dx = target_head.x - shell.x;
        let dy = target_head.y - shell.y;
        let step_x = if dx != 0 && dy != 0 {
            shell.step_axis_x = !shell.step_axis_x; // flip each diagonal step
            shell.step_axis_x
        } else {
            dx != 0
        };
        if step_x {
            shell.x += if dx > 0 { 1 } else { -1 };
        } else {
            shell.y += if dy > 0 { 1 } else { -1 };
        }
        moved = true;
        if shell.x == target_head.x && shell.y == target_head.y {
            let (sx, sy) = (shell.x, shell.y);
            game.blue_shells.remove(k);
            trigger_blue_shell_impact(game, sx, sy, target_idx);
        } else {
            k += 1;
        }
    }
    moved
}

fn trigger_blue_shell_impact(game: &mut Game, cx: i32, cy: i32, target_idx: usize) {
    let bs = &game.cfg.powerups.blue_shell;
    let (seg_pct, splash_pct, r) = (bs.segment_loss_percent, bs.splash_loss_percent, bs.explosion_radius);
    let min_len = game.cfg.min_snake_length;
    let loss = {
        let target = game.slots[target_idx].as_mut().unwrap();
        let loss = segments_lost(target.body.len(), seg_pct, min_len);
        Game::remove_segments(target, loss, min_len);
        loss
    };
    for i in 0..game.slots.len() {
        if i == target_idx {
            continue;
        }
        let in_radius = match &game.slots[i] {
            Some(s) if s.alive => s
                .body
                .iter()
                .any(|seg| (seg.x - cx).abs().max((seg.y - cy).abs()) <= r),
            _ => false,
        };
        if in_radius {
            let s = game.slots[i].as_mut().unwrap();
            let splash = segments_lost(s.body.len(), splash_pct, min_len);
            Game::remove_segments(s, splash, min_len);
        }
    }
    game.explosions.push(crate::state::Explosion { x: cx, y: cy, radius: r });
    game.dlog(&format!("blueShell impact targetIdx={} loss={} x={} y={}", target_idx, loss, cx, cy));
}
