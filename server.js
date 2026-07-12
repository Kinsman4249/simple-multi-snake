// ============================================================
// Multiplayer Snake server.
// One authoritative process. Apache reverse-proxies HTTP and the
// WebSocket upgrade to this process; this process serves the
// static client, a two-step math captcha, and the live game.
//
// Run: npm install ws
//      node server.js
// Config lives in config.json next to this file (restart to reload it).
// ============================================================
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws"); // npm install ws

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const HS_FILE = path.join(__dirname, "highscores.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = 8080;

// ------------------------------------------------------------
// High score persistence
// Two lists: "daily" (resets when the calendar date changes) and
// "allTime" (never resets). Each holds at most 5 entries.
// ------------------------------------------------------------
function todayStr() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}
function loadHighScores() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(HS_FILE, "utf8"));
  } catch {
    data = { date: todayStr(), daily: [], allTime: [] };
  }
  // If the stored date is not today, the daily board resets.
  if (data.date !== todayStr()) {
    data.date = todayStr();
    data.daily = [];
  }
  return data;
}
function saveHighScores(data) {
  fs.writeFileSync(HS_FILE, JSON.stringify(data, null, 2));
}
let highScores = loadHighScores();

// Returns which boards (daily/allTime) a given score would place into the top 5 of.
function qualifies(score) {
  const targets = [];
  if (highScores.daily.length < 5 || score > highScores.daily[highScores.daily.length - 1].score) {
    targets.push("daily");
  }
  if (highScores.allTime.length < 5 || score > highScores.allTime[highScores.allTime.length - 1].score) {
    targets.push("allTime");
  }
  return targets;
}
function recordScore(targets, initials, score) {
  highScores = loadHighScores(); // pick up a possible day rollover first
  for (const board of targets) {
    highScores[board].push({ initials, score });
    highScores[board].sort((a, b) => b.score - a.score);
    highScores[board] = highScores[board].slice(0, 5);
  }
  saveHighScores(highScores);
}

// ------------------------------------------------------------
// Super simple math captcha, meant only to stop naive scripted
// joins. Cloudflare is expected to be doing the real bot filtering
// in front of this. Tokens are one-time and short lived.
// ------------------------------------------------------------
const pendingCaptchas = new Map(); // captchaId -> expected sum
const joinTokens = new Map();      // token -> expiry timestamp
function makeCaptcha() {
  const a = 1 + Math.floor(Math.random() * 9);
  const b = 1 + Math.floor(Math.random() * 9);
  const id = crypto.randomBytes(8).toString("hex");
  pendingCaptchas.set(id, a + b);
  // Expire unused captchas after 2 minutes so the map does not grow forever.
  setTimeout(() => pendingCaptchas.delete(id), 120000);
  return { id, a, b };
}
function verifyCaptcha(id, answer) {
  const expected = pendingCaptchas.get(id);
  pendingCaptchas.delete(id); // one-time use regardless of outcome
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
  joinTokens.delete(token); // one-time use
  return expiry !== undefined && Date.now() < expiry;
}

