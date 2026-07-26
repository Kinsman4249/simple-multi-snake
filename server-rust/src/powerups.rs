// ============================================================
// Powerup registry: the Rust port of powerups/*.js. Each JS module became
// a match arm here; titles/descriptions are copied verbatim so the client
// info popup text is identical. ORDER IS LOAD-BEARING: POWERUP_TYPES index
// order must match the renderers' color tables (render.js
// POWERUP_TYPE_INDEX, render2d.js POWERUP_STYLE, wasm pickupColor/
// trailColor). New types are always APPENDED.
// ============================================================
use crate::config::{Grid, PowerupsCfg};
use crate::state::{Cell, Game, Snake};

// An `enum` where every variant is a plain marker (no per-variant data),
// so it behaves like a C-style enum; see RUST-CHEATSHEET.md ("struct and
// enum"). The derives make it copyable by value (Copy/Clone), comparable
// with == (PartialEq/Eq), and printable for debugging (Debug); see
// RUST-CHEATSHEET.md ("#[derive(...)]").
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
    Scissors,
}

pub const POWERUP_TYPES: [PowerupType; 9] = [
    PowerupType::Wormhole,
    PowerupType::GrowthSpurt,
    PowerupType::IceTrail,
    PowerupType::PoisonTrail,
    PowerupType::SpeedBoost,
    PowerupType::BlueShell,
    PowerupType::BananaTrail,
    PowerupType::HelloWorld,
    PowerupType::Scissors,
];

