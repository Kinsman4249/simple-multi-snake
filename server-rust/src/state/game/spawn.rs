// Snake spawn placement: safe random spawn (clearance halo + wall margin)
// with a bounded-attempts search, plus the config.test_spawns override used
// by e2e tests (SNAKE_TEST_SPAWNS) for deterministic geometry.
use super::Game;
use crate::config::ForcedSpawn;
use crate::state::rand_below;
use crate::state::types::{dir_vector, Cell};

// Safe-spawn tuning (v3.6.2), same constants as state.js.
const SPAWN_WALL_MARGIN: i32 = 4;
const SPAWN_CLEARANCE: i32 = 2;

impl Game {
    // True when a snake of `len` at (hx,hy) heading `dir` fits with
    // `wall_margin` from every edge and a `clearance` halo free of other
    // snakes (and never on/under an obstacle wall).
    fn spawn_area_clear(
        &self,
        hx: i32,
        hy: i32,
        dir: Cell,
        len: usize,
        slot_index: usize,
        clearance: i32,
        wall_margin: i32,
    ) -> bool {
        for n in 0..len as i32 {
            let bx = hx - dir.x * n;
            let by = hy - dir.y * n;
            if bx < wall_margin
                || bx >= self.cfg.grid.cols - wall_margin
                || by < wall_margin
                || by >= self.cfg.grid.rows - wall_margin
            {
                return false;
            }
            if self.walls.iter().any(|w| w.x == bx && w.y == by) {
                return false;
            }
            for ox in -clearance..=clearance {
                for oy in -clearance..=clearance {
                    if !self.cell_free(bx + ox, by + oy, Some(slot_index)) {
                        return false;
                    }
                }
            }
        }
        true
    }

    pub fn spawn_snake(&mut self, slot_index: usize) {
        let mut len = self.cfg.min_snake_length;
        let x;
        let y;
        let mut dir = Cell { x: 1, y: 0 };
        let forced: Option<ForcedSpawn> = self
            .cfg
            .test_spawns
            .as_ref()
            .and_then(|v| v.get(slot_index).cloned().flatten());
        if let Some(f) = forced {
            x = f.x;
            y = f.y;
            if let Some(d) = f.dir.as_deref().and_then(dir_vector) {
                dir = d;
            }
            if let Some(l) = f.len {
                if l >= self.cfg.min_snake_length {
                    len = l;
                }
            }
        } else {
            // Safe random spawn (v3.6.2): clearance halo + wall margin +
            // center-ward heading; margins shrink on tiny boards; bounded
            // attempts with graceful fallback.
            let cols = self.cfg.grid.cols;
            let rows = self.cfg.grid.rows;
            let wall_margin = SPAWN_WALL_MARGIN.min(cols.min(rows) / 4).max(1);
            let mut chosen: Option<(i32, i32, Cell)> = None;
            let mut body_free: Option<(i32, i32, Cell)> = None;
            let mut any_candidate: Option<(i32, i32, Cell)> = None;
            for _ in 0..200 {
                if chosen.is_some() {
                    break;
                }
                let hx = wall_margin + len as i32 + rand_below((cols - 2 * (wall_margin + len as i32)).max(1));
                let hy = wall_margin + rand_below((rows - 2 * wall_margin).max(1));
                let d = if hx < cols / 2 { Cell { x: 1, y: 0 } } else { Cell { x: -1, y: 0 } };
                any_candidate = Some((hx, hy, d));
                if self.spawn_area_clear(hx, hy, d, len, slot_index, SPAWN_CLEARANCE, wall_margin) {
                    chosen = Some((hx, hy, d));
                } else if body_free.is_none()
                    && self.spawn_area_clear(hx, hy, d, len, slot_index, 0, wall_margin)
                {
                    body_free = Some((hx, hy, d));
                }
            }
            let pick = chosen
                .or(body_free)
                .or(any_candidate)
                .unwrap_or((cols / 2, rows / 2, Cell { x: 1, y: 0 }));
            x = pick.0;
            y = pick.1;
            dir = pick.2;
        }
        let s = self.slots[slot_index].as_mut().expect("spawn into empty slot");
        s.body.clear();
        for n in 0..len as i32 {
            s.body.push(Cell { x: x - dir.x * n, y: y - dir.y * n });
        }
        s.dir = dir;
        s.input_queue.clear();
        s.alive = true;
        s.wall_stalls = 0;
        s.self_stalls = 0;
        s.score = 0;
        s.last_ack = 0;
        s.boost = false;
        s.boost_since = None;
        s.ramp_progress = 0.0;
        s.move_accum_ms = 0.0;
        // NOTE: last_input_at deliberately NOT reset (respawns must not feed
        // the idle clock; see the JS comment). Powerup state DOES reset every
        // (re)spawn -- a run is a clean slate.
        s.held_powerup = None;
        s.wormhole_charge = false;
        s.scissors_charge = false;
        s.active_powerup = None;
        s.activated_fx = None;
        s.ice_stacks = 0;
        s.ice_expires_at_tick = 0;
        s.teleported_this_tick = false;
        s.teleport_drain = 0;
        s.drift_dir = None;
        s.drift_until_ms = 0;
        s.invert_until_tick = 0;
        s.last_trail_cell = None;
        s.respawn_at = None;
    }
}
