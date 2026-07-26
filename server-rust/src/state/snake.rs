use super::types::{ActivePowerup, Cell, Input};
use crate::config::now_ms;
use crate::powerups::PowerupType;

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
