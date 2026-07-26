// In-flight blue-shell projectiles: staircase homing toward the current
// leader, detonating (segment loss + splash) on impact.
use crate::powerups::segments_lost;
use crate::state::Game;

// Advance every in-flight blue shell one cell toward the CURRENT leader's
// head (staircase when off-axis on both), detonating only on the head cell.
pub(crate) fn update_blue_shells(game: &mut Game, dt: f64) -> bool {
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
