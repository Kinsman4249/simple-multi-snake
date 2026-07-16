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
(window.__BUILDS__ = window.__BUILDS__ || {}).main = "main 2026-07-15.1";
let CLIENT_FX = { inputFlash: true, inputFlashMs: 90, correctionGlide: true, correctionGlideMs: 90 };
let CLIENT_RENDER = { interpolate: true };
let BOOST_CFG = { enabled: true, boostSpeed: 1.5, slideDistance: 2 };
fetch("/api/config").then(r => r.json()).then(cfg => {
  if (cfg && cfg.clientFx) CLIENT_FX = Object.assign({}, CLIENT_FX, cfg.clientFx);
  if (cfg && cfg.clientRender) CLIENT_RENDER = Object.assign({}, CLIENT_RENDER, cfg.clientRender);
  if (cfg && cfg.boost) BOOST_CFG = Object.assign({}, BOOST_CFG, cfg.boost);
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
  }
}).catch(() => {
  UI.initDebug(window.__DEBUG_SOURCE__, on => myPlayers.forEach(p => p.setDebug(on)));
});

const KEY_MAPS = [
  { arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right" }, // local 0 (p1): arrows
  { w: "up", s: "down", a: "left", d: "right" }                                 // local 1 (p2): WASD
];
const DIR_TO_VEC = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

const myPlayers = new Map();
// curr.you.locals: array of
//   { local, role:"player", slot, ack } | { local, role:"spectator", ... } |
//   { local, role:"held" } (parked during the high-score flush) | null (left).
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

function wireLocalPlayer(localIdx) {
  const p = myPlayers.get(localIdx);
  p.setSender((dir, clientSeq) => Net.send({ type: "dir", dir, cseq: clientSeq, local: localIdx }));
}
// Request (or re-request after a Leave) a seat for this local index. The
// server admits it round-robin fair like any fresh join: instant slot if the
// board is free and nobody waits, otherwise back of the spectator queue.
function requestSeat(localIdx) {
  if (seatPending[localIdx]) return;
  if (myLocals && myLocals[localIdx]) return; // seat already exists in some role
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
    }
    if (want !== boostOn[localIdx]) {
      boostOn[localIdx] = want;
      Net.send({ type: "boost", on: want, local: localIdx });
    }
  }
}

function startGame(token) {
  if (!myPlayers.has(0)) myPlayers.set(0, new LocalPlayerPredictor("p1"));
  wireLocalPlayer(0);
  UI.setConnectionStatus("connecting...");
  Net.connect(token, {
    onOpen: () => UI.setConnectionStatus("connected"),
    onClose: () => {
      // Connection is gone (we left, were idle-kicked, or the server went
      // away). Never idle on a dead board: show the menu/rejoin screen.
      UI.setConnectionStatus("disconnected");
      UI.showRejoin();
    },
    onState: handleState,
    onInitials: msg => UI.askInitials(msg.targets, msg.score, msg.deadlineMs, msg.local, myPlayers.size > 1),
    onSpectator: msg => UI.showSpectator(msg, myPlayers.size > 1),
    onOfferJoin: msg => UI.offerJoin(msg, () => Net.send({ type: "acceptJoin", local: msg.local }), myPlayers.size > 1),
    onJoinLocalDenied: () => { seatPending[1] = false; UI.notifyJoinLocalDenied({ reason: "max local players reached" }); }
  });
  UI.initCoOp(() => requestSeat(1));
  UI.initLeaveButtons(leaveSeat);
}
function handleState(curr) {
  myLocals = curr.you.locals;
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
    p.reconcile(entry.slot, curr.players, curr.tickMs, curr.grid, curr.seq, entry.ack, curr.food);
    p.retryUnacked();
    // Capture a fresh correction event for the glide effect (cosmetic only;
    // guarded by id so a still-active glide isn't restarted every frame).
    const ev = p.lastCorrectionEvent;
    if (CLIENT_FX.correctionGlide && ev && ev.id !== lastSeenCorrectionEventId[idx]) {
      lastSeenCorrectionEventId[idx] = ev.id;
      activeGlide[idx] = { from: ev.fromHead, to: ev.toHead, slot: entry.slot, startTime: performance.now() };
    }
  }
  refreshBoost(); // direction may have changed under a held key
  UI.updateStatus(curr);
  UI.updateLeaveButtons(myLocals);
  UI.updateLeaderboards(curr.highScores);
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
    Render.draw(prev, curr, localBodies, eatenKeys, { flashes, glides }, { interpolate: CLIENT_RENDER.interpolate });
  }
  requestAnimationFrame(frame);
}
document.addEventListener("keydown", e => {
  if (!myLocals) return;
  const key = e.key.toLowerCase();
  // Rejoin rule: pressing a seat's own movement keys when that seat does not
  // currently exist (never joined, or left via the Leave button) re-requests
  // it. The keypress itself is the join request and moves nothing yet.
  for (let localIdx = 0; localIdx < KEY_MAPS.length; localIdx++) {
    if (KEY_MAPS[localIdx][key] !== undefined && !myLocals[localIdx] && !seatPending[localIdx]) {
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
      // A turn typed while boosting is delayed server-side by the slide
      // penalty; tell the predictor not to pre-play it.
      const accepted = myPlayers.get(localIdx).queueInput(dir, boostOn[localIdx]);
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
    locals.push({
      label: localIdx === 0 ? "p1" : "p2",
      role: entry ? entry.role : null,
      slot: (entry && entry.role === "player") ? entry.slot : null,
      boost: boostOn[localIdx],
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
    locals
  };
};
UI.initCaptchaGate(startGame);
requestAnimationFrame(frame);
