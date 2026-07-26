// ============================================================
// Connection / seat lifecycle (port of server/lifecycle.js): admission and
// the spectator queue, couch co-op seats, leave/disconnect teardown, join
// offers, the idle sweeps, and death handling with instant high-score
// recording.
//
// One structural difference from the JS: the death->respawn delay was a
// setTimeout; here handle_death stamps snake.respawn_at and
// lifecycle_sweep (running every sim tick) fires it -- 16ms granularity on
// a 1500ms delay, observably identical.
// ============================================================
use crate::config::now_ms;
use crate::net::{broadcast_state, send_to};
use crate::state::{Conn, Game, JoinOffer, KillEvent, LocalSeat, QueueEntry, Role, Snake, WsOut};

// Record a qualifying LENGTH score for one seat (earned-length gate: a
// snake back at the starting length records nothing).
fn record_if_qualifies(game: &mut Game, conn_id: &str, local_idx: usize, mode: &'static str, slot_index: usize) {
    // game.slots is Vec<Option<Snake>>: .get() borrows the slot (Option, in
    // case the index is out of range) and the nested Some(Some(s)) pattern
    // also requires the slot itself to be occupied. let-else bails out on
    // either "no such slot" or "empty slot"; see RUST-CHEATSHEET.md.
    let Some(Some(s)) = game.slots.get(slot_index) else { return };
    let len = s.body.len();
    if len <= game.cfg.min_snake_length {
        game.dlog(&format!("score save skipped: snake at starting length local={} len={}", local_idx, len));
        return;
    }
    let score = len as f64;
    let targets = game.highscores.qualifies(score, mode, "length");
    if targets.is_empty() {
        return;
    }
    let initials = game
        .connections
        .get(conn_id)
        .map(|c| c.initials_for(local_idx).to_string())
        .unwrap_or_else(|| "???".into());
    game.highscores.record(&targets, &initials, score, mode);
    game.dlog(&format!("score recorded local={} initials={} score={} mode={}", local_idx, initials, score, mode));
}

// Food-rate score: death-independent, no earned-length gate, never resets
// the accumulator. None until the seat clears the play-time floor.
fn record_if_qualifies_food_rate(game: &mut Game, conn_id: &str, local_idx: usize, mode: &'static str) {
    let Some(conn) = game.connections.get(conn_id) else { return };
    let Some(score) = Game::food_rate_score_for_seat(conn, local_idx) else { return };
    let targets = game.highscores.qualifies(score, mode, "foodRate");
    if targets.is_empty() {
        return;
    }
    let initials = conn.initials_for(local_idx).to_string();
    game.highscores.record(&targets, &initials, score, mode);
    game.dlog(&format!("food-rate score recorded local={} initials={} score={}", local_idx, initials, score));
}

// Called once per new WebSocket connection (see ws.rs). Registers the
// connection's outbound channel and immediately tries to seat local seat 0
// (the first controller/keyboard slot) as either a player or a spectator.
pub fn assign_connection(game: &mut Game, conn_id: String, tx: tokio::sync::mpsc::UnboundedSender<WsOut>) {
    game.connections.insert(
        conn_id.clone(),
        Conn { tx, locals: Vec::new(), initials: Vec::new(), food_rate: Vec::new() },
    );
    game.conn_order.push(conn_id.clone());
    admit_local(game, &conn_id, 0);
}

// The single admission path (fresh connect at local 0, co-op joinLocal at
// 1+): take a free slot only if nobody is waiting, else queue like anyone.
pub fn admit_local(game: &mut Game, conn_id: &str, local_idx: usize) {
    if !game.connections.contains_key(conn_id) {
        return;
    }
    // .position() runs the closure over each slot and returns the index of
    // the first match (an empty seat) as Some(i), or None if every slot is
    // full; see RUST-CHEATSHEET.md ("Closures", "Option<T>").
    let free_index = game.slots.iter().position(|s| s.is_none());
    if let (Some(free_index), true) = (free_index, game.spectator_queue.is_empty() && game.join_offer.is_none()) {
        let color = if free_index < crate::config::COLORS.len() { Some(free_index) } else { None };
        game.slots[free_index] = Some(Snake::new(conn_id.to_string(), color));
        game.spawn_snake(free_index);
        let conn = game.connections.get_mut(conn_id).unwrap();
        conn.set_local(local_idx, Some(LocalSeat { role: Role::Player, slot_index: Some(free_index) }));
        Game::ensure_food_rate_acc(conn, local_idx);
        if game.session_start.is_none() {
            game.session_start = Some(now_ms());
        }
        game.ensure_foods(); // new player joined: top food up immediately
    } else {
        game.spectator_queue.push(QueueEntry { conn_id: conn_id.to_string(), local: local_idx, since: now_ms() });
        let conn = game.connections.get_mut(conn_id).unwrap();
        conn.set_local(local_idx, Some(LocalSeat { role: Role::Spectator, slot_index: None }));
        maybe_offer_slot(game);
    }
}

