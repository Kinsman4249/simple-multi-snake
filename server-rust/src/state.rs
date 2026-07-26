// ============================================================
// Shared mutable game state + board/snake primitives. Port of
// server/state.js: the JS single `S` object became the `Game` struct; the
// module functions became methods. Everything that mutates the game locks
// the one Mutex<Game> in main.rs, which preserves the JS single-threaded
// semantics exactly.
// ============================================================
use crate::config::{now_ms, Config, ForcedSpawn};
use crate::highscores::HighScores;
use crate::powerups::PowerupType;
use rand::Rng;
use serde::Serialize;
use std::collections::HashMap;
use tokio::sync::mpsc::UnboundedSender;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Debug)]
pub struct Cell {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy)]
pub struct Input {
    pub x: i32,
    pub y: i32,
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

// One player slot (JS: the object newPlayerSlot builds).
pub struct Snake {
    pub conn_id: String,
    // Index into config::COLORS; None for slots past the palette (matches
    // the JS COLORS[freeIndex] being undefined for slot 4+).
    pub color: Option<usize>,
    pub body: Vec<Cell>,
    pub dir: Cell,
    pub input_queue: Vec<Input>,
    pub alive: bool,
    pub score: i64,
    pub wall_stalls: i32,
    pub last_ack: i64,
    pub boost: bool,
    pub boost_since: Option<i64>,
    pub ramp_progress: f64,
    pub move_accum_ms: f64,
    pub last_input_at: i64,
    pub held_powerup: Option<PowerupType>,
    pub wormhole_charge: bool,
    pub scissors_charge: bool,
    pub active_powerup: Option<ActivePowerup>,
    pub activated_fx: Option<PowerupType>,
    pub ice_stacks: i32,
    pub ice_expires_at_tick: i64,
    pub teleported_this_tick: bool,
    pub teleport_drain: usize,
    pub drift_dir: Option<Cell>,
    pub drift_until_ms: i64,
    pub invert_until_tick: i64,
    pub last_trail_cell: Option<Cell>,
    // Death-respawn timer (JS used a setTimeout; here the sim loop checks
    // this deadline every tick -- 16ms granularity vs. an exact timer, which
    // nothing observable depends on).
    pub respawn_at: Option<i64>,
}

impl Snake {
    pub fn new(conn_id: String, color: Option<usize>) -> Snake {
        Snake {
            conn_id,
            color,
            body: Vec::new(),
            dir: Cell { x: 1, y: 0 },
            input_queue: Vec::new(),
            alive: true,
            score: 0,
            wall_stalls: 0,
            last_ack: 0,
            boost: false,
            boost_since: None,
            ramp_progress: 0.0,
            move_accum_ms: 0.0,
            last_input_at: now_ms(),
            held_powerup: None,
            wormhole_charge: false,
            scissors_charge: false,
            active_powerup: None,
            activated_fx: None,
            ice_stacks: 0,
            ice_expires_at_tick: 0,
            teleported_this_tick: false,
            teleport_drain: 0,
            drift_dir: None,
            drift_until_ms: 0,
            invert_until_tick: 0,
            last_trail_cell: None,
            respawn_at: None,
        }
    }
    pub fn active_powerup_is(&self, t: PowerupType) -> bool {
        self.active_powerup.map_or(false, |a| a.ptype == t)
    }
    pub fn head(&self) -> Cell {
        self.body[0]
    }
}

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
    pub top_buckets: Vec<i64>, // ascending-sorted running top-K
    pub top_sum: i64,
    pub cached_rate: f64,
    pub locked: bool,
}

// What the writer task can be asked to send.
pub enum WsOut {
    Text(String),
    Ping,
    Close,
}

pub struct Conn {
    pub tx: UnboundedSender<WsOut>,
    // Indexed by local seat; None = a hole left by a leave (rejoin fills it).
    pub locals: Vec<Option<LocalSeat>>,
    pub initials: Vec<Option<String>>,
    pub food_rate: Vec<Option<FoodRateAcc>>,
}

