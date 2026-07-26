// ============================================================
// Multiplayer Snake server -- Rust port of the node/deno server.js entry
// point. Wires transport to game: the HTTP static/API server, the
// WebSocket upgrade + per-connection message handlers, the keepalive ping,
// the PERF summary printer, and the fixed-rate sim loop.
//
// The game logic modules mirror the JS server/ split one-to-one
// (config/state/highscores/captcha/net/lifecycle/sim + powerups) and the
// wire protocol is byte-compatible: the stock client and the whole
// tests/pw_*.js suite run against this server unchanged. HTTP route
// handlers live in routes.rs; WebSocket upgrade + message dispatch in ws.rs.
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
mod routes;
mod sim;
mod state;
mod ws;

use axum::body::Body;
use axum::http::Request;
use axum::routing::{any, get, post};
use axum::Router;
use hyper_util::rt::{TokioExecutor, TokioIo};
use std::sync::Arc;
use std::sync::Mutex;
use tokio::net::TcpListener;
use tower::ServiceExt;

use crate::captcha::Captcha;
use crate::config::{now_ms, Config};
use crate::net::js_num;
use crate::state::{Game, WsOut};

#[derive(Clone)]
pub(crate) struct App {
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
        .route("/api/config", get(routes::api_config))
        .route("/api/captcha", get(routes::api_captcha))
        .route("/api/verify", post(routes::api_verify))
        .route("/api/admin/notify-shutdown", post(routes::api_admin_notify_shutdown))
        .route("/ws", any(ws::ws_handler))
        .fallback(routes::static_handler)
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