// ------------------------------------------------------------
// Game state
// slots: fixed-size array, one entry per possible player (null = empty)
// spectatorQueue: FIFO array of connection ids waiting for a slot
// connections: connId -> { ws, role, slotIndex }
// ------------------------------------------------------------
const COLORS = [
  { head: "#6f6", body: "#3a3" }, // green
  { head: "#6cf", body: "#38a" }, // blue
  { head: "#f6f", body: "#a3a" }, // magenta
  { head: "#ff6", body: "#aa3" }  // yellow
];
let slots = new Array(CFG.maxPlayers).fill(null);
let spectatorQueue = [];
let connections = new Map();
let food = null;
let sessionStart = null; // set when the board goes from empty to non-empty; drives the speed ramp

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
// Spawns a fresh 3-segment snake for a slot at a random clear spot, facing right.
function spawnSnake(slotIndex) {
  let x, y;
  let attempts = 0;
  do {
    x = 3 + Math.floor(Math.random() * (CFG.grid.cols - 6));
    y = 3 + Math.floor(Math.random() * (CFG.grid.rows - 6));
    attempts++;
    // Keep searching while ANY of the three spawn cells is occupied.
  } while ((!cellFree(x, y, slotIndex) || !cellFree(x - 1, y, slotIndex) || !cellFree(x - 2, y, slotIndex)) && attempts < 100);
  slots[slotIndex].body = [{ x, y }, { x: x - 1, y }, { x: x - 2, y }];
  slots[slotIndex].dir = { x: 1, y: 0 };
  slots[slotIndex].inputQueue = [];
  slots[slotIndex].alive = true;
  slots[slotIndex].respawnAt = null;
}
function newPlayerSlot(connId) {
  return {
    connId,
    color: null, // assigned once we know the slot index
    body: [],
    dir: { x: 1, y: 0 },
    inputQueue: [],
    alive: true,
    score: 0,
    respawnAt: null
  };
}
// Assigns a newly joined connection to an open slot, or to the spectator queue.
function assignConnection(connId, ws) {
  const freeIndex = slots.findIndex(s => s === null);
  if (freeIndex !== -1 && spectatorQueue.length === 0) {
    slots[freeIndex] = newPlayerSlot(connId);
    slots[freeIndex].color = COLORS[freeIndex];
    spawnSnake(freeIndex);
    connections.set(connId, { ws, role: "player", slotIndex: freeIndex });
    if (sessionStart === null) sessionStart = Date.now(); // board went from empty to active
    if (!food) placeFood();
  } else {
    spectatorQueue.push(connId);
    connections.set(connId, { ws, role: "spectator", slotIndex: null });
  }
}
// Frees a slot or removes a connection from the spectator queue on disconnect.
function removeConnection(connId) {
  const conn = connections.get(connId);
  if (!conn) return;
  connections.delete(connId);
  if (conn.role === "player") {
    slots[conn.slotIndex] = null;
    promoteSpectatorInto(conn.slotIndex);
  } else {
    spectatorQueue = spectatorQueue.filter(id => id !== connId);
  }
  if (slots.every(s => s === null) && spectatorQueue.length === 0) {
    sessionStart = null; // board is empty, next joiner starts the speed ramp over
    food = null;
  }
}
// Pulls the next waiting spectator into a freed slot, if anyone is waiting.
function promoteSpectatorInto(slotIndex) {
  if (spectatorQueue.length === 0) return;
  const nextConnId = spectatorQueue.shift();
  const conn = connections.get(nextConnId);
  if (!conn) return; // they disconnected while queued
  slots[slotIndex] = newPlayerSlot(nextConnId);
  slots[slotIndex].color = COLORS[slotIndex];
  spawnSnake(slotIndex);
  conn.role = "player";
  conn.slotIndex = slotIndex;
}

// ------------------------------------------------------------
// Game loop
// Uses a self-rescheduling setTimeout (not setInterval) because the
// tick rate itself changes over time as the game speeds up.
// ------------------------------------------------------------
function currentTickMs() {
  if (sessionStart === null) return CFG.speed.startTickMs;
  const elapsedSec = (Date.now() - sessionStart) / 1000;
  const steps = Math.floor(elapsedSec / CFG.speed.rampIntervalSec);
  const ms = CFG.speed.startTickMs - steps * CFG.speed.rampStepMs;
  return Math.max(CFG.speed.minTickMs, ms);
}
// Single global tick sequence, shared by every player and broadcast to every
// client. There is deliberately no per-player or per-connection tick counter:
// one board, one authoritative clock, driven by the same self-rescheduling
// setTimeout chain as before. Client-side prediction (Phase 2 client work)
// runs on each browser's own requestAnimationFrame loop and never causes an
// extra server tick; it only smooths what gets drawn between the ticks that
// already happen here.
let tickSeq = 0;

function scheduleTick() {
  setTimeout(gameTick, currentTickMs());
}

