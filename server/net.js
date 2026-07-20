// ============================================================
// Outbound network: sendTo (single message) and broadcastState (the shared
// per-tick state fanout, with the serialize-once you-splice optimization).
// ============================================================
const {
  BUILD, SIM_HZ, CFG, BOOST, boostRamp, POWERUPS, POWERUP_MODULES, SPEED_MULT_TYPES, PERF
} = require("./config");
const { S, currentMoveIntervalMs, isInverted, scoreMode } = require("./state");
const { getHighScores } = require("./highscores");

function sendTo(ws, msg) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }
function broadcastState() {
  const interval = currentMoveIntervalMs();
  const bNow = Date.now();
  const highScores = getHighScores();
  const state = {
    type: "state", build: BUILD, seq: S.moveSeq, serverTime: Date.now(),
    // foods: the active food cells (count scales with player count, v3.5.0).
    // food: kept as a compat alias (first food or null) for any consumer that
    // still reads a single food.
    tickMs: interval, simHz: SIM_HZ, grid: CFG.grid, foods: S.foods, food: S.foods[0] || null,
    powerupPickups: S.powerupPickups, trails: S.trails, blueShells: S.blueShells, explosions: S.explosions,
    // Kill feed (v3.6.8): one-shot, same pattern as explosions -- events
    // queued by lifecycle.js handleDeath since the last broadcast, cleared
    // right after this one goes out so nobody sees the same kill twice.
    kills: S.killEvents,
    players: S.slots.map((s, i) => s ? {
      // Score IS the snake's current length (v3.6.x): classic-snake scoring,
      // and what the leaderboard records at death. Poison / a blue shell that
      // shrinks you lowers your score in real time, so risky play is a real
      // gamble. (Total food picked up is a SEPARATE, planned speed-run mode --
      // see handoff.md; s.score still tallies food but is no longer surfaced.)
      slot: i, alive: s.alive, score: s.body.length, color: s.color, dir: s.dir, body: s.body,
      // Effective per-player movement rate (ms per cell), boost + speed
      // powerup + ice slow all included. Purely informational for
      // CLIENT-SIDE render smoothing: the client interpolates each snake's
      // on-screen travel in lock step with this known fixed cadence. Server
      // collision/authority are untouched.
      moveMs: Math.round(interval / ((1 + (BOOST.boostSpeed - 1) * boostRamp(s, bNow)) *
        SPEED_MULT_TYPES.reduce((m, t) => m * POWERUP_MODULES[t].speedMultiplier(s, POWERUPS), 1))),
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
    // Both leaderboards (Phase 12): "local" = one computer, "networked" =
    // two or more. `mode` is the session's CURRENT classification, so the
    // client can highlight the board this run would land on.
    highScores: {
      local: { daily: highScores.modes.local.daily, allTime: highScores.modes.local.allTime },
      networked: { daily: highScores.modes.networked.daily, allTime: highScores.modes.networked.allTime }
    },
    mode: scoreMode()
  };
  // One-shot flags: true for exactly the one broadcast right after a
  // successful wormhole fire, a blue shell impact, or a powerup activation,
  // then cleared so none repeats.
  for (const s of S.slots) if (s) { s.teleportedThisTick = false; s.activatedFx = null; }
  S.explosions = [];
  S.killEvents = [];
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
