// Death-avoidance mechanisms: wormhole phasing (always gets first say when
// it's the snake's own life on the line) and the scissors self-save/wall-
// shatter fallback (tried only after wormhole has already failed). Also
// owns the wormhole portal-marker fx lifecycle.
use super::collisions::DiedMap;
use crate::lifecycle::KillInfo;
use crate::powerups::attempt_wormhole;
use crate::state::{hits_body, Cell, Game, PortalFx, WallShatterFx};
use std::collections::HashMap;
use std::collections::HashSet;

// Wormhole portal lifecycle: a portal pair stays open while its owner's
// tail is still threading through (teleport_drain > 0). The moment the
// drain finishes -- or the owner died / left the slot -- a short linger
// window is stamped so the closing is visible, then the portal is
// dropped. Returns true if any portal was removed (forces a broadcast so
// clients see them disappear even on an otherwise quiet tick).
const PORTAL_LINGER_MS: i64 = 600;
pub(crate) fn sweep_portal_fx(game: &mut Game, now: i64) -> bool {
    if game.portal_fx.is_empty() {
        return false;
    }
    // Stamp expiry on portals whose owner is done draining (immutable
    // peek at the slot per portal, then mutate the portal).
    for k in 0..game.portal_fx.len() {
        if game.portal_fx[k].expires_ms.is_some() {
            continue;
        }
        let owner = game.portal_fx[k].owner_slot;
        let draining = matches!(
            game.slots.get(owner).and_then(|s| s.as_ref()),
            Some(s) if s.alive && s.teleport_drain > 0
        );
        if !draining {
            game.portal_fx[k].expires_ms = Some(now + PORTAL_LINGER_MS);
        }
    }
    let before = game.portal_fx.len();
    game.portal_fx.retain(|p| p.expires_ms.map_or(true, |e| now < e));
    game.portal_fx.len() != before
}

// Wormhole interception (see the JS state-machine comment): the ONLY
// transition out of ARMED is a fatal collision this step; firing always
// consumes the charge, and a failed landing dies normally. Returns true
// if the snake was saved (teleported); the caller must not also call
// died.set in that case.
pub(crate) fn try_wormhole(game: &mut Game, idx: usize, stalled: &mut HashSet<usize>, new_heads: &HashMap<usize, Cell>) -> bool {
    let armed = matches!(&game.slots[idx], Some(s) if s.wormhole_charge);
    if armed {
        let (own_dir, own_head) = {
            let s = game.slots[idx].as_ref().unwrap();
            (s.dir, s.head())
        };
        // A split-step head-on can kill a snake not moving this step: its
        // fatal contact point is its own stationary head cell.
        let fatal_head = new_heads.get(&idx).copied().unwrap_or(own_head);
        // Directional phasing (2026-07-20 rework): one spatial lookahead
        // walks the movement vector through board edges (wrap), dynamic
        // walls, own body, and other snakes alike -- see powerups.rs.
        let result = attempt_wormhole(
            game,
            own_dir,
            own_head,
            fatal_head,
            game.cfg.powerups.wormhole.lookahead_depth,
        );
        game.slots[idx].as_mut().unwrap().wormhole_charge = false;
        if let Some(r) = result {
            // Per-segment threading: only the head exits at the landing;
            // the tail drains through the entry over the next
            // (body.len - 1) steps, with wall/self collision exempt until
            // the drain completes.
            let s = game.slots[idx].as_mut().unwrap();
            s.body.insert(0, r.landing);
            s.body.pop();
            s.dir = r.dir;
            s.teleported_this_tick = true;
            s.teleport_drain = s.body.len().saturating_sub(1);
            // Trail-gap-fill anchor: apply_movement_and_food is skipped for
            // this snake while stalled/draining, so last_trail_cell would
            // otherwise still point at the pre-teleport tail. Left stale,
            // the next real movement tick's gap-fill walk bridges old and
            // new tail positions with a straight line of trail tiles clear
            // across the board. Clearing it here makes the snake start its
            // trail fresh on the landing side.
            s.last_trail_cell = None;
            stalled.insert(idx); // normal movement/food skipped this step
            // Purple portal markers at both ends of the phase. They stay
            // up until this snake's tail finishes threading through
            // (sweep_portal_fx watches teleport_drain), so the entry
            // visibly "swallows" the whole body before closing.
            for c in [r.entry_portal, r.exit_portal] {
                let id = game.next_powerup_id;
                game.next_powerup_id += 1;
                game.portal_fx.push(PortalFx {
                    id,
                    x: c.x,
                    y: c.y,
                    owner_slot: idx,
                    expires_ms: None,
                });
            }
            let landing = r.landing;
            game.dlog(&format!(
                "wormhole fired slot={} entry=({},{}) landing=({},{})",
                idx, r.entry_portal.x, r.entry_portal.y, landing.x, landing.y
            ));
            return true;
        }
        game.dlog(&format!("wormhole fizzled, no landing slot={}", idx));
    }
    false
}

