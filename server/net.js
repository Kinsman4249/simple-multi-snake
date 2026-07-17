// ============================================================
// Outbound network: sendTo (single message) and broadcastState (the shared
// per-tick state fanout, with the serialize-once you-splice optimization).
// ============================================================
const {
  BUILD, SIM_HZ, CFG, BOOST, boostRamp, POWERUPS, POWERUP_MODULES, PERF
} = require("./config");
const { S, currentMoveIntervalMs, isInverted } = require("./state");
const { getHighScores } = require("./highscores");

function sendTo(ws, msg) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }
function broadcastState() {
  const interval = currentMoveIntervalMs();
  const bNow = Date.now();
  const highScores = getHighScores();
  const state = {
    type: "state", build: BUILD, seq: S.moveSeq, serverTime: Date.now(),
    tickMs: interval, simHz: SIM_HZ, grid: CFG.grid, food: S.food,
    powerupPickups: S.powerupPickups, trails: S.trails, blueShells: S.blueShells, explosions: S.explosions,
    players: S.slots.map((s, i) => s ? {
      slot: i, alive: s.alive, score: s.score, color: s.color, dir: s.dir, body: s.body,
      // Effective per-player movement rate (ms per cell), boost + speed
      // powerup + ice slow all included. Purely informational for
      // CLIENT-SIDE render smoothing: the client interpolates each snake's
      // on-screen travel in lock step with this known fixed cadence. Server
      // collision/authority are untouched.
      moveMs: Math.round(
        interval /
        ((1 + (BOOST.boostSpeed - 1) * boostRamp(s, bNow)) *
          POWERUP_MODULES.speedBoost.speedMultiplier(s, POWERUPS) *
          POWERUP_MODULES.iceTrail.speedMultiplier(s, POWERUPS))
      ),
      // Visual-only flags for the client's boost jetstream / slide dust
      // effects (no gameplay meaning beyond what moveMs already carries).
      // boost is true once the hold has ENGAGED (past holdGraceMs), not on
      // the raw key state -- the jetstream shouldn't show for a dead tap.
      boost: boostRamp(s, bNow) > 0,
      sliding: !!(s.driftDir && Date.now() < s.driftUntilMs),
      heldPowerup: s.heldPowerup,
      wormholeCharge: s.wormholeCharge,
      activePowerup: s.activePowerup ? s.activePowerup.type : null,
      // Fraction of the active timed powerup still remaining (1 at activation,
      // 0 at expiry). Drives the client tail-drain countdown -- purely
      // cosmetic. Omitted when nothing is active.
      activePct: s.activePowerup
        ? Math.max(0, Math.min(1, (s.activePowerup.expiresAtTick - S.moveSeq) /
            Math.max(1, s.activePowerup.expiresAtTick - s.activePowerup.startTick)))
        : undefined,
      // One-shot: the type that JUST fired this tick (client draws a brief
      // activation flash). Cleared right after this broadcast.
      activated: s.activatedFx || undefined,
      iceStacks: s.iceStacks,
      // Banana-trail control inversion, while it lasts (drives the client's
      // "controls reversed" chip + head ring; omitted when not slipping).
      inverted: isInverted(s) ? true : undefined,
      teleport: s.teleportedThisTick ? true : undefined
    } : null),
    highScores: { daily: highScores.daily, allTime: highScores.allTime }
  };
  // One-shot flags: true for exactly the one broadcast right after a
  // successful wormhole fire, a blue shell impact, or a powerup activation,
  // then cleared so none repeats.
  for (const s of S.slots) if (s) { s.teleportedThisTick = false; s.activatedFx = null; }
  S.explosions = [];
  // Latency/CPU: the shared portion of the state is identical for every
  // connection, so serialize it ONCE and splice each connection's small
  // per-you payload into the JSON string, instead of re-stringifying the
  // full board (bodies included) N times. With N connections this turns an
  // O(N * board) serialization into O(board + N * you).
  const baseStr = JSON.stringify(state);
  if (PERF) PERF.bytesBase += baseStr.length;
  const basePrefix = baseStr.slice(0, -1) + ',"you":';
  // Precompute spectator queue positions once per broadcast instead of a
  // findIndex scan per seat per connection.
  const queuePos = new Map();
  for (let q = 0; q < S.spectatorQueue.length; q++) {
    queuePos.set(S.spectatorQueue[q].connId + ":" + S.spectatorQueue[q].local, q + 1);
  }
  for (const [connId, conn] of S.connections) {
    if (!conn.ws || conn.ws.readyState !== conn.ws.OPEN) continue;
    const you = {
      locals: conn.locals.map((entry, localIdx) => {
        if (!entry) return null;
        if (entry.role === "player") {
          const s = S.slots[entry.slotIndex];
          return { local: localIdx, role: "player", slot: entry.slotIndex, ack: s ? s.lastAck : 0 };
        }
        if (entry.role === "held") {
          // Waiting out this connection's high-score flush (see the
          // initials state machine): not playing, not in the queue yet.
          return { local: localIdx, role: "held" };
        }
        return {
          local: localIdx, role: "spectator",
          queuePos: queuePos.get(connId + ":" + localIdx) || 0, queueLen: S.spectatorQueue.length
        };
      })
    };
    const payload = basePrefix + JSON.stringify(you) + "}";
    if (PERF) { PERF.bytesTotal += payload.length; PERF.sends++; }
    conn.ws.send(payload);
  }
}

module.exports = { sendTo, broadcastState };
