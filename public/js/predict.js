// ============================================================
// Client-side prediction, CLIENT-AUTHORITATIVE for movement.
//
// The client simulates its OWN snake purely from the local inputs and
// renders that simulation directly. The server does NOT nudge our head
// position tick-to-tick. The only time the server overrides us is a real
// game-state conflict:
//   * deadOnServer: our snake is not alive (collision with wall / snake /
//     self), or
//   * bigJump: the authoritative head is far from ours (respawn / teleport).
// On either, we hard-snap to the authoritative body and resync. Otherwise
// we IGNORE the authoritative head entirely and keep our own simulation, so
// the normal one-tick network phase offset never shows as jitter.
//
// Growth (food eaten, kill bonuses) is length-only: we adopt the server
// body LENGTH so our snake grows/shrinks correctly, but we keep our own
// head/segment POSITIONS. Position is never corrected without a conflict.
//
// Turn feel: a queued turn takes effect on the very next local tick, so the
// snake goes exactly where you point it, immediately.
//
// Debug recording is DISABLED until the UI opens the panel (setDebug(true)).
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).predict = "predict 2026-07-12.10";
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
    this.queue = [];            // queued turn vectors (client-side buffer)
    this.pending = [];          // [{ seq, dirName, vec, sentTick, retries, confirmed }]
    this.clientSeq = 0;
    this.simBody = null;        // our own authoritative-to-us simulated body
    this.lastServerSeq = null;
    this.deadOnServer = false;
    this.grid = null;
    this.debug = false;
    this.corrections = [];
    this.correctionCount = 0;
    this.sendFn = null;
    this.lastTick = null;       // server seq we last advanced the sim on
  }
  setSender(fn) { this.sendFn = fn; }
  setDebug(on) { this.debug = !!on; if (!on) this.corrections.length = 0; }
  sameVec(a, b) { return a && b && a.x === b.x && a.y === b.y; }

  // Keypress -> queue a turn (same rules the server enforces) and send it.
  queueInput(dirName) {
    const vec = DIR_VECTORS[dirName];
    if (!vec) return null;
    if (this.queue.length >= 2) return null;
    const last = this.queue.length > 0 ? this.queue[this.queue.length - 1] : this.dir;
    if (this.sameVec(vec, { x: -last.x, y: -last.y })) return null; // reversal
    if (this.sameVec(vec, last)) return null;                       // duplicate
    this.queue.push(vec);
    const item = { seq: ++this.clientSeq, dirName, vec, sentTick: this.lastServerSeq, retries: 0, confirmed: false };
    this.pending.push(item);
    if (this.sendFn) this.sendFn(dirName, item.seq);
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

  // Advance our own simulation exactly one cell in the current heading,
  // applying at most one queued turn first (mirrors server per-tick rule).
  stepSim(growBy) {
    if (!this.simBody || this.simBody.length === 0) return;
    if (this.queue.length > 0) this.dir = this.queue.shift();
    const head = { x: this.simBody[0].x + this.dir.x, y: this.simBody[0].y + this.dir.y };
    if (!this.inBounds(head)) return; // hold at wall; server resolves the death
    this.simBody.unshift(head);
    // Keep our length in sync with the server: grow by growBy this tick,
    // else drop the tail (normal movement).
    if (growBy > 0) {
      // grow: keep the tail (do not pop); extra growth handled by length sync
    } else {
      this.simBody.pop();
    }
  }

  reconcile(slot, players, tickMs, grid, seq) {
    if (grid) this.grid = grid;
    const prevSeq = this.lastServerSeq;
    this.lastServerSeq = (seq == null ? this.lastServerSeq : seq);
    const p = players[slot];
    if (!p) { this.simBody = null; return; }
    this.slot = slot;
    this.deadOnServer = !p.alive;

    const authHead = p.body[0];
    const authDir = p.dir || this.inferDirFromBody(p.body);

    // Confirm/retire the oldest pending turn once the server heading matches.
    if (authDir) {
      const next = this.pending.find(x => !x.confirmed);
      if (next && this.sameVec(next.vec, authDir)) next.confirmed = true;
    }
    while (this.pending.length && this.pending[0].confirmed) this.pending.shift();

    // First snapshot, or no local sim yet: adopt the server body wholesale.
    if (!this.simBody || this.simBody.length === 0) {
      this.simBody = p.body.map(s => ({ x: s.x, y: s.y }));
      if (authDir) this.dir = authDir;
      return;
    }

    // CONFLICT detection: death, or a big jump between our head and the
    // authoritative head (respawn / teleport / genuine desync).
    const dxy = Math.abs(authHead.x - this.simBody[0].x) + Math.abs(authHead.y - this.simBody[0].y);
    const bigJump = dxy > 1;
    const conflict = this.deadOnServer || bigJump;

    if (this.debug) {
      const ph = this.simBody[0];
      if (ph.x !== authHead.x || ph.y !== authHead.y) {
        this.correctionCount++;
        this.corrections.push({
          seq: (seq == null ? null : seq),
          type: this.deadOnServer ? "death/collision" : (bigJump ? "respawn/teleport" : "ignored (client authoritative)"),
          predicted: { x: ph.x, y: ph.y },
          actual: { x: authHead.x, y: authHead.y }
        });
        if (this.corrections.length > 50) this.corrections.shift();
      }
    }

    if (conflict) {
      // Hard resync: server wins on collisions and teleports.
      this.simBody = p.body.map(s => ({ x: s.x, y: s.y }));
      if (authDir) this.dir = authDir;
      this.queue = [];
      this.pending = [];
      return;
    }

    // No conflict: keep our own simulated positions. Advance our sim by the
    // number of server ticks elapsed since last snapshot (normally 1). Sync
    // LENGTH to the server (growth from food/kills) without touching position.
    const ticks = (prevSeq == null || this.lastServerSeq == null)
      ? 1 : Math.max(0, this.lastServerSeq - prevSeq);
    const targetLen = p.body.length;
    for (let t = 0; t < ticks; t++) {
      const grow = this.simBody.length < targetLen ? 1 : 0;
      this.stepSim(grow);
    }
    // Final length reconciliation (in case of multi-growth from a kill bonus).
    while (this.simBody.length < targetLen) {
      const tail = this.simBody[this.simBody.length - 1];
      this.simBody.push({ x: tail.x, y: tail.y });
    }
    while (this.simBody.length > targetLen) this.simBody.pop();
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
  renderBody(_alpha) { return this.simBody; }
}
