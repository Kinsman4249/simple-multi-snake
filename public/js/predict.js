// ============================================================
// Client-side prediction with CLIENT-LEAD reconciliation.
//
// Movement is grid-snapped (integer cells only, one cell per tick).
//
// Authority split (this build):
//   * The CLIENT leads on movement/turns at all times.
//   * The server OVERRIDES the client ONLY on a real game-state conflict:
//       - deadOnServer: server reports our snake not alive (collision, wall
//         death, powerup interaction), or
//       - bigJump: authoritative head moved more than one cell from our last
//         confirmed head (respawn / teleport).
//     Only then do we hard-resync and drop pending inputs.
//   * A PLAIN positional difference (server a tick behind our predicted turn)
//     is NOT a conflict. We rebase onto the authoritative body but KEEP the
//     unconfirmed pending turns and keep leading, so turning does not jitter.
//
// Turn confirmation: when the server's authoritative dir matches our oldest
// pending input, that input is confirmed and retired. Input retry re-sends an
// unconfirmed turn after a couple of ticks; retry stops if we are dead.
//
// Debug recording is DISABLED until the UI opens the panel (setDebug(true)).
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).predict = "predict 2026-07-12.7";
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

    // A CONFLICT is ONLY death or teleport/respawn. Plain positional drift
    // while a turn is in flight is absorbed without overriding the client.
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
  recompute() {
    if (!this.confirmedBody) { this.predictedBody = null; return; }
    const head0 = this.confirmedBody[0];
    const unconfirmed = this.pending.filter(x => !x.confirmed);
    let chosen = null;
    for (const it of unconfirmed) {
      if (this.inBounds({ x: head0.x + it.vec.x, y: head0.y + it.vec.y })) { chosen = it.vec; break; }
    }
    if (!chosen) {
      const d = unconfirmed.length > 0 ? unconfirmed[0].vec : this.dir;
      if (this.inBounds({ x: head0.x + d.x, y: head0.y + d.y })) chosen = d;
    }
    if (!chosen) { this.predictedBody = this.confirmedBody.slice(); return; }
    const head = { x: head0.x + chosen.x, y: head0.y + chosen.y };
    this.predictedBody = [head, ...this.confirmedBody.slice(0, -1)];
  }
  renderBody(_alpha) { return this.predictedBody || this.confirmedBody; }
}
