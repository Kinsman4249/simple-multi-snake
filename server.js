// ============================================================
// Multiplayer Snake server (.14): DECOUPLED sim rate and movement cadence.
//
// A fixed simulation loop runs at CFG.simHz (default 60). Inputs are sampled
// every sim tick (so a keypress is on the server within ~1000/simHz ms). The
// snake advances ONE cell only when a movement accumulator crosses the current
// move interval (moveIntervalMs), which carries the speed ramp. Full state is
// broadcast only on movement ticks, so bandwidth is unchanged from before.
//
// seq counts MOVEMENT steps (not sim frames), so client reconciliation and the
// input ack model are unchanged. The client can align to the tiny sim tick
// (option B) for zero positional offset with imperceptible input lag.
//
// Authority + lifecycle + food + acks: same as .12/.13.
// Run: npm install ws ; node server.js
// ============================================================
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const HS_FILE = path.join(__dirname, "highscores.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = 8080;
const BUILD = "server 2026-07-12.18";

const SIM_HZ = Number.isFinite(CFG.simHz) && CFG.simHz > 0 ? CFG.simHz : 60;
const SIM_MS = 1000 / SIM_HZ;
const MOVE = CFG.move || { startIntervalMs: 160, minIntervalMs: 70, rampIntervalSec: 30, rampStepMs: 10 };
// Phase 3: dual local controls (couch co-op). A single WS connection may
// control more than one local seat -- conn.locals is an array indexed by
// local index (0 is "p1", arrow keys client-side; 1 is "p2", WASD). Each
// entry is { role: "player", slotIndex } or { role: "spectator",
// slotIndex: null }. Every local seat is admitted and queued exactly like a
// fresh solo connection would be (see admitLocal): a co-op connection gets
// NO fairness advantage over anyone else. If a slot isn't free and no one
// is waiting, the seat's connection gets it immediately; otherwise it goes
// to the back of the spectatorQueue and is offered a slot later like any
// other spectator. Capped by MAX_LOCAL_PLAYERS so one connection cannot
// occupy an unbounded number of seats.
const MAX_LOCAL_PLAYERS = Number.isInteger(CFG.maxLocalPlayers) && CFG.maxLocalPlayers > 0 ? CFG.maxLocalPlayers : 2;
// Purely cosmetic client-side effects (input flash, correction glide). Never
// gameplay-affecting and never client-configurable by design: on by default
// so the installer needs no prompt, with a single global on/off per effect
// here for the operator. Defaults keep the feature on even if an older
// config.json from before this key existed is still in place.
const CLIENT_FX = Object.assign(
  { inputFlash: true, inputFlashMs: 90, correctionGlide: true, correctionGlideMs: 90 },
  CFG.clientFx || {}
);
const WALL_GRACE_TICKS = Number.isInteger(CFG.wallGraceTicks) ? CFG.wallGraceTicks : 1;
const INITIALS_TIMEOUT_MS = Number.isInteger(CFG.initialsTimeoutMs) ? CFG.initialsTimeoutMs : 20000;
const SPECTATOR_IDLE_MS = Number.isInteger(CFG.spectatorIdleMs) ? CFG.spectatorIdleMs : 300000;
const JOIN_OFFER_MS = Number.isInteger(CFG.joinOfferMs) ? CFG.joinOfferMs : 10000;
const INPUT_BUFFER = Number.isInteger(CFG.inputBuffer) ? CFG.inputBuffer : 3;

function todayStr() { return new Date().toISOString().slice(0, 10); }
function loadHighScores() {
  let data;
  try { data = JSON.parse(fs.readFileSync(HS_FILE, "utf8")); }
  catch { data = { date: todayStr(), daily: [], allTime: [] }; }
  if (data.date !== todayStr()) { data.date = todayStr(); data.daily = []; }
  return data;
}
function saveHighScores(data) { fs.writeFileSync(HS_FILE, JSON.stringify(data, null, 2)); }
let highScores = loadHighScores();
function qualifies(score) {
  const targets = [];
  if (score <= 0) return targets;
  if (highScores.daily.length < 5 || score > highScores.daily[highScores.daily.length - 1].score) targets.push("daily");
  if (highScores.allTime.length < 5 || score > highScores.allTime[highScores.allTime.length - 1].score) targets.push("allTime");
  return targets;
}
function recordScore(targets, initials, score) {
  highScores = loadHighScores();
  for (const board of targets) {
    highScores[board].push({ initials, score });
    highScores[board].sort((a, b) => b.score - a.score);
    highScores[board] = highScores[board].slice(0, 5);
  }
  saveHighScores(highScores);
}
const pendingCaptchas = new Map();
const joinTokens = new Map();
function makeCaptcha() {
  const a = 1 + Math.floor(Math.random() * 9);
  const b = 1 + Math.floor(Math.random() * 9);
  const id = crypto.randomBytes(8).toString("hex");
  pendingCaptchas.set(id, a + b);
  setTimeout(() => pendingCaptchas.delete(id), 120000);
  return { id, a, b };
}
function verifyCaptcha(id, answer) {
  const expected = pendingCaptchas.get(id);
  pendingCaptchas.delete(id);
  if (expected === undefined) return false;
  return Number(answer) === expected;
}
function issueJoinToken() {
  const token = crypto.randomBytes(16).toString("hex");
  joinTokens.set(token, Date.now() + CFG.captchaTokenTtlMs);
  return token;
}
function consumeJoinToken(token) {
  const expiry = joinTokens.get(token);
  joinTokens.delete(token);
  return expiry !== undefined && Date.now() < expiry;
}
const COLORS = [
  { head: "#6f6", body: "#3a3" },
  { head: "#6cf", body: "#38a" },
  { head: "#f6f", body: "#a3a" },
  { head: "#ff6", body: "#aa3" }
];
let slots = new Array(CFG.maxPlayers).fill(null);
let spectatorQueue = [];
let connections = new Map();
let food = null;
let sessionStart = null;
let joinOffer = null;

function cellFree(x, y, ignoreSlotIndex = -1) {
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s || i === ignoreSlotIndex) continue;
    if (s.body.some(seg => seg.x === x && seg.y === y)) return false;
  }
  return true;
}
function placeFood() {
  let x, y;
  do {
    x = Math.floor(Math.random() * CFG.grid.cols);
    y = Math.floor(Math.random() * CFG.grid.rows);
  } while (!cellFree(x, y));
  food = { x, y };
}
function spawnSnake(slotIndex) {
  let x, y, attempts = 0;
  do {
    x = 3 + Math.floor(Math.random() * (CFG.grid.cols - 6));
    y = 3 + Math.floor(Math.random() * (CFG.grid.rows - 6));
    attempts++;
  } while ((!cellFree(x, y, slotIndex) || !cellFree(x - 1, y, slotIndex) || !cellFree(x - 2, y, slotIndex)) && attempts < 100);
  const s = slots[slotIndex];
  s.body = [{ x, y }, { x: x - 1, y }, { x: x - 2, y }];
  s.dir = { x: 1, y: 0 };
  s.inputQueue = [];
  s.alive = true;
  s.wallStalls = 0;
  s.awaitInitials = false;
  s.initialsDeadline = null;
  s.score = 0;
  s.lastAck = 0;
}
function newPlayerSlot(connId) {
  return {
    connId, color: null, body: [], dir: { x: 1, y: 0 }, inputQueue: [],
    alive: true, score: 0, wallStalls: 0,
    awaitInitials: false, initialsDeadline: null, lastAck: 0
  };
}
function assignConnection(connId, ws) {
  connections.set(connId, { ws, locals: [] });
  admitLocal(connId, 0);
}
// Seat a (new or re-requested) local player slot for connId at localIdx.
// This is the single admission path used by a fresh connect (localIdx 0),
// a couch-co-op joinLocal request (localIdx 1+), and nowhere else -- there
// is exactly one fairness rule, applied per LOCAL SEAT, not per connection:
// take a free slot immediately only if no one else is waiting, otherwise go
// to the back of the spectator queue like anyone else. A co-op connection
// gets no special treatment; each of its seats is round-robin fair on its
// own.
function admitLocal(connId, localIdx) {
  const conn = connections.get(connId);
  if (!conn) return;
  const freeIndex = slots.findIndex(s => s === null);
  if (freeIndex !== -1 && spectatorQueue.length === 0 && !joinOffer) {
    slots[freeIndex] = newPlayerSlot(connId);
    slots[freeIndex].color = COLORS[freeIndex];
    spawnSnake(freeIndex);
    conn.locals[localIdx] = { role: "player", slotIndex: freeIndex };
    if (sessionStart === null) sessionStart = Date.now();
    if (!food) placeFood();
  } else {
    spectatorQueue.push({ connId, local: localIdx, since: Date.now() });
    conn.locals[localIdx] = { role: "spectator", slotIndex: null };
    maybeOfferSlot();
  }
}
// Add a second (or later) local player seat to an existing connection
// (couch co-op). Only refused once config.maxLocalPlayers is reached --
// otherwise the new seat is admitted exactly like a fresh join, including
// going to the back of the spectator queue if one is already forming. This
// is deliberate: a co-op connection must not be able to hog two board slots
// while other connections wait; each local seat stands in line on its own.
function addLocalPlayer(connId) {
  const conn = connections.get(connId);
  if (!conn) return "not connected";
  if (conn.locals.length >= MAX_LOCAL_PLAYERS) return "max local players reached";
  admitLocal(connId, conn.locals.length);
  return null;
}
// After a death that does not need (or has finished) the initials prompt:
// round robin, no exceptions. If anyone is waiting, THIS seat yields its
// slot to the queue, exactly the same whether it belongs to a solo
// connection or one seat of a co-op pair. The other seat on a co-op
// connection (if any) is unaffected either way.
function respawnOrSpectate(slotIndex) {
  if (spectatorQueue.length > 0) movePlayerToSpectator(slotIndex);
  else spawnSnake(slotIndex);
}
function removeConnection(connId) {
  const conn = connections.get(connId);
  if (!conn) return;
  connections.delete(connId);
  for (const entry of conn.locals) {
    if (entry && entry.role === "player" && entry.slotIndex != null) slots[entry.slotIndex] = null;
  }
  spectatorQueue = spectatorQueue.filter(e => e.connId !== connId);
  if (joinOffer && joinOffer.connId === connId) joinOffer = null;
  maybeOfferSlot();
  if (slots.every(s => s === null) && spectatorQueue.length === 0) {
    sessionStart = null; food = null;
  }
}
function maybeOfferSlot() {
  if (joinOffer) return;
  const openIndex = slots.findIndex(s => s === null);
  if (openIndex === -1) return;
  if (spectatorQueue.length === 0) return;
  const front = spectatorQueue[0];
  const conn = connections.get(front.connId);
  const seat = conn && conn.locals[front.local];
  if (!conn || !seat || seat.role !== "spectator") {
    // Stale entry (disconnected, or this seat already left the queue some
    // other way) -- drop it and try the next one in line.
    spectatorQueue.shift();
    return maybeOfferSlot();
  }
  joinOffer = { connId: front.connId, local: front.local, expiresAt: Date.now() + JOIN_OFFER_MS };
  sendTo(conn.ws, { type: "offerJoin", local: front.local, acceptMs: JOIN_OFFER_MS });
}
function acceptJoin(connId, localIdx) {
  if (!joinOffer || joinOffer.connId !== connId || joinOffer.local !== localIdx) return;
  const openIndex = slots.findIndex(s => s === null);
  if (openIndex === -1) { joinOffer = null; return; }
  spectatorQueue = spectatorQueue.filter(e => !(e.connId === connId && e.local === localIdx));
  joinOffer = null;
  const conn = connections.get(connId);
  if (!conn) { maybeOfferSlot(); return; }
  slots[openIndex] = newPlayerSlot(connId);
  slots[openIndex].color = COLORS[openIndex];
  spawnSnake(openIndex);
  conn.locals[localIdx] = { role: "player", slotIndex: openIndex };
  if (sessionStart === null) sessionStart = Date.now();
  if (!food) placeFood();
}
function lifecycleSweep() {
  const now = Date.now();
  if (joinOffer && now >= joinOffer.expiresAt) {
    const idx = spectatorQueue.findIndex(e => e.connId === joinOffer.connId && e.local === joinOffer.local);
    if (idx !== -1) { const [e] = spectatorQueue.splice(idx, 1); spectatorQueue.push({ connId: e.connId, local: e.local, since: now }); }
    joinOffer = null;
    maybeOfferSlot();
  }
  for (const e of spectatorQueue.slice()) {
    if (now - e.since >= SPECTATOR_IDLE_MS) {
      const conn = connections.get(e.connId);
      const otherSeatStillPlaying = conn && conn.locals.some((l, idx) => idx !== e.local && l && l.role === "player");
      if (!otherSeatStillPlaying) {
        // Nothing else on this connection is active: close the socket, as
        // before.
        if (conn && conn.ws) { try { conn.ws.close(); } catch (_) {} }
        removeConnection(e.connId);
      } else {
        // A co-op connection where the OTHER local seat is still actively
        // playing: closing the whole connection would eject that seat too,
        // which would be wrong. Simplification, not yet live-tested: this
        // seat just abandons the queue rather than the socket closing; the
        // player can request it again later with joinLocal. See TODO.md.
        spectatorQueue = spectatorQueue.filter(x => !(x.connId === e.connId && x.local === e.local));
        if (conn) conn.locals[e.local] = { role: "spectator", slotIndex: null, abandoned: true };
      }
    }
  }
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s && s.awaitInitials && s.initialsDeadline && now >= s.initialsDeadline) {
      s.awaitInitials = false;
      s.initialsDeadline = null;
      respawnOrSpectate(i);
    }
  }
}
function movePlayerToSpectator(slotIndex) {
  const s = slots[slotIndex];
  if (!s) return;
  const conn = connections.get(s.connId);
  slots[slotIndex] = null;
  if (conn) {
    const localIdx = conn.locals.findIndex(l => l && l.role === "player" && l.slotIndex === slotIndex);
    if (localIdx !== -1) {
      conn.locals[localIdx] = { role: "spectator", slotIndex: null };
      spectatorQueue.push({ connId: s.connId, local: localIdx, since: Date.now() });
      sendTo(conn.ws, {
        type: "spectator", local: localIdx,
        queuePos: spectatorQueue.length, queueLen: spectatorQueue.length, disconnectMs: SPECTATOR_IDLE_MS
      });
    }
  }
  maybeOfferSlot();
}
// Current movement interval (ms per cell), carrying the ramp.
function currentMoveIntervalMs() {
  if (sessionStart === null) return MOVE.startIntervalMs;
  const elapsedSec = (Date.now() - sessionStart) / 1000;
  const steps = Math.floor(elapsedSec / MOVE.rampIntervalSec);
  const ms = MOVE.startIntervalMs - steps * MOVE.rampStepMs;
  return Math.max(MOVE.minIntervalMs, ms);
}
let moveSeq = 0;         // counts MOVEMENT steps (used as network seq)
let moveAccumMs = 0;     // accumulator toward the next movement step
let lastSimAt = null;