// impl block: PowerupType's methods, kept separate from the enum
// declaration above; see RUST-CHEATSHEET.md ("impl blocks"). `self` here is
// taken by value, which is cheap because PowerupType derives Copy above.
impl PowerupType {
    pub fn as_str(self) -> &'static str {
        // match over every enum variant -- the compiler enforces that all
        // 9 variants are covered here (no catch-all needed); see
        // RUST-CHEATSHEET.md ("match").
        match self {
            PowerupType::Wormhole => "wormhole",
            PowerupType::GrowthSpurt => "growthSpurt",
            PowerupType::IceTrail => "iceTrail",
            PowerupType::PoisonTrail => "poisonTrail",
            PowerupType::SpeedBoost => "speedBoost",
            PowerupType::BlueShell => "blueShell",
            PowerupType::BananaTrail => "bananaTrail",
            PowerupType::HelloWorld => "helloWorld",
            PowerupType::Scissors => "scissors",
        }
    }
    pub fn from_str(s: &str) -> Option<PowerupType> {
        POWERUP_TYPES.iter().copied().find(|t| t.as_str() == s)
    }
    // Which powerups wait in the held slot for the activate button (JS:
    // requiresActivation). Only speedBoost, by maintainer decision 2026-07-16.
    pub fn requires_activation(self) -> bool {
        // matches!(value, pattern) -- shorthand for "does this match?" as a
        // bool, without writing a full match; see RUST-CHEATSHEET.md.
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
            PowerupType::Scissors => "Scissors",
        }
    }
    pub fn description(self) -> &'static str {
        match self {
            PowerupType::Wormhole => {
                "You do not use a button for this one. It waits, held in reserve. The moment \
                 a move would kill you, it fires on its own -- you phase straight through whatever \
                 you hit and come out the other side, still moving the same way. Board edges wrap \
                 you to the opposite side. One-time use, then it is gone."
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
            PowerupType::Scissors => {
                "You do not use a button for this one. It waits, held in reserve, until your \
                 next fatal-looking collision. Run your head into another snake's body and you \
                 snip its tail off at the point of impact instead of dying -- the severed piece \
                 scatters as bonus food. Bite your own tail and you cut yourself free the same \
                 way. Run into a spawned wall and it shatters, kicking you sideways away from it. \
                 A cut that would leave too little snake behind kills instead. Wormhole always \
                 gets first say when it is your own life on the line -- scissors only cuts in \
                 when you hit someone else. One-time use, then it is gone."
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

// scissors module: where in `body` the impact cell lands (first match --
// a body can't revisit a cell, so this is unambiguous). Shared by the
// self-cut and opponent-cut paths in sim.rs.
// `&[Cell]` is a slice -- a borrowed view over a Vec<Cell> without taking
// ownership of it; see RUST-CHEATSHEET.md ("Slices &[T]").
pub fn scissors_cut_index(body: &[Cell], impact: Cell) -> Option<usize> {
    body.iter().position(|seg| seg.x == impact.x && seg.y == impact.y)
}

// ---------------------------------------------------------------
// Wormhole landing algorithm (reworked 2026-07-20 to the maintainer's
// diagram spec; replaces the old "nearest safe spot in any direction"
// port of powerups/wormhole.js).
//
// The new model is DIRECTIONAL PHASING: the snake keeps its movement
// vector and phases straight through whatever it hit, coming out at the
// first realistically-escapable free cell on the far side. One walk
// handles every obstacle kind the same way:
//
//   - Board edge (scenario B): the walk wraps to the opposite edge on the
//     same axis (torus-style), so hitting the left wall exits at the right
//     wall on the same row, vector preserved.
//   - Dynamic solid walls (grid-decay obstacles), own body (scenarios
//     A / C), and other players' bodies (scenario D): each occupied cell
//     along the vector is simply skipped ("phased through"), including
//     runs of several consecutive segments, until a free cell appears.
//   - Stacked obstacles ("an obstacle on the other side of the wall"):
//     because the walk just keeps stepping, a wall right behind a board
//     edge, or a second snake right behind the first, is phased through
//     by the same loop with no special casing.
//
// "Realistically escapable" (the maintainer's gap rule): a free cell
// wedged between two obstacle runs is a death trap, so a candidate cell
// only counts as the landing if the player has somewhere to go from it --
// at least `lookahead_depth` consecutive free cells in the travel
// direction or one of the two perpendiculars (never the reverse: the
// tail is still threading through the entry portal behind the head).
// If no cell on the whole wrapped line passes that bar, the best-scoring
// free cell seen is used; if the line is fully occupied, a whole-board
// search picks the escapable free cell nearest the entry.
//
// Pure: reads the board (snakes + walls + grid), returns the chosen
// landing plus the two portal-effect cells, or None (board truly full).
// ---------------------------------------------------------------
pub struct WormholeResult {
    pub dir: Cell,
    pub landing: Cell,
    // Portal visual anchors: where the snake went in and where it comes
    // out (the exit portal is always the landing cell).
    pub entry_portal: Cell,
    pub exit_portal: Cell,
}

// Wrap a possibly out-of-bounds coordinate onto the board torus-style
// (exiting the left edge re-enters on the right, etc). rem_euclid keeps
// negatives correct: -1 wraps to cols-1, not to -1.
fn wrap_cell(c: Cell, grid: &Grid) -> Cell {
    Cell { x: c.x.rem_euclid(grid.cols), y: c.y.rem_euclid(grid.rows) }
}

// A cell the wormhole must phase THROUGH (or must not land on): any
// snake segment (own body included -- that is exactly scenarios A/C) or
// any dynamic wall. Walls count in EVERY display state, not just solid:
// a telegraphing wall is about to become spikes, so landing on it would
// trade one death for another a moment later.
fn cell_occupied(game: &Game, c: Cell) -> bool {
    if game.walls.iter().any(|w| w.x == c.x && w.y == c.y) {
        return true;
    }
    for slot in game.slots.iter() {
        let Some(s) = slot else { continue };
        if s.body.iter().any(|seg| seg.x == c.x && seg.y == c.y) {
            return true;
        }
    }
    false
}

// Escape score for a candidate landing: the longest run of consecutive
// free, IN-BOUNDS cells (no wrap here -- the charge is spent, the edges
// are deadly again) along the travel direction or either perpendicular,
// capped at `depth`. depth itself means "comfortably escapable".
fn escape_score(game: &Game, from: Cell, dir: Cell, depth: i32) -> i32 {
    // dir, then the two perpendiculars (never the reverse -- the snake's
    // own tail is threading in through the entry portal behind it).
    let tries = [dir, Cell { x: -dir.y, y: -dir.x }, Cell { x: dir.y, y: dir.x }];
    let mut best = 0;
    for d in tries {
        let mut run = 0;
        let mut c = from;
        for _ in 0..depth {
            c = Cell { x: c.x + d.x, y: c.y + d.y };
            if c.x < 0 || c.x >= game.cfg.grid.cols || c.y < 0 || c.y >= game.cfg.grid.rows {
                break;
            }
            if cell_occupied(game, c) {
                break;
            }
            run += 1;
        }
        if run > best {
            best = run;
        }
    }
    best
}

// The unified spatial lookahead: walk the movement vector from the fatal
// contact cell, wrapping at board edges and skipping every occupied cell,
// until a free cell that passes the escape bar appears. `own_head` is the
// snake's current (still in-bounds) head cell, used to anchor the entry
// portal when the contact point itself is off the board (edge hits).
pub fn attempt_wormhole(
    game: &Game,
    own_dir: Cell,
    own_head: Cell,
    fatal_head: Cell,
    lookahead_depth: i32,
) -> Option<WormholeResult> {
    let grid = &game.cfg.grid;
    // Entry portal: the cell the snake visibly dives into. For wall /
    // body hits that is the contact cell itself; for a board-edge hit the
    // contact cell is off the board, so the portal sits on the head's
    // last in-bounds cell right at the edge (matches the diagram, where
    // the edge portals hug the boundary).
    let in_bounds = fatal_head.x >= 0
        && fatal_head.x < grid.cols
        && fatal_head.y >= 0
        && fatal_head.y < grid.rows;
    let entry_portal = if in_bounds { fatal_head } else { own_head };

    // Walk the full wrapped line once (cols*rows steps upper-bounds a
    // line that wraps both axes before revisiting its start).
    let max_steps = (grid.cols * grid.rows).max(1);
    let mut pos = fatal_head;
    let mut best_fallback: Option<(Cell, i32)> = None;
    for _ in 0..max_steps {
        pos = wrap_cell(pos, grid);
        if cell_occupied(game, pos) {
            // Inside an obstacle run (wall block, own coil, another
            // snake's chain) -- keep phasing through it.
            pos = Cell { x: pos.x + own_dir.x, y: pos.y + own_dir.y };
            continue;
        }
        let score = escape_score(game, pos, own_dir, lookahead_depth);
        if score >= lookahead_depth {
            // First comfortably-escapable free cell past the obstacle(s):
            // this is the landing, vector unchanged.
            return Some(WormholeResult {
                dir: own_dir,
                landing: pos,
                entry_portal,
                exit_portal: pos,
            });
        }
        // A cramped gap (e.g. one free cell before another run of
        // segments): remember the roomiest one seen, but keep walking --
        // the maintainer's rule is to pass gaps the player can't
        // realistically get out of.
        if best_fallback.map_or(true, |(_, s)| score > s) {
            best_fallback = Some((pos, score));
        }
        pos = Cell { x: pos.x + own_dir.x, y: pos.y + own_dir.y };
    }

    // No cell on the line met the escape bar. Prefer the best cramped gap
    // on the line; failing even that (line fully occupied), scan the
    // whole board for the escapable free cell nearest the entry -- "the
    // player should come out into a safe location".
    let landing = best_fallback.map(|(c, _)| c).or_else(|| {
        let mut best: Option<(Cell, i32, i32)> = None; // (cell, score, dist)
        for y in 0..grid.rows {
            for x in 0..grid.cols {
                let c = Cell { x, y };
                if cell_occupied(game, c) {
                    continue;
                }
                let score = escape_score(game, c, own_dir, lookahead_depth).min(lookahead_depth);
                let dist = (c.x - entry_portal.x).abs() + (c.y - entry_portal.y).abs();
                // Higher escape score wins; among equals, nearest to the
                // entry portal.
                let better = match best {
                    None => true,
                    Some((_, bs, bd)) => score > bs || (score == bs && dist < bd),
                };
                if better {
                    best = Some((c, score, dist));
                }
            }
        }
        best.map(|(c, _, _)| c)
    });
    landing.map(|l| WormholeResult { dir: own_dir, landing: l, entry_portal, exit_portal: l })
}
