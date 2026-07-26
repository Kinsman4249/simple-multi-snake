// ============================================================
// Outbound network (port of server/net.js): send_to (single message) and
// broadcast_state (per-tick fanout with the serialize-once you-splice
// optimization -- the shared board state is serialized ONCE, and each
// connection's small per-you payload is spliced into the JSON string).
// ============================================================
use crate::config::COLORS;
use crate::powerups::{speed_multiplier, PowerupType, POWERUP_TYPES};
use crate::state::{Cell, Explosion, Game, Role, WallShatterFx, WsOut};
use serde::ser::{SerializeMap, Serializer};
use serde::Serialize;

// JS JSON.stringify emits integral floats without the ".0" -- match it for
// numbers a consumer might compare textually.
pub fn js_num(v: f64) -> serde_json::Value {
    if v.fract() == 0.0 && v.abs() < 9e15 {
        serde_json::Value::from(v as i64)
    } else {
        serde_json::Value::from(v)
    }
}

pub fn send_to(game: &Game, conn_id: &str, msg: serde_json::Value) {
    if let Some(conn) = game.connections.get(conn_id) {
        let _ = conn.tx.send(WsOut::Text(msg.to_string()));
    }
}

// Fans an arbitrary system message out to every open connection, e.g. the
// maintenance-shutdown warning (see routes::api_admin_notify_shutdown). One
// serialize, reused for every connection -- same shape as send_to's payload,
// just not tied to a single conn_id.
pub fn broadcast_notice(game: &Game, text: &str) {
    let payload = serde_json::json!({ "type": "systemNotice", "text": text }).to_string();
    for conn in game.connections.values() {
        let _ = conn.tx.send(WsOut::Text(payload.clone()));
    }
}

// #[derive(Serialize)] auto-generates the code to turn this struct into
// JSON; see docs/RUST-CHEATSHEET.md ("#[derive(...)]").
#[derive(Serialize)]
struct ColorView {
    head: &'static str,
    body: &'static str,
}
fn color_view(idx: Option<usize>) -> Option<ColorView> {
    idx.and_then(|i| COLORS.get(i)).map(|(h, b)| ColorView { head: h, body: b })
}

// Food serializes as {x,y}, with the bounty fields only when set (matching
// the JS objects, where normal food simply has no such keys).
// This is a "tuple struct" wrapping a borrowed &Food (see RUST-CHEATSHEET.md
// on references) -- writing our own `impl Serialize` below (instead of
// #[derive(Serialize)]) is how we get the "only include bounty fields when
// bounty is true" behavior that a plain derive can't express.
struct FoodView<'a>(&'a crate::state::Food);
impl Serialize for FoodView<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let f = self.0;
        let n = if f.bounty { 4 } else { 2 };
        let mut m = s.serialize_map(Some(n))?;
        m.serialize_entry("x", &f.x)?;
        m.serialize_entry("y", &f.y)?;
        if f.bounty {
            m.serialize_entry("bounty", &true)?;
            m.serialize_entry("expiresAtTick", &f.expires_at_tick)?;
        }
        m.end()
    }
}

// #[serde(rename_all = "camelCase")] converts our snake_case field names
// to the camelCase keys the JS client expects; see RUST-CHEATSHEET.md.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickupView<'a> {
    id: i64,
    #[serde(rename = "type")]
    ptype: &'a str,
    x: i32,
    y: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrailView<'a> {
    id: i64,
    #[serde(rename = "type")]
    ptype: &'a str,
    x: i32,
    y: i32,
    owner_slot: usize,
    expires_at_tick: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellView {
    id: i64,
    x: i32,
    y: i32,
    owner_slot: usize,
    move_accum_ms: f64,
    step_axis: &'static str,
}

#[derive(Serialize)]
struct WallView {
    id: i64,
    x: i32,
    y: i32,
    state: &'static str,
}

// Wormhole portal marker (2026-07-20 rework): pure render metadata. The
// id seeds the client's pulse phase (like wall/pickup ids); ownerSlot
// lets a client associate the portal with a snake if it ever needs to.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PortalView {
    id: i64,
    x: i32,
    y: i32,
    owner_slot: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KillView<'a> {
    victim: &'a str,
    victim_color: Option<ColorView>,
    killer: Option<&'a str>,
    killer_color: Option<ColorView>,
    cause: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    rivalry_count: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerView<'a> {
    slot: usize,
    alive: bool,
    score: usize,
    color: Option<ColorView>,
    dir: Cell,
    body: &'a [Cell],
    move_ms: i64,
    boost: bool,
    sliding: bool,
    held_powerup: Option<&'static str>,
    wormhole_charge: bool,
    scissors_charge: bool,
    active_powerup: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    activated: Option<&'static str>,
    ice_stacks: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    inverted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    teleport: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BoardView<'a> {
    daily: &'a [crate::highscores::Entry],
    all_time: &'a [crate::highscores::Entry],
    food_rate_daily: &'a [crate::highscores::Entry],
    food_rate_all_time: &'a [crate::highscores::Entry],
}

