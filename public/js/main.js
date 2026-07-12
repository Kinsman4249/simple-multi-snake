// ============================================================
// Bootstrap. Wires net.js, predict.js, render.js and ui.js together and
// drives the animation-frame render loop. Also exposes a debug source
// (window.__DEBUG_SOURCE__) that the UI debug panel reads.
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).main = "main 2026-07-12.5";
const myPlayers = new Map();
myPlayers.set("p1", new LocalPlayerPredictor("p1"));
let myRole = null;
function startGame(token) {
  UI.setConnectionStatus("connecting...");
  Net.connect(token, {
    onOpen: () => UI.setConnectionStatus("connected"),
    onClose: () => UI.setConnectionStatus("disconnected. reload to rejoin."),
    onState: handleState,
    onInitials: msg => UI.askInitials(msg.targets, msg.score)
  });
}
function handleState(curr) {
  myRole = curr.you;
  if (curr.you.role === "player") {
    myPlayers.get("p1").reconcile(curr.you.slot, curr.players, curr.tickMs, curr.grid, curr.seq);
  }
  UI.updateStatus(curr);
  UI.updateLeaderboards(curr.highScores);
}
function frame() {
  const { prev, curr } = Net.snapshots();
  if (curr) {
    const localBodies = new Map();
    if (myRole && myRole.role === "player") {
      const body = myPlayers.get("p1").renderBody(performance.now());
      if (body) localBodies.set(myRole.slot, body);
    }
    Render.draw(prev, curr, localBodies);
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
  const applied = myPlayers.get("p1").queueInput(dir);
  if (applied) Net.send({ type: "dir", dir: applied });
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
    corrections: p1 ? p1.corrections.slice(-12) : [],
    correctionCount: p1 ? p1.correctionCount : 0
  };
};
UI.initCaptchaGate(startGame);
UI.initDebug(window.__DEBUG_SOURCE__);
requestAnimationFrame(frame);