impl Conn {
    // JS conn.locals[i] tolerates out-of-range reads; helpers to match.
    pub fn local(&self, i: usize) -> Option<&LocalSeat> {
        self.locals.get(i).and_then(|l| l.as_ref())
    }
    pub fn set_local(&mut self, i: usize, seat: Option<LocalSeat>) {
        if self.locals.len() <= i {
            self.locals.resize(i + 1, None);
        }
        self.locals[i] = seat;
    }
    pub fn set_initials(&mut self, i: usize, v: String) {
        if self.initials.len() <= i {
            self.initials.resize(i + 1, None);
        }
        self.initials[i] = Some(v);
    }
    pub fn initials_for(&self, i: usize) -> &str {
        self.initials
            .get(i)
            .and_then(|s| s.as_deref())
            .unwrap_or("???")
    }
    pub fn any_seat_left(&self) -> bool {
        self.locals.iter().any(|l| l.is_some())
    }
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
    pub cause: &'static str,
    pub rivalry_count: Option<i64>,
}

pub struct Game {
    pub cfg: &'static Config,
    pub slots: Vec<Option<Snake>>,
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
    pub blue_shells: Vec<BlueShell>,
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

// Safe-spawn tuning (v3.6.2), same constants as state.js.
const SPAWN_WALL_MARGIN: i32 = 4;
const SPAWN_CLEARANCE: i32 = 2;

pub fn dir_vector(name: &str) -> Option<Cell> {
    match name {
        "up" => Some(Cell { x: 0, y: -1 }),
        "down" => Some(Cell { x: 0, y: 1 }),
        "left" => Some(Cell { x: -1, y: 0 }),
        "right" => Some(Cell { x: 1, y: 0 }),
        _ => None,
    }
}

fn rand_below(n: i32) -> i32 {
    rand::rng().random_range(0..n.max(1))
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

    pub fn cell_free(&self, x: i32, y: i32, ignore_slot: Option<usize>) -> bool {
        for (i, s) in self.slots.iter().enumerate() {
            let Some(s) = s else { continue };
            if Some(i) == ignore_slot {
                continue;
            }
            if s.body.iter().any(|seg| seg.x == x && seg.y == y) {
                return false;
            }
        }
        true
    }

    // Cell already taken by food, a pickup, or an obstacle wall (any display
    // state)?
    pub fn cell_has_entity(&self, x: i32, y: i32) -> bool {
        self.foods.iter().any(|f| f.x == x && f.y == y)
            || self.powerup_pickups.iter().any(|p| p.x == x && p.y == y)
            || self.walls.iter().any(|w| w.x == x && w.y == y)
    }

    // True while (x,y) is an ACTIVE (past telegraph, not yet despawned) wall.
    pub fn is_solid_wall_cell(&self, x: i32, y: i32, now: i64) -> bool {
        self.walls
            .iter()
            .any(|w| w.x == x && w.y == y && now >= w.telegraph_until && now < w.solid_until)
    }

    // Place ONE food (uniform rejection sampling, rubberband bias toward the
    // trailing snake). Returns false if the board is full.
    pub fn place_one_food(&mut self) -> bool {
        let fb = &self.cfg.rubberband.food_bias;
        let mut target: Option<Cell> = None;
        if fb.enabled {
            if let (Some(ti), Some(li)) = (self.current_trailing_index(), self.current_leader_index()) {
                if ti != li {
                    let (tl, ll) = (
                        self.slots[ti].as_ref().unwrap().body.len(),
                        self.slots[li].as_ref().unwrap().body.len(),
                    );
                    if ll > tl {
                        target = Some(self.slots[ti].as_ref().unwrap().head());
                    }
                }
            }
        }
        let mut chosen: Option<Cell> = None;
        let mut fallback: Option<Cell> = None;
        let mut rng = rand::rng();
        for attempts in 0..500 {
            let x = rng.random_range(0..self.cfg.grid.cols);
            let y = rng.random_range(0..self.cfg.grid.rows);
            if !self.cell_free(x, y, None) || self.cell_has_entity(x, y) {
                continue;
            }
            if fallback.is_none() {
                fallback = Some(Cell { x, y });
            }
            match target {
                Some(t) if attempts < 300 => {
                    let d = (x - t.x).abs().max((y - t.y).abs());
                    if d <= fb.radius || rng.random::<f64>() < 1.0 / fb.strength {
                        chosen = Some(Cell { x, y });
                        break;
                    }
                }
                _ => {
                    chosen = Some(Cell { x, y });
                    break;
                }
            }
        }
        let mut chosen = chosen.or(fallback);
        if chosen.is_none() {
            // Sampling never found a free cell: linear scan (near-full board).
            'outer: for y in 0..self.cfg.grid.rows {
                for x in 0..self.cfg.grid.cols {
                    if self.cell_free(x, y, None) && !self.cell_has_entity(x, y) {
                        chosen = Some(Cell { x, y });
                        break 'outer;
                    }
                }
            }
        }
        if let Some(c) = chosen {
            self.foods.push(Food { x: c.x, y: c.y, bounty: false, expires_at_tick: 0 });
            true
        } else {
            false
        }
    }

