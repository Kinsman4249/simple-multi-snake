// In-flight blue-shell projectiles: staircase homing toward the current
// leader, detonating (segment loss + splash) on impact.
use crate::powerups::segments_lost;
use crate::state::Game;
// `crate::` starts from the project root -- see RUST-CHEATSHEET.md
// "Modules".

// Advance every in-flight blue shell one cell toward the CURRENT leader's
// head (staircase when off-axis on both), detonating only on the head cell.
pub(crate) fn update_blue_shells(game: &mut Game, dt: f64) -> bool {
    let mut moved = false;
    // Shells move on their own clock (`shell_interval`), independent of the
    // snakes' movement speed -- see RUST-CHEATSHEET.md-style accumulator
    // pattern in mod.rs: bank up `dt` in move_accum_ms and only step once
    // enough has built up.
    let shell_interval = game.current_move_interval_ms() * game.cfg.powerups.blue_shell.speed_ratio;
    // Manual index loop (not a `for`) because we sometimes remove the
    // current element (`.remove(k)`) mid-iteration -- a `for` iterator
    // would get confused if the Vec shrinks under it, so `k` is only
    // advanced in the branches that don't remove anything.
    let mut k = 0;
    while k < game.blue_shells.len() {
        game.blue_shells[k].move_accum_ms += dt;
        if game.blue_shells[k].move_accum_ms < shell_interval {
            k += 1;
            continue;
        }
        game.blue_shells[k].move_accum_ms -= shell_interval;
        // The leader can change (or disappear) while a shell is in flight;
        // if there's no leader left to home in on, the shell just despawns
        // rather than picking a new target mid-flight.
        let Some(target_idx) = game.current_leader_index() else {
            game.blue_shells.remove(k);
            continue;
        };
        let target_head = game.slots[target_idx].as_ref().unwrap().head();
        let shell = &mut game.blue_shells[k];
        let dx = target_head.x - shell.x;
        let dy = target_head.y - shell.y;
        // Staircase homing: when the shell is off-axis on both x and y, it
        // can't move diagonally (grid movement is one cell, one axis, per
        // step), so it alternates which axis it steps on each tick --
        // producing a stair-step path instead of an L-shaped one.
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

// Direct hit on the leader loses seg_pct of their length; anyone else
// caught within the blast radius (Chebyshev/"square" distance, matching
// how the client draws the explosion) loses the smaller splash_pct
// instead -- direct hits should sting much more than being nearby.
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
