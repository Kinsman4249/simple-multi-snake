// Food/pickup placement: uniform-with-bias food spawning, and the shared
// "pinata" bounty-scatter math used by both a snake death and a scissors
// tail-cut.
use super::Game;
use crate::state::rand_below;
use crate::state::types::{Cell, Food};
use rand::Rng;

impl Game {
    // ignore_slot: Option<usize> -- see "Option<T>" in RUST-CHEATSHEET.md.
    pub fn cell_free(&self, x: i32, y: i32, ignore_slot: Option<usize>) -> bool {
        for (i, s) in self.slots.iter().enumerate() {
            // `let ... else { ... }`: unwrap Some(s), or run the else block
            // (which must diverge, e.g. continue/return) if it was None
            // instead -- a shorthand for a two-armed match on Option.
            let Some(s) = s else { continue };
            if Some(i) == ignore_slot {
                continue;
            }
            // .any(|seg| ...): closure passed to an iterator method -- see
            // "Closures" in RUST-CHEATSHEET.md.
            if s.body.iter().any(|seg| seg.x == x && seg.y == y) {
                return false;
            }
        }
        true
    }

    // Cell already taken by food, a pickup, or an obstacle wall (any display
    // state)?
    pub fn cell_has_entity(&self, x: i32, y: i32) -> bool {
        self.foods.iter().any(|f| f.x == x && f.y == y)
            || self.powerup_pickups.iter().any(|p| p.x == x && p.y == y)
            || self.walls.iter().any(|w| w.x == x && w.y == y)
    }

    // True while (x,y) is an ACTIVE (past telegraph, not yet despawned) wall.
    pub fn is_solid_wall_cell(&self, x: i32, y: i32, now: i64) -> bool {
        self.walls
            .iter()
            .any(|w| w.x == x && w.y == y && now >= w.telegraph_until && now < w.solid_until)
    }