// gameTick is now a small pipeline of named stages instead of one long
// function. Behavior is identical to before; this is purely a Phase 2
// restructure so Phase 4 (powerups, wormhole) can hook into a stage by name
// instead of another editing pass through one monolithic function. Stage
// hook points are marked where a future powerup will plug in.
function gameTick() {
  const active = slots
    .map((s, i) => ({ s, i }))
    .filter(x => x.s && x.s.alive);
  if (active.length === 0) {
    scheduleTick();
    return;
  }

  const newHeads = computeNewHeads(active);
  const died = new Map(); // slotIndex -> killerSlotIndex or null

  resolveWallCollisions(active, newHeads, died);   // Phase 4 hook: wormhole-on-wall-touch
  resolveSelfCollisions(active, newHeads, died);
  resolveSnakeCollisions(active, newHeads, died);  // Phase 4 hook: wormhole-on-player-touch
  applyMovementAndFood(active, newHeads, died);
  applyKillBonuses(died);
  for (const [victimIndex] of died) handleDeath(victimIndex);

  tickSeq++;
  broadcastState();
  scheduleTick();
}

// Stage 1: apply one queued direction change per active snake (max one per
// tick, matching the client's own predictor so its reconciliation lines up),
// and compute where each head would land this tick.
function computeNewHeads(active) {
  const newHeads = new Map();
  for (const { s, i } of active) {
    if (s.inputQueue.length > 0) s.dir = s.inputQueue.shift();
    const head = s.body[0];
    newHeads.set(i, { x: head.x + s.dir.x, y: head.y + s.dir.y });
  }
  return newHeads;
}

// Stage 2: wall collisions.
function resolveWallCollisions(active, newHeads, died) {
  for (const { i } of active) {
    if (died.has(i)) continue;
    const h = newHeads.get(i);
    if (h.x < 0 || h.x >= CFG.grid.cols || h.y < 0 || h.y >= CFG.grid.rows) {
      died.set(i, null);
    }
  }
}

// Stage 3: self collisions (head into own body, excluding the tail cell
// since the tail moves away this same tick unless the snake is growing).
function resolveSelfCollisions(active, newHeads, died) {
  for (const { s, i } of active) {
    if (died.has(i)) continue;
    const h = newHeads.get(i);
    const bodyWithoutTail = s.body.slice(0, -1);
    if (bodyWithoutTail.some(seg => seg.x === h.x && seg.y === h.y)) {
      died.set(i, null);
    }
  }
}

// Stage 4: collisions with other snakes. Head-on-head (both moving into the
// same cell) kills both with no bonus. Head-into-body kills the mover and
// awards the bonus to the snake whose body was hit.
function resolveSnakeCollisions(active, newHeads, died) {
  for (const { i } of active) {
    if (died.has(i)) continue;
    const h = newHeads.get(i);
    for (const { s: other, i: j } of active) {
      if (j === i || died.has(j)) continue;
      const otherHead = newHeads.get(j);
      if (h.x === otherHead.x && h.y === otherHead.y) {
        died.set(i, null);
        died.set(j, null); // head-on collision, no bonus either way
        continue;
      }
      const otherBodyWithoutTail = other.body.slice(0, -1);
      if (otherBodyWithoutTail.some(seg => seg.x === h.x && seg.y === h.y)) {
        died.set(i, j); // i died, j gets credit
      }
    }
  }
}

// Stage 5: move survivors, handle food.
function applyMovementAndFood(active, newHeads, died) {
  for (const { s, i } of active) {
    if (died.has(i)) continue;
    const h = newHeads.get(i);
    s.body.unshift(h);
    if (food && h.x === food.x && h.y === food.y) {
      s.score += 1;
      placeFood();
      // growing: do not pop the tail this tick
    } else {
      s.body.pop();
    }
  }
}

