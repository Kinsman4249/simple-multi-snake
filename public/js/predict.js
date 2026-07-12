// ============================================================
// Client-side prediction and reconciliation for locally controlled
// snakes.
//
// Model (this is the "rollback" half of the netcode): every time an
// authoritative snapshot arrives, treat its body for our slot as
// ground truth ("roll back" to it), then re-derive one tick of
// predicted motion on top of it using whichever local input is still
// outstanding ("replay"). We only ever predict exactly one tick
// ahead of the confirmed base, because the server itself only
// consumes one queued input per tick (see computeNewHeads in
// server.js) -- predicting further would just be guessing at ticks
// the server hasn't run yet.
//
// This intentionally does not resimulate collisions client-side.
// Collisions depend on every other snake's position too, which this
// client does not have authority over, so a mispredicted collision
// just self-corrects on the next snapshot (one tick of visual
// smoothing, not a physics engine).
//
// One instance of this class is created per locally controlled
// snake. Phase 2 wires exactly one ("p1"); Phase 3 adds a second
// ("p2") for the WASD split without changing this file.
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
    this.predictedBody = null;  // confirmedBody advanced by one tick using pendingInputs[0]
    this.confirmedTickMs = 160;
    this.confirmedAt = 0;       // performance.now() at last reconcile()
  }

  // Called on keypress. Mirrors the server's own buffering rule
  // (server.js computeNewHeads / the ws "dir" handler: max 2 queued,
  // no immediate reversal, no duplicate) so what we predict matches
  // what the server will actually accept. Returns the dir name if it
  // was queued, or null if rejected (so the caller knows not to
  // bother sending it over the wire).
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

  // Reconcile against a fresh authoritative snapshot for `slot`.
  reconcile(slot, players, tickMs) {
    const p = players[slot];
    if (!p) {
      this.confirmedBody = null;
      this.predictedBody = null;
      return;
    }
    this.slot = slot;
    this.confirmedTickMs = tickMs;
    this.confirmedAt = performance.now();

    // Teleport / respawn guard: if the new authoritative head is not
    // adjacent to (or the same as) our old confirmed head, this was not
    // an ordinary one-cell tick step -- it's a death/respawn now, and
    // will also cover a Phase 4 wormhole teleport later. Trust the
    // server outright and drop stale pending inputs rather than
    // fast-forwarding them onto a body they were never queued against.
    const bigJump = !this.confirmedBody || this.confirmedBody.length === 0 ||
      (Math.abs(p.body[0].x - this.confirmedBody[0].x) +
       Math.abs(p.body[0].y - this.confirmedBody[0].y) > 1);

    this.confirmedBody = p.body.map(s => ({ x: s.x, y: s.y }));

    // Authoritative direction must come from the server. Without this, the
    // client keeps validating future turns against a stale heading after the
    // first accepted turn, so later keypresses can be rejected locally before
    // they are ever sent. If an older server does not send dir yet, infer it
    // from the first two body cells as a compatibility fallback.
    const authoritativeDir = p.dir || this.inferDirFromBody(this.confirmedBody);
    if (authoritativeDir) this.dir = authoritativeDir;

    if (bigJump) {
      this.pendingInputs = [];
    } else if (this.pendingInputs.length > 0) {
      // The server consumed at most one queued input to produce this
      // tick, same as computeNewHeads(). Drop the one we predicted with.
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

  // Predict exactly one tick past the confirmed body, using the next
  // outstanding input if there is one, else the current heading.
  recompute() {
    if (!this.confirmedBody) {
      this.predictedBody = null;
      return;
    }
    const nextDir = this.pendingInputs.length > 0 ? this.pendingInputs[0] : this.dir;
    const head = { x: this.confirmedBody[0].x + nextDir.x, y: this.confirmedBody[0].y + nextDir.y };
    this.predictedBody = [head, ...this.confirmedBody.slice(0, -1)];
  }

  // What to draw right now: slides from confirmedBody toward
  // predictedBody over the course of the current tick window, so a
  // keypress produces smooth motion instead of an instant grid-snap.
  renderBody(now) {
    if (!this.predictedBody) return null;
    if (!this.confirmedBody) return this.predictedBody;
    const alpha = Math.min(1, Math.max(0, (now - this.confirmedAt) / this.confirmedTickMs));
    const len = Math.min(this.confirmedBody.length, this.predictedBody.length);
    const out = [];
    for (let i = 0; i < len; i++) {
      const a = this.confirmedBody[i], b = this.predictedBody[i];
      out.push({ x: a.x + (b.x - a.x) * alpha, y: a.y + (b.y - a.y) * alpha });
    }
    for (let i = len; i < this.predictedBody.length; i++) out.push(this.predictedBody[i]);
    return out;
  }
}
