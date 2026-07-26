// Collision resolution: wall/obstacle, self, and snake-vs-snake, run in
// that order each movement step. Movers are checked against EVERY living
// snake; head-ons (same-step and split-step) kill both with no credit; a
// body hit credits the owner. See the extensive JS comments for the shapes.
use super::evasion::{try_wormhole_or_die, try_wormhole_or_scissors_or_die};
use super::movement::consume_inbounds_turn;
use crate::config::now_ms;
use crate::lifecycle::KillInfo;
use crate::powerups::scissors_cut_index;
use crate::state::{hits_body, Cell, Game};
use std::collections::{HashMap, HashSet};

// The JS `died` Map: insertion-ordered victim -> {killer, cause}.
pub(crate) struct DiedMap {
    pub(crate) entries: Vec<(usize, KillInfo)>,
}
impl DiedMap {
    pub(crate) fn new() -> DiedMap {
        DiedMap { entries: Vec::new() }
    }
    pub(crate) fn has(&self, i: usize) -> bool {
        self.entries.iter().any(|(v, _)| *v == i)
    }
    fn get_killer(&self, i: usize) -> Option<Option<usize>> {
        self.entries.iter().find(|(v, _)| *v == i).map(|(_, k)| k.killer)
    }
    pub(crate) fn set(&mut self, i: usize, info: KillInfo) {
        if let Some(e) = self.entries.iter_mut().find(|(v, _)| *v == i) {
            e.1 = info;
        } else {
            self.entries.push((i, info));
        }
    }
}

pub(crate) fn resolve_wall_collisions(
    game: &mut Game,
    movers: &[usize],
    new_heads: &mut HashMap<usize, Cell>,
    died: &mut DiedMap,
    stalled: &mut HashSet<usize>,
) {
    let now = now_ms();
    for &i in movers {
        if died.has(i) {
            continue;
        }
        let h = new_heads[&i];
        let obstacle = game.in_bounds(h) && game.is_solid_wall_cell(h.x, h.y, now);
        if game.in_bounds(h) && !obstacle {
            game.slots[i].as_mut().unwrap().wall_stalls = 0;
            continue;
        }
        // Wormhole threading: never die at a wall mid-drain; hold in place.
        if game.slots[i].as_ref().unwrap().teleport_drain > 0 {
            stalled.insert(i);
            let head = game.slots[i].as_ref().unwrap().head();
            new_heads.insert(i, head);
            continue;
        }
        if let Some(saved) = consume_inbounds_turn(game, i, now) {
            let s = game.slots[i].as_mut().unwrap();
            s.dir = saved;
            let head = s.head();
            new_heads.insert(i, Cell { x: head.x + saved.x, y: head.y + saved.y });
            s.wall_stalls = 0;
            continue;
        }
        // No wall grace while boosting: a boosted head aimed at a wall with
        // no saving turn dies without the stall tick.
        let (wall_stalls, ramp) = {
            let s = game.slots[i].as_ref().unwrap();
            (s.wall_stalls, s.ramp_progress)
        };
        if wall_stalls < game.cfg.wall_grace_ticks && ramp == 0.0 {
            let s = game.slots[i].as_mut().unwrap();
            s.wall_stalls += 1;
            stalled.insert(i);
            let head = s.head();
            new_heads.insert(i, head);
            continue;
        }
        if obstacle {
            try_wormhole_or_scissors_or_die(game, i, "obstacle", died, stalled, new_heads);
        } else {
            try_wormhole_or_die(game, i, None, "wall", died, stalled, new_heads);
        }
        game.slots[i].as_mut().unwrap().wall_stalls = 0;
    }
}

pub(crate) fn resolve_self_collisions(
    game: &mut Game,
    movers: &[usize],
    new_heads: &mut HashMap<usize, Cell>,
    died: &mut DiedMap,
    stalled: &mut HashSet<usize>,
) {
    for &i in movers {
        if died.has(i) || stalled.contains(&i) {
            continue;
        }
        // Threading: exempt from self-collision until the drain completes.
        if game.slots[i].as_ref().unwrap().teleport_drain > 0 {
            continue;
        }
        let hit = hits_body(&game.slots[i].as_ref().unwrap().body, new_heads[&i], true);
        if hit {
            try_wormhole_or_scissors_or_die(game, i, "self", died, stalled, new_heads);
        }
    }
}

