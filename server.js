// ============================================================
// Multiplayer Snake server -- entry point.
//
// The once-monolithic server now lives in server/ (split 2026-07-16, no
// behavior change -- the full e2e suite gates both sides of the split):
//   server/config.js     config.json/env resolution, every tuning constant,
//                        powerup registry metadata, dlog/PERF switches
//   server/state.js      THE shared mutable game state (the S object) +
//                        board/snake primitives (spawn, food, leader scan)
//   server/highscores.js highscores.json persistence + qualification
//   server/captcha.js    captcha + one-shot join tokens
//   server/net.js        sendTo + broadcastState (serialize-once fanout)
//   server/lifecycle.js  seats/queue/co-op/idle sweeps/death/initials
//   server/sim.js        sim loop, movement, collisions, wormhole rescue,
//                        powerup runtime, blue shells, pickup spawner
// This file wires transport to game: the HTTP static/API server, the
// WebSocket upgrade + per-connection message handlers, the keepalive ping,
// and the PERF summary printer; then starts listening and kicks simLoop.
//
// A fixed simulation loop runs at CFG.simHz (default 60). Inputs are sampled
// every sim tick (so a keypress is on the server within ~1000/simHz ms).
// Movement is accumulated PER SNAKE (s.moveAccumMs): each snake advances
// one cell when its own accumulator crosses the shared ramped interval, and
// a boosting snake accumulates faster (CFG.boost.boostSpeed). State is
// broadcast only on ticks where at least one snake moved. seq counts
// MOVEMENT ticks (not sim frames), so client reconciliation and the input
// ack model are unchanged.
//
// Run: npm install ws ; node server.js
// ============================================================
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const {
  CFG, BUILD, PUBLIC_DIR, PORT, SIM_HZ, CLIENT_FX, CLIENT_RENDER,
  ENABLE_DEBUG, BOOST, boostRamp, POWERUPS, POWERUP_TYPES, POWERUP_INFO,
  INPUT_BUFFER, PERF, TEST_HOOKS
} = require("./server/config");
const { S, placeFood, isInverted } = require("./server/state");
const { makeCaptcha, verifyCaptcha, issueJoinToken, consumeJoinToken } = require("./server/captcha");
const { sendTo, broadcastState } = require("./server/net");
const {
  assignConnection, addLocalPlayer, removeLocalSeat, removeConnection,
  acceptJoin
} = require("./server/lifecycle");
const { simLoop, firePowerup } = require("./server/sim");

// PERF summary printer (SNAKE_PERF only): one "[perf] {json}" line every 5s,
// consumed by tests/perf_baseline.js. Lives here (not config.js) because it
// reads live slot state.
if (PERF) {
  const timer = setInterval(() => {
    let totalSegs = 0, alive = 0;
    for (const s of S.slots) if (s && s.alive) { alive++; totalSegs += s.body.length; }
    console.log("[perf] " + JSON.stringify({
      mvAvgUs: PERF.mvCalls ? Math.round(Number(PERF.mvNs / BigInt(PERF.mvCalls)) / 100) / 10 : 0,
      mvMaxUs: Math.round(Number(PERF.mvMaxNs) / 100) / 10,
      mvCalls: PERF.mvCalls,
      bcAvgUs: PERF.bcCalls ? Math.round(Number(PERF.bcNs / BigInt(PERF.bcCalls)) / 100) / 10 : 0,
      bcMaxUs: Math.round(Number(PERF.bcMaxNs) / 100) / 10,
      bcCalls: PERF.bcCalls,
      baseBytesAvg: PERF.bcCalls ? Math.round(PERF.bytesBase / PERF.bcCalls) : 0,
      totalBytes: PERF.bytesTotal,
      sends: PERF.sends,
      alive, totalSegs
    }));
    PERF.mvNs = 0n; PERF.mvCalls = 0; PERF.mvMaxNs = 0n;
    PERF.bcNs = 0n; PERF.bcCalls = 0; PERF.bcMaxNs = 0n;
    PERF.bytesBase = 0; PERF.bytesTotal = 0; PERF.sends = 0;
  }, 5000);
  timer.unref && timer.unref();
}

