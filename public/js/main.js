// ============================================================
// Bootstrap. Client leads on movement + food prediction; server reconciles.
//
// Phase 3 (dual local controls / couch co-op): myPlayers is keyed by LOCAL
// INDEX (0 = p1/arrow keys, 1 = p2/WASD), not by server slot -- the server
// slot a local player occupies can change across respawns, but the local
// index (which controls map to it) never does.
//
// Phase 4 additions:
//   - Seat lifecycle: any seat can LEAVE (button) and later REJOIN by
//     pressing its own movement keys or the Play/Add button. Leaving the
//     last seat closes the connection entirely; the server said goodbye, so
//     the client shows a rejoin/menu screen instead of idling.
//   - Boost & slide: holding the key of the CURRENT travel direction sends
//     boost on/off transitions to the server. Turns entered while boosting
//     are still sent (and acked) immediately, but flagged `delayed` so the
//     predictor does not pre-play a turn the server will drift through for
//     config.boost.slideDistance cells.
//   - Lock-step render smoothing: each state message carries every player's
//     effective ms-per-cell (moveMs, boost included); render.js interpolates
//     between the last two snapshots at exactly that cadence. Cosmetic only.
//   - Zero-resource debug: when the operator sets enableDebug=false, the
//     debug button/panel/recording are never created at all -- the only
//     residue is one boolean test at startup.
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).main = "main 2026-07-18.3";
let CLIENT_FX = { inputFlash: true, inputFlashMs: 90, correctionGlide: true, correctionGlideMs: 90, boostTrail: true, slideDust: true, heldGlow: true, powerupFx: true };
let CLIENT_RENDER = { interpolate: true, renderer: "auto" };
let BOOST_CFG = { enabled: true, boostSpeed: 2.0, driftMs: 250, rampMs: 400, holdGraceMs: 120, decelMs: 250, driftThreshold: 0.3 };
let POWERUPS_CFG = {};
fetch("/api/config").then(r => r.json()).then(cfg => {
  if (cfg && cfg.clientFx) CLIENT_FX = Object.assign({}, CLIENT_FX, cfg.clientFx);
  if (cfg && cfg.clientRender) CLIENT_RENDER = Object.assign({}, CLIENT_RENDER, cfg.clientRender);
  if (cfg && cfg.boost) BOOST_CFG = Object.assign({}, BOOST_CFG, cfg.boost);
  if (cfg && cfg.powerups) POWERUPS_CFG = cfg.powerups;
  UI.setPowerupInfo((cfg && cfg.powerupInfo) || {}, POWERUPS_CFG);
  // The join-screen boost tip (index.html #boostTip) is irrelevant if the
  // operator disabled the mechanic entirely -- don't show players a tip for
  // something that will never boost them.
  if (!BOOST_CFG.enabled) {
    const tip = document.getElementById("boostTip");
    if (tip) tip.style.display = "none";
  }
  // Zero-resource debug gate: nothing debug-related is even constructed
  // when the operator disabled it -- no button, no panel, no recording
  // hooks, no per-frame branches beyond this single startup check.
  if (!cfg || cfg.enableDebug !== false) {
    UI.initDebug(window.__DEBUG_SOURCE__, on => myPlayers.forEach(p => p.setDebug(on)));
    UI.showVersionStamp(true, cfg && cfg.build);
  }
}).catch(() => {
  UI.initDebug(window.__DEBUG_SOURCE__, on => myPlayers.forEach(p => p.setDebug(on)));
  UI.showVersionStamp(true, null);
});