// Add a second (or later) local seat (couch co-op). Returns a denial
// reason, or None on success.
pub fn add_local_player(game: &mut Game, conn_id: &str) -> Option<&'static str> {
    let Some(conn) = game.connections.get(conn_id) else { return Some("not connected") };
    // A left seat leaves a None hole; rejoin fills the hole first so key
    // maps (0 = arrows, 1 = WASD) stay stable.
    let idx = conn
        .locals
        .iter()
        .position(|l| l.is_none())
        .unwrap_or(conn.locals.len());
    if idx >= game.cfg.max_local_players {
        return Some("max local players reached");
    }
    admit_local(game, conn_id, idx);
    None
}

// Explicit "Leave" for one local seat: the seat exits completely (slot
// freed / queue entry dropped / local index becomes a hole). Returns true
// when it was the connection's LAST seat (caller tears the whole
// connection down).
pub fn remove_local_seat(game: &mut Game, conn_id: &str, local_idx: usize) -> bool {
    let Some(conn) = game.connections.get(conn_id) else { return false };
    let Some(entry) = conn.local(local_idx).cloned() else { return false };
    if entry.role == Role::Player {
        if let Some(si) = entry.slot_index {
            let alive = matches!(&game.slots[si], Some(s) if s.alive);
            // Mode sampled BEFORE teardown -- the leaver still counts.
            let mode = game.score_mode();
            if alive {
                record_if_qualifies(game, conn_id, local_idx, mode, si);
            }
            record_if_qualifies_food_rate(game, conn_id, local_idx, mode);
            game.slots[si] = None;
        }
    }
    game.spectator_queue.retain(|e| !(e.conn_id == conn_id && e.local == local_idx));
    if matches!(&game.join_offer, Some(o) if o.conn_id == conn_id && o.local == local_idx) {
        game.join_offer = None;
    }
    let conn = game.connections.get_mut(conn_id).unwrap();
    conn.set_local(local_idx, None);
    if !conn.any_seat_left() {
        return true;
    }
    maybe_offer_slot(game);
    false
}

// After a death: round robin -- yield the slot if anyone waits, else
// respawn in place.
pub fn respawn_or_spectate(game: &mut Game, slot_index: usize) {
    if !game.spectator_queue.is_empty() {
        move_player_to_spectator(game, slot_index);
    } else {
        game.spawn_snake(slot_index);
    }
}

// Full teardown when a WebSocket connection closes (client disconnect, idle
// kick, etc): frees any slot(s) the connection's seats occupied, drops it
// from the spectator queue and any pending join offer, then tries to seat
// the next spectator into the slot(s) that opened up. If the room is now
// completely empty, resets session-scoped state (food, speed ramp) so the
// next player gets a fresh start.
pub fn remove_connection(game: &mut Game, conn_id: &str) {
    let Some(conn) = game.connections.remove(conn_id) else { return };
    game.conn_order.retain(|c| c != conn_id);
    for entry in conn.locals.iter().flatten() {
        if entry.role == Role::Player {
            if let Some(si) = entry.slot_index {
                game.slots[si] = None;
            }
        }
    }
    game.spectator_queue.retain(|e| e.conn_id != conn_id);
    if matches!(&game.join_offer, Some(o) if o.conn_id == conn_id) {
        game.join_offer = None;
    }
    maybe_offer_slot(game);
    if game.slots.iter().all(|s| s.is_none()) && game.spectator_queue.is_empty() {
        // Room emptied: clear food and reset the eased speed for a fresh
        // session.
        game.session_start = None;
        game.foods.clear();
        game.move_interval_ms = None;
    }
}

