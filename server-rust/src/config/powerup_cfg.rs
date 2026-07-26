// Per-powerup tuning for the remaining powerups (trails, speed boost, blue
// shell, banana trail, helloWorld, scissors) plus the aggregate PowerupsCfg
// that bundles all powerup sub-configs (including wormhole/growthSpurt from
// movement.rs) and the lookup helpers sim.rs calls per-type.
// `use` brings names from other files in this crate into scope -- see
// "Modules" in docs/RUST-CHEATSHEET.md. `super::` means "the parent module"
// (config/mod.rs), which re-exports movement's types.
use super::movement::{GrowthSpurtCfg, WormholeCfg};
use serde::{Deserialize, Serialize};

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

// The aggregate config bundling every powerup's own sub-config (this is the
// struct sim.rs and routes.rs actually hold onto -- Config.powerups).
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
    // &self borrows the PowerupsCfg without taking ownership (see
    // docs/RUST-CHEATSHEET.md). `use ...::*;` pulls every enum variant into
    // scope so the match arms below can say `Wormhole` instead of the full
    // `PowerupType::Wormhole` -- see "Glob imports" in the cheatsheet.
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