    // Players currently ON THE BOARD (occupied slots, alive or respawning).
    pub fn board_player_count(&self) -> usize {
        self.slots.iter().filter(|s| s.is_some()).count()
    }
    pub fn target_food_count(&self) -> usize {
        let n = self.board_player_count();
        if n == 0 {
            0
        } else {
            ((n + 1) / 2).min(self.cfg.max_food)
        }
    }
    pub fn pickup_cap(&self) -> usize {
        let n = self.board_player_count();
        if n == 0 {
            0
        } else {
            ((n + 3) / 4).max(1).min(self.cfg.powerups.max_concurrent_pickups)
        }
    }

    // Bring the active (non-bounty) food count to the player-scaled target.
    pub fn ensure_foods(&mut self) {
        let target = self.target_food_count();
        let mut normal = self.foods.iter().filter(|f| !f.bounty).count();
        if normal > target {
            let mut remove = normal - target;
            self.foods.retain(|f| {
                if f.bounty {
                    return true;
                }
                if remove > 0 {
                    remove -= 1;
                    false
                } else {
                    true
                }
            });
            normal = target;
        }
        while normal < target {
            if !self.place_one_food() {
                break; // board full: stop trying this tick
            }
            normal += 1;
        }
    }

    // Living slots other than `exclude`, sorted by body length ascending,
    // truncated to the ceil(playerCount/2) "lowest scoring players" group
    // (v4.5.0 generalization of the old single-trailing-snake bias -- with
    // more players seated, more of the trailing pack shares in the bounty).
    pub fn lowest_scoring_targets(&self, exclude: usize) -> Vec<usize> {
        let mut living: Vec<usize> = self
            .slots
            .iter()
            .enumerate()
            .filter(|(i, s)| *i != exclude && matches!(s, Some(sn) if sn.alive))
            .map(|(i, _)| i)
            .collect();
        living.sort_by_key(|&i| self.slots[i].as_ref().unwrap().body.len());
        let group_size = ((self.player_seat_count() as f64 / 2.0).ceil() as usize)
            .max(1)
            .min(living.len());
        living.truncate(group_size);
        living
    }

    // Shared pinata scatter math (v3.6.6, generalized v4.5.0): scatters
    // short-TTL candy around `anchor`, biased toward a random member of the
    // lowest-scoring-players group (not always the single shortest), and
    // queues the candy-burst explosion. `size_basis` drives both the candy
    // count and how far the burst spreads -- a bigger snake/cut-off tail
    // pops wider, pinata-style.
    fn scatter_bounty(&mut self, exclude: usize, anchor: Cell, size_basis: usize) {
        let p = &self.cfg.pinata;
        if !p.enabled || size_basis < p.min_length || self.player_seat_count() < 2 {
            return;
        }
        let count = p
            .max_food
            .min(((size_basis as f64 * p.percent).round() as usize).max(1));
        let spread = p.spread
            + ((size_basis.saturating_sub(p.min_length)) as f64 * p.size_scale).round() as i32;
        let ttl_ticks = ((p.ttl_ms / self.current_move_interval_ms()).ceil() as i64).max(1);
        let expires_at_tick = self.move_seq + ttl_ticks;
        let cols = self.cfg.grid.cols;
        let rows = self.cfg.grid.rows;
        // Bias targets: living snakes shorter than the source, drawn from the
        // lowest-scoring group -- each candy independently rolls whether to
        // nudge toward a (uniformly random) member of that group.
        let targets: Vec<Cell> = self
            .lowest_scoring_targets(exclude)
            .into_iter()
            .filter(|&i| self.slots[i].as_ref().map_or(false, |t| t.body.len() < size_basis))
            .map(|i| self.slots[i].as_ref().unwrap().head())
            .collect();
        let bias_p = p.bias;
        let mut placed: Vec<Cell> = Vec::new();
        let mut rng = rand::rng();
        for _ in 0..count {
            let (mut cx, mut cy) = (anchor.x, anchor.y);
            if !targets.is_empty() && rng.random::<f64>() < bias_p {
                let b = targets[rand_below(targets.len() as i32) as usize];
                cx = (cx as f64 + (b.x - cx) as f64 * 0.5).round() as i32;
                cy = (cy as f64 + (b.y - cy) as f64 * 0.5).round() as i32;
            }
            for _ in 0..12 {
                let jitter = |rng: &mut rand::rngs::ThreadRng| {
                    ((rng.random::<f64>() * 2.0 - 1.0) * spread as f64).round() as i32
                };
                let x = (cx + jitter(&mut rng)).clamp(0, cols - 1);
                let y = (cy + jitter(&mut rng)).clamp(0, rows - 1);
                if placed.iter().any(|c| c.x == x && c.y == y) || self.cell_has_entity(x, y) {
                    continue; // one candy per cell, no stacking on existing entities
                }
                placed.push(Cell { x, y });
                self.foods.push(Food { x, y, bounty: true, expires_at_tick });
                break;
            }
        }
        if !placed.is_empty() {
            self.explosions.push(Explosion { x: anchor.x, y: anchor.y, radius: -spread });
        }
    }

