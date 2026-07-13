// ============================================================
// Bootstrap. Client leads on movement + food prediction; server reconciles.
// Passes the server ack and food into the predictor so reconciliation works,
// and the predictor's provisionally-eaten food key into render so the food
// hides on a predicted eat. Debug recording only while the panel is open.
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).main = "main 2026-07-12.13";
const myPlayers = new Map();
myPlayers.set("p1", new LocalPlayerPredictor("p1"));
let myRole = null;
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
    Render.draw(prev, curr, localBodies, eatenKey);
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
  myPlayers.get("p1").queueInput(dir);
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
