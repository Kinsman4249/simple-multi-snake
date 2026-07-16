// ============================================================
// Bootstrap. Client leads on movement + food prediction; server reconciles.
// Passes the server ack and food into the predictor so reconciliation works,
// and the predictor's provisionally-eaten food key into render so the food
// hides on a predicted eat. Debug recording only while the panel is open.
//
// Client fx (input flash, correction glide) are purely cosmetic, never
// gameplay-affecting, and never user-configurable. They default ON here so
// the installer needs no prompt; CLIENT_FX is overwritten once /api/config
// resolves with the operator's server-side clientFx settings (a single
// global on/off per effect, in config.json). If the fetch fails for any
// reason, the defaults below simply stay in effect.
//
// Phase 3 (dual local controls / couch co-op): myPlayers is keyed by LOCAL
// INDEX (0 = p1/arrow keys, 1 = p2/WASD), not by server slot -- the server
// slot a local player occupies can change across respawns, but the local
// index (which controls map to it) never does. p1 always exists; p2 is
// created only after the player clicks "+ Add Player 2" and sends
// joinLocal. Every local index is round-robin fair on the server (see
// server.js): it may come back as either role "player" (curr.you.locals[i]
// has a slot) or role "spectator" (queued), and a co-op connection can
// freely be a MIX of both at once -- e.g. p1 playing while p2 sits in the
// spectator queue. Everything fx-related (input flash, correction glide,
// debug panel) is tracked per local index so p1 and p2 never step on each
// other's cosmetic state.
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).main = "main 2026-07-12.17";
let CLIENT_FX = { inputFlash: true, inputFlashMs: 90, correctionGlide: true, correctionGlideMs: 90 };
fetch("/api/config").then(r => r.json()).then(cfg => {
  if (cfg && cfg.clientFx) CLIENT_FX = Object.assign({}, CLIENT_FX, cfg.clientFx);
}).catch(() => { /* keep defaults */ });