const MIME = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json", ".css": "text/css" };
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/config" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      clientFx: CLIENT_FX, clientRender: CLIENT_RENDER, enableDebug: ENABLE_DEBUG,
      boost: BOOST, powerups: POWERUPS, powerupInfo: POWERUP_INFO
    }));
    return;
  }
  if (url.pathname === "/api/captcha" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(makeCaptcha()));
    return;
  }
  if (url.pathname === "/api/verify" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      try {
        const { id, answer } = JSON.parse(body);
        if (verifyCaptcha(id, answer)) {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ token: issueJoinToken() }));
        } else {
          res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ error: "incorrect" }));
        }
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }
  let filePath = path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(filePath);
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
    if (ext === ".js" || ext === ".css" || ext === ".html") headers["Cache-Control"] = "no-cache";
    res.writeHead(200, headers);
    res.end(data);
  });
});
// perMessageDeflate stays explicitly OFF: compression would save a little
// bandwidth on these small, frequent frames but adds per-message CPU and
// buffering latency on both ends -- the wrong trade for a realtime game.
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/ws") { socket.destroy(); return; }
  const token = url.searchParams.get("token");
  if (!consumeJoinToken(token)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
  // Disable Nagle's algorithm (RFC 896) on the underlying TCP socket. Without
  // this, the kernel can hold small writes (our frequent, small game-state
  // broadcasts and dir messages) for tens of ms waiting to coalesce them with
  // more outbound data before sending, which is pure added round-trip latency
  // for a connection that is already small-and-frequent by nature. Must be
  // set on the raw net.Socket here, before it is handed to the WebSocketServer.
  socket.setNoDelay(true);
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws));
});
setInterval(() => {
  for (const [, conn] of S.connections) {
    if (conn.ws && conn.ws.readyState === conn.ws.OPEN) conn.ws.ping();
  }
}, 30000);
wss.on("connection", ws => {
  const connId = crypto.randomBytes(8).toString("hex");
  assignConnection(connId, ws);
  broadcastState();
  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const conn = S.connections.get(connId);
    if (!conn) return;
    if (msg.type === "dir") {
      // local selects which of this connection's local seats the turn
      // applies to (0 = p1, 1 = p2, ...). Defaults to 0 so a solo
      // connection that never sends the field still works unchanged.
      const localIdx = Number.isInteger(msg.local) ? msg.local : 0;
      const entry = conn.locals[localIdx];
      if (!entry || entry.role !== "player") return;
      const slot = S.slots[entry.slotIndex];
      if (!slot || !slot.alive) return;
      slot.lastInputAt = Date.now();
      const dirMap = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
      let nd = dirMap[msg.dir];
      if (!nd) return;
      // Banana-trail inversion: applied BEFORE the reversal/duplicate checks,
      // deliberately -- left/right and up/down swap, while the "keep going
      // forward" key inverts into a reversal and is rejected below (the snake
      // coasts; slipping never introduces a new self-death mode). Commit at
      // keypress: a press made while inverted stays inverted even if the
      // effect expires before the queue drains (same philosophy as the drift
      // tag further down).
      if (isInverted(slot)) nd = { x: -nd.x, y: -nd.y };
      const cseq = Number.isFinite(msg.cseq) ? msg.cseq : null;
      if (slot.inputQueue.length >= INPUT_BUFFER) {
        if (cseq != null && cseq > slot.lastAck) slot.lastAck = cseq;
        return;
      }
      const last = slot.inputQueue.length > 0 ? slot.inputQueue[slot.inputQueue.length - 1] : slot.dir;
      const reversal = nd.x === -last.x && nd.y === -last.y;
      const duplicate = nd.x === last.x && nd.y === last.y;
      if (reversal || duplicate) {
        if (cseq != null && cseq > slot.lastAck) slot.lastAck = cseq;
        return;
      }
      // Drift: a turn made at SPEED turns the head immediately but sets the
      // body skidding in the old direction for BOOST.driftMs * momentum (see
      // computeNewHeads/applyDriftSlides). v3.4.0: eligibility follows the
      // snake's current momentum (rampProgress), not the boost key -- a turn
      // right after releasing boost still skids until the speed decays below
      // BOOST.driftThreshold. Tagged at enqueue time so momentum committed
      // at keypress is honored even if the queue drains later.
      const sp = boostRamp(slot, Date.now());
      const drift = sp >= BOOST.driftThreshold ? sp : 0;
      slot.inputQueue.push({ x: nd.x, y: nd.y, seq: cseq, drift });
    }
    if (msg.type === "boost") {
      // Client-detected hold of the current-direction key. The flag only
      // scales this snake's movement accumulator; nothing else trusts it.
      if (!BOOST.enabled) return;
      const localIdx = Number.isInteger(msg.local) ? msg.local : 0;
      const entry = conn.locals[localIdx];
      if (!entry || entry.role !== "player") return;
      const slot = S.slots[entry.slotIndex];
      if (!slot || !slot.alive) return;
      slot.lastInputAt = Date.now();
      const on = msg.on === true;
      // boostSince anchors the hold-grace + ramp clock; only a genuine
      // off->on transition restarts it (repeated on:true messages must not
      // reset a ramp already in progress).
      if (on && !slot.boost) slot.boostSince = Date.now();
      if (!on) slot.boostSince = null;
      slot.boost = on;
    }
    if (msg.type === "activatePowerup") {
      // Fires the seat's HELD powerup (only speedBoost holds a slot now; all
      // other types auto-fire on pickup, see the collection handler). Wormhole
      // never occupies heldPowerup either, so this naturally no-ops for it.
      // Deliberately does NOT touch lastInputAt -- see lifecycleSweep's
      // PLAYER_IDLE_MS comment; a powerup activation must not silently keep an
      // AFK lobby alive.
      const localIdx = Number.isInteger(msg.local) ? msg.local : 0;
      const entry = conn.locals[localIdx];
      if (!entry || entry.role !== "player") return;
      const slot = S.slots[entry.slotIndex];
      if (!slot || !slot.alive || !slot.heldPowerup) return;
      const type = slot.heldPowerup;
      slot.heldPowerup = null;
      firePowerup(slot, entry.slotIndex, type);
    }
    if (msg.type === "leaveLocal") {
      // Explicit exit for one local seat (Leave button). If it was the
      // connection's last seat, the whole connection goes: solo leave means
      // a full disconnect back to the client's menu, no idling on screen.
      const localIdx = Number.isInteger(msg.local) ? msg.local : 0;
      const wasLastSeat = removeLocalSeat(connId, localIdx);
      if (wasLastSeat) {
        removeConnection(connId);
        try { conn.ws.close(1000, "left"); } catch (_) {}
      }
      broadcastState();
    }
    if (msg.type === "acceptJoin") {
      const localIdx = Number.isInteger(msg.local) ? msg.local : 0;
      acceptJoin(connId, localIdx);
      broadcastState();
    }
    if (msg.type === "joinLocal") {
      const reason = addLocalPlayer(connId);
      if (reason) sendTo(conn.ws, { type: "joinLocalDenied", reason });
      else broadcastState();
    }
    if (msg.type === "testHook" && TEST_HOOKS) {
      // Test-only staging (see the TEST_HOOKS const in server/config.js):
      // never reachable in prod (env unset => the whole branch is dead). Ops
      // operate on SLOT indices, matching what the state broadcast exposes.
      if (msg.op === "spawnPickup" && POWERUP_TYPES.includes(msg.ptype)) {
        S.powerupPickups.push({ id: S.nextPowerupId++, type: msg.ptype, x: msg.x | 0, y: msg.y | 0 });
      } else if (msg.op === "grantPowerup" && POWERUP_TYPES.includes(msg.ptype)) {
        const s = S.slots[msg.slot];
        if (s && s.alive) {
          if (msg.ptype === "wormhole") s.wormholeCharge = true;
          else if (msg.held) s.heldPowerup = msg.ptype;
          else firePowerup(s, msg.slot, msg.ptype);
        }
      } else if (msg.op === "placeFood") {
        placeFood();
      }
      broadcastState();
    }
    if (msg.type === "setInitials") {
      // Session-bound initials (v3.4.0): the client sends these up front
      // (page-load gate for P1, first-join prompt for P2, or the Change
      // Initials button any time) and they ride the whole session. Scores
      // are recorded server-side at death/leave with whatever is stored
      // here at that moment -- the client never submits a score, so a
      // fabricated-score message remains impossible by construction.
      const localIdx = Number.isInteger(msg.local) ? msg.local : 0;
      if (localIdx < 0 || localIdx >= 8) return;
      const initials = String(msg.value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
      if (initials) conn.initials[localIdx] = initials;
    }
  });
  ws.on("close", () => { removeConnection(connId); broadcastState(); });
});
httpServer.listen(PORT, "127.0.0.1", () => {
  console.log("Multisnake listening on http://127.0.0.1:" + PORT + " build " + BUILD +
              " (simHz=" + SIM_HZ + ")");
});
simLoop();
