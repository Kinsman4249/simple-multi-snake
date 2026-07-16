// ============================================================
// Multiplayer Snake server (.15): per-snake movement cadence (boost),
// connection-scoped high-score state machine, explicit leave flow.
//
// A fixed simulation loop runs at CFG.simHz (default 60). Inputs are sampled
// every sim tick (so a keypress is on the server within ~1000/simHz ms).
// Movement is now accumulated PER SNAKE (s.moveAccumMs): each snake advances
// one cell when its own accumulator crosses the shared ramped interval, and
// a boosting snake accumulates faster (CFG.boost.boostSpeed). State is
// broadcast only on ticks where at least one snake moved.
//
// seq counts MOVEMENT ticks (not sim frames), so client reconciliation and
// the input ack model are unchanged.
//
// High-score initials are a CONNECTION-scoped queue + state machine
// (conn.pendingInitials / conn.activeInitials), never slot state: prompts
// are deferred while ANY local seat on the same keyboard is still actively
// controlling a snake, then flushed one at a time. See queueInitials().
//
// Run: npm install ws ; node server.js
// ============================================================
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const { WebSocketServer } = require("ws");
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
const HS_FILE = path.join(__dirname, "highscores.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = 8080;
// Build identity, resolved once at startup, cheapest source first:
//   1. Live git checkout: commit count + short hash (increments every commit).
//   2. Release archive: build-info.json, stamped by `git archive` export-subst
//      (see .gitattributes) with the tag describe string + short hash.
//   3. Neither (bare copy): package.json version alone, marked "dev".
// The result is broadcast in every state message and shown in the debug panel.
function resolveBuild() {
  const base = "v" + PKG.version;
  try {
    const count = execSync("git rev-list --count HEAD", { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const hash = execSync("git rev-parse --short HEAD", { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return base + " build " + count + " (" + hash + ")";
  } catch (_) { /* not a git checkout; try the stamped archive metadata */ }
  try {
    const info = JSON.parse(fs.readFileSync(path.join(__dirname, "build-info.json"), "utf8"));
    // Unsubstituted placeholders still start with "$Format" -- treat as absent.
    const describe = info.describe && !info.describe.startsWith("$Format") ? info.describe : null;
    const commit = info.commit && !info.commit.startsWith("$Format") ? info.commit : null;
    if (describe || commit) return base + " " + (describe || "") + (commit ? " (" + commit + ")" : "");
  } catch (_) { /* no build-info.json either */ }
  return base + " dev";
}
const BUILD = "server " + resolveBuild();

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
// Inactivity timeout for ACTIVE players (multiplayer expansion of the old
// single-seat spectator idle rule): when EVERY living snake on the board has
// gone this long without any input, the whole lobby is considered abandoned
// and lifecycleSweep disconnects the idle players. One attentive player
// keeps the session alive for everyone.
const PLAYER_IDLE_MS = Number.isInteger(CFG.playerIdleMs) ? CFG.playerIdleMs : 120000;
const JOIN_OFFER_MS = Number.isInteger(CFG.joinOfferMs) ? CFG.joinOfferMs : 10000;
const INPUT_BUFFER = Number.isInteger(CFG.inputBuffer) ? CFG.inputBuffer : 3;
// Boost & inertia. Holding the key of the current travel direction boosts
// the snake: its movement accumulator fills boostSpeed times faster. The
// trade-off is the slide penalty: a turn queued WHILE boosting only takes
// effect after slideDistance further cells of straight travel (the snake
// "drifts" through the turn). Both knobs live in config.json.
const BOOST = Object.assign({ enabled: true, boostSpeed: 1.5, slideDistance: 2 }, CFG.boost || {});
// Zero-resource debug switch. When enableDebug is false, dlog is null and
// every debug call site is a single falsy short-circuit (`dlog && dlog(...)`)
// -- no string building, no buffering, no I/O. The client is told via
// /api/config and skips creating its debug button/panel/recording entirely.
const ENABLE_DEBUG = CFG.enableDebug !== false;
const dlog = ENABLE_DEBUG ? (...args) => console.log("[debug]", ...args) : null;
const CLIENT_RENDER = Object.assign({ interpolate: true }, CFG.clientRender || {});

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
  s.score = 0;
  s.lastAck = 0;
  s.boost = false;
  s.moveAccumMs = 0;
  // NOTE: lastInputAt is deliberately NOT reset here. spawnSnake also runs
  // on automatic respawns, and an AFK player who keeps dying and respawning
  // must not keep resetting their own inactivity clock -- only real input
  // (dir/boost) and seat creation (newPlayerSlot) count as activity.
}
function newPlayerSlot(connId) {
  return {
    connId, color: null, body: [], dir: { x: 1, y: 0 }, inputQueue: [],
    alive: true, score: 0, wallStalls: 0, lastAck: 0,
    boost: false, moveAccumMs: 0, lastInputAt: Date.now()
  };
}
// Connection record. pendingInitials is the connection-scoped high-score
// queue ([{ local, targets, score }]); activeInitials is the one prompt
// currently on screen ({ local, targets, score, deadline }) or null. See
// queueInitials() for the state machine.
function assignConnection(connId, ws) {
  connections.set(connId, { ws, locals: [], pendingInitials: [], activeInitials: null });
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
  // A seat that left (see removeLocalSeat) leaves a null hole at its local
  // index; rejoin fills that hole first so key maps (0 = arrows, 1 = WASD)
  // stay stable. Only when there is no hole does a brand-new index get used.
  let idx = conn.locals.findIndex(l => l === null);
  if (idx === -1) idx = conn.locals.length;
  if (idx >= MAX_LOCAL_PLAYERS) return "max local players reached";
  admitLocal(connId, idx);
  return null;
}
// Explicit "Leave" for one local seat. The seat exits COMPLETELY: its slot
// (if playing) is freed, its queue entry (if spectating) is dropped, and the
// local index becomes a null hole -- it is NOT pushed into the spectator
// queue. Rejoining requires a fresh joinLocal (WASD key / Play button on the
// client). If the leaving seat was mid-game with a qualifying score, that
// score is queued for the initials flush (spec scenario A) and prompts once
// nobody on this keyboard is still playing.
// Returns true if this was the connection's LAST seat, in which case the
// caller should tear the whole connection down (solo leave = full exit).
function removeLocalSeat(connId, localIdx) {
  const conn = connections.get(connId);
  if (!conn) return false;
  const entry = conn.locals[localIdx];
  if (entry === null || entry === undefined) return false;
  if (entry.role === "player" && entry.slotIndex != null) {
    const s = slots[entry.slotIndex];
    if (s && s.alive) {
      // Leaving mid-game: bank a qualifying score now; it prompts later,
      // once no local seat on this connection is actively playing.
      const targets = qualifies(s.score);
      if (targets.length > 0) conn.pendingInitials.push({ local: localIdx, targets, score: s.score });
    }
    slots[entry.slotIndex] = null;
  }
  spectatorQueue = spectatorQueue.filter(e => !(e.connId === connId && e.local === localIdx));
  if (joinOffer && joinOffer.connId === connId && joinOffer.local === localIdx) joinOffer = null;
  // Leaving during your own live initials prompt counts as declining it.
  const declinedOwnPrompt = conn.activeInitials && conn.activeInitials.local === localIdx;
  conn.locals[localIdx] = null;
  const anySeatLeft = conn.locals.some(l => l !== null && l !== undefined);
  if (!anySeatLeft) return true;
  maybeOfferSlot();
  // If the leaver declined their own live prompt, the flush must ADVANCE
  // (next queued prompt, or re-admit held seats), not merely stop.
  if (declinedOwnPrompt) advanceInitialsFlush(connId);
  else maybeStartInitialsFlush(connId);
  return false;
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
  // Initials prompt timeouts (connection-scoped -- see the state machine
  // above handleDeath). A prompt that runs out its countdown is skipped and
  // the flush advances to the next queued score / re-admits held seats.
  for (const [connId, conn] of connections) {
    if (conn.activeInitials && now >= conn.activeInitials.deadline) {
      dlog && dlog("initials timeout", { connId, local: conn.activeInitials.local });
      advanceInitialsFlush(connId);
    }
  }
  // Multiplayer inactivity timeout: if EVERY living snake has gone
  // PLAYER_IDLE_MS without a single input, the lobby is abandoned -- kick
  // the idle connections exactly like the spectator idle rule does. Any one
  // player pressing a key resets the clock for the whole board.
  const living = [];
  for (const s of slots) if (s && s.alive) living.push(s);
  if (living.length > 0 && living.every(s => now - s.lastInputAt >= PLAYER_IDLE_MS)) {
    dlog && dlog("lobby idle timeout", { players: living.length });
    const idleConnIds = new Set(living.map(s => s.connId));
    for (const connId of idleConnIds) {
      const conn = connections.get(connId);
      if (conn && conn.ws) { try { conn.ws.close(); } catch (_) {} }
      removeConnection(connId);
    }
    broadcastState();
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
let moveSeq = 0;         // counts MOVEMENT ticks (used as network seq)
let lastSimAt = null;
let nextSimAt = null;

// Fixed-rate simulation loop: sample inputs every tick, move on cadence.
// Scheduling is against an ABSOLUTE next-tick time (nextSimAt) rather than a
// relative setTimeout(SIM_MS): timer callbacks always fire late by some
// jitter, and a relative delay accumulates that jitter into a permanently
// slower effective tick rate. Anchoring to absolute time keeps the long-run
// rate exact, which the client's lock-step interpolation relies on.
function simLoop() {
  const now = Date.now();
  const dt = lastSimAt == null ? SIM_MS : Math.min(now - lastSimAt, 250);
  lastSimAt = now;
  lifecycleSweep();
  const interval = currentMoveIntervalMs();
  // Per-snake movement accumulators. A boosting snake's accumulator fills
  // BOOST.boostSpeed times faster, so it crosses the shared ramped interval
  // sooner and takes extra movement steps -- speed is per snake while
  // collision resolution stays step-synchronous (movers vs. everyone).
  let moved = false;
  let guard = 0;
  do {
    const movers = [];
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (!s || !s.alive) continue;
      if (guard === 0) s.moveAccumMs += dt * (BOOST.enabled && s.boost ? BOOST.boostSpeed : 1);
      if (s.moveAccumMs >= interval) { s.moveAccumMs -= interval; movers.push({ s, i }); }
    }
    if (movers.length === 0) break;
    movementStep(movers);
    moved = true;
    guard++;
  } while (guard < 5); // guard: a huge dt (event-loop stall) can owe several steps
  if (moved) broadcastState();
  nextSimAt = (nextSimAt == null ? now : nextSimAt) + SIM_MS;
  if (nextSimAt < now) nextSimAt = now + SIM_MS; // fell too far behind: re-anchor
  setTimeout(simLoop, Math.max(0, nextSimAt - Date.now()));
}
// Advance one movement step for the given movers. Snakes NOT moving this
// step (slower, not boosting) still participate as static obstacles: body
// collisions are checked against every living snake, not just the movers.
function movementStep(movers) {
  const allAlive = [];
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] && slots[i].alive) allAlive.push({ s: slots[i], i });
  }
  const newHeads = computeNewHeads(movers);
  const died = new Map();
  const stalled = new Set();
  resolveWallCollisions(movers, newHeads, died, stalled);
  resolveSelfCollisions(movers, newHeads, died, stalled);
  resolveSnakeCollisions(movers, newHeads, died, stalled, allAlive);
  applyMovementAndFood(movers, newHeads, died, stalled);
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
      const inp = s.inputQueue[0];
      if (inp.delay > 0) {
        // Boost slide penalty: this turn was queued while boosting, so it
        // carries momentum -- the snake drifts straight for `delay` more
        // cells before the turn registers. The input is acked immediately
        // (the client knows it landed); only its EFFECT is deferred.
        inp.delay--;
        if (inp.seq != null && inp.seq > s.lastAck) s.lastAck = inp.seq;
      } else {
        s.inputQueue.shift();
        s.dir = { x: inp.x, y: inp.y };
        if (inp.seq != null) s.lastAck = inp.seq;
      }
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
// hitsBody: does (h) land on any segment of `body` except the tail? The tail
// cell vacates this step. Index loop instead of slice().some() on purpose:
// this runs per snake pair per movement step and the slice allocated a fresh
// array each call in the hottest path the server has.
function hitsBody(body, h, skipTail) {
  const end = skipTail ? body.length - 1 : body.length;
  for (let k = 0; k < end; k++) {
    if (body[k].x === h.x && body[k].y === h.y) return true;
  }
  return false;
}
function resolveSelfCollisions(active, newHeads, died, stalled) {
  for (const { s, i } of active) {
    if (died.has(i) || stalled.has(i)) continue;
    if (hitsBody(s.body, newHeads.get(i), true)) died.set(i, null);
  }
}
// Movers are checked against EVERY living snake (allAlive), not just other
// movers: with per-snake boost cadence a slower snake may not step this
// tick, but its body is still a solid obstacle. Head-on (both die) applies
// only between two snakes moving this same step; a non-mover's stationary
// head counts as part of its body. A non-mover's tail does NOT vacate this
// step, so skipTail is false for them.
function resolveSnakeCollisions(active, newHeads, died, stalled, allAlive) {
  for (const { i } of active) {
    if (died.has(i) || stalled.has(i)) continue;
    const h = newHeads.get(i);
    for (const { s: other, i: j } of allAlive) {
      if (j === i || died.has(j)) continue;
      const otherHead = newHeads.get(j); // undefined when j isn't moving this step
      if (otherHead && !stalled.has(j) && h.x === otherHead.x && h.y === otherHead.y) { died.set(i, null); died.set(j, null); continue; }
      if (hitsBody(other.body, h, otherHead !== undefined && !stalled.has(j))) died.set(i, j);
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
// ---------------------------------------------------------------
// High-score initials: connection-scoped state machine.
//
// States (per connection):
//   PLAYING   -- at least one local seat has a LIVING snake. Initials
//                prompts are NEVER shown here (shared-keyboard rule:
//                a prompt would steal keys from whoever is still alive).
//                Qualifying scores are banked in conn.pendingInitials.
//   FLUSHING  -- no local seat is alive and pendingInitials is non-empty:
//                prompts are shown ONE AT A TIME (conn.activeInitials),
//                each with its own timeout that only starts when the
//                prompt actually appears. Seats that died while a flush
//                was owed are parked as role "held" (their board slot is
//                freed for round-robin fairness) instead of respawning,
//                so play cannot restart underneath the prompts.
//   RESUMING  -- queue drained: every held seat is re-admitted through
//                the normal admitLocal path (respawn immediately if the
//                board is free, otherwise back of the spectator queue).
//
// Transitions are driven from exactly three events: a death, a leave, and
// an initials resolution (submit / timeout / leaver-declined).
// ---------------------------------------------------------------
function anyLocalAlive(conn) {
  return conn.locals.some(l => {
    if (!l || l.role !== "player" || l.slotIndex == null) return false;
    const s = slots[l.slotIndex];
    return s && s.alive;
  });
}
// Bank a qualifying score for a local seat. Called from death and leave.
function queueInitials(conn, localIdx, targets, score) {
  conn.pendingInitials.push({ local: localIdx, targets, score });
  dlog && dlog("initials queued", { local: localIdx, score, queued: conn.pendingInitials.length });
}
// PLAYING -> FLUSHING: begin showing prompts if nothing blocks them.
function maybeStartInitialsFlush(connId) {
  const conn = connections.get(connId);
  if (!conn || conn.activeInitials || conn.pendingInitials.length === 0) return;
  if (anyLocalAlive(conn)) return; // someone on this keyboard is still playing
  const next = conn.pendingInitials.shift();
  conn.activeInitials = { ...next, deadline: Date.now() + INITIALS_TIMEOUT_MS };
  sendTo(conn.ws, { type: "askInitials", targets: next.targets, score: next.score, deadlineMs: INITIALS_TIMEOUT_MS, local: next.local });
}
// One prompt resolved (submitted, timed out, or its seat left): show the
// next queued one, or -- FLUSHING -> RESUMING -- re-admit every held seat.
function advanceInitialsFlush(connId) {
  const conn = connections.get(connId);
  if (!conn) return;
  conn.activeInitials = null;
  if (conn.pendingInitials.length > 0) { maybeStartInitialsFlush(connId); return; }
  for (let i = 0; i < conn.locals.length; i++) {
    if (conn.locals[i] && conn.locals[i].role === "held") admitLocal(connId, i);
  }
}
function handleDeath(slotIndex) {
  const s = slots[slotIndex];
  if (!s) return;
  s.alive = false;
  s.boost = false;
  const conn = connections.get(s.connId);
  const localIdx = conn ? conn.locals.findIndex(l => l && l.role === "player" && l.slotIndex === slotIndex) : -1;
  if (conn && localIdx !== -1) {
    const targets = qualifies(s.score);
    if (targets.length > 0) queueInitials(conn, localIdx, targets, s.score);
  }
  const connId = s.connId;
  setTimeout(() => {
    if (!slots[slotIndex] || slots[slotIndex].connId !== connId) return;
    const c = connections.get(connId);
    if (c && (c.activeInitials || c.pendingInitials.length > 0)) {
      // An initials flush is owed (or running) on this connection: park the
      // seat as "held" instead of respawning, freeing the board slot for
      // others. advanceInitialsFlush re-admits it once the queue drains.
      slots[slotIndex] = null;
      if (localIdx !== -1) c.locals[localIdx] = { role: "held", slotIndex: null };
      maybeOfferSlot();
      maybeStartInitialsFlush(connId);
      broadcastState();
      return;
    }
    respawnOrSpectate(slotIndex);
  }, CFG.spectatorPromoteDelayMs);
  if (conn) maybeStartInitialsFlush(s.connId);
}
function sendTo(ws, msg) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }
function broadcastState() {
  const interval = currentMoveIntervalMs();
  const state = {
    type: "state", build: BUILD, seq: moveSeq, serverTime: Date.now(),
    tickMs: interval, simHz: SIM_HZ, grid: CFG.grid, food,
    players: slots.map((s, i) => s ? {
      slot: i, alive: s.alive, score: s.score, color: s.color, dir: s.dir, body: s.body,
      // Effective per-player movement rate (ms per cell), boost included.
      // Purely informational for CLIENT-SIDE render smoothing: the client
      // interpolates each snake's on-screen travel in lock step with this
      // known fixed cadence. Server collision/authority are untouched.
      moveMs: Math.round(BOOST.enabled && s.boost ? interval / BOOST.boostSpeed : interval)
    } : null),
    highScores: { daily: highScores.daily, allTime: highScores.allTime }
  };
  // Latency/CPU: the shared portion of the state is identical for every
  // connection, so serialize it ONCE and splice each connection's small
  // per-you payload into the JSON string, instead of re-stringifying the
  // full board (bodies included) N times. With N connections this turns an
  // O(N * board) serialization into O(board + N * you).
  const baseStr = JSON.stringify(state);
  const basePrefix = baseStr.slice(0, -1) + ',"you":';
  // Precompute spectator queue positions once per broadcast instead of a
  // findIndex scan per seat per connection.
  const queuePos = new Map();
  for (let q = 0; q < spectatorQueue.length; q++) {
    queuePos.set(spectatorQueue[q].connId + ":" + spectatorQueue[q].local, q + 1);
  }
  for (const [connId, conn] of connections) {
    if (!conn.ws || conn.ws.readyState !== conn.ws.OPEN) continue;
    const you = {
      locals: conn.locals.map((entry, localIdx) => {
        if (!entry) return null;
        if (entry.role === "player") {
          const s = slots[entry.slotIndex];
          return { local: localIdx, role: "player", slot: entry.slotIndex, ack: s ? s.lastAck : 0 };
        }
        if (entry.role === "held") {
          // Waiting out this connection's high-score flush (see the
          // initials state machine): not playing, not in the queue yet.
          return { local: localIdx, role: "held" };
        }
        return {
          local: localIdx, role: "spectator",
          queuePos: queuePos.get(connId + ":" + localIdx) || 0, queueLen: spectatorQueue.length
        };
      })
    };
    conn.ws.send(basePrefix + JSON.stringify(you) + "}");
  }
}
const MIME = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json", ".css": "text/css" };
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/config" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ clientFx: CLIENT_FX, clientRender: CLIENT_RENDER, enableDebug: ENABLE_DEBUG, boost: BOOST }));
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
      slot.lastInputAt = Date.now();
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
      // Slide penalty: a turn queued while boosting carries momentum and
      // only registers after slideDistance further straight cells (see
      // computeNewHeads). Tagged at enqueue time so releasing boost right
      // after the keypress doesn't cancel momentum already committed.
      const delay = (BOOST.enabled && slot.boost) ? BOOST.slideDistance : 0;
      slot.inputQueue.push({ x: nd.x, y: nd.y, seq: cseq, delay });
    }
    if (msg.type === "boost") {
      // Client-detected hold of the current-direction key. The flag only
      // scales this snake's movement accumulator; nothing else trusts it.
      if (!BOOST.enabled) return;
      const localIdx = Number.isInteger(msg.local) ? msg.local : 0;
      const entry = conn.locals[localIdx];
      if (!entry || entry.role !== "player") return;
      const slot = slots[entry.slotIndex];
      if (!slot || !slot.alive) return;
      slot.lastInputAt = Date.now();
      slot.boost = msg.on === true;
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
    if (msg.type === "initials") {
      // Only the prompt the server itself put on screen can be answered,
      // and the score/targets recorded are the SERVER-tracked ones from
      // that prompt -- msg.score/msg.targets from the wire are ignored, so
      // a client cannot submit a fabricated score to the boards.
      const localIdx = Number.isInteger(msg.local) ? msg.local : 0;
      const active = conn.activeInitials;
      if (!active || active.local !== localIdx) return;
      const initials = String(msg.value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3).padEnd(3, "A");
      recordScore(active.targets, initials, active.score);
      advanceInitialsFlush(connId);
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
