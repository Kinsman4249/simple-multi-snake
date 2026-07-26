// HTTP routes: /api/config, /api/captcha, /api/verify, /api/admin/*, and the
// static file server for public/. WebSocket upgrade + message handling lives
// in ws.rs.
use crate::App;
use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use crate::powerups::POWERUP_TYPES;

pub(crate) fn no_store_json(body: String) -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

pub(crate) async fn api_config(State(app): State<App>) -> Response {
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

pub(crate) async fn api_captcha(State(app): State<App>) -> Response {
    let (id, a, b) = app.captcha.lock().unwrap().make();
    no_store_json(serde_json::json!({ "id": id, "a": a, "b": b }).to_string())
}

pub(crate) async fn api_verify(State(app): State<App>, body: String) -> Response {
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

// Used by install.sh before `systemctl restart multisnake`: broadcasts a
// maintenance-shutdown warning to every connected client (so players can
// finish their run to bank a high score) and reports how many connections
// got it, so the installer knows whether it's worth waiting out the warning
// period at all. Gated on ADMIN_TOKEN (see config/mod.rs) since Apache
// proxies "/" straight through, making this route internet-reachable, not
// loopback-only -- no configured token means the route always 403s, and a
// mismatched/missing X-Admin-Token header does too.
pub(crate) async fn api_admin_notify_shutdown(
    State(app): State<App>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let Some(expected) = &app.cfg.admin_token else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let given = headers.get("x-admin-token").and_then(|v| v.to_str().ok()).unwrap_or("");
    if given != expected {
        return StatusCode::FORBIDDEN.into_response();
    }
    let text = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(String::from))
        .unwrap_or_else(|| "The server is restarting for maintenance in 30 seconds.".to_string());

    let game = app.game.lock().unwrap();
    let connected = game.connections.len();
    if connected > 0 {
        crate::net::broadcast_notice(&game, &text);
    }
    no_store_json(serde_json::json!({ "connected": connected }).to_string())
}

pub(crate) async fn static_handler(State(app): State<App>, uri: Uri) -> Response {
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