// Plain wrapper for call sites that must NOT fall back to scissors: the
// arena boundary (always instakill) and head-on collisions (scissors
// intentionally does not apply there -- see sim.rs module notes).
pub(crate) fn try_wormhole_or_die(
    game: &mut Game,
    idx: usize,
    killer: Option<usize>,
    cause: &'static str,
    died: &mut DiedMap,
    stalled: &mut HashSet<usize>,
    new_heads: &HashMap<usize, Cell>,
) {
    if try_wormhole(game, idx, stalled, new_heads) {
        return;
    }
    died.set(idx, KillInfo { killer, cause });
}

// Find the safer of the two directions perpendicular to `dir`: whichever
// leads `depth` cells further before hitting a solid wall cell, the board
// edge, or another snake's body. Used by the scissors wall-shatter save to
// steer away from the wall it just broke through.
fn safer_perpendicular(game: &Game, from: Cell, dir: Cell, depth: i32) -> Option<Cell> {
    let now = crate::config::now_ms();
    let clear_run = |d: Cell| -> i32 {
        let mut run = 0;
        let mut c = from;
        for _ in 0..depth {
            c = Cell { x: c.x + d.x, y: c.y + d.y };
            if !game.in_bounds(c) || game.is_solid_wall_cell(c.x, c.y, now) {
                break;
            }
            if game.slots.iter().flatten().any(|s| hits_body(&s.body, c, false)) {
                break;
            }
            run += 1;
        }
        run
    };
    let left = Cell { x: dir.y, y: -dir.x };
    let right = Cell { x: -dir.y, y: dir.x };
    let (lr, rr) = (clear_run(left), clear_run(right));
    if lr == 0 && rr == 0 {
        return None;
    }
    Some(if rr > lr { right } else { left })
}

// Scissors fallback save (v4.5.0): tried only after wormhole has already
// failed to save the snake, and only for a self-collision or a dynamic
// (spawned) wall hit -- never the arena boundary. Wormhole always gets
// first say when it is the snake's own life on the line; this function is
// the second chance. Returns true if the snake was saved.
pub(crate) fn try_scissors_self_save(
    game: &mut Game,
    idx: usize,
    cause: &'static str,
    stalled: &mut HashSet<usize>,
    new_heads: &mut HashMap<usize, Cell>,
) -> bool {
    let armed = matches!(&game.slots[idx], Some(s) if s.scissors_charge);
    if !armed {
        return false;
    }
    game.slots[idx].as_mut().unwrap().scissors_charge = false;
    let fatal_head = new_heads[&idx];
    match cause {
        "self" => {
            let min_len = game.cfg.min_snake_length;
            let (old_body, old_len) = {
                let s = game.slots[idx].as_ref().unwrap();
                (s.body.clone(), s.body.len())
            };
            let Some(k) = crate::powerups::scissors_cut_index(&old_body, fatal_head) else { return false };
            let surviving_len = k + 1;
            if surviving_len < min_len {
                return false;
            }
            let mut new_body = Vec::with_capacity(surviving_len);
            new_body.push(fatal_head);
            new_body.extend_from_slice(&old_body[0..k]);
            let severed: Vec<Cell> = old_body[k..].to_vec();
            let s = game.slots[idx].as_mut().unwrap();
            s.body = new_body;
            s.last_trail_cell = None;
            game.drop_scissors_food(idx, &severed, old_len);
            stalled.insert(idx);
            game.dlog(&format!("scissors self-cut slot={} survivingLen={}", idx, surviving_len));
            true
        }
        "obstacle" => {
            let Some(wall_id) = game.walls.iter().find(|w| w.x == fatal_head.x && w.y == fatal_head.y).map(|w| w.id) else {
                return false;
            };
            let (own_dir, own_head) = {
                let s = game.slots[idx].as_ref().unwrap();
                (s.dir, s.head())
            };
            let Some(turn) = safer_perpendicular(game, own_head, own_dir, 3) else { return false };
            let shattered: Vec<Cell> = game.walls.iter().filter(|w| w.id == wall_id).map(|w| Cell { x: w.x, y: w.y }).collect();
            game.walls.retain(|w| w.id != wall_id);
            game.wall_shatters.push(WallShatterFx { x: fatal_head.x, y: fatal_head.y });
            let s = game.slots[idx].as_mut().unwrap();
            s.dir = turn;
            s.wall_stalls = 0;
            new_heads.insert(idx, Cell { x: own_head.x + turn.x, y: own_head.y + turn.y });
            game.dlog(&format!(
                "scissors wall-shatter slot={} wallId={} cells={}",
                idx, wall_id, shattered.len()
            ));
            true
        }
        _ => false,
    }
}

pub(crate) fn try_wormhole_or_scissors_or_die(
    game: &mut Game,
    idx: usize,
    cause: &'static str,
    died: &mut DiedMap,
    stalled: &mut HashSet<usize>,
    new_heads: &mut HashMap<usize, Cell>,
) {
    if try_wormhole(game, idx, stalled, new_heads) {
        return;
    }
    if try_scissors_self_save(game, idx, cause, stalled, new_heads) {
        return;
    }
    died.set(idx, KillInfo { killer: None, cause });
}