    // "Pinata" bounty burst (v3.6.6) for a dead snake's body (read before
    // clearing).
    pub fn drop_pinata_food(&mut self, dead_slot: usize) {
        let Some(s) = self.slots[dead_slot].as_ref() else { return };
        let body_len = s.body.len();
        let mid = s.body[body_len / 2];
        self.scatter_bounty(dead_slot, mid, body_len);
    }

    // Scissors tail-cut bounty (v4.5.0): the severed segments of a self-cut
    // or opponent-cut scatter the same way a corpse does, sized off the
    // ORIGINAL (pre-cut) body length so a bigger snake's cut still sprays
    // wide even though only the tail portion is actually being converted.
    pub fn drop_scissors_food(&mut self, exclude: usize, severed: &[Cell], original_len: usize) {
        if severed.is_empty() {
            return;
        }
        let mid = severed[severed.len() / 2];
        self.scatter_bounty(exclude, mid, original_len);
    }

    // Clear and refill food (the placeFood test hook).
    pub fn reroll_foods(&mut self) {
        self.foods.clear();
        self.ensure_foods();
    }

    // True when a snake of `len` at (hx,hy) heading `dir` fits with
    // `wall_margin` from every edge and a `clearance` halo free of other
    // snakes (and never on/under an obstacle wall).
    fn spawn_area_clear(
        &self,
        hx: i32,
        hy: i32,
        dir: Cell,
        len: usize,
        slot_index: usize,
        clearance: i32,
        wall_margin: i32,
    ) -> bool {
        for n in 0..len as i32 {
            let bx = hx - dir.x * n;
            let by = hy - dir.y * n;
            if bx < wall_margin
                || bx >= self.cfg.grid.cols - wall_margin
                || by < wall_margin
                || by >= self.cfg.grid.rows - wall_margin
            {
                return false;
            }
            if self.walls.iter().any(|w| w.x == bx && w.y == by) {
                return false;
            }
            for ox in -clearance..=clearance {
                for oy in -clearance..=clearance {
                    if !self.cell_free(bx + ox, by + oy, Some(slot_index)) {
                        return false;
                    }
                }
            }
        }
        true
    }

