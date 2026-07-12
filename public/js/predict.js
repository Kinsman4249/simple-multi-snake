// ============================================================
// Client-side prediction and reconciliation for locally controlled
// snakes. Movement is grid-snapped: integer cell coordinates only, one
// whole cell per tick, so the classic Snake step is preserved (tail
// drops, a cell appears at the head). No sub-cell values are ever
// produced here.
//
// Walls are static and fully known to the client, so the client is
// allowed to be correct about walls: the predictor never renders its own
// head off-board and holds in place to mirror the server wall-grace
// stall. The server stays authoritative for snake-vs-snake outcomes.
//
// Debug: each reconcile compares the previously predicted head against
// the incoming authoritative head and records any mismatch (a "server
// correction") into a small ring buffer for the DEBUG panel.
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).predict = "predict 2026-07-12.5";
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
    this.pendingInputs = [];
    this.confirmedBody = null;
    this.predictedBody = null;
    this.grid = null;
    this.corrections = [];
    this.correctionCount = 0;
  }
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
  reconcile(slot, players, tickMs, grid, seq) {
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

    if (this.predictedBody && this.predictedBody.length && this.confirmedBody && this.confirmedBody.length) {
      const ph = this.predictedBody[0];
      const ah = p.body[0];
      if (ph.x !== ah.x || ph.y !== ah.y) {
        this.correctionCount++;
        this.corrections.push({
          seq: (seq == null ? null : seq),
          type: bigJump ? "respawn/teleport" : "mispredict",
          predicted: { x: ph.x, y: ph.y },
          actual: { x: ah.x, y: ah.y }
        });
        if (this.corrections.length > 50) this.corrections.shift();
      }
    }

    this.confirmedBody = p.body.map(s => ({ x: s.x, y: s.y }));
    const authoritativeDir = p.dir || this.inferDirFromBody(this.confirmedBody);
    if (authoritativeDir) this.dir = authoritativeDir;

    if (bigJump) {
      this.pendingInputs = [];
    } else if (this.pendingInputs.length > 0) {
      this.pendingInputs.shift();
    }
    this.recompute();
  }
  inferDirFromBody(body) {
    if (!body || body.length < 2) return null;
    const dx = body[0].x - body[1].x;
    const dy = body[0].y - body[1].y;
    if (Math.abs(dx) + Math.abs(dy) !== 1) return null;
    return { x: dx, y: dy };
  }
  inBounds(h) {
    if (!this.grid) return true;
    return h.x >= 0 && h.x < this.grid.cols && h.y >= 0 && h.y < this.grid.rows;
  }
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
      this.predictedBody = this.confirmedBody.slice();
      return;
    }
    const head = { x: head0.x + chosen.x, y: head0.y + chosen.y };
    this.predictedBody = [head, ...this.confirmedBody.slice(0, -1)];
  }
  renderBody(_alpha) {
    return this.predictedBody || this.confirmedBody;
  }
}
