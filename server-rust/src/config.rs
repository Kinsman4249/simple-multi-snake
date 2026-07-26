// ============================================================
// Config & constants: everything resolved ONCE at startup from
// config.json / package.json / env. Port of server/config.js. Each JS
// Object.assign({defaults}, CFG.section) shallow merge became a serde
// struct with per-field defaults, which behaves the same way for a
// config.json that is missing a section or individual keys.
//
// One deliberate difference from the node server: PORT was a `const 8080`
// that install.sh sed-patched into the source. A compiled binary cannot be
// patched, so the port is now runtime config: the PORT env var wins, then
// config.json's "port" key, then 8080.
// ============================================================
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

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

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct IceTrailCfg {
    pub enabled: bool,
    pub duration_ms: f64,
    pub tile_duration_ms: f64,
    pub slow_duration_ms: f64,
    pub slow_multiplier_per_stack: f64,
    pub min_speed_multiplier: f64,
}
impl Default for IceTrailCfg {
    fn default() -> Self {
        IceTrailCfg {
            enabled: true, duration_ms: 8000.0, tile_duration_ms: 10000.0,
            slow_duration_ms: 4000.0, slow_multiplier_per_stack: 0.15, min_speed_multiplier: 0.4,
        }
    }
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct PoisonTrailCfg {
    pub enabled: bool,
    pub duration_ms: f64,
    pub tile_duration_ms: f64,
}
impl Default for PoisonTrailCfg {
    fn default() -> Self {
        PoisonTrailCfg { enabled: true, duration_ms: 8000.0, tile_duration_ms: 10000.0 }
    }
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct SpeedBoostCfg {
    pub enabled: bool,
    pub duration_ms: f64,
    pub speed_mult: f64,
}
impl Default for SpeedBoostCfg {
    fn default() -> Self {
        SpeedBoostCfg { enabled: true, duration_ms: 6000.0, speed_mult: 1.6 }
    }
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct BlueShellCfg {
    pub enabled: bool,
    pub segment_loss_percent: f64,
    pub explosion_radius: i32,
    pub splash_loss_percent: f64,
    pub speed_ratio: f64,
    pub short_leader_length: usize,
    pub short_leader_factor: f64,
}
impl Default for BlueShellCfg {
    fn default() -> Self {
        BlueShellCfg {
            enabled: true, segment_loss_percent: 0.33, explosion_radius: 3,
            splash_loss_percent: 1.0 / 6.0, speed_ratio: 0.45,
            short_leader_length: 15, short_leader_factor: 0.25,
        }
    }
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct BananaTrailCfg {
    pub enabled: bool,
    pub duration_ms: f64,
    pub tile_duration_ms: f64,
    pub invert_duration_ms: f64,
}
impl Default for BananaTrailCfg {
    fn default() -> Self {
        BananaTrailCfg { enabled: true, duration_ms: 8000.0, tile_duration_ms: 10000.0, invert_duration_ms: 4000.0 }
    }
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct HelloWorldCfg {
    pub enabled: bool,
    pub duration_ms: f64,
    pub speed_mult: f64,
}
impl Default for HelloWorldCfg {
    fn default() -> Self {
        HelloWorldCfg { enabled: false, duration_ms: 1000.0, speed_mult: 1.02 }
    }
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct ScissorsCfg {
    pub enabled: bool,
}
impl Default for ScissorsCfg {
    fn default() -> Self {
        ScissorsCfg { enabled: true }
    }
}

#[derive(Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PowerupsCfg {
    #[serde(default = "d_spawn_interval")]
    pub spawn_interval_ms: f64,
    #[serde(default = "d_max_pickups")]
    pub max_concurrent_pickups: usize,
    pub wormhole: WormholeCfg,
    pub growth_spurt: GrowthSpurtCfg,
    pub ice_trail: IceTrailCfg,
    pub poison_trail: PoisonTrailCfg,
    pub speed_boost: SpeedBoostCfg,
    pub blue_shell: BlueShellCfg,
    pub banana_trail: BananaTrailCfg,
    pub hello_world: HelloWorldCfg,
    pub scissors: ScissorsCfg,
}
fn d_spawn_interval() -> f64 {
    8000.0
}
fn d_max_pickups() -> usize {
    4
}
impl PowerupsCfg {
    pub fn enabled(&self, t: crate::powerups::PowerupType) -> bool {
        use crate::powerups::PowerupType::*;
        match t {
            Wormhole => self.wormhole.enabled,
            GrowthSpurt => self.growth_spurt.enabled,
            IceTrail => self.ice_trail.enabled,
            PoisonTrail => self.poison_trail.enabled,
            SpeedBoost => self.speed_boost.enabled,
            BlueShell => self.blue_shell.enabled,
            BananaTrail => self.banana_trail.enabled,
            HelloWorld => self.hello_world.enabled,
            Scissors => self.scissors.enabled,
        }
    }
    // The timed self-buff duration for a type (blueShell/wormhole never use it).
    pub fn duration_ms(&self, t: crate::powerups::PowerupType) -> f64 {
        use crate::powerups::PowerupType::*;
        match t {
            GrowthSpurt => self.growth_spurt.duration_ms,
            IceTrail => self.ice_trail.duration_ms,
            PoisonTrail => self.poison_trail.duration_ms,
            SpeedBoost => self.speed_boost.duration_ms,
            BananaTrail => self.banana_trail.duration_ms,
            HelloWorld => self.hello_world.duration_ms,
            Wormhole | BlueShell | Scissors => 0.0,
        }
    }
    pub fn tile_duration_ms(&self, t: crate::powerups::PowerupType) -> f64 {
        use crate::powerups::PowerupType::*;
        match t {
            IceTrail => self.ice_trail.tile_duration_ms,
            PoisonTrail => self.poison_trail.tile_duration_ms,
            BananaTrail => self.banana_trail.tile_duration_ms,
            _ => 0.0,
        }
    }
}

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

// The raw config.json shape. clientFx/clientRender are opaque passthrough
// JSON (the server never reads them, only merges defaults and hands them to
// /api/config), so they stay serde_json::Value.
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

// Everything the rest of the server reads. Built once in load() and leaked
// to 'static (the JS equivalent was module-level consts).
pub struct Config {
    pub root: PathBuf,
    pub build: String,
    pub public_dir: PathBuf,
    pub port: u16,
    pub sim_hz: f64,
    pub sim_ms: f64,
    pub grid: Grid,
    pub mv: MoveCfg,
    pub max_food: usize,
    pub max_players: usize,
    pub max_local_players: usize,
    pub client_fx: serde_json::Value,
    pub client_render: serde_json::Value,
    pub wall_grace_ticks: i32,
    pub spectator_idle_ms: i64,
    pub player_idle_ms: i64,
    pub join_offer_ms: i64,
    pub input_buffer: usize,
    pub boost: BoostCfg,
    pub min_snake_length: usize,
    pub powerups: PowerupsCfg,
    pub enable_debug: bool,
    pub kill_bonus_score: i64,
    pub kill_bonus_growth: i64,
    pub spectator_promote_delay_ms: i64,
    pub captcha_token_ttl_ms: i64,
    pub rubberband: RubberbandCfg,
    pub pinata: PinataCfg,
    pub food_rate: FoodRateCfg,
    pub walls: WallsCfg,
    pub highscores_file: String,
    pub perf: bool,
    pub test_hooks: bool,
    pub test_spawns: Option<Vec<Option<ForcedSpawn>>>,
}

#[derive(Deserialize, Clone)]
pub struct ForcedSpawn {
    pub x: i32,
    pub y: i32,
    pub dir: Option<String>,
    pub len: Option<usize>,
}

pub const COLORS: [(&str, &str); 4] = [
    ("#6f6", "#3a3"),
    ("#6cf", "#38a"),
    ("#f6f", "#a3a"),
    ("#ff6", "#aa3"),
];

// Merge `overlay` keys over `base` (one level deep) -- the JS
// Object.assign({defaults}, CFG.section) for the opaque clientFx/
// clientRender sections.
fn shallow_merge(base: serde_json::Value, overlay: &serde_json::Value) -> serde_json::Value {
    let mut out = base;
    if let (Some(out_map), Some(over_map)) = (out.as_object_mut(), overlay.as_object()) {
        for (k, v) in over_map {
            out_map.insert(k.clone(), v.clone());
        }
    }
    out
}

// Build identity, cheapest source first: live git checkout (commit count +
// short hash), release archive (build-info.json stamped by export-subst),
// else package.json version alone marked "dev".
fn resolve_build(root: &PathBuf) -> String {
    let version = std::fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(String::from))
        .unwrap_or_else(|| "0.0.0".into());
    let base = format!("v{}", version);
    let git = |args: &[&str]| -> Option<String> {
        let out = Command::new("git").args(args).current_dir(root).output().ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    if let (Some(count), Some(hash)) = (
        git(&["rev-list", "--count", "HEAD"]),
        git(&["rev-parse", "--short", "HEAD"]),
    ) {
        return format!("{} build {} ({})", base, count, hash);
    }
    if let Ok(raw) = std::fs::read_to_string(root.join("build-info.json")) {
        if let Ok(info) = serde_json::from_str::<serde_json::Value>(&raw) {
            let get = |k: &str| {
                info.get(k)
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.starts_with("$Format"))
                    .map(String::from)
            };
            let describe = get("describe");
            let commit = get("commit");
            if describe.is_some() || commit.is_some() {
                let mut s = format!("{} {}", base, describe.unwrap_or_default());
                if let Some(c) = commit {
                    s.push_str(&format!(" ({})", c));
                }
                return s;
            }
        }
    }
    format!("{} dev", base)
}

pub fn load() -> &'static Config {
    // The repo/app root is the working directory (tests and systemd both set
    // it); SNAKE_CONFIG points at an alternate config file relative to it.
    let root = std::env::current_dir().expect("cwd");
    let cfg_name = std::env::var("SNAKE_CONFIG").unwrap_or_else(|_| "config.json".into());
    let raw_text = std::fs::read_to_string(root.join(&cfg_name))
        .unwrap_or_else(|e| panic!("cannot read {}: {}", cfg_name, e));
    let raw: RawCfg = serde_json::from_str(&raw_text)
        .unwrap_or_else(|e| panic!("bad config {}: {}", cfg_name, e));

