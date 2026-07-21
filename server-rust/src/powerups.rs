// ============================================================
// Powerup registry: the Rust port of powerups/*.js. Each JS module became
// a match arm here; titles/descriptions are copied verbatim so the client
// info popup text is identical. ORDER IS LOAD-BEARING: POWERUP_TYPES index
// order must match the renderers' color tables (render.js
// POWERUP_TYPE_INDEX, render2d.js POWERUP_STYLE, wasm pickupColor/
// trailColor). New types are always APPENDED.
// ============================================================
use crate::config::{Grid, PowerupsCfg};
use crate::state::{Cell, Snake};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PowerupType {
    Wormhole,
    GrowthSpurt,
    IceTrail,
    PoisonTrail,
    SpeedBoost,
    BlueShell,
    BananaTrail,
    HelloWorld,
}

pub const POWERUP_TYPES: [PowerupType; 8] = [
    PowerupType::Wormhole,
    PowerupType::GrowthSpurt,
    PowerupType::IceTrail,
    PowerupType::PoisonTrail,
    PowerupType::SpeedBoost,
    PowerupType::BlueShell,
    PowerupType::BananaTrail,
    PowerupType::HelloWorld,
];

impl PowerupType {
    pub fn as_str(self) -> &'static str {
        match self {
            PowerupType::Wormhole => "wormhole",
            PowerupType::GrowthSpurt => "growthSpurt",
            PowerupType::IceTrail => "iceTrail",
            PowerupType::PoisonTrail => "poisonTrail",
            PowerupType::SpeedBoost => "speedBoost",
            PowerupType::BlueShell => "blueShell",
            PowerupType::BananaTrail => "bananaTrail",
            PowerupType::HelloWorld => "helloWorld",
        }
    }
    pub fn from_str(s: &str) -> Option<PowerupType> {
        POWERUP_TYPES.iter().copied().find(|t| t.as_str() == s)
    }
    // Which powerups wait in the held slot for the activate button (JS:
    // requiresActivation). Only speedBoost, by maintainer decision 2026-07-16.
    pub fn requires_activation(self) -> bool {
        matches!(self, PowerupType::SpeedBoost)
    }
    // Trail-laying powerups: while one is the activePowerup, each movement
    // step lays a tile of that type at the vacated cell.
    pub fn is_trail(self) -> bool {
        matches!(
            self,
            PowerupType::IceTrail | PowerupType::PoisonTrail | PowerupType::BananaTrail
        )
    }
    // Modules exposing a speedMultiplier hook (JS: SPEED_MULT_TYPES).
    pub fn has_speed_multiplier(self) -> bool {
        matches!(
            self,
            PowerupType::IceTrail | PowerupType::SpeedBoost | PowerupType::HelloWorld
        )
    }
    pub fn title(self) -> &'static str {
        match self {
            PowerupType::Wormhole => "Wormhole",
            PowerupType::GrowthSpurt => "Growth Spurt",
            PowerupType::IceTrail => "Ice Trail",
            PowerupType::PoisonTrail => "Poison Trail",
            PowerupType::SpeedBoost => "Speed Boost",
            PowerupType::BlueShell => "Blue Shell",
            PowerupType::BananaTrail => "Banana Trail",
            PowerupType::HelloWorld => "Hello World",
        }
    }
    pub fn description(self) -> &'static str {
        match self {
            PowerupType::Wormhole => {
                "You do not use a button for this one. It waits, held in reserve. The moment \
                 a move would kill you, it fires on its own -- teleporting you to the nearest safe spot, \
                 or clear across the board, whichever is safer. One-time use, then it is gone."
            }
            PowerupType::GrowthSpurt => {
                "For a short time, food makes you grow twice as much, and killing another \
                 snake gives you extra length too. Good for getting big fast."
            }
            PowerupType::IceTrail => {
                "While active, you leave a trail of ice behind you. Any snake that crosses \
                 it (even you) slows down more each time, but never stops completely."
            }
            PowerupType::PoisonTrail => {
                "While active, you leave a poison trail behind you. Any snake that crosses \
                 it (even you) loses one segment, down to a safe minimum length."
            }
            PowerupType::SpeedBoost => {
                "Press your activate key to move faster for a short time. Works together with \
                 holding the boost key, so both speed-ups add up."
            }
            PowerupType::BlueShell => {
                "Fires the moment you grab it, at whoever has the longest snake right now -- \
                 even if that is you. It flies through every other snake with no effect. When it hits \
                 the leader, they lose about a third of their length, and it explodes -- everyone else \
                 nearby loses a little too. If you are the only player, it just grows you by one instead."
            }
            PowerupType::BananaTrail => {
                "Fires the moment you grab it: you leave banana peels behind you for a while. \
                 Any snake that slips on one (even you) gets its controls REVERSED for a few seconds -- \
                 left is right, up is down. Pressing straight ahead does nothing while slipping."
            }
            PowerupType::HelloWorld => {
                "A tiny demo powerup for developers: it says hello in the server log and \
                 makes you 2% faster for one second. Off by default."
            }
        }
    }
}

