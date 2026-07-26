// WebSocket upgrade + per-connection message dispatch (dir/boost/powerup
// activation/seat lifecycle/test hooks). HTTP routes live in routes.rs.
use crate::captcha;
use crate::config::now_ms;
use crate::lifecycle;
use crate::net::{broadcast_state, send_to};
use crate::powerups::PowerupType;
use crate::state::{self, Cell, Game, Pickup, Wall, WsOut};
use crate::App;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{RawQuery, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

pub(crate) async fn ws_handler(
    State(app): State<App>,
    ws: WebSocketUpgrade,
    RawQuery(query): RawQuery,
) -> Response {
    // One-shot join token, minted by /api/verify.
    let token = query
        .as_deref()
        .and_then(|q| {
            q.split('&')
                .find_map(|kv| kv.strip_prefix("token=").map(String::from))
        })
        .unwrap_or_default();
    if !app.captcha.lock().unwrap().consume_token(&token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(app, socket))
}

async fn handle_socket(app: App, socket: WebSocket) {
    use futures_util::{SinkExt, StreamExt};
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<WsOut>();
    let conn_id = captcha::random_hex(8);

    // Writer task: drains the connection's outbound channel.
    let writer = tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            let res = match out {
                WsOut::Text(s) => sink.send(Message::Text(s.into())).await,
                WsOut::Ping => sink.send(Message::Ping(Vec::new().into())).await,
                WsOut::Close => {
                    let _ = sink.send(Message::Close(None)).await;
                    break;
                }
            };
            if res.is_err() {
                break;
            }
        }
    });

    {
        let mut g = app.game.lock().unwrap();
        lifecycle::assign_connection(&mut g, conn_id.clone(), tx);
        broadcast_state(&mut g);
    }

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(raw) => {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
                let mut g = app.game.lock().unwrap();
                handle_message(&mut g, &conn_id, &v);
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    {
        let mut g = app.game.lock().unwrap();
        lifecycle::remove_connection(&mut g, &conn_id);
        broadcast_state(&mut g);
    }
    writer.abort();
}

// JS Number.isInteger(msg.local) ? msg.local : 0
fn local_idx(v: &serde_json::Value) -> usize {
    v.get("local").and_then(|x| x.as_i64()).map_or(0, |n| n.max(0) as usize)
}

fn handle_message(g: &mut Game, conn_id: &str, msg: &serde_json::Value) {
    if !g.connections.contains_key(conn_id) {
        return;
    }
    let msg_type = msg.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match msg_type {
        "dir" => handle_dir(g, conn_id, msg),
        "boost" => handle_boost(g, conn_id, msg),
        "activatePowerup" => {
            // Fires the seat's HELD powerup. Deliberately does NOT touch
            // last_input_at (a powerup press must not keep an AFK lobby
            // alive).
            let li = local_idx(msg);
            let Some(si) = player_slot(g, conn_id, li) else { return };
            let ptype = {
                let s = g.slots[si].as_mut().unwrap();
                if !s.alive {
                    return;
                }
                let Some(t) = s.held_powerup.take() else { return };
                t
            };
            crate::sim::fire_powerup(g, si, ptype);
        }
        "leaveLocal" => {
            let li = local_idx(msg);
            let was_last = lifecycle::remove_local_seat(g, conn_id, li);
            if was_last {
                if let Some(c) = g.connections.get(conn_id) {
                    let _ = c.tx.send(WsOut::Close);
                }
                lifecycle::remove_connection(g, conn_id);
            }
            broadcast_state(g);
        }
        "acceptJoin" => {
            lifecycle::accept_join(g, conn_id, local_idx(msg));
            broadcast_state(g);
        }
        "joinLocal" => match lifecycle::add_local_player(g, conn_id) {
            Some(reason) => send_to(g, conn_id, serde_json::json!({ "type": "joinLocalDenied", "reason": reason })),
            None => broadcast_state(g),
        },
        "testHook" if g.cfg.test_hooks => {
            handle_test_hook(g, msg);
            broadcast_state(g);
        }
        "setInitials" => {
            // Session-bound initials: recorded server-side at death/leave; a
            // fabricated-score message stays impossible by construction.
            let li = local_idx(msg);
            if li >= 8 {
                return;
            }
            let value = msg.get("value").and_then(|v| v.as_str()).unwrap_or("");
            let initials: String = value
                .to_uppercase()
                .chars()
                .filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
                .take(3)
                .collect();
            if !initials.is_empty() {
                if let Some(c) = g.connections.get_mut(conn_id) {
                    c.set_initials(li, initials);
                }
            }
        }
        _ => {}
    }
}

// The slot index this connection's local seat controls, if it is a living
// player's seat.
fn player_slot(g: &Game, conn_id: &str, li: usize) -> Option<usize> {
    let conn = g.connections.get(conn_id)?;
    let seat = conn.local(li)?;
    if seat.role != state::Role::Player {
        return None;
    }
    let si = seat.slot_index?;
    g.slots.get(si)?.as_ref()?;
    Some(si)
}