// Stage 6: apply kill bonuses now that survivors have already moved this tick.
function applyKillBonuses(died) {
  for (const [victimIndex, killerIndex] of died) {
    if (killerIndex === null) continue;
    const killer = slots[killerIndex];
    if (!killer || !killer.alive) continue;
    killer.score += CFG.killBonusScore;
    // Grow by a fixed 3 segments by duplicating the tail cell 3 times.
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
  if (targets.length > 0 && conn) {
    sendTo(conn.ws, { type: "askInitials", targets, score: s.score });
  }
  setTimeout(() => {
    if (!slots[slotIndex] || slots[slotIndex].connId !== s.connId) return; // already replaced
    if (spectatorQueue.length > 0) {
      // Someone is waiting: this player steps aside into the spectator queue,
      // and the next spectator in line takes the slot.
      slots[slotIndex] = null;
      spectatorQueue.push(s.connId);
      if (conn) conn.role = "spectator";
      if (conn) conn.slotIndex = null;
      promoteSpectatorInto(slotIndex);
    } else {
      // Nobody waiting: just respawn the same player.
      spawnSnake(slotIndex);
    }
  }, CFG.spectatorPromoteDelayMs);
}

// ------------------------------------------------------------
// Networking helpers
// ------------------------------------------------------------
function sendTo(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcastState() {
  const state = {
    type: "state",
    seq: tickSeq,           // one global monotonic counter, shared by all players
    serverTime: Date.now(), // wall-clock time this tick was produced
    tickMs: currentTickMs(),
    grid: CFG.grid,
    food,
    players: slots.map((s, i) =>
      s
        ? {
            slot: i,
            alive: s.alive,
            score: s.score,
            color: s.color,
            body: s.body
          }
        : null
    ),
    highScores: { daily: highScores.daily, allTime: highScores.allTime }
  };
  for (const [connId, conn] of connections) {
    const you =
      conn.role === "player"
        ? { role: "player", slot: conn.slotIndex }
        : { role: "spectator", queuePos: spectatorQueue.indexOf(connId) + 1, queueLen: spectatorQueue.length };
    sendTo(conn.ws, { ...state, you });
  }
}

// ------------------------------------------------------------
// HTTP server: static files + captcha API
// ------------------------------------------------------------
const MIME = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json", ".css": "text/css" };
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/captcha" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
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
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ token: issueJoinToken() }));
        } else {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "incorrect" }));
        }
      } catch {
        res.writeHead(400);
        res.end();
      }
    });
    return;
  }
  // Static file serving out of public/, defaulting to index.html.
  let filePath = path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

// ------------------------------------------------------------
// WebSocket server: manual upgrade handling so we can check the
// join token on the URL before accepting the connection.
// ------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const token = url.searchParams.get("token");
  if (!consumeJoinToken(token)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws));
});

// Cloudflare drops idle proxied WebSocket connections after about 100 seconds.
// When the board is idle (spectators waiting, no active players) no state is
// broadcast, so send a lightweight ping on an interval to keep them alive.
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
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const conn = connections.get(connId);
    if (!conn) return;
    if (msg.type === "dir" && conn.role === "player") {
      const slot = slots[conn.slotIndex];
      if (!slot) return;
      const dirMap = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
      const nd = dirMap[msg.dir];
      if (!nd) return;
      if (slot.inputQueue.length >= 2) return;
      const last = slot.inputQueue.length > 0 ? slot.inputQueue[slot.inputQueue.length - 1] : slot.dir;
      const reversal = nd.x === -last.x && nd.y === -last.y;
      const duplicate = nd.x === last.x && nd.y === last.y;
      if (!reversal && !duplicate) slot.inputQueue.push(nd);
    }
    if (msg.type === "initials") {
      const initials = String(msg.value || "").toUpperCase().slice(0, 3).padEnd(3, "A");
      const targets = qualifies(msg.score || 0);
      recordScore(msg.targets || targets, initials, msg.score || 0);
      broadcastState();
    }
  });
  ws.on("close", () => {
    removeConnection(connId);
    broadcastState();
  });
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log("Multisnake listening on http://127.0.0.1:" + PORT);
});
scheduleTick();
