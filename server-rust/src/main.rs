// ============================================================
// Multiplayer Snake server -- Rust port of the node/deno server.js entry
// point. Wires transport to game: the HTTP static/API server, the
// WebSocket upgrade + per-connection message handlers, the keepalive ping,
// the PERF summary printer, and the fixed-rate sim loop.
//
// The game logic modules mirror the JS server/ split one-to-one
// (config/state/highscores/captcha/net/lifecycle/sim + powerups) and the
// wire protocol is byte-compatible: the stock client and the whole
// tests/pw_*.js suite run against this server unchanged.
//
// Run: cargo run --release (listens on 127.0.0.1:8080; PORT env or
// config.json "port" overrides).
// ============================================================
mod captcha;
mod config;
mod highscores;
mod lifecycle;
mod net;
mod powerups;
mod sim;
mod state;

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{RawQuery, State};
use axum::http::{header, Request, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::Router;
use hyper_util::rt::{TokioExecutor, TokioIo};
use std::sync::Arc;
use std::sync::Mutex;
use tokio::net::TcpListener;
use tower::ServiceExt;

use crate::captcha::Captcha;
use crate::config::{now_ms, Config};
use crate::net::{broadcast_state, js_num, send_to};
use crate::powerups::{PowerupType, POWERUP_TYPES};
use crate::state::{Cell, Game, Pickup, Wall, WsOut};

#[derive(Clone)]
struct App {
    cfg: &'static Config,
    game: Arc<Mutex<Game>>,
    captcha: Arc<Mutex<Captcha>>,
}

#[tokio::main]
async fn main() {
    let cfg = config::load();
    let hs = highscores::HighScores::open(cfg.root.join(&cfg.highscores_file));
    let game = Arc::new(Mutex::new(Game::new(cfg, hs)));
    let captcha = Arc::new(Mutex::new(Captcha::new(cfg.captcha_token_ttl_ms)));
    let app = App { cfg, game: game.clone(), captcha };

    // PERF summary printer (SNAKE_PERF only): one "[perf] {json}" line every
    // 5s, consumed by tests/perf_baseline.js.
    if cfg.perf {
        let game = game.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                let mut g = game.lock().unwrap();
                let mut total_segs = 0usize;
                let mut alive = 0usize;
                for s in g.slots.iter().flatten() {
                    if s.alive {
                        alive += 1;
                        total_segs += s.body.len();
                    }
                }
                let p = &g.perf;
                let round1 = |ns_avg: f64| (ns_avg / 100.0).round() / 10.0; // 0.1us precision
                let line = serde_json::json!({
                    "mvAvgUs": js_num(if p.mv_calls > 0 { round1(p.mv_ns as f64 / p.mv_calls as f64) } else { 0.0 }),
                    "mvMaxUs": js_num((p.mv_max_ns as f64 / 100.0).round() / 10.0),
                    "mvCalls": p.mv_calls,
                    "bcAvgUs": js_num(if p.bc_calls > 0 { round1(p.bc_ns as f64 / p.bc_calls as f64) } else { 0.0 }),
                    "bcMaxUs": js_num((p.bc_max_ns as f64 / 100.0).round() / 10.0),
                    "bcCalls": p.bc_calls,
                    "baseBytesAvg": if p.bc_calls > 0 { (p.bytes_base as f64 / p.bc_calls as f64).round() as u64 } else { 0 },
                    "totalBytes": p.bytes_total,
                    "sends": p.sends,
                    "alive": alive,
                    "totalSegs": total_segs
                });
                println!("[perf] {}", line);
                g.perf = state::PerfCounters::default();
            }
        });
    }

    // Keepalive ping, one sweep every 30s over every open connection.
    {
        let game = game.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                let g = game.lock().unwrap();
                for conn in g.connections.values() {
                    let _ = conn.tx.send(WsOut::Ping);
                }
            }
        });
    }

    // Fixed-rate simulation loop, anchored to an ABSOLUTE next-tick time so
    // timer jitter never accumulates into a slower effective tick rate.
    {
        let game = game.clone();
        let sim_ms = cfg.sim_ms;
        tokio::spawn(async move {
            loop {
                let delay_ms = {
                    let mut g = game.lock().unwrap();
                    sim::sim_tick(&mut g);
                    let now = now_ms() as f64;
                    let mut next = g.next_sim_at.unwrap_or(now) + sim_ms;
                    if next < now {
                        next = now + sim_ms; // fell too far behind: re-anchor
                    }
                    g.next_sim_at = Some(next);
                    (next - now_ms() as f64).max(0.0)
                };
                tokio::time::sleep(std::time::Duration::from_micros((delay_ms * 1000.0) as u64)).await;
            }
        });
    }

    let router = Router::new()
        .route("/api/config", get(api_config))
        .route("/api/captcha", get(api_captcha))
        .route("/api/verify", post(api_verify))
        .route("/ws", any(ws_handler))
        .fallback(static_handler)
        .with_state(app);

    let addr = format!("127.0.0.1:{}", cfg.port);
    let listener = TcpListener::bind(&addr).await.expect("bind");
    println!(
        "Multisnake listening on http://{} build {} (simHz={})",
        addr,
        cfg.build,
        js_num(cfg.sim_hz)
    );

    // Manual accept loop instead of axum::serve, purely to set TCP_NODELAY
    // on every socket: the kernel must not hold our small, frequent
    // broadcasts waiting to coalesce them (Nagle) -- that is pure added
    // latency for a realtime game.
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let _ = stream.set_nodelay(true);
        let tower_service = router.clone();
        tokio::spawn(async move {
            let socket = TokioIo::new(stream);
            let hyper_service =
                hyper::service::service_fn(move |request: Request<hyper::body::Incoming>| {
                    tower_service.clone().oneshot(request.map(Body::new))
                });
            let _ = hyper_util::server::conn::auto::Builder::new(TokioExecutor::new())
                .serve_connection_with_upgrades(socket, hyper_service)
                .await;
        });
    }
}

