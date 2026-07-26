// The raw config.json shape + the shallow-merge helper used for the two
// opaque client-passthrough sections (clientFx/clientRender).
use super::movement::{BoostCfg, Grid, MoveCfg};
use super::powerup_cfg::PowerupsCfg;
use super::spawn::{FoodRateCfg, PinataCfg, RubberbandCfg, WallsCfg};
use serde::Deserialize;

// clientFx/clientRender are opaque passthrough JSON (the server never reads
// them, only merges defaults and hands them to /api/config), so they stay
// serde_json::Value.
// This mirrors config.json's shape 1:1 for parsing; config/mod.rs::load()
// turns it into the resolved Config the rest of the server actually uses
// (filling in derived fields like sim_ms, applying grid presets, etc).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawCfg {
    pub max_players: usize,
    pub max_local_players: usize,
    pub grid: Grid,
    pub sim_hz: f64,
    #[serde(rename = "move")]
    pub mv: MoveCfg,
    pub max_concurrent_food: usize,
    pub boost: BoostCfg,
    pub enable_debug: bool,
    pub kill_bonus_score: i64,
    pub kill_bonus_growth: i64,
    pub min_snake_length: usize,
    pub spectator_promote_delay_ms: i64,
    pub captcha_token_ttl_ms: i64,
    pub wall_grace_ticks: i32,
    pub spectator_idle_ms: i64,
    pub player_idle_ms: i64,
    pub join_offer_ms: i64,
    pub input_buffer: usize,
    pub client_fx: serde_json::Value,
    pub client_render: serde_json::Value,
    pub powerups: PowerupsCfg,
    pub rubberband: RubberbandCfg,
    pub pinata: PinataCfg,
    pub food_rate: FoodRateCfg,
    pub walls: WallsCfg,
    pub highscores_file: Option<String>,
    pub port: Option<u16>,
}
impl Default for RawCfg {
    fn default() -> Self {
        RawCfg {
            max_players: 8,
            max_local_players: 2,
            grid: Grid::default(),
            sim_hz: 60.0,
            mv: MoveCfg::default(),
            max_concurrent_food: 8,
            boost: BoostCfg::default(),
            enable_debug: true,
            kill_bonus_score: 5,
            kill_bonus_growth: 3,
            min_snake_length: 3,
            spectator_promote_delay_ms: 1500,
            captcha_token_ttl_ms: 60000,
            wall_grace_ticks: 1,
            spectator_idle_ms: 300000,
            player_idle_ms: 120000,
            join_offer_ms: 10000,
            input_buffer: 3,
            client_fx: serde_json::Value::Null,
            client_render: serde_json::Value::Null,
            powerups: PowerupsCfg::default(),
            rubberband: RubberbandCfg::default(),
            pinata: PinataCfg::default(),
            food_rate: FoodRateCfg::default(),
            walls: WallsCfg::default(),
            highscores_file: None,
            port: None,
        }
    }
}

// Merge `overlay` keys over `base` (one level deep) -- the JS
// Object.assign({defaults}, CFG.section) for the opaque clientFx/
// clientRender sections.
pub(super) fn shallow_merge(base: serde_json::Value, overlay: &serde_json::Value) -> serde_json::Value {
    let mut out = base;
    // if let (Some(a), Some(b)) = (...) only runs the body when BOTH values
    // are JSON objects (as_object_mut()/as_object() return None otherwise)
    // -- see "Option<T>" in docs/RUST-CHEATSHEET.md.
    if let (Some(out_map), Some(over_map)) = (out.as_object_mut(), overlay.as_object()) {
        // `for (k, v) in over_map` walks every key/value pair in the overlay
        // object, overwriting (or adding) that key in the base map.
        for (k, v) in over_map {
            out_map.insert(k.clone(), v.clone());
        }
    }
    out
}
