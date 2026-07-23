// ============================================================
// Client-side prediction + SERVER RECONCILIATION (Gambetta model, option A).
//
// Movement: re-anchor to the authoritative body every snapshot, then predict
// AT MOST one cell ahead using the OLDEST unacknowledged turn (the one the
// server is about to process next, since the server applies queued turns in
// the order they were received). If that turn would carry the head out of
// bounds, mirror the server's wall-grace lookahead (server-rust/src/sim.rs
// consume_inbounds_turn): scan the remaining queued turns in order for the
// first one that stays in bounds and use that instead. If none of the queued
// turns stay in bounds, render no movement (mirrors the server's stall) and
// do not log a debug correction for that tick, since whether the server
// stalls or lets the snake die depends on wallGraceTicks state the client
// does not track. Corrections are always bounded to one cell. If there are
// no unacknowledged inputs the authoritative body is rendered verbatim with
// no advance, so the server never appears to lag behind or be overridden on
// a plain straight run.
//
// If a queued turn exhausts all its retries without ever being acked (the
// server most likely never received it, e.g. a dropped WebSocket frame), it
// is dropped from the buffer rather than left stuck at the front forever.
// Left in place, a permanently-unconfirmable entry would poison every future
// one-cell prediction (always anchored on the oldest queued entry) and the
// food-eat check that reads the same predicted head.
//
// lastCorrectionEvent exposes the most recent predicted-vs-actual head
// mismatch (regardless of debug state) so main.js/render.js can drive a
// short, purely cosmetic correction-glide effect. This module has no opinion
// on whether that effect is enabled; that is a server-controlled, client-only
// config flag read elsewhere.
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
// Boost/drift: a turn typed while boosting is queued and sent normally (so
// the ack/retry machinery is unchanged) but flagged `delayed`. The server
// now applies the turn to the HEAD immediately, but it simultaneously
// starts translating the whole body laterally for config.boost.driftMs (the
// drift/skid) -- so the resulting body is still not a plain follow-the-
// leader advance the one-cell predictor could reproduce. rebuild() therefore
// still does not pre-play a boosted turn; the server's authoritative steps
// (plus the correction glide, if enabled) show the skid.
(window.__BUILDS__ = window.__BUILDS__ || {}).predict = "predict 2026-07-18.1";
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
    // Raw correction events (predicted vs actual head), for the client-only
    // correction-glide visual effect. Always populated regardless of debug
    // state; main.js/render.js decide independently whether to act on it,
    // based on the server-controlled clientFx.correctionGlide flag.
    this.lastCorrectionEvent = null;
    this.correctionEventSeq = 0;
    this.sendFn = null;
    // Multi-food (v3.5.0): the board can hold several food cells at once.
    // foodKeys is the set of "x,y" keys from the last snapshot; pendingEat
    // names the ONE cell this snake is provisionally eating.
    this.foodKeys = new Set();
    this.pendingEat = null;      // { key, atServerSeq }
    this.localGrow = 0;
    this.lastServerLen = null;
  }
  keySet(foods) {
    const s = new Set();
    if (foods) for (const f of foods) s.add(f.x + "," + f.y);
    return s;
  }
  setSender(fn) { this.sendFn = fn; }
  setDebug(on) { this.debug = !!on; if (!on) this.corrections.length = 0; }
  sameVec(a, b) { return a && b && a.x === b.x && a.y === b.y; }

  queueInput(dirName, delayed) {
    const vec = DIR_VECTORS[dirName];
    if (!vec) return null;
    if (this.inputBuffer.length >= 3) return null;
    const last = this.inputBuffer.length > 0
      ? this.inputBuffer[this.inputBuffer.length - 1].vec : this.dir;
    if (this.sameVec(vec, { x: -last.x, y: -last.y })) return null;
    if (this.sameVec(vec, last)) return null;
    const item = { seq: ++this.clientSeq, dirName, vec, sentTick: this.lastServerSeq, retries: 0, delayed: !!delayed };
    this.inputBuffer.push(item);
    if (this.sendFn) this.sendFn(dirName, item.seq);
    this.rebuild();
    return dirName;
  }

  retryUnacked() {
    if (this.deadOnServer || !this.sendFn) return;
    let dropped = false;
    // Iterate back-to-front so splicing an exhausted entry doesn't shift the
    // index of entries not yet visited.
    for (let i = this.inputBuffer.length - 1; i >= 0; i--) {
      const p = this.inputBuffer[i];
      const waited = (this.lastServerSeq == null || p.sentTick == null)
        ? 0 : (this.lastServerSeq - p.sentTick);
      if (waited < RETRY_AFTER_TICKS) continue;
      if (p.retries < MAX_RETRIES) {
        p.retries++;
        p.sentTick = this.lastServerSeq;
        this.sendFn(p.dirName, p.seq);
      } else {
        // All retries exhausted with no ack: the server almost certainly
        // never received this turn (a dropped WebSocket frame). Trusting a
        // turn that will never be confirmed would poison every future
        // one-cell prediction, since prediction always anchors on the
        // oldest queued entry. Drop it and fall back to the authoritative
        // body (or the next queued entry, if any).
        this.inputBuffer.splice(i, 1);
        dropped = true;
      }
    }
    if (dropped) this.rebuild();
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
    // A boosted (drifting) turn moves the head AND translates the body in
    // the same server step -- state this one-cell follow-the-leader
    // predictor cannot reproduce: render the authoritative body verbatim
    // and let the server show the skid. Anything else would guarantee
    // corrections.
    if (this.inputBuffer[0].delayed) {
      this.simBody = body;
      this.predicted = false;
      return;
    }
    const grow = this.localGrow > 0;
    // Predict using the OLDEST unacked turn: that is the one the server will
    // process on its next tick, since it applies queued turns in receipt
    // order.
    const nextDir = this.inputBuffer[0].vec;
    const head = { x: body[0].x + nextDir.x, y: body[0].y + nextDir.y };
    if (this.inBounds(head)) {
      this.simBody = this.advance(body, nextDir, grow);
      this.predicted = true;
      return;
    }
    // The oldest queued turn would leave the grid. Mirror the server's
    // wall-grace lookahead (consume_inbounds_turn in server-rust/src/sim.rs):
    // scan the remaining queued turns, skipping any that reverse the current
    // authoritative direction, for the first one that stays in bounds.
    let saved = null;
    for (let k = 0; k < this.inputBuffer.length; k++) {
      const d = this.inputBuffer[k].vec;
      if (d.x === -this.dir.x && d.y === -this.dir.y) continue;
      const h = { x: body[0].x + d.x, y: body[0].y + d.y };
      if (this.inBounds(h)) { saved = d; break; }
    }
    if (saved) {
      this.simBody = this.advance(body, saved, grow);
      this.predicted = true;
      return;
    }
    // No queued turn saves it. The server will either stall it in place
    // (still under wallGraceTicks) or let it die; the client does not track
    // wallGraceTicks state, so it renders no movement and skips the
    // correction check rather than guess which outcome applies.
    this.simBody = body;
    this.predicted = false;
  }

  // Food cell we are provisionally treating as eaten (for render to hide).
  eatenFoodKey() { return this.pendingEat ? this.pendingEat.key : null; }

  reconcile(slot, players, tickMs, grid, seq, ack, foods) {
    if (grid) this.grid = grid;
    this.lastServerSeq = (seq == null ? this.lastServerSeq : seq);
    const p = players[slot];
    if (!p) { this.simBody = null; this.authBody = null; return; }
    this.slot = slot;
    this.deadOnServer = !p.alive;

    const authDir = p.dir || this.inferDirFromBody(p.body);
    if (authDir) this.dir = authDir;

    // Wormhole snap: instant, no glide, no correction-event. Checked BEFORE
    // the normal food-prediction/correction-detection logic below (an early
    // return) so a teleport can never fall through into the correction-glide
    // path even by accident -- it would otherwise look like a >1-cell resync
    // and animate a slide across the board instead of an instant snap.
    if (p.teleport) {
      this.authBody = p.body.map(s => ({ x: s.x, y: s.y }));
      this.simBody = this.authBody.map(s => ({ ...s }));
      this.predicted = false;
      this.inputBuffer = [];
      this.pendingEat = null;
      this.localGrow = 0;
      this.foodKeys = this.keySet(foods);
      this.lastServerLen = p.body.length;
      return;
    }

    const newKeys = this.keySet(foods);
    const serverLen = p.body.length;
    const grew = (this.lastServerLen != null) && (serverLen > this.lastServerLen);
    // The specific food we predicted eating is gone from the board now.
    const ateGone = this.pendingEat != null && !newKeys.has(this.pendingEat.key);

    // Predict our own eat when the predicted head lands on ANY food cell.
    if (foods && foods.length && this.simBody && this.simBody.length && !this.pendingEat) {
      const ph = this.simBody[0];
      const hit = foods.find(f => f.x === ph.x && f.y === ph.y);
      if (hit) {
        this.pendingEat = { key: hit.x + "," + hit.y, atServerSeq: this.lastServerSeq };
        this.localGrow = 1;
      }
    }
    // Confirm: the eaten food disappeared AND we grew -> eat is authoritative.
    if (this.pendingEat && ateGone && grew) {
      this.pendingEat = null;
      this.localGrow = 0;
    }
    // Roll back: server did not confirm in time -> drop provisional growth.
    if (this.pendingEat && this.lastServerSeq != null &&
        (this.lastServerSeq - this.pendingEat.atServerSeq) >= EAT_CONFIRM_TICKS &&
        !(ateGone && grew)) {
      this.pendingEat = null;
      this.localGrow = 0;
    }

    // Detect a correction whenever the previous rebuild() actually made a
    // one-cell prediction that didn't match. With an empty buffer, simBody
    // was just a mirror of the previous authoritative body, and the new
    // snapshot naturally differs from it because the snake kept moving; that
    // is normal movement, not a misprediction, and must not count as one.
    // This runs unconditionally (not gated on this.debug) because the
    // correction-glide client effect needs it even with the panel closed;
    // only the debug-panel log entry itself is gated below.
    if (this.predicted && this.simBody && this.simBody.length) {
      const ph = this.simBody[0];
      const ah = p.body[0];
      if (ph.x !== ah.x || ph.y !== ah.y) {
        this.lastCorrectionEvent = {
          id: ++this.correctionEventSeq,
          fromHead: { x: ph.x, y: ph.y },
          toHead: { x: ah.x, y: ah.y }
        };
        if (this.debug) {
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
    }

    this.authBody = p.body.map(s => ({ x: s.x, y: s.y }));
    this.foodKeys = newKeys;
    this.lastServerLen = serverLen;

    if (ack != null) this.inputBuffer = this.inputBuffer.filter(inp => inp.seq > ack);
    if (this.deadOnServer) { this.inputBuffer = []; this.pendingEat = null; this.localGrow = 0; }

    this.rebuild();
  }

  renderBody(_alpha) { return this.simBody; }
}
