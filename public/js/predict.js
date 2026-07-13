// ============================================================
// Client-side prediction + SERVER RECONCILIATION (Gambetta model, option A).
//
// Movement: re-anchor to the authoritative body every snapshot, then predict
// AT MOST one cell ahead using the OLDEST unacknowledged turn (the one the
// server is about to process next, since the server applies queued turns in
// the order they were received). Predicting off the newest queued turn
// instead of the oldest was wrong: if two turns queue up before the first is
// acked, the server's next tick still applies the first one, so predicting
// the second produces a spurious diagonal "resync" even though nothing was
// actually mispredicted. Corrections are always bounded to one cell. If
// there are no unacknowledged inputs the authoritative body is rendered
// verbatim with no advance, so the server never appears to lag behind or be
// overridden on a plain straight run.
//
// Food: the client PREDICTS its own eat for instant feedback, but the server
// is authoritative and the prediction is provisional:
//   - When our predicted head lands on the current food cell we mark a
//     pending eat and grow locally by one.
//   - If the server then shows a NEW food (position changed) AND our body
//     grew, the eat is CONFIRMED and the provisional growth is folded in.
//   - If the server has not confirmed within EAT_CONFIRM_TICKS (another snake
//     ate it, or our predicted head was ahead of the real head), we ROLL BACK
//     the local growth. This removes phantom eats and the "ate it while
//     circling" artifact, both caused by rendering the head one cell ahead.
//
// Length always reconciles to the server; predicted growth is provisional.
//
// eatenFoodKey exposes the food cell we are provisionally treating as eaten,
// so render.js can hide that food immediately for visual consistency.
//
// Debug recording is DISABLED until the UI opens the panel (setDebug(true)).
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).predict = "predict 2026-07-12.17";
const DIR_VECTORS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};
const RETRY_AFTER_TICKS = 2;
const MAX_RETRIES = 3;
const EAT_CONFIRM_TICKS = 3;
class LocalPlayerPredictor {
  constructor(id) {
    this.id = id;
    this.slot = null;
    this.dir = { x: 1, y: 0 };
    this.inputBuffer = [];
    this.clientSeq = 0;
    this.authBody = null;
    this.simBody = null;
    this.predicted = false;
    this.grid = null;
    this.lastServerSeq = null;
    this.deadOnServer = false;
    this.debug = false;
    this.corrections = [];
    this.correctionCount = 0;
    this.sendFn = null;
    this.foodKey = null;
    this.pendingEat = null;      // { key, atServerSeq }
    this.localGrow = 0;
    this.lastServerLen = null;
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
    if (this.sameVec(vec, { x: -last.x, y: -last.y })) return null;
    if (this.sameVec(vec, last)) return null;
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
  advance(body, dir, grow) {
    const head = { x: body[0].x + dir.x, y: body[0].y + dir.y };
    if (!this.inBounds(head)) return body.slice();
    const nb = [head, ...body];
    if (!grow) nb.pop();
    return nb;
  }

  rebuild() {
    if (!this.authBody) { this.simBody = null; this.predicted = false; return; }
    const body = this.authBody.map(s => ({ x: s.x, y: s.y }));
    // No unacknowledged input: render the authoritative body exactly. This is
    // the fix for the .13 regression where a stale direction was replayed
    // even with an empty buffer, leaving the head a constant cell ahead.
    if (this.inputBuffer.length === 0) {
      this.simBody = body;
      this.predicted = false;
      return;
    }
    // Predict exactly one cell using the OLDEST unacked turn: that is the
    // one the server will process on its next tick, since it applies queued
    // turns in receipt order. Using the newest turn instead was wrong and
    // caused spurious diagonal resyncs whenever two turns queued up before
    // the first was acked.
    const nextDir = this.inputBuffer[0].vec;
    this.simBody = this.advance(body, nextDir, this.localGrow > 0);
    this.predicted = true;
  }

  // Food cell we are provisionally treating as eaten (for render to hide).
  eatenFoodKey() { return this.pendingEat ? this.pendingEat.key : null; }

  reconcile(slot, players, tickMs, grid, seq, ack, food) {
    if (grid) this.grid = grid;
    this.lastServerSeq = (seq == null ? this.lastServerSeq : seq);
    const p = players[slot];
    if (!p) { this.simBody = null; this.authBody = null; return; }
    this.slot = slot;
    this.deadOnServer = !p.alive;

    const authDir = p.dir || this.inferDirFromBody(p.body);
    if (authDir) this.dir = authDir;

    const foodKey = food ? (food.x + "," + food.y) : null;
    const serverLen = p.body.length;
    const grew = (this.lastServerLen != null) && (serverLen > this.lastServerLen);
    const foodChanged = (this.foodKey != null) && (foodKey !== this.foodKey);

    // Predict our own eat when the predicted head lands on the food cell.
    if (food && this.simBody && this.simBody.length) {
      const ph = this.simBody[0];
      if (ph.x === food.x && ph.y === food.y && !this.pendingEat) {
        this.pendingEat = { key: foodKey, atServerSeq: this.lastServerSeq };
        this.localGrow = 1;
      }
    }
    // Confirm: server food moved AND we grew -> eat is authoritative now.
    if (this.pendingEat && foodChanged && grew) {
      this.pendingEat = null;
      this.localGrow = 0;
    }
    // Roll back: server did not confirm in time -> drop provisional growth.
    if (this.pendingEat && this.lastServerSeq != null &&
        (this.lastServerSeq - this.pendingEat.atServerSeq) >= EAT_CONFIRM_TICKS &&
        !(foodChanged && grew)) {
      this.pendingEat = null;
      this.localGrow = 0;
    }

    // Only check for a correction if the previous rebuild() actually made a
    // one-cell prediction. With an empty buffer, simBody was just a mirror
    // of the previous authoritative body, and the new snapshot naturally
    // differs from it because the snake kept moving; that is normal
    // movement, not a misprediction, and must not be logged as one.
    if (this.debug && this.predicted && this.simBody && this.simBody.length) {
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
    this.foodKey = foodKey;
    this.lastServerLen = serverLen;

    if (ack != null) this.inputBuffer = this.inputBuffer.filter(inp => inp.seq > ack);
    if (this.deadOnServer) { this.inputBuffer = []; this.pendingEat = null; this.localGrow = 0; }

    this.rebuild();
  }

  renderBody(_alpha) { return this.simBody; }
}