// If a slot is free and nobody already has a pending join offer, offer it
// to the spectator at the front of the queue (they get join_offer_ms to
// accept via "acceptJoin" before the offer expires -- see
// lifecycle_sweep). Recurses to skip past stale queue entries (e.g. a
// spectator who disconnected without formally leaving the queue).
pub fn maybe_offer_slot(game: &mut Game) {
    if game.join_offer.is_some() {
        return;
    }
    if game.slots.iter().all(|s| s.is_some()) {
        return;
    }
    let Some(front) = game.spectator_queue.first() else { return };
    let front_conn_id = front.conn_id.clone();
    let front_local = front.local;
    let valid = game
        .connections
        .get(&front_conn_id)
        .and_then(|c| c.local(front_local))
        .map_or(false, |seat| seat.role == Role::Spectator);
    if !valid {
        // Stale entry: drop and try the next in line.
        game.spectator_queue.remove(0);
        return maybe_offer_slot(game);
    }
    game.join_offer = Some(JoinOffer {
        conn_id: front_conn_id.clone(),
        local: front_local,
        expires_at: now_ms() + game.cfg.join_offer_ms,
    });
    send_to(
        game,
        &front_conn_id,
        serde_json::json!({ "type": "offerJoin", "local": front_local, "acceptMs": game.cfg.join_offer_ms }),
    );
}

pub fn accept_join(game: &mut Game, conn_id: &str, local_idx: usize) {
    let matches_offer = matches!(&game.join_offer, Some(o) if o.conn_id == conn_id && o.local == local_idx);
    if !matches_offer {
        return;
    }
    let Some(open_index) = game.slots.iter().position(|s| s.is_none()) else {
        game.join_offer = None;
        return;
    };
    game.spectator_queue.retain(|e| !(e.conn_id == conn_id && e.local == local_idx));
    game.join_offer = None;
    if !game.connections.contains_key(conn_id) {
        maybe_offer_slot(game);
        return;
    }
    let color = if open_index < crate::config::COLORS.len() { Some(open_index) } else { None };
    game.slots[open_index] = Some(Snake::new(conn_id.to_string(), color));
    game.spawn_snake(open_index);
    let conn = game.connections.get_mut(conn_id).unwrap();
    conn.set_local(local_idx, Some(LocalSeat { role: Role::Player, slot_index: Some(open_index) }));
    Game::ensure_food_rate_acc(conn, local_idx);
    if game.session_start.is_none() {
        game.session_start = Some(now_ms());
    }
    game.ensure_foods();
}

pub fn lifecycle_sweep(game: &mut Game) {
    let now = now_ms();

    // Due respawns (the JS setTimeout, see module comment).
    for i in 0..game.slots.len() {
        let due = matches!(&game.slots[i], Some(s) if !s.alive && s.respawn_at.map_or(false, |t| now >= t));
        if due {
            game.slots[i].as_mut().unwrap().respawn_at = None;
            respawn_or_spectate(game, i);
            broadcast_state(game);
        }
    }

    if matches!(&game.join_offer, Some(o) if now >= o.expires_at) {
        let offer = game.join_offer.take().unwrap();
        if let Some(idx) = game
            .spectator_queue
            .iter()
            .position(|e| e.conn_id == offer.conn_id && e.local == offer.local)
        {
            let e = game.spectator_queue.remove(idx);
            game.spectator_queue.push(QueueEntry { conn_id: e.conn_id, local: e.local, since: now });
        }
        maybe_offer_slot(game);
    }

    // Spectator idle sweep.
    let idle: Vec<(String, usize)> = game
        .spectator_queue
        .iter()
        .filter(|e| now - e.since >= game.cfg.spectator_idle_ms)
        .map(|e| (e.conn_id.clone(), e.local))
        .collect();
    for (conn_id, local) in idle {
        let other_seat_playing = game.connections.get(&conn_id).map_or(false, |c| {
            c.locals
                .iter()
                .enumerate()
                .any(|(i, l)| i != local && matches!(l, Some(seat) if seat.role == Role::Player))
        });
        if !other_seat_playing {
            if let Some(c) = game.connections.get(&conn_id) {
                let _ = c.tx.send(WsOut::Close);
            }
            remove_connection(game, &conn_id);
        } else {
            // Co-op connection with the other seat still playing: this seat
            // just abandons the queue (rejoin later with joinLocal).
            game.spectator_queue.retain(|x| !(x.conn_id == conn_id && x.local == local));
            if let Some(c) = game.connections.get_mut(&conn_id) {
                c.set_local(local, Some(LocalSeat { role: Role::Spectator, slot_index: None }));
            }
        }
    }

    // Multiplayer inactivity timeout: every living snake idle for
    // playerIdleMs => the lobby is abandoned; kick the idle connections.
    let living: Vec<usize> = game
        .slots
        .iter()
        .enumerate()
        .filter(|(_, s)| matches!(s, Some(s) if s.alive))
        .map(|(i, _)| i)
        .collect();
    if !living.is_empty()
        && living.iter().all(|&i| {
            now - game.slots[i].as_ref().unwrap().last_input_at >= game.cfg.player_idle_ms
        })
    {
        game.dlog(&format!("lobby idle timeout players={}", living.len()));
        let mut idle_conn_ids: Vec<String> = living
            .iter()
            .map(|&i| game.slots[i].as_ref().unwrap().conn_id.clone())
            .collect();
        idle_conn_ids.dedup();
        for conn_id in idle_conn_ids {
            if let Some(c) = game.connections.get(&conn_id) {
                let _ = c.tx.send(WsOut::Close);
            }
            remove_connection(game, &conn_id);
        }
        broadcast_state(game);
    }
}

