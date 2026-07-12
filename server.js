// ============================================================
// Multiplayer Snake server.
//
// Authority: server authoritative for collisions/powerups; the client
// leads on movement (see predict.js). The server sends each player's
// authoritative dir so the client can confirm/retire predicted turns.
//
// Lifecycle (this build):
//   1. On death, if the score qualifies, the player is prompted for
//      initials and enters state "awaitInitials". They CANNOT respawn
//      until initials are submitted.
//   2. If initials are not submitted within INITIALS_TIMEOUT_MS (20s) the
//      player is moved to spectator.
//   3. Spectators sit in a global queue. A spectator is disconnected after
//      SPECTATOR_IDLE_MS (5 min) of being idle in the queue. This timeout
//      is GLOBAL (one shared constant).
//   4. When a slot opens, the front spectator is OFFERED the slot with an
//      explicit JOIN button (JOIN_OFFER_MS). If they do not accept, the
//      offer passes to the next spectator. This prevents AFK takeover.
//
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
const BUILD = "server 2026-07-12.6";
const WALL_GRACE_TICKS = Number.isInteger(CFG.wallGraceTicks) ? CFG.wallGraceTicks : 1;

// Lifecycle timeouts (config-overridable).
const INITIALS_TIMEOUT_MS = Number.isInteger(CFG.initialsTimeoutMs) ? CFG.initialsTimeoutMs : 20000;
const SPECTATOR_IDLE_MS = Number.isInteger(CFG.spectatorIdleMs) ? CFG.spectatorIdleMs : 300000; // global 5 min
const JOIN_OFFER_MS = Number.isInteger(CFG.joinOfferMs) ? CFG.joinOfferMs : 10000;

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
// Spectators: [{ connId, since }]. Global idle disconnect uses since.
let spectatorQueue = [];
let connections = new Map();
let food = null;
let sessionStart = null;
// Active join offer: { connId, expiresAt } or null.
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
}
function newPlayerSlot(connId) {
  return {
    connId, color: null, body: [], dir: { x: 1, y: 0 }, inputQueue: [],
    alive: true, score: 0, wallStalls: 0,
    awaitInitials: false, initialsDeadline: null
  };
}
function assignConnection(connId, ws) {
  const freeIndex = slots.findIndex(s => s === null);
  if (freeIndex !== -1 && spectatorQueue.length === 0 && !joinOffer) {
    slots[freeIndex] = newPlayerSlot(connId);
    slots[freeIndex].color = COLORS[freeIndex];
    spawnSnake(freeIndex);
    connections.set(connId, { ws, role: "player", slotIndex: freeIndex });
    if (sessionStart === null) sessionStart = Date.now();
    if (!food) placeFood();
  } else {
    spectatorQueue.push({ connId, since: Date.now() });
    connections.set(connId, { ws, role: "spectator", slotIndex: null });
    maybeOfferSlot();
  }
}
function removeConnection(connId) {
  const conn = connections.get(connId);
  if (!conn) return;
  connections.delete(connId);
  if (conn.role === "player") {
    slots[conn.slotIndex] = null;
    maybeOfferSlot();
  } else {
    spectatorQueue = spectatorQueue.filter(e => e.connId !== connId);
    if (joinOffer && joinOffer.connId === connId) { joinOffer = null; maybeOfferSlot(); }
  }
  if (slots.every(s => s === null) && spectatorQueue.length === 0) {
    sessionStart = null; food = null;
  }
}
// Offer an open slot to the front spectator with an explicit JOIN button.
// If they never accept, the offer expires and passes to the next spectator.
function maybeOfferSlot() {
  if (joinOffer) return;
  const openIndex = slots.findIndex(s => s === null);
  if (openIndex === -1) return;
  if (spectatorQueue.length === 0) return;
  const front = spectatorQueue[0];
  const conn = connections.get(front.connId);
  if (!conn) { spectatorQueue.shift(); return maybeOfferSlot(); }
  joinOffer = { connId: front.connId, expiresAt: Date.now() + JOIN_OFFER_MS };
  sendTo(conn.ws, { type: "offerJoin", acceptMs: JOIN_OFFER_MS });
}
function acceptJoin(connId) {
  if (!joinOffer || joinOffer.connId !== connId) return;
  const openIndex = slots.findIndex(s => s === null);
  if (openIndex === -1) { joinOffer = null; return; }
  spectatorQueue = spectatorQueue.filter(e => e.connId !== connId);
  joinOffer = null;
  const conn = connections.get(connId);
  if (!conn) { maybeOfferSlot(); return; }
  slots[openIndex] = newPlayerSlot(connId);
  slots[openIndex].color = COLORS[openIndex];
  spawnSnake(openIndex);
  conn.role = "player";
  conn.slotIndex = openIndex;
  if (sessionStart === null) sessionStart = Date.now();
  if (!food) placeFood();
}
// Timers: expire join offers and disconnect idle spectators (global).
function lifecycleSweep() {
  const now = Date.now();
  if (joinOffer && now >= joinOffer.expiresAt) {
    // front spectator did not accept: rotate them to the back, offer next.
    const idx = spectatorQueue.findIndex(e => e.connId === joinOffer.connId);
    if (idx !== -1) { const [e] = spectatorQueue.splice(idx, 1); spectatorQueue.push({ connId: e.connId, since: now }); }
    joinOffer = null;
    maybeOfferSlot();
  }
  // Global spectator idle disconnect.
  for (const e of spectatorQueue.slice()) {
    if (now - e.since >= SPECTATOR_IDLE_MS) {
      const conn = connections.get(e.connId);
      if (conn && conn.ws) { try { conn.ws.close(); } catch (_) {} }
      removeConnection(e.connId);
    }
  }
  // Initials deadline: move lingering awaitInitials players to spectator.
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s && s.awaitInitials && s.initialsDeadline && now >= s.initialsDeadline) {
      movePlayerToSpectator(i);
    }
  }
}
function movePlayerToSpectator(slotIndex) {
  const s = slots[slotIndex];
  if (!s) return;
  const conn = connections.get(s.connId);
  slots[slotIndex] = null;
  if (conn) {
    conn.role = "spectator";
    conn.slotIndex = null;
    spectatorQueue.push({ connId: s.connId, since: Date.now() });
    sendTo(conn.ws, { type: "spectator", queuePos: spectatorQueue.length, queueLen: spectatorQueue.length, disconnectMs: SPECTATOR_IDLE_MS });
  }
  maybeOfferSlot();
}
function currentTickMs() {
  if (sessionStart === null) return CFG.speed.startTickMs;
  const elapsedSec = (Date.now() - sessionStart) / 1000;
  const steps = Math.floor(elapsedSec / CFG.speed.rampIntervalSec);
  const ms = CFG.speed.startTickMs - steps * CFG.speed.rampStepMs;
  return Math.max(CFG.speed.minTickMs, ms);
}
let tickSeq = 0;
function scheduleTick() { setTimeout(gameTick, currentTickMs()); }
function gameTick() {
  lifecycleSweep();
  const active = slots.map((s, i) => ({ s, i })).filter(x => x.s && x.s.alive);
  if (active.length === 0) { tickSeq++; broadcastState(); scheduleTick(); return; }
  const newHeads = computeNewHeads(active);
  const died = new Map();
  const stalled = new Set();
  resolveWallCollisions(active, newHeads, died, stalled);
  resolveSelfCollisions(active, newHeads, died, stalled);
  resolveSnakeCollisions(active, newHeads, died, stalled);
  applyMovementAndFood(active, newHeads, died, stalled);
  applyKillBonuses(died);
  for (const [victimIndex] of died) handleDeath(victimIndex);
  tickSeq++;
  broadcastState();
  scheduleTick();
}
function inBounds(h) { return h.x >= 0 && h.x < CFG.grid.cols && h.y >= 0 && h.y < CFG.grid.rows; }
function consumeInboundsTurn(s) {
  const head = s.body[0];
  for (let k = 0; k < s.inputQueue.length; k++) {
    const d = s.inputQueue[k];
    if (d.x === -s.dir.x && d.y === -s.dir.y) continue;
    if (inBounds({ x: head.x + d.x, y: head.y + d.y })) { s.inputQueue.splice(0, k + 1); return d; }
  }
  return null;
}
function computeNewHeads(active) {
  const newHeads = new Map();
  for (const { s, i } of active) {
    if (s.inputQueue.length > 0) s.dir = s.inputQueue.shift();
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
// On death: if the score qualifies, gate on initials (no respawn until
// submitted or the deadline moves them to spectator). Otherwise respawn as
// before (subject to queue/offer flow).
function handleDeath(slotIndex) {
  const s = slots[slotIndex];
  if (!s) return;
  s.alive = false;
  const targets = qualifies(s.score);
  const conn = connections.get(s.connId);
  if (targets.length > 0 && conn) {
    s.awaitInitials = true;
    s.initialsDeadline = Date.now() + INITIALS_TIMEOUT_MS;
    sendTo(conn.ws, { type: "askInitials", targets, score: s.score, deadlineMs: INITIALS_TIMEOUT_MS });
    return; // do NOT schedule respawn; gated on initials
  }
  // Non-qualifying: respawn in place, or yield slot if spectators waiting.
  setTimeout(() => {
    if (!slots[slotIndex] || slots[slotIndex].connId !== s.connId) return;
    if (spectatorQueue.length > 0) movePlayerToSpectator(slotIndex);
    else spawnSnake(slotIndex);
  }, CFG.spectatorPromoteDelayMs);
}
function sendTo(ws, msg) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }
function broadcastState() {
  const state = {
    type: "state", build: BUILD, seq: tickSeq, serverTime: Date.now(),
    tickMs: currentTickMs(), grid: CFG.grid, food,
    players: slots.map((s, i) => s ? {
      slot: i, alive: s.alive, score: s.score, color: s.color, dir: s.dir, body: s.body
    } : null),
    highScores: { daily: highScores.daily, allTime: highScores.allTime }
  };
  for (const [connId, conn] of connections) {
    const you = conn.role === "player"
      ? { role: "player", slot: conn.slotIndex }
      : { role: "spectator", queuePos: spectatorQueue.findIndex(e => e.connId === connId) + 1, queueLen: spectatorQueue.length };
    sendTo(conn.ws, { ...state, you });
  }
}
const MIME = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json", ".css": "text/css" };
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
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
    // Cache-Control: no-cache on code/markup so a CDN edge (Cloudflare) does
    // not serve stale JS after a deploy. Assets still validate via ETag.
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
    if (msg.type === "dir" && conn.role === "player") {
      const slot = slots[conn.slotIndex];
      if (!slot || !slot.alive) return;
      const dirMap = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
      const nd = dirMap[msg.dir];
      if (!nd) return;
      // Dedup by client seq is unnecessary here: reversal/duplicate guard plus
      // the 2-item cap make a resent turn idempotent against the queue.
      if (slot.inputQueue.length >= 2) return;
      const last = slot.inputQueue.length > 0 ? slot.inputQueue[slot.inputQueue.length - 1] : slot.dir;
      const reversal = nd.x === -last.x && nd.y === -last.y;
      const duplicate = nd.x === last.x && nd.y === last.y;
      if (!reversal && !duplicate) slot.inputQueue.push(nd);
    }
    if (msg.type === "acceptJoin" && conn.role === "spectator") {
      acceptJoin(connId);
      broadcastState();
    }
    if (msg.type === "initials") {
      const initials = String(msg.value || "").toUpperCase().slice(0, 3).padEnd(3, "A");
      const targets = qualifies(msg.score || 0);
      recordScore(msg.targets || targets, initials, msg.score || 0);
      // Initials satisfied: clear the gate and respawn (or yield if queued).
      if (conn.role === "player") {
        const s = slots[conn.slotIndex];
        if (s) {
          s.awaitInitials = false;
          s.initialsDeadline = null;
          if (spectatorQueue.length > 0) movePlayerToSpectator(conn.slotIndex);
          else spawnSnake(conn.slotIndex);
        }
      }
      broadcastState();
    }
  });
  ws.on("close", () => { removeConnection(connId); broadcastState(); });
});
httpServer.listen(PORT, "127.0.0.1", () => {
  console.log("Multisnake listening on http://127.0.0.1:" + PORT + " build " + BUILD);
});
scheduleTick();
