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
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).main = "main 2026-07-12.14";
let CLIENT_FX = { inputFlash: true, inputFlashMs: 90, correctionGlide: true, correctionGlideMs: 90 };
fetch("/api/config").then(r => r.json()).then(cfg => {
  if (cfg && cfg.clientFx) CLIENT_FX = Object.assign({}, CLIENT_FX, cfg.clientFx);
}).catch(() => { /* keep defaults */ });

const myPlayers = new Map();
myPlayers.set("p1", new LocalPlayerPredictor("p1"));
let myRole = null;
// Most recent accepted input, for the input-flash effect. Set the instant a
// keypress is accepted, independent of whether the body actually steps this
// tick -- this is what makes the effect feel decoupled from network timing.
let lastInputFlash = null;
// Active correction-glide state, captured once per new correction event and
// consumed by render.js over clientFx.correctionGlideMs, then cleared.
let activeGlide = null;
let lastSeenCorrectionEventId = 0;
function startGame(token) {
  const p1 = myPlayers.get("p1");
  p1.setSender((dir, clientSeq) => Net.send({ type: "dir", dir, cseq: clientSeq }));
  UI.setConnectionStatus("connecting...");
  Net.connect(token, {
    onOpen: () => UI.setConnectionStatus("connected"),
    onClose: () => UI.setConnectionStatus("disconnected. reload to rejoin."),
    onState: handleState,
    onInitials: msg => UI.askInitials(msg.targets, msg.score, msg.deadlineMs),
    onSpectator: msg => UI.showSpectator(msg),
    onOfferJoin: msg => UI.offerJoin(msg, () => Net.send({ type: "acceptJoin" }))
  });
}
function handleState(curr) {
  myRole = curr.you;
  const p1 = myPlayers.get("p1");
  if (curr.you.role === "player") {
    p1.reconcile(curr.you.slot, curr.players, curr.tickMs, curr.grid, curr.seq, curr.you.ack, curr.food);
    p1.retryUnacked();
    // Capture a fresh correction event for the glide effect. lastCorrectionEvent
    // is always populated by predict.js regardless of debug state; we only act
    // on it here if the operator has correctionGlide enabled, and only once per
    // event (guarded by id so a still-active glide isn't restarted every frame).
    const ev = p1.lastCorrectionEvent;
    if (CLIENT_FX.correctionGlide && ev && ev.id !== lastSeenCorrectionEventId) {
      lastSeenCorrectionEventId = ev.id;
      activeGlide = { from: ev.fromHead, to: ev.toHead, slot: curr.you.slot, startTime: performance.now() };
    }
  }
  UI.updateStatus(curr);
  UI.updateLeaderboards(curr.highScores);
}
function frame() {
  const { prev, curr } = Net.snapshots();
  if (curr) {
    const localBodies = new Map();
    let eatenKey = null;
    if (myRole && myRole.role === "player") {
      const p1 = myPlayers.get("p1");
      const body = p1.renderBody(performance.now());
      if (body) localBodies.set(myRole.slot, body);
      eatenKey = p1.eatenFoodKey();
    }
    const now = performance.now();
    // Expire the input flash and the correction glide once their configured
    // window has elapsed, so render.js never has to reason about staleness.
    const flash = (CLIENT_FX.inputFlash && lastInputFlash &&
      (now - lastInputFlash.t) < CLIENT_FX.inputFlashMs)
      ? { slot: myRole ? myRole.slot : null, dir: lastInputFlash.dir, t: lastInputFlash.t, durationMs: CLIENT_FX.inputFlashMs }
      : null;
    const glide = (activeGlide && (now - activeGlide.startTime) < CLIENT_FX.correctionGlideMs)
      ? Object.assign({ durationMs: CLIENT_FX.correctionGlideMs }, activeGlide)
      : null;
    if (activeGlide && !glide) activeGlide = null; // expired, stop carrying it forward
    Render.draw(prev, curr, localBodies, eatenKey, { flash, glide });
  }
  requestAnimationFrame(frame);
}
document.addEventListener("keydown", e => {
  if (!myRole || myRole.role !== "player") return;
  const key = e.key.toLowerCase();
  const map = {
    arrowup: "up", w: "up",
    arrowdown: "down", s: "down",
    arrowleft: "left", a: "left",
    arrowright: "right", d: "right"
  };
  const dir = map[key];
  if (!dir) return;
  const accepted = myPlayers.get("p1").queueInput(dir);
  if (accepted && CLIENT_FX.inputFlash) lastInputFlash = { dir, t: performance.now() };
  if (key.startsWith("arrow")) e.preventDefault();
});
window.__DEBUG_SOURCE__ = function () {
  const { curr } = Net.snapshots();
  const p1 = myPlayers.get("p1");
  return {
    builds: window.__BUILDS__ || {},
    serverBuild: curr ? curr.build : null,
    seq: curr ? curr.seq : null,
    tickMs: curr ? curr.tickMs : null,
    role: myRole ? myRole.role : null,
    slot: myRole ? myRole.slot : null,
    pending: p1 ? p1.inputBuffer.map(x => ({ seq: x.seq, dir: x.dirName, retries: x.retries })) : [],
    corrections: p1 ? p1.corrections.slice(-12) : [],
    correctionCount: p1 ? p1.correctionCount : 0
  };
};
window.__DEBUG_TOGGLE__ = function (on) {
  const p1 = myPlayers.get("p1");
  if (p1) p1.setDebug(on);
};
UI.initCaptchaGate(startGame);
UI.initDebug(window.__DEBUG_SOURCE__, window.__DEBUG_TOGGLE__);
requestAnimationFrame(frame);
