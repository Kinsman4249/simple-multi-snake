// The `Game` struct itself. Its methods are split by responsibility across
// sibling files in this directory (all as `impl Game` blocks -- Rust allows
// multiple impl blocks for one type across files in the same crate):
//   spawn.rs      -- snake spawn placement
//   food.rs       -- food/pickup placement, pinata/scissors bounty scatter
//   query.rs      -- read-only lookups (leader/trailing snake, seat counts,
//                    speed easing, etc.) + small state-clock helpers
//   food_rate.rs  -- speed-run/food-rate score-mode accumulator (v3.7.0)
use super::conn::Conn;
use super::types::{
    Explosion, Food, JoinOffer, KillEvent, PerfCounters, Pickup, PortalFx, QueueEntry, Trail,
    Wall, WallShatterFx,
};
use crate::config::Config;
use crate::highscores::HighScores;
use std::collections::HashMap;

pub struct Game {
    pub cfg: &'static Config,
    pub slots: Vec<Option<super::Snake>>,
    pub spectator_queue: Vec<QueueEntry>,
    pub connections: HashMap<String, Conn>,
    // Insertion order of connections (JS Map iterates in insertion order;
    // scoreMode/playerSeatCount don't care, but keeping broadcast order
    // stable costs one Vec).
    pub conn_order: Vec<String>,
    pub foods: Vec<Food>,
    pub move_interval_ms: Option<f64>,
    pub session_start: Option<i64>,
    pub join_offer: Option<JoinOffer>,
    pub powerup_pickups: Vec<Pickup>,
    pub trails: Vec<Trail>,
    pub blue_shells: Vec<super::types::BlueShell>,
    pub explosions: Vec<Explosion>,
    pub walls: Vec<Wall>,
    pub portal_fx: Vec<PortalFx>,
    pub wall_shatters: Vec<WallShatterFx>,
    pub next_powerup_id: i64,
    pub last_powerup_spawn_at: Option<i64>,
    pub last_wall_spawn_at: Option<i64>,
    pub move_seq: i64,
    pub last_sim_at: Option<i64>,
    pub next_sim_at: Option<f64>, // float ms: SIM_MS is fractional at 60Hz
    pub kill_events: Vec<KillEvent>,
    pub rivalries: HashMap<String, i64>,
    pub highscores: HighScores,
    // Perf counters (SNAKE_PERF): nanoseconds + counts, printed/reset by the
    // 5s summary task in main.rs.
    pub perf: PerfCounters,
}

impl Game {
    pub fn new(cfg: &'static Config, highscores: HighScores) -> Game {
        Game {
            cfg,
            slots: (0..cfg.max_players).map(|_| None).collect(),
            spectator_queue: Vec::new(),
            connections: HashMap::new(),
            conn_order: Vec::new(),
            foods: Vec::new(),
            move_interval_ms: None,
            session_start: None,
            join_offer: None,
            powerup_pickups: Vec::new(),
            trails: Vec::new(),
            blue_shells: Vec::new(),
            explosions: Vec::new(),
            walls: Vec::new(),
            portal_fx: Vec::new(),
            wall_shatters: Vec::new(),
            next_powerup_id: 1,
            last_powerup_spawn_at: None,
            last_wall_spawn_at: None,
            move_seq: 0,
            last_sim_at: None,
            next_sim_at: None,
            kill_events: Vec::new(),
            rivalries: HashMap::new(),
            highscores,
            perf: PerfCounters::default(),
        }
    }

    // Zero-resource debug log gate (JS dlog).
    pub fn dlog(&self, msg: &str) {
        if self.cfg.enable_debug {
            println!("[debug] {}", msg);
        }
    }
}

mod food;
mod food_rate;
mod query;
mod spawn;