    pub fn spawn_snake(&mut self, slot_index: usize) {
        let mut len = self.cfg.min_snake_length;
        let x;
        let y;
        let mut dir = Cell { x: 1, y: 0 };
        let forced: Option<ForcedSpawn> = self
            .cfg
            .test_spawns
            .as_ref()
            .and_then(|v| v.get(slot_index).cloned().flatten());
        if let Some(f) = forced {
            x = f.x;
            y = f.y;
            if let Some(d) = f.dir.as_deref().and_then(dir_vector) {
                dir = d;
            }
            if let Some(l) = f.len {
                if l >= self.cfg.min_snake_length {
                    len = l;
                }
            }
        } else {
            // Safe random spawn (v3.6.2): clearance halo + wall margin +
            // center-ward heading; margins shrink on tiny boards; bounded
            // attempts with graceful fallback.
            let cols = self.cfg.grid.cols;
            let rows = self.cfg.grid.rows;
            let wall_margin = SPAWN_WALL_MARGIN.min(cols.min(rows) / 4).max(1);
            let mut chosen: Option<(i32, i32, Cell)> = None;
            let mut body_free: Option<(i32, i32, Cell)> = None;
            let mut any_candidate: Option<(i32, i32, Cell)> = None;
            for _ in 0..200 {
                if chosen.is_some() {
                    break;
                }
                let hx = wall_margin + len as i32 + rand_below((cols - 2 * (wall_margin + len as i32)).max(1));
                let hy = wall_margin + rand_below((rows - 2 * wall_margin).max(1));
                let d = if hx < cols / 2 { Cell { x: 1, y: 0 } } else { Cell { x: -1, y: 0 } };
                any_candidate = Some((hx, hy, d));
                if self.spawn_area_clear(hx, hy, d, len, slot_index, SPAWN_CLEARANCE, wall_margin) {
                    chosen = Some((hx, hy, d));
                } else if body_free.is_none()
                    && self.spawn_area_clear(hx, hy, d, len, slot_index, 0, wall_margin)
                {
                    body_free = Some((hx, hy, d));
                }
            }
            let pick = chosen
                .or(body_free)
                .or(any_candidate)
                .unwrap_or((cols / 2, rows / 2, Cell { x: 1, y: 0 }));
            x = pick.0;
            y = pick.1;
            dir = pick.2;
        }
        let s = self.slots[slot_index].as_mut().expect("spawn into empty slot");
        s.body.clear();
        for n in 0..len as i32 {
            s.body.push(Cell { x: x - dir.x * n, y: y - dir.y * n });
        }
        s.dir = dir;
        s.input_queue.clear();
        s.alive = true;
        s.wall_stalls = 0;
        s.score = 0;
        s.last_ack = 0;
        s.boost = false;
        s.boost_since = None;
        s.ramp_progress = 0.0;
        s.move_accum_ms = 0.0;
        // NOTE: last_input_at deliberately NOT reset (respawns must not feed
        // the idle clock; see the JS comment). Powerup state DOES reset every
        // (re)spawn -- a run is a clean slate.
        s.held_powerup = None;
        s.wormhole_charge = false;
        s.scissors_charge = false;
        s.active_powerup = None;
        s.activated_fx = None;
        s.ice_stacks = 0;
        s.ice_expires_at_tick = 0;
        s.teleported_this_tick = false;
        s.teleport_drain = 0;
        s.drift_dir = None;
        s.drift_until_ms = 0;
        s.invert_until_tick = 0;
        s.last_trail_cell = None;
        s.respawn_at = None;
    }

    // Banana-trail control inversion status (sim-clock based).
    pub fn is_inverted(&self, s: &Snake) -> bool {
        self.move_seq < s.invert_until_tick
    }

    // Shared floor-respecting shrink (poison pop / blue-shell damage).
    pub fn remove_segments(s: &mut Snake, count: usize, min_len: usize) {
        let n = count.min(s.body.len().saturating_sub(min_len));
        for _ in 0..n {
            s.body.pop();
        }
    }

    // Living snake with the most segments (ties: lowest slot index).
    pub fn current_leader_index(&self) -> Option<usize> {
        let mut best: Option<(usize, usize)> = None;
        for (i, s) in self.slots.iter().enumerate() {
            let Some(s) = s else { continue };
            if !s.alive {
                continue;
            }
            if best.map_or(true, |(_, l)| s.body.len() > l) {
                best = Some((i, s.body.len()));
            }
        }
        best.map(|(i, _)| i)
    }
    // Living snake with the FEWEST segments (same tie rule).
    pub fn current_trailing_index(&self) -> Option<usize> {
        let mut worst: Option<(usize, usize)> = None;
        for (i, s) in self.slots.iter().enumerate() {
            let Some(s) = s else { continue };
            if !s.alive {
                continue;
            }
            if worst.map_or(true, |(_, l)| s.body.len() < l) {
                worst = Some((i, s.body.len()));
            }
        }
        worst.map(|(i, _)| i)
    }

    // Connected PEOPLE still in the game: seats in role player (alive or
    // dead-awaiting-respawn). The blue-shell presence gate.
    pub fn player_seat_count(&self) -> usize {
        self.connections
            .values()
            .map(|c| c.locals.iter().filter(|l| matches!(l, Some(seat) if seat.role == Role::Player)).count())
            .sum()
    }

