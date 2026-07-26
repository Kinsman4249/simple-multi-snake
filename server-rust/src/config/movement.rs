// Grid/movement/boost tuning + the two powerup sub-configs whose effect is
// movement-shaped (wormhole teleports, growthSpurt's speed-adjacent growth).
use serde::{Deserialize, Serialize};

// #[derive(...)] auto-generates code for this struct -- see
// docs/RUST-CHEATSHEET.md. The #[serde(...)] lines below control how JSON
// keys map onto these fields, also covered there.
#[derive(Deserialize, Serialize, Clone)]
pub struct Grid {
    // Explicit cols/rows always win over a preset (this keeps every test's
    // grid override and any operator's hand-tuned board working unchanged).
    #[serde(default)]
    pub cols: i32,
    #[serde(default)]
    pub rows: i32,
    #[serde(default = "d_cell_size", rename = "cellSize")]
    pub cell_size: i32,
    // Option<String>: the preset name is optional (absent = use explicit
    // cols/rows or the hardcoded fallback in config/mod.rs load()).
    #[serde(default, skip_serializing)]
    pub preset: Option<String>,
}
fn d_cell_size() -> i32 {
    20
}
// impl blocks hold a type's methods/trait implementations separately from
// its struct/enum declaration -- see docs/RUST-CHEATSHEET.md.
impl Default for Grid {
    fn default() -> Self {
        Grid { cols: 0, rows: 0, cell_size: 20, preset: None }
    }
}

// Snake move-tick tuning: how fast the snake ticks forward and how that
// speeds up as it grows.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct MoveCfg {
    pub start_interval_ms: f64,  // ms between moves at length 1 (slowest)
    pub min_interval_ms: f64,    // ms between moves at max length (fastest, floor)
    pub length_saturation: f64,  // length at which speed maxes out
    pub speed_ease_ms: f64,      // how long a speed change takes to ease in
}
impl Default for MoveCfg {
    fn default() -> Self {
        MoveCfg { start_interval_ms: 160.0, min_interval_ms: 70.0, length_saturation: 40.0, speed_ease_ms: 1000.0 }
    }
}

// Speed-boost (holding the boost key) tuning.
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct BoostCfg {
    pub enabled: bool,
    pub boost_speed: f64,      // speed multiplier while boosting
    pub drift_ms: f64,         // grace window before boost drains on release
    pub ramp_ms: f64,          // time to ramp up to full boost speed
    pub hold_grace_ms: f64,    // how long a boost keypress "sticks" if released briefly
    pub decel_ms: f64,         // time to decelerate back to normal speed
    pub drift_threshold: f64,
}
impl Default for BoostCfg {
    fn default() -> Self {
        BoostCfg {
            enabled: true, boost_speed: 1.5, drift_ms: 250.0, ramp_ms: 400.0,
            hold_grace_ms: 120.0, decel_ms: 250.0, drift_threshold: 0.3,
        }
    }
}

// Per-powerup sub-configs (shallow-merged over defaults like BOOST above).
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct WormholeCfg {
    pub enabled: bool,
    pub lookahead_depth: i32,  // how many tiles ahead to scan for a safe teleport exit
}
impl Default for WormholeCfg {
    fn default() -> Self {
        WormholeCfg { enabled: true, lookahead_depth: 3 }
    }
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct GrowthSpurtCfg {
    pub enabled: bool,
    pub duration_ms: f64,
    pub food_multiplier: i64,
    pub kill_bonus_growth: i64,
}
impl Default for GrowthSpurtCfg {
    fn default() -> Self {
        GrowthSpurtCfg { enabled: true, duration_ms: 8000.0, food_multiplier: 2, kill_bonus_growth: 2 }
    }
}