    // Board presets: explicit cols/rows always win; else resolve the preset.
    let mut grid = raw.grid.clone();
    if grid.cols <= 0 || grid.rows <= 0 {
        let (cols, rows) = match grid.preset.as_deref() {
            Some("4k") => (192, 108),
            _ => (96, 54),
        };
        grid.cols = cols;
        grid.rows = rows;
    }

    let sim_hz = if raw.sim_hz.is_finite() && raw.sim_hz > 0.0 { raw.sim_hz } else { 60.0 };

    let client_fx_defaults = serde_json::json!({
        "inputFlash": true, "inputFlashMs": 90, "correctionGlide": true,
        "correctionGlideMs": 90, "heldGlow": true
    });
    let client_render_defaults = serde_json::json!({ "interpolate": true, "renderer": "auto" });

    let test_spawns = std::env::var("SNAKE_TEST_SPAWNS")
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<Option<ForcedSpawn>>>(&s).ok());

    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .or(raw.port)
        .unwrap_or(8080);

    let build = format!("server {}", resolve_build(&root));

    let cfg = Config {
        public_dir: root.join("public"),
        build,
        port,
        sim_hz,
        sim_ms: 1000.0 / sim_hz,
        grid,
        mv: raw.mv,
        max_food: raw.max_concurrent_food,
        max_players: raw.max_players,
        max_local_players: raw.max_local_players.max(1),
        client_fx: shallow_merge(client_fx_defaults, &raw.client_fx),
        client_render: shallow_merge(client_render_defaults, &raw.client_render),
        wall_grace_ticks: raw.wall_grace_ticks,
        spectator_idle_ms: raw.spectator_idle_ms,
        player_idle_ms: raw.player_idle_ms,
        join_offer_ms: raw.join_offer_ms,
        input_buffer: raw.input_buffer,
        boost: raw.boost,
        min_snake_length: raw.min_snake_length.max(1),
        powerups: raw.powerups,
        enable_debug: raw.enable_debug,
        kill_bonus_score: raw.kill_bonus_score,
        kill_bonus_growth: raw.kill_bonus_growth,
        spectator_promote_delay_ms: raw.spectator_promote_delay_ms,
        captcha_token_ttl_ms: raw.captcha_token_ttl_ms,
        rubberband: raw.rubberband,
        pinata: raw.pinata,
        food_rate: raw.food_rate,
        walls: raw.walls,
        highscores_file: raw.highscores_file.filter(|s| !s.is_empty()).unwrap_or_else(|| "highscores.json".into()),
        perf: std::env::var("SNAKE_PERF").map(|v| !v.is_empty()).unwrap_or(false),
        test_hooks: std::env::var("SNAKE_TEST_HOOKS").map(|v| v == "1").unwrap_or(false),
        test_spawns,
        root,
    };
    Box::leak(Box::new(cfg))
}

// Current epoch time in ms (the JS Date.now()).
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
