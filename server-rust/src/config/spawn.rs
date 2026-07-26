// Spawn/placement bias tuning: food rubberbanding, pinata bounty scatter,
// food-rate score mode, and the obstacle-wall spawner (incl. its own
// leader-bias sub-config, distinct from the food rubberband one).
use serde::Deserialize;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct FoodBiasCfg {
    pub enabled: bool,
    pub radius: i32,
    pub strength: f64,
}
impl Default for FoodBiasCfg {
    fn default() -> Self {
        FoodBiasCfg { enabled: true, radius: 15, strength: 3.0 }
    }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct ShellPressureCfg {
    pub enabled: bool,
    pub lead_ratio: f64,
    pub type_weight: f64,
    pub interval_scale: f64,
}
impl Default for ShellPressureCfg {
    fn default() -> Self {
        ShellPressureCfg { enabled: true, lead_ratio: 1.3, type_weight: 4.0, interval_scale: 0.5 }
    }
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RubberbandCfg {
    pub food_bias: FoodBiasCfg,
    pub shell_pressure: ShellPressureCfg,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct PinataCfg {
    pub enabled: bool,
    pub min_length: usize,
    pub percent: f64,
    pub max_food: usize,
    pub ttl_ms: f64,
    pub spread: i32,
    pub bias: f64,
    // Extra scatter-radius cells per body segment above min_length -- a
    // bigger pinata (a longer snake's corpse or cut-off tail) bursts wider.
    pub size_scale: f64,
}
impl Default for PinataCfg {
    fn default() -> Self {
        // minLength default is twice blueShell's shortLeaderLength default
        // (JS computed it from the merged POWERUPS; with both defaulted the
        // result is the same 30).
        PinataCfg {
            enabled: true, min_length: 30, percent: 0.30, max_food: 12, ttl_ms: 6000.0, spread: 6,
            bias: 0.6, size_scale: 0.15,
        }
    }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct FoodRateCfg {
    pub enabled: bool,
    pub bucket_ms: f64,
    pub floor_ms: f64,
    pub window_ms: f64,
}
impl Default for FoodRateCfg {
    fn default() -> Self {
        FoodRateCfg { enabled: true, bucket_ms: 1000.0, floor_ms: 300000.0, window_ms: 300000.0 }
    }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct LeaderBiasCfg {
    pub enabled: bool,
    pub radius: i32,
    pub strength: f64,
}
impl Default for LeaderBiasCfg {
    fn default() -> Self {
        LeaderBiasCfg { enabled: true, radius: 12, strength: 3.0 }
    }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct WallsCfg {
    pub enabled: bool,
    pub min_players: usize,
    pub telegraph_ms: i64,
    pub lifetime_ms: i64,
    pub despawn_telegraph_ms: i64,
    pub spawn_interval_ms: i64,
    pub max_concurrent: usize,
    pub min_head_distance: i32,
    pub leader_bias: LeaderBiasCfg,
}
impl Default for WallsCfg {
    fn default() -> Self {
        WallsCfg {
            enabled: true, min_players: 1, telegraph_ms: 3000, lifetime_ms: 45000,
            despawn_telegraph_ms: 3000, spawn_interval_ms: 15000, max_concurrent: 3,
            min_head_distance: 4, leader_bias: LeaderBiasCfg::default(),
        }
    }
}
