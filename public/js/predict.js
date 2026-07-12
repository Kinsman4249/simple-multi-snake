// ============================================================
// Client-side prediction and reconciliation for locally controlled
// snakes. Movement is grid-snapped: the predictor advances the body one
// whole cell per tick and never produces sub-cell positions, so the
// classic Snake step is preserved (tail cell drops, a cell appears at the
// new head). Prediction exists only to make local input feel immediate.
//
// Walls are static and fully known to the client, so we let the client be
// correct about walls: the predictor never renders its own head off-board.
// If a queued input keeps the head in bounds it turns immediately; if the
// only heading would leave the board it holds in place for that frame,
// matching the server's wall-grace stall (see server.js resolveWallCollisions).
// The server stays authoritative for snake-vs-snake outcomes.
// ============================================================
const DIR_VECTORS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};
class LocalPlayerPredictor {
  constructor(id) {
    this.id = id;
    this.slot = null;
    this.dir = { x: 1, y: 0 };
    this.pendingInputs = [];    // outstanding dir vectors, sent but not yet confirmed
    this.confirmedBody = null;  // last authoritative body for our slot
    this.predictedBody = null;  // confirmedBody advanced by one tick
    this.grid = null;           // set from snapshots so we know where walls are
  }
  // Called on keypress. Mirrors the server buffering rule (max 2 queued,
  // no reversal, no duplicate) so what we predict matches what the server
  // will accept. Returns the dir name if queued, or null if rejected.
  queueInput(dirName) {
    const nd = DIR_VECTORS[dirName];
    if (!nd) return null;
    if (this.pendingInputs.length >= 2) return null;
    const last = this.pendingInputs.length > 0
      ? this.pendingInputs[this.pendingInputs.length - 1]
      : this.dir;
    const reversal = nd.x === -last.x && nd.y === -last.y;
    const duplicate = nd.x === last.x && nd.y === last.y;
    if (reversal || duplicate) return null;
    this.pendingInputs.push(nd);
    this.recompute();
    return dirName;
  }
  // Reconcile against a fresh authoritative snapshot for slot. grid is
  // optional; when provided the predictor becomes wall-aware. If main.js
  // does not pass it, prediction falls back to the plain one-tick advance.
  reconcile(slot, players, tickMs, grid) {
    if (grid) this.grid = grid;
    const p = players[slot];
    if (!p) {
      this.confirmedBody = null;
      this.predictedBody = null;
      return;
    }
    this.slot = slot;
    const bigJump = !this.confirmedBody || this.confirmedBody.length === 0 ||
      (Math.abs(p.body[0].x - this.confirmedBody[0].x) +
       Math.abs(p.body[0].y - this.confirmedBody[0].y) > 1);
    this.confirmedBody = p.body.map(s => ({ x: s.x, y: s.y }));

    // Authoritative direction must come from the server. Without this the
    // client keeps validating turns against a stale heading after the first
    // accepted turn, so later keypresses get rejected locally before they are
    // ever sent. Older servers without p.dir fall back to body inference.
    const authoritativeDir = p.dir || this.inferDirFromBody(this.confirmedBody);
    if (authoritativeDir) this.dir = authoritativeDir;

    if (bigJump) {
      this.pendingInputs = [];
    } else if (this.pendingInputs.length > 0) {
      // The server consumed at most one queued input to produce this tick.
      this.pendingInputs.shift();
    }
    this.recompute();
  }
  // Compatibility fallback for older snapshots that do not include p.dir.
  // The vector from body[1] to body[0] is the snake's current heading.
  inferDirFromBody(body) {
    if (!body || body.length < 2) return null;
    const dx = body[0].x - body[1].x;
    const dy = body[0].y - body[1].y;
    if (Math.abs(dx) + Math.abs(dy) !== 1) return null;
    return { x: dx, y: dy };
  }
  inBounds(h) {
    if (!this.grid) return true; // no grid known: assume any move is fine
    return h.x >= 0 && h.x < this.grid.cols && h.y >= 0 && h.y < this.grid.rows;
  }
  // Predict exactly one tick past the confirmed body. Prefer the first queued
  // input that keeps us in bounds; if none do, fall back to the current
  // heading; if even that leaves the board, hold in place to mirror the
  // server wall-grace stall instead of drawing the head off-board.
  recompute() {
    if (!this.confirmedBody) {
      this.predictedBody = null;
      return;
    }
    const head0 = this.confirmedBody[0];
    let chosen = null;
    for (const d of this.pendingInputs) {
      if (this.inBounds({ x: head0.x + d.x, y: head0.y + d.y })) { chosen = d; break; }
    }
    if (!chosen) {
      const d = this.pendingInputs.length > 0 ? this.pendingInputs[0] : this.dir;
      if (this.inBounds({ x: head0.x + d.x, y: head0.y + d.y })) chosen = d;
    }
    if (!chosen) {
      // Would hit a wall with no valid turn queued: hold, do not go off-board.
      this.predictedBody = this.confirmedBody.slice();
      return;
    }
    const head = { x: head0.x + chosen.x, y: head0.y + chosen.y };
    this.predictedBody = [head, ...this.confirmedBody.slice(0, -1)];
  }
  // Grid-snapped: returns whole-cell positions only, never sub-cell values.
  // The parameter is ignored; kept for call-site compatibility.
  renderBody(_alpha) {
    return this.predictedBody || this.confirmedBody;
  }
}