    // A slot's session-bound initials ("???" fallback).
    pub fn initials_for_slot(&self, slot_index: usize) -> String {
        let Some(Some(s)) = self.slots.get(slot_index) else { return "???".into() };
        let Some(conn) = self.connections.get(&s.conn_id) else { return "???".into() };
        match self.local_index_for_slot(conn, slot_index) {
            Some(li) => conn.initials_for(li).to_string(),
            None => "???".into(),
        }
    }

    pub fn local_index_for_slot(&self, conn: &Conn, slot_index: usize) -> Option<usize> {
        conn.locals.iter().position(|l| {
            matches!(l, Some(seat) if seat.role == Role::Player && seat.slot_index == Some(slot_index))
        })
    }

    // Kill feed rivalry tally (in-memory, keyed on displayed initials).
    pub fn bump_rivalry(&mut self, killer: &str, victim: &str) -> i64 {
        let key = format!("{}>{}", killer, victim);
        let count = self.rivalries.get(&key).copied().unwrap_or(0) + 1;
        self.rivalries.insert(key, count);
        count
    }

    // Blue-shell equal-length gate: >= 2 living snakes, all the same length.
    pub fn all_equal_length(&self) -> bool {
        let mut first: Option<usize> = None;
        let mut count = 0;
        for s in self.slots.iter().flatten() {
            if !s.alive {
                continue;
            }
            count += 1;
            match first {
                None => first = Some(s.body.len()),
                Some(f) if s.body.len() != f => return false,
                _ => {}
            }
        }
        count >= 2
    }

