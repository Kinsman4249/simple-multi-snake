// ============================================================
// Multiplayer Snake server.
// Authority model: server authoritative for everything EXCEPT static
// walls. A wall-avoiding turn is favored even if it arrives a tick late
// (resolveWallCollisions wall-grace). Snake-vs-snake and self collisions
// stay fully server-authoritative.
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
const BUILD = "server 2026-07-12.5";
const WALL_GRACE_TICKS = Number.isInteger(CFG.wallGraceTicks) ? CFG.wallGraceTicks : 1;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function loadHighScores() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(HS_FILE, "utf8"));
  } catch {
    data = { date: todayStr(), daily: [], allTime: [] };
  }
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
  let x, y;
  let attempts = 0;
  do {
    x = 3 + Math.floor(Math.random() * (CFG.grid.cols - 6));
    y = 3 + Math.floor(Math.random() * (CFG.grid.rows - 6));
    attempts++;
  } while ((!cellFree(x, y, slotIndex) || !cellFree(x - 1, y, slotIndex) || !cellFree(x - 2, y, slotIndex)) && attempts < 100);
  slots[slotIndex].body = [{ x, y }, { x: x - 1, y }, { x: x - 2, y }];
  slots[slotIndex].dir = { x: 1, y: 0 };
  slots[slotIndex].inputQueue = [];
  slots[slotIndex].alive = true;
  slots[slotIndex].respawnAt = null;
  slots[slotIndex].wallStalls = 0;
}
function newPlayerSlot(connId) {
  return {
    connId,
    color: null,
    body: [],
    dir: { x: 1, y: 0 },
    inputQueue: [],
    alive: true,
    score: 0,
    respawnAt: null,
    wallStalls: 0
  };
}
function assignConnection(connId, ws) {
  const freeIndex = slots.findIndex(s => s === null);
  if (freeIndex !== -1 && spectatorQueue.length === 0) {
    slots[freeIndex] = newPlayerSlot(connId);
    slots[freeIndex].color = COLORS[freeIndex];
    spawnSnake(freeIndex);
    connections.set(connId, { ws, role: "player", slotIndex: freeIndex });
    if (sessionStart === null) sessionStart = Date.now();
    if (!food) placeFood();
  } else {
    spectatorQueue.push(connId);
    connections.set(connId, { ws, role: "spectator", slotIndex: null });
  }
}
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
    sessionStart = null;
    food = null;
  }
}
function promoteSpectatorInto(slotIndex) {
  if (spectatorQueue.length === 0) return;
  const nextConnId = spectatorQueue.shift();
  const conn = connections.get(nextConnId);
  if (!conn) return;
  slots[slotIndex] = newPlayerSlot(nextConnId);
  slots[slotIndex].color = COLORS[slotIndex];
  spawnSnake(slotIndex);
  conn.role = "player";
  conn.slotIndex = slotIndex;
}
function currentTickMs() {
  if (sessionStart === null) return CFG.speed.startTickMs;
  const elapsedSec = (Date.now() - sessionStart) / 1000;
  const steps = Math.floor(elapsedSec / CFG.speed.rampIntervalSec);
  const ms = CFG.speed.startTickMs - steps * CFG.speed.rampStepMs;
  return Math.max(CFG.speed.minTickMs, ms);
}
let tickSeq = 0;
function scheduleTick() {
  setTimeout(gameTick, currentTickMs());
}
function gameTick() {
  const active = slots
    .map((s, i) => ({ s, i }))
    .filter(x => x.s && x.s.alive);
  if (active.length === 0) {
    scheduleTick();
    return;
  }
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
function inBounds(h) {
  return h.x >= 0 && h.x < CFG.grid.cols && h.y >= 0 && h.y < CFG.grid.rows;
}
function consumeInboundsTurn(s) {
  const head = s.body[0];
  for (let k = 0; k < s.inputQueue.length; k++) {
    const d = s.inputQueue[k];
    const reversal = d.x === -s.dir.x && d.y === -s.dir.y;
    if (reversal) continue;
    if (inBounds({ x: head.x + d.x, y: head.y + d.y })) {
      s.inputQueue.splice(0, k + 1);
      return d;
    }
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
    if (saved) {
      s.dir = saved;
      h = { x: s.body[0].x + saved.x, y: s.body[0].y + saved.y };
      newHeads.set(i, h);
      s.wallStalls = 0;
      continue;
    }
    if (s.wallStalls < WALL_GRACE_TICKS) {
      s.wallStalls++;
      stalled.add(i);
      newHeads.set(i, { x: s.body[0].x, y: s.body[0].y });
      continue;
    }
    died.set(i, null);
    s.wallStalls = 0;
  }
}
function resolveSelfCollisions(active, newHeads, died, stalled) {
  for (const { s, i } of active) {
    if (died.has(i) || stalled.has(i)) continue;
    const h = newHeads.get(i);
    const bodyWithoutTail = s.body.slice(0, -1);
    if (bodyWithoutTail.some(seg => seg.x === h.x && seg.y === h.y)) {
      died.set(i, null);
    }
  }
}
function resolveSnakeCollisions(active, newHeads, died, stalled) {
  for (const { i } of active) {
    if (died.has(i) || stalled.has(i)) continue;
    const h = newHeads.get(i);
    for (const { s: other, i: j } of active) {
      if (j === i || died.has(j)) continue;
      const otherHead = newHeads.get(j);
      if (!stalled.has(j) && h.x === otherHead.x && h.y === otherHead.y) {
        died.set(i, null);
        died.set(j, null);
        continue;
      }
      const otherBodyWithoutTail = other.body.slice(0, -1);
      if (otherBodyWithoutTail.some(seg => seg.x === h.x && seg.y === h.y)) {
        died.set(i, j);
      }
    }
  }
}
function applyMovementAndFood(active, newHeads, died, stalled) {
  for (const { s, i } of active) {
    if (died.has(i) || stalled.has(i)) continue;
    const h = newHeads.get(i);
    s.body.unshift(h);
    if (food && h.x === food.x && h.y === food.y) {
      s.score += 1;
      placeFood();
    } else {
      s.body.pop();
    }
    s.wallStalls = 0;
  }
}
function applyKillBonuses(died) {
  for (const [victimIndex, killerIndex] of died) {
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
  if (targets.length > 0 && conn) {
    sendTo(conn.ws, { type: "askInitials", targets, score: s.score });
  }
  setTimeout(() => {
    if (!slots[slotIndex] || slots[slotIndex].connId !== s.connId) return;
    if (spectatorQueue.length > 0) {
      slots[slotIndex] = null;
      spectatorQueue.push(s.connId);
      if (conn) conn.role = "spectator";
      if (conn) conn.slotIndex = null;
      promoteSpectatorInto(slotIndex);
    } else {
      spawnSnake(slotIndex);
    }
  }, CFG.spectatorPromoteDelayMs);
}
function sendTo(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcastState() {
  const state = {
    type: "state",
    build: BUILD,
    seq: tickSeq,
    serverTime: Date.now(),
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
            dir: s.dir,
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
  console.log("Multisnake listening on http://127.0.0.1:" + PORT + " build " + BUILD);
});
scheduleTick();