fn handle_dir(g: &mut Game, conn_id: &str, msg: &serde_json::Value) {
    let li = local_idx(msg);
    let Some(si) = player_slot(g, conn_id, li) else { return };
    if !g.slots[si].as_ref().unwrap().alive {
        return;
    }
    let now = now_ms();
    let Some(mut nd) = msg
        .get("dir")
        .and_then(|d| d.as_str())
        .and_then(state::dir_vector)
    else {
        g.slots[si].as_mut().unwrap().last_input_at = now;
        return;
    };
    let inverted = g.is_inverted(g.slots[si].as_ref().unwrap());
    let input_buffer = g.cfg.input_buffer;
    let drift_threshold = g.cfg.boost.drift_threshold;
    let s = g.slots[si].as_mut().unwrap();
    s.last_input_at = now;
    // Banana inversion applies BEFORE the reversal/duplicate checks: the
    // "keep going forward" key inverts into a rejected reversal (the snake
    // coasts). Committed at keypress.
    if inverted {
        nd = Cell { x: -nd.x, y: -nd.y };
    }
    let cseq = msg.get("cseq").and_then(|c| c.as_i64());
    if s.input_queue.len() >= input_buffer {
        if let Some(c) = cseq {
            if c > s.last_ack {
                s.last_ack = c;
            }
        }
        return;
    }
    let last = s.input_queue.last().map(|i| Cell { x: i.x, y: i.y }).unwrap_or(s.dir);
    let reversal = nd.x == -last.x && nd.y == -last.y;
    let duplicate = nd.x == last.x && nd.y == last.y;
    if reversal || duplicate {
        if let Some(c) = cseq {
            if c > s.last_ack {
                s.last_ack = c;
            }
        }
        return;
    }
    // Drift eligibility follows the snake's momentum at keypress (v3.4.0).
    let sp = s.ramp_progress;
    let drift = if sp >= drift_threshold { sp } else { 0.0 };
    s.input_queue.push(state::Input { x: nd.x, y: nd.y, seq: cseq, drift });
}

fn handle_boost(g: &mut Game, conn_id: &str, msg: &serde_json::Value) {
    if !g.cfg.boost.enabled {
        return;
    }
    let li = local_idx(msg);
    let Some(si) = player_slot(g, conn_id, li) else { return };
    let s = g.slots[si].as_mut().unwrap();
    if !s.alive {
        return;
    }
    s.last_input_at = now_ms();
    let on = msg.get("on").and_then(|o| o.as_bool()) == Some(true);
    // Only a genuine off->on transition restarts the hold-grace/ramp clock.
    if on && !s.boost {
        s.boost_since = Some(now_ms());
    }
    if !on {
        s.boost_since = None;
    }
    s.boost = on;
}

// Test-only staging ops (inert in prod: the branch is dead without
// SNAKE_TEST_HOOKS=1). Ops operate on SLOT indices.
fn handle_test_hook(g: &mut Game, msg: &serde_json::Value) {
    let op = msg.get("op").and_then(|o| o.as_str()).unwrap_or("");
    let ptype = msg
        .get("ptype")
        .and_then(|p| p.as_str())
        .and_then(PowerupType::from_str);
    let xy = |k: &str| msg.get(k).and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    match op {
        "spawnPickup" => {
            if let Some(t) = ptype {
                let id = g.next_powerup_id;
                g.next_powerup_id += 1;
                g.powerup_pickups.push(Pickup { id, ptype: t, x: xy("x"), y: xy("y") });
            }
        }
        "grantPowerup" => {
            if let Some(t) = ptype {
                let slot = msg.get("slot").and_then(|s| s.as_i64()).unwrap_or(-1);
                if slot >= 0 && (slot as usize) < g.slots.len() {
                    let si = slot as usize;
                    let alive = matches!(&g.slots[si], Some(s) if s.alive);
                    if alive {
                        let held = msg.get("held").and_then(|h| h.as_bool()) == Some(true);
                        if t == PowerupType::Wormhole {
                            g.slots[si].as_mut().unwrap().wormhole_charge = true;
                        } else if t == PowerupType::Scissors {
                            g.slots[si].as_mut().unwrap().scissors_charge = true;
                        } else if held {
                            g.slots[si].as_mut().unwrap().held_powerup = Some(t);
                        } else {
                            crate::sim::fire_powerup(g, si, t);
                        }
                    }
                }
            }
        }
        "placeFood" => g.reroll_foods(),
        "spawnWall" => {
            // Places a wall directly at (x,y), bypassing the cell picker,
            // for deterministic staging. telegraphMs defaults to 0
            // (instantly solid), lifetimeMs to 30s.
            let wnow = now_ms();
            let telegraph_ms = msg.get("telegraphMs").and_then(|v| v.as_i64()).unwrap_or(0);
            let lifetime_ms = msg.get("lifetimeMs").and_then(|v| v.as_i64()).unwrap_or(30000);
            let id = g.next_powerup_id;
            g.next_powerup_id += 1;
            g.walls.push(Wall {
                id,
                x: xy("x"),
                y: xy("y"),
                telegraph_until: wnow + telegraph_ms,
                solid_until: wnow + telegraph_ms + lifetime_ms,
            });
        }
        "clearPickups" => g.powerup_pickups.clear(),
        _ => {}
    }
}