    // Place ONE food (uniform rejection sampling, rubberband bias toward the
    // trailing snake). Returns false if the board is full.
    pub fn place_one_food(&mut self) -> bool {
        let fb = &self.cfg.rubberband.food_bias;
        let mut target: Option<Cell> = None;
        if fb.enabled {
            if let (Some(ti), Some(li)) = (self.current_trailing_index(), self.current_leader_index()) {
                if ti != li {
                    let (tl, ll) = (
                        self.slots[ti].as_ref().unwrap().body.len(),
                        self.slots[li].as_ref().unwrap().body.len(),
                    );
                    if ll > tl {
                        target = Some(self.slots[ti].as_ref().unwrap().head());
                    }
                }
            }
        }
        let mut chosen: Option<Cell> = None;
        let mut fallback: Option<Cell> = None;
        let mut rng = rand::rng();
        for attempts in 0..500 {
            let x = rng.random_range(0..self.cfg.grid.cols);
            let y = rng.random_range(0..self.cfg.grid.rows);
            if !self.cell_free(x, y, None) || self.cell_has_entity(x, y) {
                continue;
            }
            if fallback.is_none() {
                fallback = Some(Cell { x, y });
            }
            // match with a guard (`if attempts < 300`): only takes this arm
            // when both the pattern matches AND the condition holds -- see
            // "match" in RUST-CHEATSHEET.md.
            match target {
                Some(t) if attempts < 300 => {
                    let d = (x - t.x).abs().max((y - t.y).abs());
                    if d <= fb.radius || rng.random::<f64>() < 1.0 / fb.strength {
                        chosen = Some(Cell { x, y });
                        break;
                    }
                }
                _ => {
                    chosen = Some(Cell { x, y });
                    break;
                }
            }
        }
        let mut chosen = chosen.or(fallback);
        if chosen.is_none() {
            // Sampling never found a free cell: linear scan (near-full board).
            'outer: for y in 0..self.cfg.grid.rows {
                for x in 0..self.cfg.grid.cols {
                    if self.cell_free(x, y, None) && !self.cell_has_entity(x, y) {
                        chosen = Some(Cell { x, y });
                        break 'outer;
                    }
                }
            }
        }
        if let Some(c) = chosen {
            self.foods.push(Food { x: c.x, y: c.y, bounty: false, expires_at_tick: 0 });
            true
        } else {
            false
        }
    }

    // Players currently ON THE BOARD (occupied slots, alive or respawning).
    pub fn board_player_count(&self) -> usize {
        self.slots.iter().filter(|s| s.is_some()).count()
    }
    pub fn target_food_count(&self) -> usize {
        let n = self.board_player_count();
        if n == 0 {
            0
        } else {
            ((n + 1) / 2).min(self.cfg.max_food)
        }
    }
    pub fn pickup_cap(&self) -> usize {
        let n = self.board_player_count();
        if n == 0 {
            0
        } else {
            ((n + 3) / 4).max(1).min(self.cfg.powerups.max_concurrent_pickups)
        }
    }

    // Bring the active (non-bounty) food count to the player-scaled target.
    pub fn ensure_foods(&mut self) {
        let target = self.target_food_count();
        let mut normal = self.foods.iter().filter(|f| !f.bounty).count();
        if normal > target {
            let mut remove = normal - target;
            self.foods.retain(|f| {
                if f.bounty {
                    return true;
                }
                if remove > 0 {
                    remove -= 1;
                    false
                } else {
                    true
                }
            });
            normal = target;
        }
        while normal < target {
            if !self.place_one_food() {
                break; // board full: stop trying this tick
            }
            normal += 1;
        }
    }

    // Living slots other than `exclude`, sorted by body length ascending,
    // truncated to the ceil(playerCount/2) "lowest scoring players" group
    // (v4.5.0 generalization of the old single-trailing-snake bias -- with
    // more players seated, more of the trailing pack shares in the bounty).
    pub fn lowest_scoring_targets(&self, exclude: usize) -> Vec<usize> {
        let mut living: Vec<usize> = self
            .slots
            .iter()
            .enumerate()
            .filter(|(i, s)| *i != exclude && matches!(s, Some(sn) if sn.alive))
            .map(|(i, _)| i)
            .collect();
        living.sort_by_key(|&i| self.slots[i].as_ref().unwrap().body.len());
        let group_size = ((self.player_seat_count() as f64 / 2.0).ceil() as usize)
            .max(1)
            .min(living.len());
        living.truncate(group_size);
        living
    }

    // Shared pinata scatter math (v3.6.6, generalized v4.5.0): scatters
    // short-TTL candy around `anchor`, biased toward a random member of the
    // lowest-scoring-players group (not always the single shortest), and
    // queues the candy-burst explosion. `size_basis` drives both the candy
    // count and how far the burst spreads -- a bigger snake/cut-off tail
    // pops wider, pinata-style.
    fn scatter_bounty(&mut self, exclude: usize, anchor: Cell, size_basis: usize) {
        let p = &self.cfg.pinata;
        if !p.enabled || size_basis < p.min_length || self.player_seat_count() < 2 {
            return;
        }
        let count = p
            .max_food
            .min(((size_basis as f64 * p.percent).round() as usize).max(1));
        let spread = p.spread
            + ((size_basis.saturating_sub(p.min_length)) as f64 * p.size_scale).round() as i32;
        let ttl_ticks = ((p.ttl_ms / self.current_move_interval_ms()).ceil() as i64).max(1);
        let expires_at_tick = self.move_seq + ttl_ticks;
        let cols = self.cfg.grid.cols;
        let rows = self.cfg.grid.rows;
        // Bias targets: living snakes shorter than the source, drawn from the
        // lowest-scoring group -- each candy independently rolls whether to
        // nudge toward a (uniformly random) member of that group.
        let targets: Vec<Cell> = self
            .lowest_scoring_targets(exclude)
            .into_iter()
            .filter(|&i| self.slots[i].as_ref().map_or(false, |t| t.body.len() < size_basis))
            .map(|i| self.slots[i].as_ref().unwrap().head())
            .collect();
        let bias_p = p.bias;
        let mut placed: Vec<Cell> = Vec::new();
        let mut rng = rand::rng();
        for _ in 0..count {
            let (mut cx, mut cy) = (anchor.x, anchor.y);
            if !targets.is_empty() && rng.random::<f64>() < bias_p {
                let b = targets[rand_below(targets.len() as i32) as usize];
                cx = (cx as f64 + (b.x - cx) as f64 * 0.5).round() as i32;
                cy = (cy as f64 + (b.y - cy) as f64 * 0.5).round() as i32;
            }
            for _ in 0..12 {
                let jitter = |rng: &mut rand::rngs::ThreadRng| {
                    ((rng.random::<f64>() * 2.0 - 1.0) * spread as f64).round() as i32
                };
                let x = (cx + jitter(&mut rng)).clamp(0, cols - 1);
                let y = (cy + jitter(&mut rng)).clamp(0, rows - 1);
                if placed.iter().any(|c| c.x == x && c.y == y) || self.cell_has_entity(x, y) {
                    continue; // one candy per cell, no stacking on existing entities
                }
                placed.push(Cell { x, y });
                self.foods.push(Food { x, y, bounty: true, expires_at_tick });
                break;
            }
        }
        if !placed.is_empty() {
            self.explosions.push(crate::state::Explosion { x: anchor.x, y: anchor.y, radius: -spread });
        }
    }

    // "Pinata" bounty burst (v3.6.6) for a dead snake's body (read before
    // clearing).
    pub fn drop_pinata_food(&mut self, dead_slot: usize) {
        let Some(s) = self.slots[dead_slot].as_ref() else { return };
        let body_len = s.body.len();
        let mid = s.body[body_len / 2];
        self.scatter_bounty(dead_slot, mid, body_len);
    }

    // Scissors tail-cut bounty (v4.5.0): the severed segments of a self-cut
    // or opponent-cut scatter the same way a corpse does, sized off the
    // ORIGINAL (pre-cut) body length so a bigger snake's cut still sprays
    // wide even though only the tail portion is actually being converted.
    // severed: &[Cell] -- a borrowed slice, see "Slices" in
    // RUST-CHEATSHEET.md.
    pub fn drop_scissors_food(&mut self, exclude: usize, severed: &[Cell], original_len: usize) {
        if severed.is_empty() {
            return;
        }
        let mid = severed[severed.len() / 2];
        self.scatter_bounty(exclude, mid, original_len);
    }

    // Clear and refill food (the placeFood test hook).
    pub fn reroll_foods(&mut self) {
        self.foods.clear();
        self.ensure_foods();
    }
}