    // "How many computers": connections owning at least one player seat.
    pub fn score_mode(&self) -> &'static str {
        let n = self
            .connections
            .values()
            .filter(|c| c.locals.iter().any(|l| matches!(l, Some(seat) if seat.role == Role::Player)))
            .count();
        if n >= 2 {
            "networked"
        } else {
            "local"
        }
    }

    // ---------------------------------------------------------------
    // Speed-run / food-rate score mode (v3.7.0).
    // ---------------------------------------------------------------
    pub fn food_rate_window_size(&self) -> usize {
        ((self.cfg.food_rate.window_ms / self.cfg.food_rate.bucket_ms).round() as usize).max(1)
    }

    pub fn ensure_food_rate_acc(conn: &mut Conn, local_idx: usize) {
        if conn.food_rate.len() <= local_idx {
            conn.food_rate.resize(local_idx + 1, None);
        }
        if conn.food_rate[local_idx].is_none() {
            conn.food_rate[local_idx] = Some(FoodRateAcc::default());
        }
    }

    fn close_food_rate_bucket(acc: &mut FoodRateAcc, bucket_ms: f64, floor_ms: f64, window: usize) {
        let food = acc.cur_food;
        acc.cur_food = 0;
        acc.cur_play_ms -= bucket_ms;
        acc.closed_count += 1;
        let arr = &mut acc.top_buckets;
        if arr.len() < window {
            let idx = arr.partition_point(|&v| v <= food);
            arr.insert(idx, food);
            acc.top_sum += food;
        } else if !arr.is_empty() && food > arr[0] {
            acc.top_sum += food - arr[0];
            arr[0] = food;
            let mut idx = 0;
            while idx + 1 < arr.len() && arr[idx] > arr[idx + 1] {
                arr.swap(idx, idx + 1);
                idx += 1;
            }
        }
        let k = (acc.closed_count as usize).min(window);
        acc.cached_rate = if k > 0 {
            (acc.top_sum as f64 * 60000.0) / (k as f64 * bucket_ms)
        } else {
            0.0
        };
        if !acc.locked && acc.closed_count as f64 * bucket_ms >= floor_ms {
            acc.locked = true;
        }
    }

    // The seat (conn_id + localIdx) occupying slot i, or None.
    pub fn seat_for_slot(&self, slot_index: usize) -> Option<(String, usize)> {
        let s = self.slots.get(slot_index)?.as_ref()?;
        let conn = self.connections.get(&s.conn_id)?;
        let li = self.local_index_for_slot(conn, slot_index)?;
        Some((s.conn_id.clone(), li))
    }

    // Credit the owning seat's current bucket (food eaten / kill bonus).
    pub fn bump_food_rate_points(&mut self, slot_index: usize, amount: i64) {
        if !self.cfg.food_rate.enabled {
            return;
        }
        let Some((conn_id, li)) = self.seat_for_slot(slot_index) else { return };
        if let Some(conn) = self.connections.get_mut(&conn_id) {
            if let Some(Some(acc)) = conn.food_rate.get_mut(li) {
                acc.cur_food += amount;
            }
        }
    }

    // Advance every living, seated player's play-time by dt.
    pub fn advance_food_rate_timers(&mut self, dt: f64) {
        if !self.cfg.food_rate.enabled || dt <= 0.0 {
            return;
        }
        let bucket_ms = self.cfg.food_rate.bucket_ms;
        let floor_ms = self.cfg.food_rate.floor_ms;
        let window = self.food_rate_window_size();
        for i in 0..self.slots.len() {
            let alive = matches!(&self.slots[i], Some(s) if s.alive);
            if !alive {
                continue;
            }
            let Some((conn_id, li)) = self.seat_for_slot(i) else { continue };
            if let Some(conn) = self.connections.get_mut(&conn_id) {
                if let Some(Some(acc)) = conn.food_rate.get_mut(li) {
                    acc.cur_play_ms += dt;
                    while acc.cur_play_ms >= bucket_ms {
                        Self::close_food_rate_bucket(acc, bucket_ms, floor_ms, window);
                    }
                }
            }
        }
    }

    // Live snapshot for the broadcast: (ratePerMin rounded to 1 decimal,
    // locked), or None if this seat has never been a player.
    pub fn food_rate_snapshot(conn: &Conn, local_idx: usize) -> Option<(f64, bool)> {
        let acc = conn.food_rate.get(local_idx)?.as_ref()?;
        Some(((acc.cached_rate * 10.0).round() / 10.0, acc.locked))
    }

    // Leaderboard value, or None until the seat clears the play-time floor.
    pub fn food_rate_score_for_seat(conn: &Conn, local_idx: usize) -> Option<f64> {
        let acc = conn.food_rate.get(local_idx)?.as_ref()?;
        if !acc.locked {
            return None;
        }
        Some((acc.cached_rate * 100.0).round() / 100.0)
    }

    pub fn in_bounds(&self, h: Cell) -> bool {
        h.x >= 0 && h.x < self.cfg.grid.cols && h.y >= 0 && h.y < self.cfg.grid.rows
    }

    // Global speed target (v3.5.0): eased function of the average living-
    // snake length, saturating at lengthSaturation.
    pub fn target_move_interval_ms(&self) -> f64 {
        let mut total = 0usize;
        let mut n = 0usize;
        for s in self.slots.iter().flatten() {
            if s.alive {
                total += s.body.len();
                n += 1;
            }
        }
        if n == 0 {
            return self.cfg.mv.start_interval_ms;
        }
        let avg = total as f64 / n as f64;
        let lo = self.cfg.min_snake_length as f64;
        let hi = (lo + 1.0).max(self.cfg.mv.length_saturation);
        let t = ((avg - lo) / (hi - lo)).clamp(0.0, 1.0);
        let eased = 1.0 - (1.0 - t) * (1.0 - t); // easeOutQuad
        self.cfg.mv.start_interval_ms + (self.cfg.mv.min_interval_ms - self.cfg.mv.start_interval_ms) * eased
    }

    // Exponential smoothing toward the target (time constant speedEaseMs).
    pub fn advance_global_speed(&mut self, dt: f64) {
        let target = self.target_move_interval_ms();
        if self.move_interval_ms.is_none() || !(self.cfg.mv.speed_ease_ms > 0.0) || dt <= 0.0 {
            self.move_interval_ms = Some(target);
            return;
        }
        let a = (dt / self.cfg.mv.speed_ease_ms).min(1.0);
        let cur = self.move_interval_ms.unwrap();
        self.move_interval_ms = Some(cur + (target - cur) * a);
    }

    pub fn current_move_interval_ms(&self) -> f64 {
        self.move_interval_ms.unwrap_or_else(|| self.target_move_interval_ms())
    }
}

// hitsBody: does h land on any segment of body except (optionally) the
// tail? Free function so callers can borrow one snake while scanning
// another's body.
pub fn hits_body(body: &[Cell], h: Cell, skip_tail: bool) -> bool {
    let end = if skip_tail { body.len().saturating_sub(1) } else { body.len() };
    body[..end].iter().any(|c| c.x == h.x && c.y == h.y)
}
