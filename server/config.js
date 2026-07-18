// ============================================================
// Config & constants: everything resolved ONCE at startup from
// config.json / package.json / env, plus the powerup registry metadata.
// No game state lives here -- this module is safe to require from anywhere
// (it is the bottom of the server's dependency graph).
// ============================================================
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const POWERUP_MODULES = require("../powerups");

// __dirname is server/ -- the repo root (config.json, package.json,
// public/) is one level up.
const ROOT = path.join(__dirname, "..");
// SNAKE_CONFIG lets tests point at an alternate config file (e.g. faster
// powerup spawn cadence) without touching the real config.json; unset in
// normal operation, so production behavior is unchanged.
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, process.env.SNAKE_CONFIG || "config.json"), "utf8"));
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const PUBLIC_DIR = path.join(ROOT, "public");
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
    const count = execSync("git rev-list --count HEAD", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const hash = execSync("git rev-parse --short HEAD", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return base + " build " + count + " (" + hash + ")";
  } catch (_) { /* not a git checkout; try the stamped archive metadata */ }
  try {
    const info = JSON.parse(fs.readFileSync(path.join(ROOT, "build-info.json"), "utf8"));
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
// Phase 5: board size presets. grid.preset names a 16:9 cell count at the
// configured cellSize ("1080p" fills a 1920x1080 display, "4k" a 3840x2160
// one -- 4k is intentionally MORE cells, not bigger ones, for high-end
// servers). Explicit grid.cols/rows ALWAYS win over a preset (this is what
// keeps every tests/pw_*.js startServer({grid:{cols,rows}}) override, and
// any operator's hand-tuned board, working unchanged). The resolved
// cols/rows are written back into CFG.grid so the rest of the server -- and
// the grid object broadcast in every state message -- needs no changes.
const GRID_PRESETS = {
  "1080p": { cols: 96, rows: 54 },
  "4k":    { cols: 192, rows: 108 }
};
CFG.grid = Object.assign({ cellSize: 20 }, CFG.grid || {});
if (!Number.isInteger(CFG.grid.cols) || !Number.isInteger(CFG.grid.rows)) {
  const preset = GRID_PRESETS[CFG.grid.preset] || GRID_PRESETS["1080p"];
  CFG.grid.cols = preset.cols;
  CFG.grid.rows = preset.rows;
}
// Speed model (v3.5.0): the global movement interval is a function of the
// AVERAGE living-snake length, eased toward its target -- see state.js
// targetMoveIntervalMs/advanceGlobalSpeed. startIntervalMs is the slow base
// (empty room or all-minimum-length snakes); minIntervalMs the fast floor,
// reached once the average hits lengthSaturation; speedEaseMs is the smooth
// transition window applied to EVERY target change (growth, join, leave).
// (Replaces the old time-based ramp; a leftover rampIntervalSec/rampStepMs in
// an old config.json is simply ignored.)
const MOVE = Object.assign(
  { startIntervalMs: 160, minIntervalMs: 70, lengthSaturation: 40, speedEaseMs: 1000 },
  CFG.move || {}
);
// Hard ceiling on simultaneous food items (the per-player-count target,
// ceil(players/2), is clamped to this). A test can pin it to 1 to force the
// classic single-food board.
const MAX_FOOD = Number.isInteger(CFG.maxConcurrentFood) && CFG.maxConcurrentFood > 0 ? CFG.maxConcurrentFood : 8;
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
  { inputFlash: true, inputFlashMs: 90, correctionGlide: true, correctionGlideMs: 90, heldGlow: true },
  CFG.clientFx || {}
);
const WALL_GRACE_TICKS = Number.isInteger(CFG.wallGraceTicks) ? CFG.wallGraceTicks : 1;
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
// trade-off is the drift: a turn made WHILE boosting takes effect on the
// head IMMEDIATELY, but the whole body keeps skidding sideways in the
// previous travel direction for driftMs (a real drift, not a delayed
// input -- see applyDriftSlides). Both knobs live in config.json.
// (driftMs replaced the old slideDistance "turn is delayed N cells" model
// in round fifteen; a leftover slideDistance key in an old config.json is
// simply ignored.)
// Boost model (Phase 7 redesign): holding boost no longer snaps straight to
// boostSpeed. The hold must survive holdGraceMs before boost ENGAGES at all
// (so a short tap neither speeds the snake up nor tags queued turns with
// drift), then the speed multiplier RAMPS linearly from 1x to boostSpeed
// over rampMs. Drift length scales with how far up the ramp the snake was
// when the turn was pressed (driftMs * ramp), so a barely-boosting snake
// barely skids. rampMs/holdGraceMs of 0 restore the old instant behavior.
// v3.4.0 momentum model: speed is a PER-SNAKE state (s.rampProgress, 0..1),
// not a function of the boost key. While the hold is engaged (past
// holdGraceMs) the progress climbs over rampMs; when the key is released the
// snake KEEPS its speed and decelerates over decelMs -- faster than the
// ramp-up (decel rate > accel rate) but spanning multiple sim frames, so a
// released boost still carries real momentum. Drift eligibility follows the
// SPEED, not the key: any turn made while rampProgress >= driftThreshold
// starts a body skid (scaled by the progress at keypress), including turns
// made after the key was already released. rampMs/decelMs of 0 restore
// instant transitions.
const BOOST = Object.assign({ enabled: true, boostSpeed: 1.5, driftMs: 250, rampMs: 400, holdGraceMs: 120, decelMs: 250, driftThreshold: 0.3 }, CFG.boost || {});
// Current momentum 0..1 for a snake (0 = base speed, 1 = full boostSpeed).
// Reads the per-snake state updated by updateMomentum below; the `now`
// parameter is kept for call-site compatibility but no longer used.
function boostRamp(s, _now) {
  return s.rampProgress || 0;
}
// Advance one snake's momentum by dt ms. Called once per sim tick per living
// snake (sim.js), BEFORE the movement-accumulator math that consumes it.
function updateMomentum(s, now, dt) {
  const engaged = BOOST.enabled && s.boost && s.boostSince != null &&
    (now - s.boostSince) > BOOST.holdGraceMs;
  let p = s.rampProgress || 0;
  if (engaged) p = BOOST.rampMs > 0 ? Math.min(1, p + dt / BOOST.rampMs) : 1;
  else p = BOOST.decelMs > 0 ? Math.max(0, p - dt / BOOST.decelMs) : 0;
  s.rampProgress = p;
}
// Global floor on snake length. Drives both the initial spawn length
// (spawnSnake) and the poison-trail damage floor -- one source of truth so
// the two can never drift out of sync.
const MIN_SNAKE_LENGTH = Number.isInteger(CFG.minSnakeLength) && CFG.minSnakeLength > 0 ? CFG.minSnakeLength : 3;
// Powerups. Each type is its own sub-config, shallow-merged over defaults
// exactly like BOOST/CLIENT_FX above so an older config.json missing the
// whole section (or missing one type) still works.
// maxConcurrentPickups is now the HARD CEILING; the live cap scales with
// player count (max(1, ceil(players/4)), see state.js pickupCap) up to it.
const POWERUPS = Object.assign({ spawnIntervalMs: 8000, maxConcurrentPickups: 4 }, CFG.powerups || {});
POWERUPS.wormhole    = Object.assign({ enabled: true, lookaheadDepth: 3 }, POWERUPS.wormhole || {});
POWERUPS.growthSpurt = Object.assign({ enabled: true, durationMs: 8000, foodMultiplier: 2, killBonusGrowth: 2 }, POWERUPS.growthSpurt || {});
POWERUPS.iceTrail    = Object.assign({ enabled: true, durationMs: 8000, tileDurationMs: 10000, slowDurationMs: 4000, slowMultiplierPerStack: 0.15, minSpeedMultiplier: 0.4 }, POWERUPS.iceTrail || {});
POWERUPS.poisonTrail = Object.assign({ enabled: true, durationMs: 8000, tileDurationMs: 10000 }, POWERUPS.poisonTrail || {});
POWERUPS.speedBoost  = Object.assign({ enabled: true, durationMs: 6000, speedMult: 1.6 }, POWERUPS.speedBoost || {});
// Blue Shell: not a self-buff -- picking it up launches a seeking
// projectile (see updateBlueShells). segmentLossPercent hits whoever is
// CURRENTLY longest (re-targeted every tick, including the firer -- the
// leader is meant to spend effort GUARDING the shell, not just racing food);
// splashLossPercent hits every other living snake within explosionRadius
// cells of the impact point. moveIntervalMs governs how often the
// projectile itself steps (independent of any snake's speed). Never spawns
// with fewer than two people in the game (see maybeSpawnPowerupPickup).
POWERUPS.blueShell = Object.assign(
  { enabled: true, segmentLossPercent: 0.33, explosionRadius: 3, splashLossPercent: 1 / 6, moveIntervalMs: 90 },
  POWERUPS.blueShell || {}
);
// Banana Trail (Phase 11): lays tiles like ice/poison; crossing one INVERTS
// the crosser's controls for invertDurationMs (see the dir handler + the
// module doc in powerups/bananaTrail.js).
POWERUPS.bananaTrail = Object.assign(
  { enabled: true, durationMs: 8000, tileDurationMs: 10000, invertDurationMs: 4000 },
  POWERUPS.bananaTrail || {}
);
// Hello World: the powerups/README.md teaching template. Off by default --
// it exists to be read and copied, not played (a test flips it on).
POWERUPS.helloWorld = Object.assign(
  { enabled: false, durationMs: 1000, speedMult: 1.02 },
  POWERUPS.helloWorld || {}
);
// ORDER IS LOAD-BEARING: index order must match the renderers' color tables
// (render.js POWERUP_TYPE_INDEX, render2d.js POWERUP_STYLE, wasm
// pickupColor/trailColor). New types are always APPENDED.
const POWERUP_TYPES = ["wormhole", "growthSpurt", "iceTrail", "poisonTrail", "speedBoost", "blueShell", "bananaTrail", "helloWorld"];
// Trail-laying powerups: while one is the activePowerup, each movement step
// lays a tile of that type at the vacated cell (see applyMovementAndFood).
const TRAIL_TYPES = new Set(["iceTrail", "poisonTrail", "bananaTrail"]);
// Short, ESL-friendly title/description per powerup, sourced from each
// module (not duplicated here) so the client's info popup and the modules
// themselves can never drift out of sync with each other.
const POWERUP_INFO = {};
for (const t of POWERUP_TYPES) {
  POWERUP_INFO[t] = { title: POWERUP_MODULES[t].title || t, description: POWERUP_MODULES[t].description || "" };
}
// Which powerups wait in the held slot for the activate button. A module opts
// in with `requiresActivation: true` (only speedBoost, by design -- see the
// maintainer decision 2026-07-16). Everything else fires the instant it is
// picked up; wormhole is separate again (its own charge, auto-triggers on a
// fatal move, never touches the held slot). Keeping this data-driven means a
// new powerup only has to set the flag, not edit the pickup/activate handlers.
const HELD_TYPES = new Set(POWERUP_TYPES.filter(t => POWERUP_MODULES[t].requiresActivation));
// Every module exposing a speedMultiplier hook -- multiplied into the
// per-snake movement accumulator (simLoop) and the broadcast moveMs
// (broadcastState) so a new speed-affecting powerup only writes the hook.
const SPEED_MULT_TYPES = POWERUP_TYPES.filter(t => typeof POWERUP_MODULES[t].speedMultiplier === "function");
// Zero-resource debug switch. When enableDebug is false, dlog is null and
// every debug call site is a single falsy short-circuit (`dlog && dlog(...)`)
// -- no string building, no buffering, no I/O. The client is told via
// /api/config and skips creating its debug button/panel/recording entirely.
const ENABLE_DEBUG = CFG.enableDebug !== false;
const dlog = ENABLE_DEBUG ? (...args) => console.log("[debug]", ...args) : null;
// Zero-resource perf instrumentation, same philosophy as dlog: when the
// SNAKE_PERF env var is unset, PERF is null and every site is one falsy
// short-circuit. When set, the sim loop times movementStep/broadcastState
// (at their CALL SITES, so the hot functions themselves stay untouched),
// broadcastState counts serialized bytes, and one "[perf] {json}" summary
// line is printed every 5s (consumed by tests/perf_baseline.js). The 5s
// summary timer itself lives in server.js (it reads live slot state).
const PERF = process.env.SNAKE_PERF ? {
  mvNs: 0n, mvCalls: 0, mvMaxNs: 0n,
  bcNs: 0n, bcCalls: 0, bcMaxNs: 0n,
  bytesBase: 0, bytesTotal: 0, sends: 0
} : null;
const CLIENT_RENDER = Object.assign({ interpolate: true, renderer: "auto" }, CFG.clientRender || {});
// Rubberbanding (Phase 8, maintainer-specced): silent catch-up mechanics.
//   foodBias: food placement prefers cells near the SHORTEST living snake's
//     head -- a free cell within `radius` (Chebyshev) is always accepted, a
//     farther one only with probability 1/strength. Inert with one player
//     or all-equal lengths (see placeFood).
//   shellPressure: when the leader is at least `leadRatio` times the length
//     of the second-longest snake (1.3 = "30% longer"), blue shells spawn
//     sooner (spawn interval x intervalScale) and the type roll weights
//     blueShell at `typeWeight` vs 1 for everything else. Runs AFTER the
//     presence gate -- pressure can never re-introduce a blueShell the gate
//     removed.
const RUBBERBAND = Object.assign({}, CFG.rubberband || {});
RUBBERBAND.foodBias = Object.assign({ enabled: true, radius: 15, strength: 3 }, RUBBERBAND.foodBias || {});
RUBBERBAND.shellPressure = Object.assign({ enabled: true, leadRatio: 1.3, typeWeight: 4, intervalScale: 0.5 }, RUBBERBAND.shellPressure || {});

const COLORS = [
  { head: "#6f6", body: "#3a3" },
  { head: "#6cf", body: "#38a" },
  { head: "#f6f", body: "#a3a" },
  { head: "#ff6", body: "#aa3" }
];
const DIR_VECTORS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const TEST_SPAWNS = (() => {
  try { return process.env.SNAKE_TEST_SPAWNS ? JSON.parse(process.env.SNAKE_TEST_SPAWNS) : null; }
  catch (_) { return null; }
})();
// Test-only runtime hooks (inert unless SNAKE_TEST_HOOKS=1): enables the
// "testHook" WS message, which lets a test place a pickup of a chosen type at
// a chosen cell, grant/fire a powerup on a slot, or re-roll food -- mid-test
// staging that the startup-time SNAKE_TEST_SPAWNS env cannot express.
const TEST_HOOKS = process.env.SNAKE_TEST_HOOKS === "1";

module.exports = {
  ROOT, CFG, PKG, BUILD, PUBLIC_DIR, PORT,
  SIM_HZ, SIM_MS, MOVE, MAX_FOOD, MAX_LOCAL_PLAYERS, CLIENT_FX, CLIENT_RENDER,
  WALL_GRACE_TICKS, SPECTATOR_IDLE_MS, PLAYER_IDLE_MS,
  JOIN_OFFER_MS, INPUT_BUFFER, BOOST, boostRamp, updateMomentum, MIN_SNAKE_LENGTH,
  POWERUPS, POWERUP_TYPES, POWERUP_INFO, HELD_TYPES, TRAIL_TYPES, SPEED_MULT_TYPES, POWERUP_MODULES,
  ENABLE_DEBUG, dlog, PERF, COLORS, DIR_VECTORS, TEST_SPAWNS, TEST_HOOKS,
  RUBBERBAND
};
