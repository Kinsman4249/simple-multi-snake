// ============================================================
// Client-side prediction + SERVER RECONCILIATION with input acks.
// (Gabriel Gambetta fast-paced multiplayer model, option A: zero added
//  input latency; the small timing skew is corrected every snapshot.)
//
// The client renders the authoritative body, PLUS a one-cell forward
// prediction of a turn the player has entered but the server has not yet
// acknowledged. Concretely, every snapshot the client:
//   1. RE-ANCHORS to the authoritative body (head corrected to server every
//      tick, so no cosmetic drift),
//   2. DROPS buffered inputs with seq <= ack (server already applied them),
//   3. If a still-pending turn remains, predicts ONE cell in that turn's
//      direction; otherwise renders the authoritative body as-is.
// Predicting a single cell bounds any reconciliation to <= 1 cell (the
// minimum for zero-added-latency), so the head never snaps by more than one
// cell. On a straight run with nothing pending, the rendered head sits
// exactly on the server head (no lead, no drift).
//
// Growth (food / kill bonus) is automatic: we anchor to the authoritative
// body (correct length); the optional one-cell prediction only moves the head.
//
// Debug recording is DISABLED until the UI opens the panel (setDebug(true)).
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).predict = "predict 2026-07-12.12";
const DIR_VECTORS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};
const RETRY_AFTER_TICKS = 2;
const MAX_RETRIES = 3;
class LocalPlayerPredictor {
  constructor(id) {
    this.id = id;
    this.slot = null;
    this.dir = { x: 1, y: 0 };      // authoritative heading from server
    this.inputBuffer = [];         // [{ seq, dirName, vec, sentTick, retries }]
    this.clientSeq = 0;
    this.authBody = null;          // last authoritative body (anchor base)
    this.simBody = null;           // what we render
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
    if (this.inputBuffer.length >= 3) return null;
    const last = this.inputBuffer.length > 0
      ? this.inputBuffer[this.inputBuffer.length - 1].vec : this.dir;
    if (this.sameVec(vec, { x: -last.x, y: -last.y })) return null; // reversal
    if (this.sameVec(vec, last)) return null;                       // duplicate
    const item = { seq: ++this.clientSeq, dirName, vec, sentTick: this.lastServerSeq, retries: 0 };
    this.inputBuffer.push(item);
    if (this.sendFn) this.sendFn(dirName, item.seq);
    this.rebuild();
    return dirName;
  }

  retryUnacked() {
    if (this.deadOnServer || !this.sendFn) return;
    for (const p of this.inputBuffer) {
      const waited = (this.lastServerSeq == null || p.sentTick == null)
        ? 0 : (this.lastServerSeq - p.sentTick);
      if (waited >= RETRY_AFTER_TICKS && p.retries < MAX_RETRIES) {
        p.retries++;
        p.sentTick = this.lastServerSeq;
        this.sendFn(p.dirName, p.seq);
      }
    }
  }

  inBounds(h) {
    if (!this.grid) return true;
    return h.x >= 0 && h.x < this.grid.cols && h.y >= 0 && h.y < this.grid.rows;
  }
  inferDirFromBody(body) {
    if (!body || body.length < 2) return null;
    const dx = body[0].x - body[1].x;
    const dy = body[0].y - body[1].y;
    if (Math.abs(dx) + Math.abs(dy) !== 1) return null;
    return { x: dx, y: dy };
  }
  advance(body, dir) {
    const head = { x: body[0].x + dir.x, y: body[0].y + dir.y };
    if (!this.inBounds(head)) return body.slice(); // hold at wall
    return [head, ...body.slice(0, -1)];
  }

  // Anchor to the authoritative body. If a turn is still pending (entered but
  // not yet acked by the server), predict exactly ONE cell in that direction
  // so the turn shows immediately; otherwise render the authoritative body
  // unchanged (no lead on straight runs).
  rebuild() {
    if (!this.authBody) { this.simBody = null; return; }
    const body = this.authBody.map(s => ({ x: s.x, y: s.y }));
    if (this.inputBuffer.length > 0) {
      this.simBody = this.advance(body, this.inputBuffer[0].vec);
    } else {
      this.simBody = body;
    }
  }

  reconcile(slot, players, tickMs, grid, seq, ack) {
    if (grid) this.grid = grid;
    this.lastServerSeq = (seq == null ? this.lastServerSeq : seq);
    const p = players[slot];
    if (!p) { this.simBody = null; this.authBody = null; return; }
    this.slot = slot;
    this.deadOnServer = !p.alive;

    const authDir = p.dir || this.inferDirFromBody(p.body);
    if (authDir) this.dir = authDir;

    // Debug: measure the disagreement between the head we CURRENTLY render and
    // the incoming authoritative head, before we re-anchor.
    if (this.debug && this.simBody && this.simBody.length) {
      const ph = this.simBody[0];
      const ah = p.body[0];
      if (ph.x !== ah.x || ph.y !== ah.y) {
        const dist = Math.abs(ph.x - ah.x) + Math.abs(ph.y - ah.y);
        this.correctionCount++;
        this.corrections.push({
          seq: (seq == null ? null : seq),
          type: this.deadOnServer ? "death/collision"
               : (dist > 1 ? "resync (>1 cell)" : "reconciled (1 cell)"),
          predicted: { x: ph.x, y: ph.y },
          actual: { x: ah.x, y: ah.y }
        });
        if (this.corrections.length > 50) this.corrections.shift();
      }
    }

    this.authBody = p.body.map(s => ({ x: s.x, y: s.y }));

    if (ack != null) {
      this.inputBuffer = this.inputBuffer.filter(inp => inp.seq > ack);
    }
    if (this.deadOnServer) this.inputBuffer = [];

    this.rebuild();
  }

  renderBody(_alpha) { return this.simBody; }
}
