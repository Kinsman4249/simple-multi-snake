// ============================================================
// Client-side prediction with CLIENT-LEAD reconciliation.
//
// Movement is grid-snapped (integer cells only, one cell per tick).
//
// Turn-corner fix (.9): the server has ~1 tick of input latency, so after
// you press a turn it runs ONE more straight cell in the old heading and
// THEN turns. Earlier builds predicted the turn happening at the current
// head immediately, so the predicted corner sat one cell short of where the
// server actually places it, and the head popped over by a cell on the next
// snapshot (the residual "absorbed (no override)" diagonal jitter). We now
// model that lag: a queued turn is applied AFTER first advancing one cell in
// the current confirmed heading, matching the server's corner timing.
//
// Authority split:
//   * The CLIENT leads on movement/turns at all times.
//   * The server OVERRIDES only on a real conflict: deadOnServer (collision/
//     wall/powerup) or bigJump (respawn/teleport). Then hard-resync and drop
//     pending inputs. Plain positional drift is absorbed (no override).
//
// Turn confirmation: when the server's authoritative dir matches our oldest
// pending input, that input is confirmed and retired. Input retry re-sends an
// unconfirmed turn after a couple of ticks; retry stops if we are dead.
//
// Debug recording is DISABLED until the UI opens the panel (setDebug(true)).
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).predict = "predict 2026-07-12.9";
const DIR_VECTORS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};
const RETRY_AFTER_TICKS = 2;
const MAX_RETRIES = 3;
const MAX_LEAD_CELLS = 2;   // how many predicted cells we may lead the server by
const SERVER_INPUT_LAG = 1; // straight cells the server runs before a queued turn
class LocalPlayerPredictor {
  constructor(id) {
    this.id = id;
    this.slot = null;
    this.dir = { x: 1, y: 0 };
    this.pending = [];
    this.clientSeq = 0;
    this.confirmedBody = null;
    this.predictedBody = null;
    this.grid = null;
    this.lastServerSeq = null;
    this.deadOnServer = false;
    this.debug = false;
    this.corrections = [];
    this.correctionCount = 0;
    this.sendFn = null;
  }
  setSender(fn) { this.sendFn = fn; }
  setDebug(on) { this.debug = !!on; if (!on) this.corrections.length = 0; }
  sameVec(a, b) { return a && b && a.x === b.x && a.y === b.y; }

  queueInput(dirName) {
    const vec = DIR_VECTORS[dirName];
    if (!vec) return null;
    const unconfirmed = this.pending.filter(p => !p.confirmed);
    if (unconfirmed.length >= 2) return null;
    const last = unconfirmed.length > 0 ? unconfirmed[unconfirmed.length - 1].vec : this.dir;
    if (this.sameVec(vec, { x: -last.x, y: -last.y })) return null;
    if (this.sameVec(vec, last)) return null;
    const item = { seq: ++this.clientSeq, dirName, vec, sentTick: this.lastServerSeq, retries: 0, confirmed: false };
    this.pending.push(item);
    if (this.sendFn) this.sendFn(dirName, item.seq);
    this.recompute();
    return dirName;
  }

  retryUnconfirmed() {
    if (this.deadOnServer || !this.sendFn) return;
    for (const p of this.pending) {
      if (p.confirmed) continue;
      const waited = (this.lastServerSeq == null || p.sentTick == null) ? 0 : (this.lastServerSeq - p.sentTick);
      if (waited >= RETRY_AFTER_TICKS && p.retries < MAX_RETRIES) {
        p.retries++;
        p.sentTick = this.lastServerSeq;
        this.sendFn(p.dirName, p.seq);
      }
    }
  }

  reconcile(slot, players, tickMs, grid, seq) {
    if (grid) this.grid = grid;
    this.lastServerSeq = (seq == null ? this.lastServerSeq : seq);
    const p = players[slot];
    if (!p) { this.confirmedBody = null; this.predictedBody = null; return; }
    this.slot = slot;
    this.deadOnServer = !p.alive;

    const authDir = p.dir || this.inferDirFromBody(p.body);
    const bigJump = !this.confirmedBody || this.confirmedBody.length === 0 ||
      (Math.abs(p.body[0].x - this.confirmedBody[0].x) +
       Math.abs(p.body[0].y - this.confirmedBody[0].y) > 1);

    if (authDir) {
      const next = this.pending.find(x => !x.confirmed);
      if (next && this.sameVec(next.vec, authDir)) next.confirmed = true;
    }
    while (this.pending.length && this.pending[0].confirmed) this.pending.shift();

    const conflict = this.deadOnServer || bigJump;

    if (this.debug && this.predictedBody && this.predictedBody.length) {
      const ph = this.predictedBody[0];
      const ah = p.body[0];
      if (ph.x !== ah.x || ph.y !== ah.y) {
        this.correctionCount++;
        this.corrections.push({
          seq: (seq == null ? null : seq),
          type: this.deadOnServer ? "death/collision" : (bigJump ? "respawn/teleport" : "absorbed (no override)"),
          predicted: { x: ph.x, y: ph.y },
          actual: { x: ah.x, y: ah.y }
        });
        if (this.corrections.length > 50) this.corrections.shift();
      }
    }

    this.confirmedBody = p.body.map(s => ({ x: s.x, y: s.y }));
    if (authDir) this.dir = authDir;
    if (conflict) this.pending = [];

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

  // Predict forward from the confirmed head. A queued turn does NOT bend the
  // path at the current cell; instead we first advance SERVER_INPUT_LAG cells
  // in the current heading (matching the server running one straight cell
  // before it applies the turn), and only then change heading. This places
  // the predicted corner where the server will actually place it, so turns
  // stop relocating by a cell. Bounded by MAX_LEAD_CELLS so we never over-run.
  recompute() {
    if (!this.confirmedBody) { this.predictedBody = null; return; }
    const unconfirmed = this.pending.filter(x => !x.confirmed);
    const steps = Math.min(MAX_LEAD_CELLS, Math.max(1, unconfirmed.length + SERVER_INPUT_LAG));

    let body = this.confirmedBody.slice();
    let heading = this.dir;
    let turnIdx = 0;          // which queued turn to apply next
    let lagLeft = SERVER_INPUT_LAG; // straight cells to run before first turn

    for (let n = 0; n < steps; n++) {
      // Apply the next queued turn only after the server-lag straight cells.
      if (lagLeft <= 0 && unconfirmed[turnIdx]) {
        heading = unconfirmed[turnIdx].vec;
        turnIdx++;
        lagLeft = SERVER_INPUT_LAG; // model lag before the following turn too
      } else if (lagLeft > 0) {
        lagLeft--;
      }
      const head = { x: body[0].x + heading.x, y: body[0].y + heading.y };
      if (!this.inBounds(head)) break; // hold at wall; do not go off-board
      body = [head, ...body.slice(0, -1)];
    }
    this.predictedBody = body;
  }
  renderBody(_alpha) { return this.predictedBody || this.confirmedBody; }
}
