// Plain data structs + small free functions shared across the state/sim
// layer. No behavior lives here beyond trivial constructors/lookups; see
// snake.rs/conn.rs/game/ for the entities that own logic.
use crate::powerups::PowerupType;
use rand::Rng;
use serde::Serialize;

// `struct` bundling named fields, with `#[derive(...)]` auto-generating
// common trait impls (Clone, comparisons, debug-printing, JSON) above it --
// see "struct/enum" and "derive" in docs/RUST-CHEATSHEET.md.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Debug)]
pub struct Cell {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy)]
pub struct Input {
    pub x: i32,
    pub y: i32,
    // Option<T>: "maybe present, maybe not" -- see RUST-CHEATSHEET.md.
    pub seq: Option<i64>,
    // Boost ramp progress (0..1) at keypress time; 0 = no drift.
    pub drift: f64,
}

#[derive(Clone, Copy)]
pub struct ActivePowerup {
    pub ptype: PowerupType,
    pub start_tick: i64,
    pub expires_at_tick: i64,
}

// `enum`: exactly one of these named variants at a time (here, no variant
// carries extra data -- see WsOut below for one that does).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Player,
    Spectator,
}

#[derive(Clone)]
pub struct LocalSeat {
    pub role: Role,
    pub slot_index: Option<usize>,
}

// Food-rate accumulator (v3.7.0), one per local seat per connection.
#[derive(Clone, Default)]
pub struct FoodRateAcc {
    pub cur_food: i64,
    pub cur_play_ms: f64,
    pub closed_count: i64,
    // Vec<T>: growable array -- see RUST-CHEATSHEET.md. Ascending-sorted
    // running top-K here.
    pub top_buckets: Vec<i64>,
    pub top_sum: i64,
    pub cached_rate: f64,
    pub locked: bool,
}

// What the writer task can be asked to send. Unlike Role above, these
// variants carry data per-variant (Text holds a String).
pub enum WsOut {
    Text(String),
    Ping,
    Close,
}

pub struct QueueEntry {
    pub conn_id: String,
    pub local: usize,
    pub since: i64,
}

pub struct JoinOffer {
    pub conn_id: String,
    pub local: usize,
    pub expires_at: i64,
}

#[derive(Clone, Copy)]
pub struct Food {
    pub x: i32,
    pub y: i32,
    pub bounty: bool,
    pub expires_at_tick: i64, // only meaningful when bounty
}

pub struct Pickup {
    pub id: i64,
    pub ptype: PowerupType,
    pub x: i32,
    pub y: i32,
}

pub struct Trail {
    pub id: i64,
    pub ptype: PowerupType,
    pub x: i32,
    pub y: i32,
    pub owner_slot: usize,
    pub expires_at_tick: i64,
}

pub struct BlueShell {
    pub id: i64,
    pub x: i32,
    pub y: i32,
    pub owner_slot: usize,
    pub move_accum_ms: f64,
    pub step_axis_x: bool, // JS stepAxis "x"/"y" alternator
}

#[derive(Clone, Copy, Serialize)]
pub struct Explosion {
    pub x: i32,
    pub y: i32,
    // Negative radius flags the client's pinata candy burst (vs a blue-shell
    // ring).
    pub radius: i32,
}

pub struct Wall {
    pub id: i64,
    pub x: i32,
    pub y: i32,
    pub telegraph_until: i64,
    pub solid_until: i64,
}

// One-shot fx (v4.5.0 scissors): a dynamic wall shattered by a
// scissors-armed snake running into it. Same lifecycle as Explosion --
// pushed during the sim tick, serialized once, cleared right after.
#[derive(Clone, Copy, Serialize)]
pub struct WallShatterFx {
    pub x: i32,
    pub y: i32,
}

// Wormhole portal visual (2026-07-20 rework): a purple portal marker at
// the entry and exit cells of a fired wormhole. Gameplay-inert -- pure
// render metadata. Portals stay up while their owner's tail is still
// threading through (teleport_drain > 0); once the drain finishes (or the
// owner dies/despawns) expires_ms is stamped and the portal lingers
// briefly so the closing reads on screen, then sweep_portal_fx drops it.
pub struct PortalFx {
    pub id: i64, // seeds the client-side pulse phase, like wall/pickup ids
    pub x: i32,
    pub y: i32,
    pub owner_slot: usize,
    pub expires_ms: Option<i64>, // None while the owner is still draining
}

pub struct KillEvent {
    pub victim: String,
    pub victim_color: Option<usize>,
    pub killer: Option<String>,
    pub killer_color: Option<usize>,
    // &'static str: lives for the whole program (a literal), never freed --
    // see RUST-CHEATSHEET.md.
    pub cause: &'static str,
    pub rivalry_count: Option<i64>,
}

// Perf counters (SNAKE_PERF): nanoseconds + counts, printed/reset by the
// 5s summary task in main.rs.
#[derive(Default)]
pub struct PerfCounters {
    pub mv_ns: u128,
    pub mv_calls: u64,
    pub mv_max_ns: u128,
    pub bc_ns: u128,
    pub bc_calls: u64,
    pub bc_max_ns: u128,
    pub bytes_base: u64,
    pub bytes_total: u64,
    pub sends: u64,
}

pub fn dir_vector(name: &str) -> Option<Cell> {
    // match: pattern-matching switch, every case covered (see the `_`
    // catch-all below) -- see RUST-CHEATSHEET.md.
    match name {
        "up" => Some(Cell { x: 0, y: -1 }),
        "down" => Some(Cell { x: 0, y: 1 }),
        "left" => Some(Cell { x: -1, y: 0 }),
        "right" => Some(Cell { x: 1, y: 0 }),
        _ => None,
    }
}

pub(crate) fn rand_below(n: i32) -> i32 {
    // .max(1): random_range panics on an empty 0..0 range, so a zero/negative
    // n is clamped up to 0..1 (always returns 0) instead of crashing.
    rand::rng().random_range(0..n.max(1))
}

// hitsBody: does h land on any segment of body except (optionally) the
// tail? Free function so callers can borrow one snake while scanning
// another's body.
// body: &[Cell] borrows a slice (view into a Vec, no ownership taken) --
// see "Slices" and "References" in RUST-CHEATSHEET.md.
pub fn hits_body(body: &[Cell], h: Cell, skip_tail: bool) -> bool {
    let end = if skip_tail { body.len().saturating_sub(1) } else { body.len() };
    // .any(|c| ...) takes a closure (inline anonymous function) -- see
    // "Closures" in RUST-CHEATSHEET.md.
    body[..end].iter().any(|c| c.x == h.x && c.y == h.y)
}