// The per-snake speed multiplier for one hook-bearing type (JS: each
// module's speedMultiplier). Multiplied into the movement accumulator and
// the broadcast moveMs.
pub fn speed_multiplier(t: PowerupType, s: &Snake, pw: &PowerupsCfg) -> f64 {
    match t {
        PowerupType::IceTrail => {
            if s.ice_stacks == 0 {
                1.0
            } else {
                (1.0 - s.ice_stacks as f64 * pw.ice_trail.slow_multiplier_per_stack)
                    .max(pw.ice_trail.min_speed_multiplier)
            }
        }
        PowerupType::SpeedBoost => {
            if s.active_powerup_is(PowerupType::SpeedBoost) {
                pw.speed_boost.speed_mult
            } else {
                1.0
            }
        }
        PowerupType::HelloWorld => {
            if s.active_powerup_is(PowerupType::HelloWorld) {
                pw.hello_world.speed_mult
            } else {
                1.0
            }
        }
        _ => 1.0,
    }
}

// growthSpurt module hooks (pure readers over activePowerup).
pub fn food_growth_multiplier(s: &Snake, pw: &PowerupsCfg) -> i64 {
    if s.active_powerup_is(PowerupType::GrowthSpurt) {
        pw.growth_spurt.food_multiplier
    } else {
        1
    }
}
pub fn kill_bonus_growth_bonus(s: &Snake, pw: &PowerupsCfg) -> i64 {
    if s.active_powerup_is(PowerupType::GrowthSpurt) {
        pw.growth_spurt.kill_bonus_growth
    } else {
        0
    }
}

// blueShell module: how many segments a snake of body_length loses at
// `percent`, floored so it never goes below `floor` segments.
pub fn segments_lost(body_length: usize, percent: f64, floor: usize) -> usize {
    let by_percent = (body_length as f64 * percent).floor() as i64;
    let room = body_length as i64 - floor as i64;
    by_percent.min(room).max(0) as usize
}

// ---------------------------------------------------------------
// Wormhole landing algorithm (port of powerups/wormhole.js). Pure: reads
// the board, returns the chosen landing or None.
// ---------------------------------------------------------------
pub struct WormholeResult {
    pub dir: Cell,
    pub landing: Cell,
}

const CARDINAL_DIRS: [Cell; 4] = [
    Cell { x: 1, y: 0 },
    Cell { x: -1, y: 0 },
    Cell { x: 0, y: 1 },
    Cell { x: 0, y: -1 },
];

fn is_cell_safe(x: i32, y: i32, grid: &Grid, slots: &[Option<Snake>], ignore: usize) -> bool {
    if x < 0 || x >= grid.cols || y < 0 || y >= grid.rows {
        return false;
    }
    for (k, other) in slots.iter().enumerate() {
        let Some(other) = other else { continue };
        if k == ignore {
            continue;
        }
        if other.body.iter().any(|seg| seg.x == x && seg.y == y) {
            return false;
        }
    }
    true
}

// From the fatal head cell, scan a shallow lookahead in every cardinal
// direction (reversing included -- an emergency rescue may need it), score
// each by consecutive safe cells, and also consider teleporting to the
// board cell reflected through the center. Highest score wins; landing is
// the FIRST safe cell along the winning path.
pub fn attempt_wormhole(
    slot_index: usize,
    own_dir: Cell,
    fatal_head: Cell,
    slots: &[Option<Snake>],
    grid: &Grid,
    lookahead_depth: i32,
) -> Option<WormholeResult> {
    let mut best: Option<(Cell, Cell, i32)> = None; // (dir, landing, score)
    for dir in CARDINAL_DIRS {
        let mut x = fatal_head.x;
        let mut y = fatal_head.y;
        let mut score = 0;
        let mut landing: Option<Cell> = None;
        for _ in 0..lookahead_depth {
            x += dir.x;
            y += dir.y;
            if !is_cell_safe(x, y, grid, slots, slot_index) {
                break;
            }
            score += 1;
            if landing.is_none() {
                landing = Some(Cell { x, y });
            }
        }
        if let Some(l) = landing {
            if best.map_or(true, |b| score > b.2) {
                best = Some((dir, l, score));
            }
        }
    }
    let opp_x = grid.cols - 1 - fatal_head.x;
    let opp_y = grid.rows - 1 - fatal_head.y;
    if is_cell_safe(opp_x, opp_y, grid, slots, slot_index) {
        let mut score = 0;
        let mut x = opp_x;
        let mut y = opp_y;
        for _ in 0..lookahead_depth {
            if !is_cell_safe(x + own_dir.x, y + own_dir.y, grid, slots, slot_index) {
                break;
            }
            x += own_dir.x;
            y += own_dir.y;
            score += 1;
        }
        if best.map_or(true, |b| score > b.2) {
            best = Some((own_dir, Cell { x: opp_x, y: opp_y }, score));
        }
    }
    best.map(|(dir, landing, _)| WormholeResult { dir, landing })
}
