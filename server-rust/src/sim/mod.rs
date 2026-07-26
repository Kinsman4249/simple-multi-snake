// ============================================================
// Simulation (port of server/sim.js): per-snake movement cadence, drift
// slides, collision resolution (wall/self/snake + wormhole interception),
// food/pickup collection, trails, kill bonuses, expiry, blue shells, and
// the pickup/wall spawners. sim_tick is the body of the JS simLoop; the
// scheduling (absolute next-tick anchoring) lives in main.rs.
//
// Split by responsibility: walls.rs (obstacle spawn/shrink/sweep),
// movement.rs (momentum/drift/turn + the one-step orchestrator),
// evasion.rs (wormhole/scissors death-avoidance + portal fx),
// collisions.rs (wall/self/snake collision resolution + DiedMap),
// effects.rs (powerup spawn/activation/collection, expiry),
// blue_shell.rs (in-flight projectile homing + impact).
// ============================================================
mod blue_shell;
mod collisions;
mod effects;
mod evasion;
mod movement;
mod walls;

pub use effects::fire_powerup;

use crate::config::now_ms;
use crate::net::broadcast_state;
use crate::powerups::{speed_multiplier, POWERUP_TYPES};
use crate::state::Game;

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
    crate::lifecycle::lifecycle_sweep(game);
    game.advance_global_speed(dt);
    game.ensure_foods();
    effects::maybe_spawn_powerup_pickup(game, now);
    let walls_changed = walls::maybe_spawn_wall(game, now)
        | walls::shrink_walls_to_budget(game, now)
        | walls::sweep_walls(game, now)
        | evasion::sweep_portal_fx(game, now);
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
                movement::update_momentum(game, i, now, dt);
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
            movement::movement_step(game, &movers);
            let d = t0.elapsed().as_nanos();
            game.perf.mv_ns += d;
            game.perf.mv_calls += 1;
            if d > game.perf.mv_max_ns {
                game.perf.mv_max_ns = d;
            }
        } else {
            movement::movement_step(game, &movers);
        }
        moved = true;
        guard += 1;
        if guard >= 5 {
            break; // a huge dt (stall) can owe several steps
        }
    }
    if blue_shell::update_blue_shells(game, dt) {
        moved = true;
    }
    if moved {
        broadcast_state(game);
    }
}