pub(crate) fn resolve_snake_collisions(
    game: &mut Game,
    movers: &[usize],
    new_heads: &HashMap<usize, Cell>,
    died: &mut DiedMap,
    stalled: &mut HashSet<usize>,
    all_alive: &[usize],
) {
    for &i in movers {
        if died.has(i) || stalled.contains(&i) {
            continue;
        }
        let h = new_heads[&i];
        for &j in all_alive {
            if j == i {
                continue;
            }
            enum Action {
                HeadOnBoth,
                BodyHit,
            }
            let action = {
                let me_dir = game.slots[i].as_ref().unwrap().dir;
                let other = game.slots[j].as_ref().unwrap();
                let other_head_new = new_heads.get(&j);
                let j_moves = other_head_new.is_some() && !stalled.contains(&j) && !died.has(j);
                if j_moves {
                    let oh = *other_head_new.unwrap();
                    if h.x == oh.x && h.y == oh.y {
                        Some(Action::HeadOnBoth)
                    } else if hits_body(&other.body, h, true) {
                        Some(Action::BodyHit)
                    } else {
                        None
                    }
                } else {
                    // Split-step head-on: j stationary, mover lands exactly
                    // on j's head while the two face each other.
                    let oh = other.body.first().copied();
                    if !died.has(j)
                        && oh.map_or(false, |oh| h.x == oh.x && h.y == oh.y)
                        && other.dir.x == -me_dir.x
                        && other.dir.y == -me_dir.y
                    {
                        Some(Action::HeadOnBoth)
                    } else if hits_body(&other.body, h, false) {
                        Some(Action::BodyHit)
                    } else {
                        None
                    }
                }
            };
            match action {
                Some(Action::HeadOnBoth) => {
                    // Each side checked independently for a wormhole charge.
                    try_wormhole_or_die(game, i, None, "headon", died, stalled, new_heads);
                    try_wormhole_or_die(game, j, None, "headon", died, stalled, new_heads);
                    if died.has(i) || stalled.contains(&i) {
                        break;
                    }
                    continue;
                }
                Some(Action::BodyHit) => {
                    // Scissors claims a body-hit before wormhole even gets
                    // consulted (the one exception to "wormhole always goes
                    // first"): the attacker was never in mortal danger once
                    // scissors converts the crash into a cut, so it never
                    // touches its own wormhole charge here.
                    let attacker_armed = matches!(&game.slots[i], Some(s) if s.scissors_charge);
                    if attacker_armed {
                        game.slots[i].as_mut().unwrap().scissors_charge = false;
                        let victim_body = game.slots[j].as_ref().unwrap().body.clone();
                        let original_len = victim_body.len();
                        if let Some(k) = scissors_cut_index(&victim_body, h) {
                            if k < game.cfg.min_snake_length {
                                died.set(j, KillInfo { killer: Some(i), cause: "scissors" });
                            } else {
                                let severed: Vec<Cell> = victim_body[k..].to_vec();
                                game.slots[j].as_mut().unwrap().body.truncate(k);
                                game.drop_scissors_food(j, &severed, original_len);
                                game.dlog(&format!(
                                    "scissors cut victim={} by={} survivingLen={}",
                                    j, i, k
                                ));
                            }
                        }
                        break; // i (the attacker) is untouched, continues normally
                    }
                    try_wormhole_or_die(game, i, Some(j), "body", died, stalled, new_heads);
                    break; // i resolved (died or teleported)
                }
                None => {}
            }
        }
    }
}

// A head-on SWAP records each as the other's killer via the body-hit
// branch; nobody survived, so strip the mutual credit.
pub(crate) fn clear_mutual_kills(died: &mut DiedMap) {
    let mutual: Vec<usize> = died
        .entries
        .iter()
        .filter(|(victim, info)| {
            info.killer
                .and_then(|k| died.get_killer(k))
                .map_or(false, |kk| kk == Some(*victim))
        })
        .map(|(v, _)| *v)
        .collect();
    for v in mutual {
        died.set(v, KillInfo { killer: None, cause: "headon" });
    }
}
