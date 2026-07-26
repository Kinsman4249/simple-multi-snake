// Speed-run / food-rate score mode (v3.7.0): a per-seat running-top-K
// bucket accumulator, closed and re-scored every bucket_ms of live play.
use super::Game;
use crate::state::conn::Conn;
use crate::state::types::FoodRateAcc;

impl Game {
    pub fn food_rate_window_size(&self) -> usize {
        ((self.cfg.food_rate.window_ms / self.cfg.food_rate.bucket_ms).round() as usize).max(1)
    }

    pub fn ensure_food_rate_acc(conn: &mut Conn, local_idx: usize) {
        if conn.food_rate.len() <= local_idx {
            conn.food_rate.resize(local_idx + 1, None);
        }
        if conn.food_rate[local_idx].is_none() {
            conn.food_rate[local_idx] = Some(FoodRateAcc::default());
        }
    }

    fn close_food_rate_bucket(acc: &mut FoodRateAcc, bucket_ms: f64, floor_ms: f64, window: usize) {
        let food = acc.cur_food;
        acc.cur_food = 0;
        acc.cur_play_ms -= bucket_ms;
        acc.closed_count += 1;
        let arr = &mut acc.top_buckets;
        if arr.len() < window {
            let idx = arr.partition_point(|&v| v <= food);
            arr.insert(idx, food);
            acc.top_sum += food;
        } else if !arr.is_empty() && food > arr[0] {
            acc.top_sum += food - arr[0];
            arr[0] = food;
            let mut idx = 0;
            while idx + 1 < arr.len() && arr[idx] > arr[idx + 1] {
                arr.swap(idx, idx + 1);
                idx += 1;
            }
        }
        let k = (acc.closed_count as usize).min(window);
        acc.cached_rate = if k > 0 {
            (acc.top_sum as f64 * 60000.0) / (k as f64 * bucket_ms)
        } else {
            0.0
        };
        if !acc.locked && acc.closed_count as f64 * bucket_ms >= floor_ms {
            acc.locked = true;
        }
    }

    // The seat (conn_id + localIdx) occupying slot i, or None.
    pub fn seat_for_slot(&self, slot_index: usize) -> Option<(String, usize)> {
        let s = self.slots.get(slot_index)?.as_ref()?;
        let conn = self.connections.get(&s.conn_id)?;
        let li = self.local_index_for_slot(conn, slot_index)?;
        Some((s.conn_id.clone(), li))
    }

    // Credit the owning seat's current bucket (food eaten / kill bonus).
    pub fn bump_food_rate_points(&mut self, slot_index: usize, amount: i64) {
        if !self.cfg.food_rate.enabled {
            return;
        }
        let Some((conn_id, li)) = self.seat_for_slot(slot_index) else { return };
        if let Some(conn) = self.connections.get_mut(&conn_id) {
            if let Some(Some(acc)) = conn.food_rate.get_mut(li) {
                acc.cur_food += amount;
            }
        }
    }

    // Advance every living, seated player's play-time by dt.
    pub fn advance_food_rate_timers(&mut self, dt: f64) {
        if !self.cfg.food_rate.enabled || dt <= 0.0 {
            return;
        }
        let bucket_ms = self.cfg.food_rate.bucket_ms;
        let floor_ms = self.cfg.food_rate.floor_ms;
        let window = self.food_rate_window_size();
        for i in 0..self.slots.len() {
            let alive = matches!(&self.slots[i], Some(s) if s.alive);
            if !alive {
                continue;
            }
            let Some((conn_id, li)) = self.seat_for_slot(i) else { continue };
            if let Some(conn) = self.connections.get_mut(&conn_id) {
                if let Some(Some(acc)) = conn.food_rate.get_mut(li) {
                    acc.cur_play_ms += dt;
                    while acc.cur_play_ms >= bucket_ms {
                        Self::close_food_rate_bucket(acc, bucket_ms, floor_ms, window);
                    }
                }
            }
        }
    }

    // Live snapshot for the broadcast: (ratePerMin rounded to 1 decimal,
    // locked), or None if this seat has never been a player.
    pub fn food_rate_snapshot(conn: &Conn, local_idx: usize) -> Option<(f64, bool)> {
        let acc = conn.food_rate.get(local_idx)?.as_ref()?;
        Some(((acc.cached_rate * 10.0).round() / 10.0, acc.locked))
    }

    // Leaderboard value, or None until the seat clears the play-time floor.
    pub fn food_rate_score_for_seat(conn: &Conn, local_idx: usize) -> Option<f64> {
        let acc = conn.food_rate.get(local_idx)?.as_ref()?;
        if !acc.locked {
            return None;
        }
        Some((acc.cached_rate * 100.0).round() / 100.0)
    }
}