pub fn move_player_to_spectator(game: &mut Game, slot_index: usize) {
    let Some(s) = game.slots[slot_index].take() else { return };
    let conn_id = s.conn_id;
    if let Some(conn) = game.connections.get(&conn_id) {
        let local_idx = conn.locals.iter().position(|l| {
            matches!(l, Some(seat) if seat.role == Role::Player && seat.slot_index == Some(slot_index))
        });
        if let Some(li) = local_idx {
            let conn = game.connections.get_mut(&conn_id).unwrap();
            conn.set_local(li, Some(LocalSeat { role: Role::Spectator, slot_index: None }));
            game.spectator_queue.push(QueueEntry { conn_id: conn_id.clone(), local: li, since: now_ms() });
            let queue_len = game.spectator_queue.len();
            send_to(
                game,
                &conn_id,
                serde_json::json!({
                    "type": "spectator", "local": li,
                    "queuePos": queue_len, "queueLen": queue_len,
                    "disconnectMs": game.cfg.spectator_idle_ms
                }),
            );
        }
    }
    maybe_offer_slot(game);
}

pub struct KillInfo {
    pub killer: Option<usize>,
    pub cause: &'static str,
}

// Runs the moment a snake dies: kills its momentum, drops any pinata food,
// records a qualifying high score immediately (since initials are
// session-bound, this is the only safe time to write them), builds a
// kill-feed event for the next broadcast, and schedules the respawn timer
// that lifecycle_sweep will fire later.
pub fn handle_death(game: &mut Game, slot_index: usize, kill_info: &KillInfo) {
    if game.slots[slot_index].is_none() {
        return;
    }
    {
        let s = game.slots[slot_index].as_mut().unwrap();
        s.alive = false;
        s.boost = false;
        s.boost_since = None;
        s.ramp_progress = 0.0; // death kills momentum
        s.drift_dir = None;
    }
    // Pinata burst BEFORE the body is cleared on respawn.
    game.drop_pinata_food(slot_index);
    // Session-bound initials: a qualifying score is written RIGHT NOW.
    let conn_id = game.slots[slot_index].as_ref().unwrap().conn_id.clone();
    let local_idx = game
        .connections
        .get(&conn_id)
        .and_then(|c| game.local_index_for_slot(c, slot_index));
    if let Some(li) = local_idx {
        let mode = game.score_mode();
        record_if_qualifies(game, &conn_id, li, mode, slot_index);
        record_if_qualifies_food_rate(game, &conn_id, li, mode);
    }
    // Kill feed: one line per death, queued for the next broadcast.
    let victim_initials = local_idx
        .and_then(|li| game.connections.get(&conn_id).map(|c| c.initials_for(li).to_string()))
        .unwrap_or_else(|| "???".into());
    let victim_color = game.slots[slot_index].as_ref().unwrap().color;
    let mut event = KillEvent {
        victim: victim_initials,
        victim_color,
        killer: None,
        killer_color: None,
        cause: kill_info.cause,
        rivalry_count: None,
    };
    if let Some(ki) = kill_info.killer {
        if game.slots.get(ki).map_or(false, |s| s.is_some()) {
            let killer_initials = game.initials_for_slot(ki);
            event.killer_color = game.slots[ki].as_ref().unwrap().color;
            event.rivalry_count = Some(game.bump_rivalry(&killer_initials, &event.victim));
            event.killer = Some(killer_initials);
        }
    }
    game.kill_events.push(event);
    // Respawn timer (see module comment).
    game.slots[slot_index].as_mut().unwrap().respawn_at =
        Some(now_ms() + game.cfg.spectator_promote_delay_ms);
}