const KEY_MAPS = [
  { arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right" }, // local 0 (p1): arrows
  { w: "up", s: "down", a: "left", d: "right" }                                 // local 1 (p2): WASD
];

const myPlayers = new Map();
myPlayers.set(0, new LocalPlayerPredictor("p1"));
// curr.you.locals: array of { local, role: "player", slot, ack } | { local, role: "spectator", queuePos, queueLen }.
// One entry per local seat this connection has ever requested (length 1
// until co-op is joined, then 2). A mix of roles across entries is normal.
let myLocals = null;
let coOpRequested = false;
// Per-local-index cosmetic fx state (index matches myPlayers/KEY_MAPS).
let lastInputFlash = [null, null];
let activeGlide = [null, null];
let lastSeenCorrectionEventId = [0, 0];

function wireLocalPlayer(localIdx) {
  const p = myPlayers.get(localIdx);
  p.setSender((dir, clientSeq) => Net.send({ type: "dir", dir, cseq: clientSeq, local: localIdx }));
}
// Requests a second local player (WASD) on this same connection -- called
// either from the "+ Add Player 2" button (ui.js) or automatically the
// first time a WASD key is pressed (see the keydown listener below). This
// is ALWAYS granted a seat (up to config.maxLocalPlayers) -- it is never
// refused for lack of a free slot, since a co-op seat is round-robin fair
// like anyone else and simply queues as a spectator if the board is full or
// others are already waiting. See UI.notifyJoinLocalDenied for the one
// remaining refusal reason (the local-player cap itself).
function requestCoOp() {
  if (coOpRequested || myPlayers.has(1)) return;
  coOpRequested = true;
  myPlayers.set(1, new LocalPlayerPredictor("p2"));
  wireLocalPlayer(1);
  Net.send({ type: "joinLocal" });
}

function startGame(token) {
  wireLocalPlayer(0);
  UI.setConnectionStatus("connecting...");
  Net.connect(token, {
    onOpen: () => UI.setConnectionStatus("connected"),
    onClose: () => UI.setConnectionStatus("disconnected. reload to rejoin."),
    onState: handleState,
    onInitials: msg => UI.askInitials(msg.targets, msg.score, msg.deadlineMs, msg.local, myPlayers.size > 1),
    onSpectator: msg => UI.showSpectator(msg, myPlayers.size > 1),
    onOfferJoin: msg => UI.offerJoin(msg, () => Net.send({ type: "acceptJoin", local: msg.local }), myPlayers.size > 1),
    onJoinLocalDenied: msg => UI.notifyJoinLocalDenied(msg)
  });
  UI.initCoOp(requestCoOp);
}
function handleState(curr) {
  myLocals = curr.you.locals;
  if (myPlayers.has(1) && myLocals[1] && myLocals[1].role === "player") UI.coOpJoined();
  myLocals.forEach(entry => {
    if (!entry) return;
    const p = myPlayers.get(entry.local);
    if (!p) return; // server reports a local index we don't have a predictor for (shouldn't happen)
    if (entry.role !== "player") {
      // This seat is spectating (queued): nothing to reconcile against, and
      // any previously predicted body must not keep rendering stale.
      p.simBody = null; p.authBody = null;
      return;
    }
    p.reconcile(entry.slot, curr.players, curr.tickMs, curr.grid, curr.seq, entry.ack, curr.food);
    p.retryUnacked();
    // Capture a fresh correction event for the glide effect. lastCorrectionEvent
    // is always populated by predict.js regardless of debug state; we only act
    // on it here if the operator has correctionGlide enabled, and only once per
    // event (guarded by id so a still-active glide isn't restarted every frame).
    const ev = p.lastCorrectionEvent;
    if (CLIENT_FX.correctionGlide && ev && ev.id !== lastSeenCorrectionEventId[entry.local]) {
      lastSeenCorrectionEventId[entry.local] = ev.id;
      activeGlide[entry.local] = { from: ev.fromHead, to: ev.toHead, slot: entry.slot, startTime: performance.now() };
    }
  });
  UI.updateStatus(curr);
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
        // Expire the input flash and the correction glide once their configured
        // window has elapsed, so render.js never has to reason about staleness.
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
    Render.draw(prev, curr, localBodies, eatenKeys, { flashes, glides });
  }
  requestAnimationFrame(frame);
}
document.addEventListener("keydown", e => {
  if (!myLocals) return;
  const key = e.key.toLowerCase();
  // Auto-join P2 the first time a WASD key is pressed -- same effect as
  // clicking "+ Add Player 2", just discovered naturally instead of
  // requiring the button. This keypress itself becomes the join request; it
  // doesn't queue a move, since there's no seat to queue one for yet (the
  // server hasn't granted it). The very next WASD press, once the state
  // broadcast confirms the seat, moves the snake normally.
  if (!myPlayers.has(1) && KEY_MAPS[1][key] !== undefined) {
    requestCoOp();
    return;
  }
  for (let localIdx = 0; localIdx < KEY_MAPS.length; localIdx++) {
    const dir = KEY_MAPS[localIdx][key];
    if (!dir) continue;
    // This local seat isn't currently an active slot (p2 not joined yet, or
    // this seat is queued as a spectator) -- ignore the keypress rather
    // than queue an input that has nowhere to go.
    const entry = myLocals[localIdx];
    if (!myPlayers.has(localIdx) || !entry || entry.role !== "player") break;
    const accepted = myPlayers.get(localIdx).queueInput(dir);
    if (accepted && CLIENT_FX.inputFlash) lastInputFlash[localIdx] = { dir, t: performance.now() };
    if (key.startsWith("arrow")) e.preventDefault();
    break; // a key belongs to at most one local player's map
  }
});
window.__DEBUG_SOURCE__ = function () {
  const { curr } = Net.snapshots();
  const locals = [];
  myPlayers.forEach((p, localIdx) => {
    const entry = myLocals ? myLocals[localIdx] : null;
    locals.push({
      label: localIdx === 0 ? "p1" : "p2",
      role: entry ? entry.role : null,
      slot: (entry && entry.role === "player") ? entry.slot : null,
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
window.__DEBUG_TOGGLE__ = function (on) {
  myPlayers.forEach(p => p.setDebug(on));
};
UI.initCaptchaGate(startGame);
UI.initDebug(window.__DEBUG_SOURCE__, window.__DEBUG_TOGGLE__);
requestAnimationFrame(frame);
