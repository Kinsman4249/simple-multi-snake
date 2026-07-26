// ============================================================
// Shared mutable client state: config mirrors (patched by bootstrap.js's
// /api/config fetch), boost/momentum tracking, cosmetic fx queues
// (explosions/wall-shatters/powerup-flashes/drift-dust), and touch
// detection. Every other main-* file reads/writes these as plain globals.
// ============================================================
let CLIENT_FX = { inputFlash: true, inputFlashMs: 90, correctionGlide: true, correctionGlideMs: 90, boostTrail: true, slideDust: true, heldGlow: true, powerupFx: true };
let CLIENT_RENDER = { interpolate: true, renderer: "auto" };
let BOOST_CFG = { enabled: true, boostSpeed: 2.0, driftMs: 250, rampMs: 400, holdGraceMs: 120, decelMs: 250, driftThreshold: 0.3 };
let POWERUPS_CFG = {};

const DIR_TO_VEC = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

// Phase 3 (dual local controls / couch co-op): myPlayers is keyed by LOCAL
// INDEX (0 = p1/arrow keys, 1 = p2/WASD), not by server slot -- the server
// slot a local player occupies can change across respawns, but the local
// index (which controls map to it) never does.
const myPlayers = new Map();
// curr.you.locals: array of
//   { local, role:"player", slot, ack } | { local, role:"spectator", ... } |
//   null (left).
let myLocals = null;
// Guards against sending duplicate joinLocal requests while one is in flight.
const seatPending = [false, false];
// Per-local-index cosmetic fx state (index matches myPlayers/KEY_MAPS).
let lastInputFlash = [null, null];
let activeGlide = [null, null];
let lastSeenCorrectionEventId = [0, 0];
// Boost input state: which raw keys are physically held, and whether each
// seat's boost is currently reported ON to the server.
const heldKeys = new Set();
const boostOn = [false, false];
// When each seat's boost was last reported ON. Mirrors the server's
// hold-grace (BOOST_CFG.holdGraceMs): until the hold survives the grace the
// server treats the snake as NOT boosting.
const boostOnSince = [0, 0];
// Client-side mirror of the server's per-snake momentum (v3.4.0): speed is
// state, not key state -- it ramps up while the hold is engaged and decays
// over decelMs after release. Updated lazily on every read (refreshBoost
// runs on every state broadcast, keeping it fresh). The server tags a turn
// as drifting whenever its momentum >= driftThreshold, so the predictor
// must skip pre-playing turns under the same condition -- including turns
// typed shortly AFTER the boost key was released.
const speedEst = [{ p: 0, t: 0 }, { p: 0, t: 0 }];
function seatSpeed(localIdx) {
  const st = speedEst[localIdx];
  const now = performance.now();
  const dt = st.t ? now - st.t : 0;
  st.t = now;
  const engaged = boostOn[localIdx] &&
    (now - boostOnSince[localIdx]) > (BOOST_CFG.holdGraceMs || 0);
  if (engaged) st.p = BOOST_CFG.rampMs > 0 ? Math.min(1, st.p + dt / BOOST_CFG.rampMs) : 1;
  else st.p = BOOST_CFG.decelMs > 0 ? Math.max(0, st.p - dt / BOOST_CFG.decelMs) : 0;
  return st.p;
}
function driftyTurn(localIdx) {
  return seatSpeed(localIdx) >= (BOOST_CFG.driftThreshold || 0.3);
}
// Banana-trail inversion (server-authoritative): while this seat's player is
// flagged `inverted`, the server flips every dir it receives, so the one-cell
// predictor must NOT pre-play the raw keypress -- reuse the drift's `delayed`
// mechanism (send + ack normally, render the authoritative body).
function seatInverted(localIdx) {
  const entry = myLocals && myLocals[localIdx];
  if (!entry || entry.role !== "player") return false;
  const { curr } = Net.snapshots();
  const p = curr && curr.players && curr.players[entry.slot];
  return !!(p && p.inverted);
}
// Blue Shell explosions: state.explosions is a one-shot list (populated only
// on the broadcast where an impact happened, per server-rust/src/net.rs).
// Each one is stamped with a local start time here and aged out client-side
// over EXPLOSION_DURATION_MS -- this module is the only place that owns
// that timing; render.js just draws whatever age it's given.
const EXPLOSION_DURATION_MS = 500;
let activeExplosions = [];
// Scissors wall-shatter fx (v4.5.0): same one-shot-list-plus-local-timer
// pattern as explosions above (server-rust/src/net.rs wallShatters).
const WALLSHATTER_DURATION_MS = 450;
let activeWallShatters = [];
// Powerup activation flash: state.players[i].activated is a one-shot type
// (set for exactly the broadcast where a powerup fired, per
// server-rust/src/net.rs). Each is stamped with a local start time and aged
// out over POWERUP_FLASH_MS -- a brief bright pop in the powerup's color on
// that snake, visible to everyone.
const POWERUP_FLASH_MS = 380;
let activePowerFlashes = []; // [{ slot, type, startTime }]
// Drift dust (v3.4.0): one transparent particle per grid cell a body
// segment slides through while its snake is drifting (`sliding` broadcast).
// Cells are found by diffing consecutive snapshots -- each segment's
// previous-snapshot cell is the cell it just vacated. Fast fade, hard cap,
// deduped per spawn so overlapping segments don't stack particles.
const DUST_MS = 300;
const DUST_CAP = 400;
let activeDust = []; // [{ x, y, startTime }]
function spawnDriftDust(curr, prev) {
  if (!CLIENT_FX.slideDust || !prev || !prev.players) return;
  const now = performance.now();
  const seen = new Set();
  curr.players.forEach((p, i) => {
    if (!p || !p.alive || !p.sliding) return;
    const pb = prev.players[i] && prev.players[i].body;
    if (!pb) return;
    for (let si = 0; si < p.body.length && si < pb.length; si++) {
      const a = pb[si], b = p.body[si];
      if (a.x === b.x && a.y === b.y) continue; // segment didn't move
      const key = a.x + "," + a.y;
      if (seen.has(key)) continue;
      seen.add(key);
      if (activeDust.length < DUST_CAP) activeDust.push({ x: a.x, y: a.y, startTime: now });
    }
  });
}
// Phase 6 -- mobile/touch (single seat only: seat 0). Coarse-pointer
// detection gates ALL touch surfaces; desktop behavior is untouched. A
// touchscreen laptop matches too and simply gets both input surfaces --
// harmless, since WASD still auto-joins P2 the keyboard way.
const IS_TOUCH = (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
  "ontouchstart" in window;
// Hold-to-boost button state, OR-ed into refreshBoost()'s want for seat 0 so
// the server keeps seeing only on/off transitions through the one code path.
let touchBoost = false;
const SWIPE_MIN_PX = 24;
