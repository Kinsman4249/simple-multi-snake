// ============================================================
// Connection / seat lifecycle: admission and the spectator queue, couch
// co-op seats, leave/disconnect teardown, join offers, the idle sweeps, and
// death handling with instant high-score recording. (Movement/collision
// live in sim.js; this module owns everything about WHO is on the board.)
//
// v3.4.0: the post-death initials prompt state machine (PLAYING/FLUSHING/
// RESUMING, held seats, per-prompt timeouts) is GONE. Initials are
// session-bound: the client sends them up front (setInitials, before or at
// seat join), and a qualifying score is written to the boards the moment
// the death/leave happens -- no prompt, no key-stealing overlay, no parked
// seats. A seat that never sent initials (e.g. a bare test client) records
// as "???".
// ============================================================
const {
  CFG, COLORS, MAX_LOCAL_PLAYERS, SPECTATOR_IDLE_MS, PLAYER_IDLE_MS,
  JOIN_OFFER_MS, dlog
} = require("./config");
const { S, placeFood, spawnSnake, newPlayerSlot, scoreMode } = require("./state");
const { sendTo, broadcastState } = require("./net");
const { qualifies, recordScore } = require("./highscores");

// Connection record. `initials` is per LOCAL INDEX, set by the client's
// setInitials message and bound for the whole session (overwritable any
// time via the same message -- the Change Initials button).
function assignConnection(connId, ws) {
  S.connections.set(connId, { ws, locals: [], initials: [] });
  admitLocal(connId, 0);
}
// Record a qualifying score for one local seat, immediately, using the
// seat's session-bound initials. The mode (local vs networked board) is
// sampled by the CALLER at the death/leave moment, before any teardown.
function recordIfQualifies(conn, localIdx, score, mode) {
  const targets = qualifies(score, mode);
  if (targets.length === 0) return;
  const initials = (conn && conn.initials[localIdx]) || "???";
  recordScore(targets, initials, score, mode);
  dlog && dlog("score recorded", { local: localIdx, initials, score, mode, targets });
}
// Seat a (new or re-requested) local player slot for connId at localIdx.
// This is the single admission path used by a fresh connect (localIdx 0),
// a couch-co-op joinLocal request (localIdx 1+), and nowhere else -- there
// is exactly one fairness rule, applied per LOCAL SEAT, not per connection:
// take a free slot immediately only if no one else is waiting, otherwise go
// to the back of the spectator queue like anyone else. A co-op connection
// gets no special treatment; each of its seats is round-robin fair on its
// own.
function admitLocal(connId, localIdx) {
  const conn = S.connections.get(connId);
  if (!conn) return;
  const freeIndex = S.slots.findIndex(s => s === null);
  if (freeIndex !== -1 && S.spectatorQueue.length === 0 && !S.joinOffer) {
    S.slots[freeIndex] = newPlayerSlot(connId);
    S.slots[freeIndex].color = COLORS[freeIndex];
    spawnSnake(freeIndex);
    conn.locals[localIdx] = { role: "player", slotIndex: freeIndex };
    if (S.sessionStart === null) S.sessionStart = Date.now();
    if (!S.food) placeFood();
  } else {
    S.spectatorQueue.push({ connId, local: localIdx, since: Date.now() });
    conn.locals[localIdx] = { role: "spectator", slotIndex: null };
    maybeOfferSlot();
  }
}
// Add a second (or later) local player seat to an existing connection
// (couch co-op). Only refused once config.maxLocalPlayers is reached --
// otherwise the new seat is admitted exactly like a fresh join, including
// going to the back of the spectator queue if one is already forming. This
// is deliberate: a co-op connection must not be able to hog two board slots
// while other connections wait; each local seat stands in line on its own.
function addLocalPlayer(connId) {
  const conn = S.connections.get(connId);
  if (!conn) return "not connected";
  // A seat that left (see removeLocalSeat) leaves a null hole at its local
  // index; rejoin fills that hole first so key maps (0 = arrows, 1 = WASD)
  // stay stable. Only when there is no hole does a brand-new index get used.
  let idx = conn.locals.findIndex(l => l === null);
  if (idx === -1) idx = conn.locals.length;
  if (idx >= MAX_LOCAL_PLAYERS) return "max local players reached";
  admitLocal(connId, idx);
  return null;
}
// Explicit "Leave" for one local seat. The seat exits COMPLETELY: its slot
// (if playing) is freed, its queue entry (if spectating) is dropped, and the
// local index becomes a null hole -- it is NOT pushed into the spectator
// queue. Rejoining requires a fresh joinLocal (WASD key / Play button on the
// client). If the leaving seat was mid-game with a qualifying score, it is
// recorded IMMEDIATELY with the seat's session initials. Mode is sampled
// BEFORE this seat is torn down -- the leaver still counts as present for
// their own run's classification.
// Returns true if this was the connection's LAST seat, in which case the
// caller should tear the whole connection down (solo leave = full exit).
function removeLocalSeat(connId, localIdx) {
  const conn = S.connections.get(connId);
  if (!conn) return false;
  const entry = conn.locals[localIdx];
  if (entry === null || entry === undefined) return false;
  if (entry.role === "player" && entry.slotIndex != null) {
    const s = S.slots[entry.slotIndex];
    if (s && s.alive) recordIfQualifies(conn, localIdx, s.score, scoreMode());
    S.slots[entry.slotIndex] = null;
  }
  S.spectatorQueue = S.spectatorQueue.filter(e => !(e.connId === connId && e.local === localIdx));
  if (S.joinOffer && S.joinOffer.connId === connId && S.joinOffer.local === localIdx) S.joinOffer = null;
  conn.locals[localIdx] = null;
  const anySeatLeft = conn.locals.some(l => l !== null && l !== undefined);
  if (!anySeatLeft) return true;
  maybeOfferSlot();
  return false;
}
// After a death that does not need (or has finished) the initials prompt:
// round robin, no exceptions. If anyone is waiting, THIS seat yields its
// slot to the queue, exactly the same whether it belongs to a solo
// connection or one seat of a co-op pair. The other seat on a co-op
// connection (if any) is unaffected either way.
function respawnOrSpectate(slotIndex) {
  if (S.spectatorQueue.length > 0) movePlayerToSpectator(slotIndex);
  else spawnSnake(slotIndex);
}
function removeConnection(connId) {
  const conn = S.connections.get(connId);
  if (!conn) return;
  S.connections.delete(connId);
  for (const entry of conn.locals) {
    if (entry && entry.role === "player" && entry.slotIndex != null) S.slots[entry.slotIndex] = null;
  }
  S.spectatorQueue = S.spectatorQueue.filter(e => e.connId !== connId);
  if (S.joinOffer && S.joinOffer.connId === connId) S.joinOffer = null;
  maybeOfferSlot();
  if (S.slots.every(s => s === null) && S.spectatorQueue.length === 0) {
    S.sessionStart = null; S.food = null;
  }
}
function maybeOfferSlot() {
  if (S.joinOffer) return;
  const openIndex = S.slots.findIndex(s => s === null);
  if (openIndex === -1) return;
  if (S.spectatorQueue.length === 0) return;
  const front = S.spectatorQueue[0];
  const conn = S.connections.get(front.connId);
  const seat = conn && conn.locals[front.local];
  if (!conn || !seat || seat.role !== "spectator") {
    // Stale entry (disconnected, or this seat already left the queue some
    // other way) -- drop it and try the next one in line.
    S.spectatorQueue.shift();
    return maybeOfferSlot();
  }
  S.joinOffer = { connId: front.connId, local: front.local, expiresAt: Date.now() + JOIN_OFFER_MS };
  sendTo(conn.ws, { type: "offerJoin", local: front.local, acceptMs: JOIN_OFFER_MS });
}
function acceptJoin(connId, localIdx) {
  if (!S.joinOffer || S.joinOffer.connId !== connId || S.joinOffer.local !== localIdx) return;
  const openIndex = S.slots.findIndex(s => s === null);
  if (openIndex === -1) { S.joinOffer = null; return; }
  S.spectatorQueue = S.spectatorQueue.filter(e => !(e.connId === connId && e.local === localIdx));
  S.joinOffer = null;
  const conn = S.connections.get(connId);
  if (!conn) { maybeOfferSlot(); return; }
  S.slots[openIndex] = newPlayerSlot(connId);
  S.slots[openIndex].color = COLORS[openIndex];
  spawnSnake(openIndex);
  conn.locals[localIdx] = { role: "player", slotIndex: openIndex };
  if (S.sessionStart === null) S.sessionStart = Date.now();
  if (!S.food) placeFood();
}
function lifecycleSweep() {
  const now = Date.now();
  if (S.joinOffer && now >= S.joinOffer.expiresAt) {
    const idx = S.spectatorQueue.findIndex(e => e.connId === S.joinOffer.connId && e.local === S.joinOffer.local);
    if (idx !== -1) { const [e] = S.spectatorQueue.splice(idx, 1); S.spectatorQueue.push({ connId: e.connId, local: e.local, since: now }); }
    S.joinOffer = null;
    maybeOfferSlot();
  }
  for (const e of S.spectatorQueue.slice()) {
    if (now - e.since >= SPECTATOR_IDLE_MS) {
      const conn = S.connections.get(e.connId);
      const otherSeatStillPlaying = conn && conn.locals.some((l, idx) => idx !== e.local && l && l.role === "player");
      if (!otherSeatStillPlaying) {
        // Nothing else on this connection is active: close the socket, as
        // before.
        if (conn && conn.ws) { try { conn.ws.close(); } catch (_) {} }
        removeConnection(e.connId);
      } else {
        // A co-op connection where the OTHER local seat is still actively
        // playing: closing the whole connection would eject that seat too,
        // which would be wrong. Simplification, not yet live-tested: this
        // seat just abandons the queue rather than the socket closing; the
        // player can request it again later with joinLocal. See TODO.md.
        S.spectatorQueue = S.spectatorQueue.filter(x => !(x.connId === e.connId && x.local === e.local));
        if (conn) conn.locals[e.local] = { role: "spectator", slotIndex: null, abandoned: true };
      }
    }
  }
  // Multiplayer inactivity timeout: if EVERY living snake has gone
  // PLAYER_IDLE_MS without a single input, the lobby is abandoned -- kick
  // the idle connections exactly like the spectator idle rule does. Any one
  // player pressing a key resets the clock for the whole board.
  const living = [];
  for (const s of S.slots) if (s && s.alive) living.push(s);
  if (living.length > 0 && living.every(s => now - s.lastInputAt >= PLAYER_IDLE_MS)) {
    dlog && dlog("lobby idle timeout", { players: living.length });
    const idleConnIds = new Set(living.map(s => s.connId));
    for (const connId of idleConnIds) {
      const conn = S.connections.get(connId);
      if (conn && conn.ws) { try { conn.ws.close(); } catch (_) {} }
      removeConnection(connId);
    }
    broadcastState();
  }
}
function movePlayerToSpectator(slotIndex) {
  const s = S.slots[slotIndex];
  if (!s) return;
  const conn = S.connections.get(s.connId);
  S.slots[slotIndex] = null;
  if (conn) {
    const localIdx = conn.locals.findIndex(l => l && l.role === "player" && l.slotIndex === slotIndex);
    if (localIdx !== -1) {
      conn.locals[localIdx] = { role: "spectator", slotIndex: null };
      S.spectatorQueue.push({ connId: s.connId, local: localIdx, since: Date.now() });
      sendTo(conn.ws, {
        type: "spectator", local: localIdx,
        queuePos: S.spectatorQueue.length, queueLen: S.spectatorQueue.length, disconnectMs: SPECTATOR_IDLE_MS
      });
    }
  }
  maybeOfferSlot();
}
function handleDeath(slotIndex) {
  const s = S.slots[slotIndex];
  if (!s) return;
  s.alive = false;
  s.boost = false;
  s.boostSince = null;
  s.rampProgress = 0; // death kills momentum; a respawn starts from base speed
  s.driftDir = null;
  // Session-bound initials (v3.4.0): a qualifying score is written to the
  // boards RIGHT NOW, with the mode sampled at this instant -- no prompt,
  // no banking, no parked seats. The respawn timer below runs unchanged.
  const conn = S.connections.get(s.connId);
  const localIdx = conn ? conn.locals.findIndex(l => l && l.role === "player" && l.slotIndex === slotIndex) : -1;
  if (conn && localIdx !== -1) recordIfQualifies(conn, localIdx, s.score, scoreMode());
  const connId = s.connId;
  setTimeout(() => {
    if (!S.slots[slotIndex] || S.slots[slotIndex].connId !== connId) return;
    respawnOrSpectate(slotIndex);
    broadcastState();
  }, CFG.spectatorPromoteDelayMs);
}

module.exports = {
  assignConnection, admitLocal, addLocalPlayer, removeLocalSeat,
  respawnOrSpectate, removeConnection, maybeOfferSlot, acceptJoin,
  lifecycleSweep, movePlayerToSpectator, handleDeath
};