// Keybind remap (Phase 4): 100% client-side, localStorage-persisted, never
// sent to the server (the server only ever needs to know WHICH local index
// activated, not the physical key). "activate" is a distinct action, not a
// movement direction, stored per-seat alongside up/down/left/right -- it is
// looked up against e.code (e.g. "Space", "ShiftRight") rather than e.key so
// left/right Shift can be told apart, which e.key cannot do.
const KEYMAP_STORAGE_PREFIX = "snake.keymap.local";
const DEFAULT_KEY_MAPS = [
  // p1 plays with the arrow keys (right side of the keyboard), so its activate
  // key is Right Shift (right there by the arrows). p2 plays WASD (left side)
  // and activates with Space -- easy reach for the left hand. (Swapped
  // 2026-07-16: the old p1=Space/p2=RightShift mapping was the source of the
  // "speed boost won't activate" confusion.)
  { arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", activate: "ShiftRight" }, // local 0 (p1): arrows
  { w: "up", s: "down", a: "left", d: "right", activate: "Space" }                                      // local 1 (p2): WASD
];
function loadKeyMaps() {
  const maps = [];
  for (let i = 0; i < DEFAULT_KEY_MAPS.length; i++) {
    let map = null;
    try {
      const raw = localStorage.getItem(KEYMAP_STORAGE_PREFIX + i);
      if (raw) map = JSON.parse(raw);
    } catch (_) { /* localStorage unavailable or corrupt entry: fall back to default */ }
    maps.push(map || Object.assign({}, DEFAULT_KEY_MAPS[i]));
  }
  return maps;
}
function saveKeyMap(localIdx, map) {
  KEY_MAPS[localIdx] = map;
  try { localStorage.setItem(KEYMAP_STORAGE_PREFIX + localIdx, JSON.stringify(map)); } catch (_) {}
}
// Swaps which local index uses WASD vs. arrows -- movement keys only, each
// seat keeps its OWN activation key rebind across the swap.
function swapKeyMaps() {
  const a = KEY_MAPS[0], b = KEY_MAPS[1];
  const moveOnly = m => { const o = {}; for (const k in m) if (k !== "activate") o[k] = m[k]; return o; };
  saveKeyMap(0, Object.assign({ activate: a.activate }, moveOnly(b)));
  saveKeyMap(1, Object.assign({ activate: b.activate }, moveOnly(a)));
}
const KEY_MAPS = loadKeyMaps();
const DIR_TO_VEC = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

const myPlayers = new Map();
// Session-bound initials per local seat (v3.4.0): P1's are entered on the
// captcha gate before play; P2's on its first join. Sent to the server via
// setInitials and used there to auto-record qualifying scores at death --
// there is no post-game prompt anymore. localStorage only PREFILLS the
// entry fields on the next page load; the prompt itself always runs.
const INITIALS_STORAGE_PREFIX = "snake.initials.local";
const sessionInitials = [null, null];
function storeInitials(localIdx, value) {
  sessionInitials[localIdx] = value;
  try { localStorage.setItem(INITIALS_STORAGE_PREFIX + localIdx, value); } catch (_) {}
  Net.send({ type: "setInitials", local: localIdx, value });
}
function storedInitials(localIdx) {
  try { return localStorage.getItem(INITIALS_STORAGE_PREFIX + localIdx) || ""; } catch (_) { return ""; }
}
// Post-initials-entry input grace (v3.4.0 listener-isolation fix): for a
// short window after ANY initials entry is confirmed, movement keys cannot
// REQUEST A SEAT -- residual/trailing keypresses from typing initials (WASD
// letters!) must not spawn P2. Movement of already-playing seats is
// unaffected.
const SEAT_REQUEST_GRACE_MS = 1800;
let seatRequestGraceUntil = 0;
function armSeatRequestGrace() { seatRequestGraceUntil = performance.now() + SEAT_REQUEST_GRACE_MS; }
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
// on the broadcast where an impact happened, per server.js). Each one is
// stamped with a local start time here and aged out client-side over
// EXPLOSION_DURATION_MS -- this module is the only place that owns that
// timing; render.js just draws whatever age it's given.
const EXPLOSION_DURATION_MS = 500;
let activeExplosions = [];
// Powerup activation flash: state.players[i].activated is a one-shot type
// (set for exactly the broadcast where a powerup fired, per server.js). Each
// is stamped with a local start time and aged out over POWERUP_FLASH_MS -- a
// brief bright pop in the powerup's color on that snake, visible to everyone.
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

function wireLocalPlayer(localIdx) {
  const p = myPlayers.get(localIdx);
  p.setSender((dir, clientSeq) => Net.send({ type: "dir", dir, cseq: clientSeq, local: localIdx }));
}
// Request (or re-request after a Leave) a seat for this local index. The
// server admits it round-robin fair like any fresh join: instant slot if the
// board is free and nobody waits, otherwise back of the spectator queue.
// v3.4.0: a seat with no session initials yet (P2's first join) prompts for
// them FIRST -- the join proceeds on confirm. While that prompt is open all
// game key handling is suspended (see the keydown gate), and confirming it
// arms the seat-request grace so trailing keypresses can't double-join.
function requestSeat(localIdx) {
  if (seatPending[localIdx]) return;
  if (myLocals && myLocals[localIdx]) return; // seat already exists in some role
  if (!sessionInitials[localIdx]) {
    UI.promptInitials(localIdx, storedInitials(localIdx), value => {
      storeInitials(localIdx, value);
      armSeatRequestGrace();
      doRequestSeat(localIdx);
    });
    return;
  }
  doRequestSeat(localIdx);
}
function doRequestSeat(localIdx) {
  if (seatPending[localIdx]) return;
  if (myLocals && myLocals[localIdx]) return;
  seatPending[localIdx] = true;
  if (!myPlayers.has(localIdx)) {
    myPlayers.set(localIdx, new LocalPlayerPredictor(localIdx === 0 ? "p1" : "p2"));
    wireLocalPlayer(localIdx);
  }
  Net.send({ type: "joinLocal" });
}
// Leave one seat completely (no spectator queue). Server-side this frees the
// slot / queue entry and, if it was our LAST seat, closes the connection --
// onClose below then shows the rejoin menu instead of a dead board.
function leaveSeat(localIdx) {
  if (!myLocals || !myLocals[localIdx]) return;
  if (boostOn[localIdx]) { boostOn[localIdx] = false; } // socket may close; no point sending off
  Net.send({ type: "leaveLocal", local: localIdx });
}
// Called from handleState when the server reports a seat as gone (null):
// tear down the local predictor and pending flags so the seat can be
// re-requested cleanly with a keypress or button later.
function dropSeat(localIdx) {
  if (!myPlayers.has(localIdx)) return;
  myPlayers.delete(localIdx);
  seatPending[localIdx] = false;
  boostOn[localIdx] = false;
  lastInputFlash[localIdx] = null;
  activeGlide[localIdx] = null;
}

// ---- Boost detection ------------------------------------------------
// Boost is "the key of the current direction of travel is held down".
// Evaluated on every keydown/keyup AND after every server state (the
// current direction can change under a held key); only on/off TRANSITIONS
// go over the wire.
function dirNameOfVec(v) {
  for (const name in DIR_TO_VEC) {
    if (DIR_TO_VEC[name].x === v.x && DIR_TO_VEC[name].y === v.y) return name;
  }
  return null;
}
function keyForDir(localIdx, dirName) {
  const map = KEY_MAPS[localIdx];
  for (const key in map) if (map[key] === dirName) return key;
  return null;
}
function refreshBoost() {
  if (!BOOST_CFG.enabled || !myLocals) return;
  for (let localIdx = 0; localIdx < KEY_MAPS.length; localIdx++) {
    seatSpeed(localIdx); // keep the lazy momentum clock fresh (runs every broadcast)
    const entry = myLocals[localIdx];
    const p = myPlayers.get(localIdx);
    const playing = entry && entry.role === "player" && p;
    let want = false;
    if (playing) {
      // Effective direction: the last queued (unacked) turn if any,
      // otherwise the authoritative direction -- matches what the server
      // will be traveling when the hold takes effect.
      const pending = p.inputBuffer.length > 0 ? p.inputBuffer[p.inputBuffer.length - 1].vec : p.dir;
      const dirName = dirNameOfVec(pending);
      const key = dirName && keyForDir(localIdx, dirName);
      want = !!(key && heldKeys.has(key));
      // The touch BOOST button has no direction of its own: holding it
      // boosts seat 0's current travel, whatever that is.
      if (localIdx === 0 && touchBoost) want = true;
    }
    if (want !== boostOn[localIdx]) {
      boostOn[localIdx] = want;
      if (want) boostOnSince[localIdx] = performance.now();
      Net.send({ type: "boost", on: want, local: localIdx });
    }
  }
}

function startGame(token, initials) {
  if (!myPlayers.has(0)) myPlayers.set(0, new LocalPlayerPredictor("p1"));
  wireLocalPlayer(0);
  // P1's initials came from the captcha gate; bind them for the session and
  // arm the grace so residual keypresses from typing them can't spawn P2.
  // (The setInitials send inside storeInitials is dropped -- no socket yet --
  // and onOpen below re-sends every bound seat's initials once connected.)
  if (initials) storeInitials(0, initials);
  armSeatRequestGrace();
  UI.setConnectionStatus("connecting...");
  Net.connect(token, {
    onOpen: () => {
      UI.setConnectionStatus("connected");
      // The socket is up now: (re)send every seat's session initials.
      sessionInitials.forEach((v, idx) => { if (v) Net.send({ type: "setInitials", local: idx, value: v }); });
    },
    onClose: () => {
      // Connection is gone (we left, were idle-kicked, or the server went
      // away). Never idle on a dead board: show the menu/rejoin screen.
      UI.setConnectionStatus("disconnected");
      UI.showRejoin();
    },
    onState: handleState,
    onSpectator: msg => UI.showSpectator(msg, myPlayers.size > 1),
    onOfferJoin: msg => UI.offerJoin(msg, () => Net.send({ type: "acceptJoin", local: msg.local }), myPlayers.size > 1),
    onJoinLocalDenied: () => { seatPending[1] = false; UI.notifyJoinLocalDenied({ reason: "max local players reached" }); }
  });
  // Mobile is single-seat only (maintainer decision, Phase 6): no co-op
  // button on coarse-pointer devices -- swipe + PWR + BOOST replace the
  // keyboard surfaces instead.
  if (IS_TOUCH) {
    UI.initTouchControls({
      onActivate: () => {
        const entry = myLocals && myLocals[0];
        if (entry && entry.role === "player") Net.send({ type: "activatePowerup", local: 0 });
      },
      onBoost: on => { touchBoost = on; refreshBoost(); }
    });
    initSwipeSteering();
    // Mobile: hide the INFO overlays by default behind a small toggle so they
    // never cover the board (swipe-to-steer keeps working while hidden). The
    // PWR/BOOST play buttons stay on screen at all times -- see initMobileUiToggle.
    UI.initMobileUiToggle();
  } else {
    UI.initCoOp(() => requestSeat(1));
  }
  UI.initLeaveButtons(leaveSeat);
  UI.initKeymapPanel(() => KEY_MAPS, saveKeyMap, swapKeyMaps);
  // Persistent "Change Initials" (v3.4.0): overwrite either seat's session
  // initials any time, no refresh needed. Saving re-arms the grace window.
  UI.initInitialsPanel(
    idx => sessionInitials[idx] || storedInitials(idx),
    (idx, value) => { storeInitials(idx, value); armSeatRequestGrace(); }
  );
}
// Swipe-to-turn (Phase 6): dominant axis of the drag, one turn per swipe
// (the start point is consumed once the threshold trips; a new turn needs a
// new touch). Feeds the exact same predictor path as a keypress --
// queueInput + input flash -- so netcode and prediction need no changes.
// A swipe when seat 0 doesn't exist is the rejoin gesture, mirroring the
// keydown rejoin rule ("the input itself is the join request").
function steerTouch(dir) {
  if (!myLocals) return;
  const entry = myLocals[0];
  if (!entry) {
    if (!seatPending[0]) requestSeat(0);
    return;
  }
  if (entry.role !== "player") return;
  const p = myPlayers.get(0);
  if (!p) return;
  const accepted = p.queueInput(dir, driftyTurn(0) || seatInverted(0));
  if (accepted && CLIENT_FX.inputFlash) lastInputFlash[0] = { dir, t: performance.now() };
}
function initSwipeSteering() {
  const board = document.getElementById("game");
  let start = null;
  board.addEventListener("touchstart", e => {
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  board.addEventListener("touchmove", e => {
    if (!start) return;
    const t = e.touches[0];
    const dx = t.clientX - start.x, dy = t.clientY - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_MIN_PX) return;
    start = null; // consumed: one turn per swipe
    steerTouch(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"));
  }, { passive: true });
  board.addEventListener("touchend", () => { start = null; });
}
function handleState(curr, prev) {
  myLocals = curr.you.locals;
  spawnDriftDust(curr, prev);
  if (myPlayers.has(1) && myLocals[1] && myLocals[1].role === "player") UI.coOpJoined();
  for (let idx = 0; idx < KEY_MAPS.length; idx++) {
    const entry = myLocals[idx];
    if (!entry) {
      // Seat left (or never existed). Clean up so its keys can re-request
      // it -- but NOT while a join request is still in flight: a state
      // broadcast can arrive before the server processed our joinLocal, and
      // tearing the predictor down then would cancel the join.
      if (!seatPending[idx]) {
        dropSeat(idx);
        if (idx === 1) UI.coOpLeft();
      }
      continue;
    }
    seatPending[idx] = false; // server now knows this seat, in whatever role
    const p = myPlayers.get(idx);
    if (!p) continue;
    if (entry.role !== "player") {
      // Spectating or held: nothing to reconcile against, and any
      // previously predicted body must not keep rendering stale.
      p.simBody = null; p.authBody = null;
      continue;
    }
    p.reconcile(entry.slot, curr.players, curr.tickMs, curr.grid, curr.seq, entry.ack, curr.foods);
    p.retryUnacked();
    // Capture a fresh correction event for the glide effect (cosmetic only;
    // guarded by id so a still-active glide isn't restarted every frame).
    const ev = p.lastCorrectionEvent;
    if (CLIENT_FX.correctionGlide && ev && ev.id !== lastSeenCorrectionEventId[idx]) {
      lastSeenCorrectionEventId[idx] = ev.id;
      activeGlide[idx] = { from: ev.fromHead, to: ev.toHead, slot: entry.slot, startTime: performance.now() };
    }
  }
  if (curr.explosions && curr.explosions.length) {
    const now = performance.now();
    curr.explosions.forEach(e => activeExplosions.push(Object.assign({ startTime: now }, e)));
  }
  // Powerup activation flashes: one per player whose `activated` one-shot is
  // set this broadcast (any seat, local or remote -- everyone sees the pop).
  if (curr.players) {
    const now = performance.now();
    curr.players.forEach((p, slot) => {
      if (p && p.activated) activePowerFlashes.push({ slot, type: p.activated, startTime: now });
    });
  }
  refreshBoost(); // direction may have changed under a held key
  UI.updateStatus(curr);
  UI.updateLeaveButtons(myLocals);
  UI.updateLeaderboards(curr.highScores, curr.mode);
}
function frame() {
  const { prev, curr } = Net.snapshots();
  if (curr) {
    const localBodies = new Map();
    const eatenKeys = [];
    const flashes = [];
    const glides = [];
    const now = performance.now();
    if (myLocals) {
      myLocals.forEach(entry => {
        if (!entry || entry.role !== "player") return;
        const p = myPlayers.get(entry.local);
        if (!p) return;
        const body = p.renderBody(now);
        if (body) localBodies.set(entry.slot, body);
        const k = p.eatenFoodKey();
        if (k) eatenKeys.push(k);
        const lif = lastInputFlash[entry.local];
        if (CLIENT_FX.inputFlash && lif && (now - lif.t) < CLIENT_FX.inputFlashMs) {
          flashes.push({ slot: entry.slot, dir: lif.dir, t: lif.t, durationMs: CLIENT_FX.inputFlashMs });
        }
        const g = activeGlide[entry.local];
        if (g && (now - g.startTime) < CLIENT_FX.correctionGlideMs) {
          glides.push(Object.assign({ durationMs: CLIENT_FX.correctionGlideMs }, g));
        } else if (g) {
          activeGlide[entry.local] = null; // expired, stop carrying it forward
        }
      });
    }
    const now2 = performance.now();
    activeExplosions = activeExplosions.filter(e => now2 - e.startTime < EXPLOSION_DURATION_MS);
    const explosions = activeExplosions.map(e => Object.assign({}, e, { age: (now2 - e.startTime) / EXPLOSION_DURATION_MS }));
    activePowerFlashes = activePowerFlashes.filter(f => now2 - f.startTime < POWERUP_FLASH_MS);
    const powerFlashes = CLIENT_FX.powerupFx
      ? activePowerFlashes.map(f => ({ slot: f.slot, type: f.type, age: (now2 - f.startTime) / POWERUP_FLASH_MS }))
      : [];
    activeDust = activeDust.filter(d => now2 - d.startTime < DUST_MS);
    const dust = activeDust.map(d => ({ x: d.x, y: d.y, age: (now2 - d.startTime) / DUST_MS }));
    Render.draw(prev, curr, localBodies, eatenKeys, { flashes, glides, explosions, powerFlashes, dust }, {
      interpolate: CLIENT_RENDER.interpolate,
      renderer: CLIENT_RENDER.renderer,
      boostTrail: CLIENT_FX.boostTrail,
      slideDust: CLIENT_FX.slideDust,
      heldGlow: CLIENT_FX.heldGlow,
      powerupFx: CLIENT_FX.powerupFx
    });
  }
  requestAnimationFrame(frame);
}
document.addEventListener("keydown", e => {
  // Listener isolation (v3.4.0): while any text entry is active -- the
  // captcha/initials gate, a P2 initials prompt, the Change Initials panel,
  // or focus sitting in ANY input -- the game must not see keys at all. No
  // movement, no boost, no seat requests; nothing leaks from typing "WAS"
  // into a WASD listener. This is a gate on WHEN the listener acts, not a
  // remap of any key.
  if (UI.isTextEntryActive() || (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA"))) return;
  if (!myLocals) return;
  // Powerup activation: a distinct action from movement, looked up against
  // e.code (not e.key) so left/right Shift can be told apart. This is its
  // own branch, NOT folded into the movement loop's break-after-first-match
  // below, since "activate" is not a direction and the two must not compete
  // for the same physical key.
  let didActivate = false;
  for (let localIdx = 0; localIdx < KEY_MAPS.length; localIdx++) {
    if (KEY_MAPS[localIdx].activate === e.code) {
      const entry = myLocals[localIdx];
      if (entry && entry.role === "player") Net.send({ type: "activatePowerup", local: localIdx });
      e.preventDefault();
      didActivate = true;
      break; // activation key belongs to at most one local player
    }
  }
  if (didActivate) {
    // Always refresh boost even after activation, since a keystroke doesn't
    // erase the held direction keys. This ensures boost state is current.
    refreshBoost();
    return;
  }
  const key = e.key.toLowerCase();
  // Rejoin rule: pressing a seat's own movement keys when that seat does not
  // currently exist (never joined, or left via the Leave button) re-requests
  // it. The keypress itself is the join request and moves nothing yet.
  // Suppressed during the post-initials grace window: trailing keypresses
  // from an initials entry must not count as a join request.
  for (let localIdx = 0; localIdx < KEY_MAPS.length; localIdx++) {
    if (KEY_MAPS[localIdx][key] !== undefined && !myLocals[localIdx] && !seatPending[localIdx]) {
      if (performance.now() < seatRequestGraceUntil) return;
      requestSeat(localIdx);
      return;
    }
  }
  const wasHeld = heldKeys.has(key);
  heldKeys.add(key);
  for (let localIdx = 0; localIdx < KEY_MAPS.length; localIdx++) {
    const dir = KEY_MAPS[localIdx][key];
    if (!dir) continue;
    const entry = myLocals[localIdx];
    if (!myPlayers.has(localIdx) || !entry || entry.role !== "player") break;
    if (!wasHeld) {
      // A turn typed at SPEED (momentum >= driftThreshold, whether or not
      // the boost key is still held) drifts the body server-side; tell the
      // predictor not to pre-play it (see predict.js). Below the threshold
      // it's a plain, predictable turn. A turn typed while banana-INVERTED
      // is flipped server-side -- same rule.
      const accepted = myPlayers.get(localIdx).queueInput(dir, driftyTurn(localIdx) || seatInverted(localIdx));
      if (accepted && CLIENT_FX.inputFlash) lastInputFlash[localIdx] = { dir, t: performance.now() };
    }
    if (key.startsWith("arrow")) e.preventDefault();
    break; // a key belongs to at most one local player's map
  }
  refreshBoost();
});
document.addEventListener("keyup", e => {
  heldKeys.delete(e.key.toLowerCase());
  refreshBoost();
});
// Alt-tab etc.: the browser stops delivering keyups, so treat everything as
// released rather than leave a snake boosting forever.
window.addEventListener("blur", () => { heldKeys.clear(); refreshBoost(); });
window.__DEBUG_SOURCE__ = function () {
  const { curr } = Net.snapshots();
  const locals = [];
  myPlayers.forEach((p, localIdx) => {
    const entry = myLocals ? myLocals[localIdx] : null;
    let playerState = null;
    if (entry && entry.role === "player" && curr && curr.players) {
      playerState = curr.players[entry.slot];
    }
    const activationKey = KEY_MAPS[localIdx].activate;
    const isPressingActivation = heldKeys.has(activationKey.toLowerCase()) || heldKeys.has(activationKey);
    locals.push({
      label: localIdx === 0 ? "p1" : "p2",
      role: entry ? entry.role : null,
      slot: (entry && entry.role === "player") ? entry.slot : null,
      boost: boostOn[localIdx],
      heldPowerup: playerState ? playerState.heldPowerup : null,
      activePowerup: playerState ? playerState.activePowerup : null,
      isDrifting: playerState ? !!playerState.activePowerup && (playerState.activePowerup.type === "iceTrail" || playerState.activePowerup.type === "poisonTrail") : false,
      isPressingActivation: isPressingActivation,
      pending: p.inputBuffer.map(x => ({ seq: x.seq, dir: x.dirName, retries: x.retries })),
      corrections: p.corrections.slice(-12),
      correctionCount: p.correctionCount
    });
  });
  return {
    builds: window.__BUILDS__ || {},
    serverBuild: curr ? curr.build : null,
    seq: curr ? curr.seq : null,
    tickMs: curr ? curr.tickMs : null,
    boostSpeed: BOOST_CFG.boostSpeed,
    driftMs: BOOST_CFG.driftMs,
    rampMs: BOOST_CFG.rampMs,
    holdGraceMs: BOOST_CFG.holdGraceMs,
    locals
  };
};
UI.initCaptchaGate(startGame);
requestAnimationFrame(frame);