#[derive(Serialize)]
struct HighScoresView<'a> {
    local: BoardView<'a>,
    networked: BoardView<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GridView {
    cols: i32,
    rows: i32,
    cell_size: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StateMsg<'a> {
    #[serde(rename = "type")]
    msg_type: &'static str,
    build: &'a str,
    seq: i64,
    server_time: i64,
    tick_ms: f64,
    sim_hz: serde_json::Value,
    grid: GridView,
    foods: Vec<FoodView<'a>>,
    food: Option<FoodView<'a>>,
    powerup_pickups: Vec<PickupView<'a>>,
    trails: Vec<TrailView<'a>>,
    blue_shells: Vec<ShellView>,
    explosions: &'a [Explosion],
    wall_shatters: &'a [WallShatterFx],
    walls: Vec<WallView>,
    portal_fx: Vec<PortalView>,
    kills: Vec<KillView<'a>>,
    players: Vec<Option<PlayerView<'a>>>,
    high_scores: HighScoresView<'a>,
    mode: &'static str,
}

// The effective per-player movement rate (ms/cell) the client interpolates
// against: base interval over boost ramp x every speed-multiplier hook.
fn move_ms(game: &Game, s: &crate::state::Snake, interval: f64) -> i64 {
    let mut mult = 1.0 + (game.cfg.boost.boost_speed - 1.0) * s.ramp_progress;
    for t in POWERUP_TYPES {
        if t.has_speed_multiplier() {
            mult *= speed_multiplier(t, s, &game.cfg.powerups);
        }
    }
    (interval / mult).round() as i64
}

