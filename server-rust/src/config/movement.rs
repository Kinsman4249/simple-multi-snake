// Grid/movement/boost tuning + the two powerup sub-configs whose effect is
// movement-shaped (wormhole teleports, growthSpurt's speed-adjacent growth).
use serde::{Deserialize, Serialize};

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
    #[serde(default, skip_serializing)]
    pub preset: Option<String>,
}
fn d_cell_size() -> i32 {
    20
}
impl Default for Grid {
    fn default() -> Self {
        Grid { cols: 0, rows: 0, cell_size: 20, preset: None }
    }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct MoveCfg {
    pub start_interval_ms: f64,
    pub min_interval_ms: f64,
    pub length_saturation: f64,
    pub speed_ease_ms: f64,
}
impl Default for MoveCfg {
    fn default() -> Self {
        MoveCfg { start_interval_ms: 160.0, min_interval_ms: 70.0, length_saturation: 40.0, speed_ease_ms: 1000.0 }
    }
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct BoostCfg {
    pub enabled: bool,
    pub boost_speed: f64,
    pub drift_ms: f64,
    pub ramp_ms: f64,
    pub hold_grace_ms: f64,
    pub decel_ms: f64,
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
    pub lookahead_depth: i32,
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
