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
//
// Split by responsibility: movement.rs (grid/move/boost + wormhole/
// growthSpurt), powerup_cfg.rs (remaining per-powerup tuning +
// PowerupsCfg), spawn.rs (food/wall placement bias, pinata, food-rate),
// raw.rs (the config.json shape + shallow-merge). This file holds the
// resolved `Config` the rest of the server reads, plus load()/now_ms().
// ============================================================
mod movement;
mod powerup_cfg;
mod raw;
mod spawn;

pub use movement::{BoostCfg, Grid, MoveCfg};
pub use powerup_cfg::PowerupsCfg;
pub use raw::RawCfg;
pub use spawn::{FoodRateCfg, PinataCfg, RubberbandCfg, WallsCfg};

use raw::shallow_merge;
use serde::Deserialize;
use std::path::PathBuf;
use std::process::Command;

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
    // Shared secret gating POST /api/admin/notify-shutdown (see routes.rs).
    // Apache proxies "/" straight through to this server (deploy vhost
    // template), so that route is internet-reachable, not loopback-only --
    // ADMIN_TOKEN is what keeps it from being a public "kick everyone"
    // button. None (unset) means the route always 403s.
    pub admin_token: Option<String>,
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
        admin_token: std::env::var("ADMIN_TOKEN").ok().filter(|s| !s.is_empty()),
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
