// Read-only lookups (leader/trailing snake, seat counts, bounds checks) plus
// the global speed-easing state-clock helpers.
use super::Game;
use crate::state::conn::Conn;
use crate::state::snake::Snake;
use crate::state::types::{Cell, Role};

impl Game {
    // Banana-trail control inversion status (sim-clock based).
    pub fn is_inverted(&self, s: &Snake) -> bool {
        self.move_seq < s.invert_until_tick
    }

    // Shared floor-respecting shrink (poison pop / blue-shell damage).
    pub fn remove_segments(s: &mut Snake, count: usize, min_len: usize) {
        let n = count.min(s.body.len().saturating_sub(min_len));
        for _ in 0..n {
            s.body.pop();
        }
    }

    // Living snake with the most segments (ties: lowest slot index).
    pub fn current_leader_index(&self) -> Option<usize> {
        let mut best: Option<(usize, usize)> = None;
        for (i, s) in self.slots.iter().enumerate() {
            let Some(s) = s else { continue };
            if !s.alive {
                continue;
            }
            if best.map_or(true, |(_, l)| s.body.len() > l) {
                best = Some((i, s.body.len()));
            }
        }
        best.map(|(i, _)| i)
    }
    // Living snake with the FEWEST segments (same tie rule).
    pub fn current_trailing_index(&self) -> Option<usize> {
        let mut worst: Option<(usize, usize)> = None;
        for (i, s) in self.slots.iter().enumerate() {
            let Some(s) = s else { continue };
            if !s.alive {
                continue;
            }
            if worst.map_or(true, |(_, l)| s.body.len() < l) {
                worst = Some((i, s.body.len()));
            }
        }
        worst.map(|(i, _)| i)
    }

    // Connected PEOPLE still in the game: seats in role player (alive or
    // dead-awaiting-respawn). The blue-shell presence gate.
    pub fn player_seat_count(&self) -> usize {
        self.connections
            .values()
            .map(|c| c.locals.iter().filter(|l| matches!(l, Some(seat) if seat.role == Role::Player)).count())
            .sum()
    }

    // A slot's session-bound initials ("???" fallback).
    pub fn initials_for_slot(&self, slot_index: usize) -> String {
        let Some(Some(s)) = self.slots.get(slot_index) else { return "???".into() };
        let Some(conn) = self.connections.get(&s.conn_id) else { return "???".into() };
        match self.local_index_for_slot(conn, slot_index) {
            Some(li) => conn.initials_for(li).to_string(),
            None => "???".into(),
        }
    }

    pub fn local_index_for_slot(&self, conn: &Conn, slot_index: usize) -> Option<usize> {
        conn.locals.iter().position(|l| {
            matches!(l, Some(seat) if seat.role == Role::Player && seat.slot_index == Some(slot_index))
        })
    }

    // Kill feed rivalry tally (in-memory, keyed on displayed initials).
    pub fn bump_rivalry(&mut self, killer: &str, victim: &str) -> i64 {
        let key = format!("{}>{}", killer, victim);
        let count = self.rivalries.get(&key).copied().unwrap_or(0) + 1;
        self.rivalries.insert(key, count);
        count
    }

    // Blue-shell equal-length gate: >= 2 living snakes, all the same length.
    pub fn all_equal_length(&self) -> bool {
        let mut first: Option<usize> = None;
        let mut count = 0;
        for s in self.slots.iter().flatten() {
            if !s.alive {
                continue;
            }
            count += 1;
            match first {
                None => first = Some(s.body.len()),
                Some(f) if s.body.len() != f => return false,
                _ => {}
            }
        }
        count >= 2
    }

    // "How many computers": connections owning at least one player seat.
    pub fn score_mode(&self) -> &'static str {
        let n = self
            .connections
            .values()
            .filter(|c| c.locals.iter().any(|l| matches!(l, Some(seat) if seat.role == Role::Player)))
            .count();
        if n >= 2 {
            "networked"
        } else {
            "local"
        }
    }

    pub fn in_bounds(&self, h: Cell) -> bool {
        h.x >= 0 && h.x < self.cfg.grid.cols && h.y >= 0 && h.y < self.cfg.grid.rows
    }

    // Global speed target (v3.5.0): eased function of the average living-
    // snake length, saturating at lengthSaturation.
    pub fn target_move_interval_ms(&self) -> f64 {
        let mut total = 0usize;
        let mut n = 0usize;
        for s in self.slots.iter().flatten() {
            if s.alive {
                total += s.body.len();
                n += 1;
            }
        }
        if n == 0 {
            return self.cfg.mv.start_interval_ms;
        }
        let avg = total as f64 / n as f64;
        let lo = self.cfg.min_snake_length as f64;
        let hi = (lo + 1.0).max(self.cfg.mv.length_saturation);
        let t = ((avg - lo) / (hi - lo)).clamp(0.0, 1.0);
        let eased = 1.0 - (1.0 - t) * (1.0 - t); // easeOutQuad
        self.cfg.mv.start_interval_ms + (self.cfg.mv.min_interval_ms - self.cfg.mv.start_interval_ms) * eased
    }

    // Exponential smoothing toward the target (time constant speedEaseMs).
    pub fn advance_global_speed(&mut self, dt: f64) {
        let target = self.target_move_interval_ms();
        if self.move_interval_ms.is_none() || !(self.cfg.mv.speed_ease_ms > 0.0) || dt <= 0.0 {
            self.move_interval_ms = Some(target);
            return;
        }
        let a = (dt / self.cfg.mv.speed_ease_ms).min(1.0);
        let cur = self.move_interval_ms.unwrap();
        self.move_interval_ms = Some(cur + (target - cur) * a);
    }

    pub fn current_move_interval_ms(&self) -> f64 {
        self.move_interval_ms.unwrap_or_else(|| self.target_move_interval_ms())
    }
}
