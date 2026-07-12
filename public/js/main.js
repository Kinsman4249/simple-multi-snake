// ============================================================
// Bootstrap. Wires net.js, predict.js, render.js and ui.js together
// and drives the animation-frame render loop.
//
// Phase 2 wires exactly one locally controlled snake ("p1", arrow
// keys, WASD mapped to the same directions). Phase 3 adds a second
// predictor ("p2") for a WASD-only local player and splits the keymap;
// nothing in net.js/predict.js/render.js needs to change for that.
// ============================================================
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
    // Pass curr.grid so the predictor is wall-aware: a wall-avoiding turn is
    // favored client-side (walls are static and fully known here), matching
    // the server wall-grace stall in server.js resolveWallCollisions.
    myPlayers.get("p1").reconcile(curr.you.slot, curr.players, curr.tickMs, curr.grid);
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
UI.initCaptchaGate(startGame);
requestAnimationFrame(frame);