fn no_store_json(body: String) -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

async fn api_config(State(app): State<App>) -> Response {
    let cfg = app.cfg;
    let mut powerup_info = serde_json::Map::new();
    for t in POWERUP_TYPES {
        powerup_info.insert(
            t.as_str().to_string(),
            serde_json::json!({ "title": t.title(), "description": t.description() }),
        );
    }
    let body = serde_json::json!({
        "clientFx": cfg.client_fx,
        "clientRender": cfg.client_render,
        "enableDebug": cfg.enable_debug,
        "build": cfg.build,
        "boost": cfg.boost,
        "powerups": cfg.powerups,
        "powerupInfo": powerup_info
    });
    no_store_json(body.to_string())
}

async fn api_captcha(State(app): State<App>) -> Response {
    let (id, a, b) = app.captcha.lock().unwrap().make();
    no_store_json(serde_json::json!({ "id": id, "a": a, "b": b }).to_string())
}

async fn api_verify(State(app): State<App>, body: String) -> Response {
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(&body);
    let Ok(v) = parsed else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
    // The JS did Number(answer): accept numbers or numeric strings.
    let answer = match v.get("answer") {
        Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(serde_json::Value::String(s)) => s.trim().parse::<f64>().unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    let ok = answer.fract() == 0.0 && app.captcha.lock().unwrap().verify(id, answer as i64);
    if ok {
        let token = app.captcha.lock().unwrap().issue_token();
        no_store_json(serde_json::json!({ "token": token }).to_string())
    } else {
        (
            StatusCode::FORBIDDEN,
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            serde_json::json!({ "error": "incorrect" }).to_string(),
        )
            .into_response()
    }
}

async fn static_handler(State(app): State<App>, uri: Uri) -> Response {
    let path = uri.path();
    let rel = if path == "/" { "index.html" } else { path.trim_start_matches('/') };
    // Path traversal guard (the JS relied on path.join + startsWith; a
    // component check is equivalent and simpler).
    if rel.split('/').any(|c| c == ".." || c.is_empty()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let file_path = app.cfg.public_dir.join(rel);
    match std::fs::read(&file_path) {
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
        Ok(data) => {
            let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let mime = match ext {
                "html" => "text/html",
                "js" => "application/javascript",
                "json" => "application/json",
                "css" => "text/css",
                _ => "application/octet-stream",
            };
            let mut resp = Response::builder().header(header::CONTENT_TYPE, mime);
            if matches!(ext, "js" | "css" | "html") {
                resp = resp.header(header::CACHE_CONTROL, "no-cache");
            }
            resp.body(Body::from(data)).unwrap()
        }
    }
}

async fn ws_handler(
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
            sim::fire_powerup(g, si, ptype);
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
                            sim::fire_powerup(g, si, t);
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