// Fixed-rate simulation loop: sample inputs every tick, move on cadence.
function simLoop() {
  const now = Date.now();
  const dt = lastSimAt == null ? SIM_MS : (now - lastSimAt);
  lastSimAt = now;
  lifecycleSweep();
  moveAccumMs += dt;
  const interval = currentMoveIntervalMs();
  // Advance movement steps for each whole interval elapsed (usually 0 or 1).
  let moved = false;
  let guard = 0;
  while (moveAccumMs >= interval && guard < 5) {
    moveAccumMs -= interval;
    movementStep();
    moved = true;
    guard++;
  }
  if (moved) broadcastState();
  setTimeout(simLoop, SIM_MS);
}
function movementStep() {
  const active = slots.map((s, i) => ({ s, i })).filter(x => x.s && x.s.alive);
  if (active.length === 0) { moveSeq++; return; }
  const newHeads = computeNewHeads(active);
  const died = new Map();
  const stalled = new Set();
  resolveWallCollisions(active, newHeads, died, stalled);
  resolveSelfCollisions(active, newHeads, died, stalled);
  resolveSnakeCollisions(active, newHeads, died, stalled);
  applyMovementAndFood(active, newHeads, died, stalled);
  applyKillBonuses(died);
  for (const [victimIndex] of died) handleDeath(victimIndex);
  moveSeq++;
}
function inBounds(h) { return h.x >= 0 && h.x < CFG.grid.cols && h.y >= 0 && h.y < CFG.grid.rows; }
function consumeInboundsTurn(s) {
  const head = s.body[0];
  for (let k = 0; k < s.inputQueue.length; k++) {
    const d = s.inputQueue[k];
    if (d.x === -s.dir.x && d.y === -s.dir.y) continue;
    if (inBounds({ x: head.x + d.x, y: head.y + d.y })) {
      for (let j = 0; j <= k; j++) if (s.inputQueue[j].seq != null) s.lastAck = s.inputQueue[j].seq;
      s.inputQueue.splice(0, k + 1);
      return d;
    }
  }
  return null;
}
function computeNewHeads(active) {
  const newHeads = new Map();
  for (const { s, i } of active) {
    if (s.inputQueue.length > 0) {
      const inp = s.inputQueue.shift();
      s.dir = inp;
      if (inp.seq != null) s.lastAck = inp.seq;
    }
    const head = s.body[0];
    newHeads.set(i, { x: head.x + s.dir.x, y: head.y + s.dir.y });
  }
  return newHeads;
}
function resolveWallCollisions(active, newHeads, died, stalled) {
  for (const { s, i } of active) {
    if (died.has(i)) continue;
    let h = newHeads.get(i);
    if (inBounds(h)) { s.wallStalls = 0; continue; }
    const saved = consumeInboundsTurn(s);
    if (saved) { s.dir = saved; h = { x: s.body[0].x + saved.x, y: s.body[0].y + saved.y }; newHeads.set(i, h); s.wallStalls = 0; continue; }
    if (s.wallStalls < WALL_GRACE_TICKS) { s.wallStalls++; stalled.add(i); newHeads.set(i, { x: s.body[0].x, y: s.body[0].y }); continue; }
    died.set(i, null); s.wallStalls = 0;
  }
}
function resolveSelfCollisions(active, newHeads, died, stalled) {
  for (const { s, i } of active) {
    if (died.has(i) || stalled.has(i)) continue;
    const h = newHeads.get(i);
    if (s.body.slice(0, -1).some(seg => seg.x === h.x && seg.y === h.y)) died.set(i, null);
  }
}
function resolveSnakeCollisions(active, newHeads, died, stalled) {
  for (const { i } of active) {
    if (died.has(i) || stalled.has(i)) continue;
    const h = newHeads.get(i);
    for (const { s: other, i: j } of active) {
      if (j === i || died.has(j)) continue;
      const otherHead = newHeads.get(j);
      if (!stalled.has(j) && h.x === otherHead.x && h.y === otherHead.y) { died.set(i, null); died.set(j, null); continue; }
      if (other.body.slice(0, -1).some(seg => seg.x === h.x && seg.y === h.y)) died.set(i, j);
    }
  }
}
function applyMovementAndFood(active, newHeads, died, stalled) {
  for (const { s, i } of active) {
    if (died.has(i) || stalled.has(i)) continue;
    const h = newHeads.get(i);
    s.body.unshift(h);
    if (food && h.x === food.x && h.y === food.y) { s.score += 1; placeFood(); }
    else s.body.pop();
    s.wallStalls = 0;
  }
}
function applyKillBonuses(died) {
  for (const [, killerIndex] of died) {
    if (killerIndex === null) continue;
    const killer = slots[killerIndex];
    if (!killer || !killer.alive) continue;
    killer.score += CFG.killBonusScore;
    const tail = killer.body[killer.body.length - 1];
    for (let n = 0; n < CFG.killBonusGrowth; n++) killer.body.push({ ...tail });
  }
}
function handleDeath(slotIndex) {
  const s = slots[slotIndex];
  if (!s) return;
  s.alive = false;
  const targets = qualifies(s.score);
  const conn = connections.get(s.connId);
  const localIdx = conn ? conn.locals.findIndex(l => l && l.role === "player" && l.slotIndex === slotIndex) : -1;
  if (targets.length > 0 && conn && localIdx !== -1) {
    s.awaitInitials = true;
    s.initialsDeadline = Date.now() + INITIALS_TIMEOUT_MS;
    sendTo(conn.ws, { type: "askInitials", targets, score: s.score, deadlineMs: INITIALS_TIMEOUT_MS, local: localIdx });
    return;
  }
  setTimeout(() => {
    if (!slots[slotIndex] || slots[slotIndex].connId !== s.connId) return;
    respawnOrSpectate(slotIndex);
  }, CFG.spectatorPromoteDelayMs);
}
function sendTo(ws, msg) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }
function broadcastState() {
  const state = {
    type: "state", build: BUILD, seq: moveSeq, serverTime: Date.now(),
    tickMs: currentMoveIntervalMs(), simHz: SIM_HZ, grid: CFG.grid, food,
    players: slots.map((s, i) => s ? {
      slot: i, alive: s.alive, score: s.score, color: s.color, dir: s.dir, body: s.body
    } : null),
    highScores: { daily: highScores.daily, allTime: highScores.allTime }
  };
  for (const [connId, conn] of connections) {
    const you = {
      locals: conn.locals.map((entry, localIdx) => {
        if (!entry) return null;
        if (entry.role === "player") {
          const s = slots[entry.slotIndex];
          return { local: localIdx, role: "player", slot: entry.slotIndex, ack: s ? s.lastAck : 0 };
        }
        const queuePos = spectatorQueue.findIndex(e => e.connId === connId && e.local === localIdx) + 1;
        return { local: localIdx, role: "spectator", queuePos, queueLen: spectatorQueue.length };
      })
    };
    sendTo(conn.ws, { ...state, you });
  }
}
const MIME = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json", ".css": "text/css" };
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/config" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ clientFx: CLIENT_FX }));
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
const wss = new WebSocketServer({ noServer: true });
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
  for (const [, conn] of connections) {
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
    const conn = connections.get(connId);
    if (!conn) return;
    if (msg.type === "dir") {
      // local selects which of this connection's local seats the turn
      // applies to (0 = p1, 1 = p2, ...). Defaults to 0 so a solo
      // connection that never sends the field still works unchanged.
      const localIdx = Number.isInteger(msg.local) ? msg.local : 0;
      const entry = conn.locals[localIdx];
      if (!entry || entry.role !== "player") return;
      const slot = slots[entry.slotIndex];
      if (!slot || !slot.alive) return;
      const dirMap = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
      const nd = dirMap[msg.dir];
      if (!nd) return;
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
      slot.inputQueue.push({ x: nd.x, y: nd.y, seq: cseq });
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
    if (msg.type === "initials") {
      const initials = String(msg.value || "").toUpperCase().slice(0, 3).padEnd(3, "A");
      const targets = qualifies(msg.score || 0);
      recordScore(msg.targets || targets, initials, msg.score || 0);
      const localIdx = Number.isInteger(msg.local) ? msg.local : 0;
      const entry = conn.locals[localIdx];
      if (entry && entry.role === "player" && entry.slotIndex != null) {
        const s = slots[entry.slotIndex];
        if (s) {
          s.awaitInitials = false;
          s.initialsDeadline = null;
          respawnOrSpectate(entry.slotIndex);
        }
      }
      broadcastState();
    }
  });
  ws.on("close", () => { removeConnection(connId); broadcastState(); });
});
httpServer.listen(PORT, "127.0.0.1", () => {
  console.log("Multisnake listening on http://127.0.0.1:" + PORT + " build " + BUILD +
              " (simHz=" + SIM_HZ + ")");
});
simLoop();