pub fn broadcast_state(game: &mut Game) {
    // Optional perf instrumentation: only pay for the clock read when the
    // perf flag is on (t0 stays None otherwise).
    let t0 = if game.cfg.perf { Some(std::time::Instant::now()) } else { None };
    let interval = game.current_move_interval_ms();
    let b_now = crate::config::now_ms();

    // .iter().enumerate().map(closure).collect() -- walk each slot with its
    // index, build a PlayerView (or None), gather into a Vec; see
    // RUST-CHEATSHEET.md ("Closures", "Vec<T>").
    let players: Vec<Option<PlayerView>> = game
        .slots
        .iter()
        .enumerate()
        .map(|(i, slot)| {
            slot.as_ref().map(|s| PlayerView {
                slot: i,
                alive: s.alive,
                score: s.body.len(),
                color: color_view(s.color),
                dir: s.dir,
                body: &s.body,
                move_ms: move_ms(game, s, interval),
                boost: s.ramp_progress > 0.0,
                sliding: s.drift_dir.is_some() && b_now < s.drift_until_ms,
                held_powerup: s.held_powerup.map(PowerupType::as_str),
                wormhole_charge: s.wormhole_charge,
                scissors_charge: s.scissors_charge,
                active_powerup: s.active_powerup.map(|a| a.ptype.as_str()),
                active_pct: s.active_powerup.map(|a| {
                    let span = (a.expires_at_tick - a.start_tick).max(1) as f64;
                    (((a.expires_at_tick - game.move_seq) as f64) / span).clamp(0.0, 1.0)
                }),
                activated: s.activated_fx.map(PowerupType::as_str),
                ice_stacks: s.ice_stacks,
                inverted: if game.is_inverted(s) { Some(true) } else { None },
                teleport: if s.teleported_this_tick { Some(true) } else { None },
            })
        })
        .collect();

    let walls: Vec<WallView> = game
        .walls
        .iter()
        .map(|w| {
            let state = if b_now < w.telegraph_until {
                "warn"
            } else if b_now >= w.solid_until - game.cfg.walls.despawn_telegraph_ms {
                "fading"
            } else {
                "solid"
            };
            WallView { id: w.id, x: w.x, y: w.y, state }
        })
        .collect();

    let portal_fx: Vec<PortalView> = game
        .portal_fx
        .iter()
        .map(|p| PortalView { id: p.id, x: p.x, y: p.y, owner_slot: p.owner_slot })
        .collect();

    let kills: Vec<KillView> = game
        .kill_events
        .iter()
        .map(|k| KillView {
            victim: &k.victim,
            victim_color: color_view(k.victim_color),
            killer: k.killer.as_deref(),
            killer_color: k.killer_color.and_then(|c| color_view(Some(c))),
            cause: k.cause,
            rivalry_count: k.rivalry_count,
        })
        .collect();

    let hs = &game.highscores.data.modes;
    let board = |b: &'static str| -> BoardView<'_> {
        let m = if b == "networked" { &hs.networked } else { &hs.local };
        BoardView {
            daily: &m.daily,
            all_time: &m.all_time,
            food_rate_daily: &m.food_rate_daily,
            food_rate_all_time: &m.food_rate_all_time,
        }
    };

    let state = StateMsg {
        msg_type: "state",
        build: &game.cfg.build,
        seq: game.move_seq,
        server_time: b_now,
        tick_ms: interval,
        sim_hz: js_num(game.cfg.sim_hz),
        grid: GridView {
            cols: game.cfg.grid.cols,
            rows: game.cfg.grid.rows,
            cell_size: game.cfg.grid.cell_size,
        },
        foods: game.foods.iter().map(FoodView).collect(),
        food: game.foods.first().map(FoodView),
        powerup_pickups: game
            .powerup_pickups
            .iter()
            .map(|p| PickupView { id: p.id, ptype: p.ptype.as_str(), x: p.x, y: p.y })
            .collect(),
        trails: game
            .trails
            .iter()
            .map(|t| TrailView {
                id: t.id,
                ptype: t.ptype.as_str(),
                x: t.x,
                y: t.y,
                owner_slot: t.owner_slot,
                expires_at_tick: t.expires_at_tick,
            })
            .collect(),
        blue_shells: game
            .blue_shells
            .iter()
            .map(|b| ShellView {
                id: b.id,
                x: b.x,
                y: b.y,
                owner_slot: b.owner_slot,
                move_accum_ms: b.move_accum_ms,
                step_axis: if b.step_axis_x { "x" } else { "y" },
            })
            .collect(),
        explosions: &game.explosions,
        wall_shatters: &game.wall_shatters,
        walls,
        portal_fx,
        kills,
        players,
        high_scores: HighScoresView { local: board("local"), networked: board("networked") },
        mode: game.score_mode(),
    };

    // Serialize the shared board state ONE time, no matter how many
    // connections we're about to send to (that's the "serialize-once"
    // optimization the module header mentions).
    let base_str = serde_json::to_string(&state).expect("state serialize");
    drop(state); // state's borrows (e.g. &game.explosions) must end before game is mutated below

    // One-shot flags: cleared right after this broadcast.
    for s in game.slots.iter_mut().flatten() {
        s.teleported_this_tick = false;
        s.activated_fx = None;
    }
    game.explosions.clear();
    game.wall_shatters.clear();
    game.kill_events.clear();

    if game.cfg.perf {
        game.perf.bytes_base += base_str.len() as u64;
    }
    // The "you-splice" trick: base_str is a JSON object ending in "}". Chop
    // off that final brace and append a `"you":` key -- each connection
    // below then just tacks on its own small per-connection payload and a
    // closing brace, instead of re-serializing the whole shared state.
    let base_prefix = format!("{},\"you\":", &base_str[..base_str.len() - 1]);

    // Spectator queue positions, precomputed once per broadcast.
    let queue_len = game.spectator_queue.len();
    let queue_pos = |conn_id: &str, local: usize| -> usize {
        game.spectator_queue
            .iter()
            .position(|e| e.conn_id == conn_id && e.local == local)
            .map(|p| p + 1)
            .unwrap_or(0)
    };

    let conn_ids: Vec<String> = game.conn_order.clone();
    for conn_id in conn_ids {
        let Some(conn) = game.connections.get(&conn_id) else { continue };
        let locals: Vec<serde_json::Value> = conn
            .locals
            .iter()
            .enumerate()
            .map(|(li, entry)| match entry {
                None => serde_json::Value::Null,
                Some(seat) => {
                    let food_rate = Game::food_rate_snapshot(conn, li)
                        .map(|(rate, locked)| serde_json::json!({ "ratePerMin": js_num(rate), "locked": locked }));
                    let mut o = if seat.role == Role::Player {
                        let ack = seat
                            .slot_index
                            .and_then(|si| game.slots.get(si).and_then(|s| s.as_ref()))
                            .map(|s| s.last_ack)
                            .unwrap_or(0);
                        serde_json::json!({
                            "local": li, "role": "player", "slot": seat.slot_index, "ack": ack
                        })
                    } else {
                        serde_json::json!({
                            "local": li, "role": "spectator",
                            "queuePos": queue_pos(&conn_id, li), "queueLen": queue_len
                        })
                    };
                    if let Some(fr) = food_rate {
                        o.as_object_mut().unwrap().insert("foodRate".into(), fr);
                    }
                    o
                }
            })
            .collect();
        let you = serde_json::json!({ "locals": locals });
        let payload = format!("{}{}}}", base_prefix, you);
        if game.cfg.perf {
            game.perf.bytes_total += payload.len() as u64;
            game.perf.sends += 1;
        }
        let _ = conn.tx.send(WsOut::Text(payload));
    }

    if let Some(t0) = t0 {
        let d = t0.elapsed().as_nanos();
        game.perf.bc_ns += d;
        game.perf.bc_calls += 1;
        if d > game.perf.bc_max_ns {
            game.perf.bc_max_ns = d;
        }
    }
}
