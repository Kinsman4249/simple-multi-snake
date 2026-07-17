// ============================================================
// Connection / seat lifecycle: admission and the spectator queue, couch
// co-op seats, leave/disconnect teardown, join offers, the idle sweeps,
// death handling, and the connection-scoped high-score initials state
// machine. (Movement/collision live in sim.js; this module owns everything
// about WHO is on the board.)
// ============================================================
const {
  CFG, COLORS, MAX_LOCAL_PLAYERS, SPECTATOR_IDLE_MS, PLAYER_IDLE_MS,
  JOIN_OFFER_MS, INITIALS_TIMEOUT_MS, dlog
} = require("./config");
const { S, placeFood, spawnSnake, newPlayerSlot, scoreMode } = require("./state");
const { sendTo, broadcastState } = require("./net");
const { qualifies } = require("./highscores");

// Connection record. pendingInitials is the connection-scoped high-score
// queue ([{ local, targets, score, mode }]); activeInitials is the one
// prompt currently on screen ({ local, targets, score, mode, deadline }) or
// null. See queueInitials() for the state machine.
function assignConnection(connId, ws) {
  S.connections.set(connId, { ws, locals: [], pendingInitials: [], activeInitials: null });
  admitLocal(connId, 0);
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
// client). If the leaving seat was mid-game with a qualifying score, that
// score is queued for the initials flush (spec scenario A) and prompts once
// nobody on this keyboard is still playing.
// Returns true if this was the connection's LAST seat, in which case the
// caller should tear the whole connection down (solo leave = full exit).
function removeLocalSeat(connId, localIdx) {
  const conn = S.connections.get(connId);
  if (!conn) return false;
  const entry = conn.locals[localIdx];
  if (entry === null || entry === undefined) return false;
  if (entry.role === "player" && entry.slotIndex != null) {
    const s = S.slots[entry.slotIndex];
    if (s && s.alive) {
      // Leaving mid-game: bank a qualifying score now; it prompts later,
      // once no local seat on this connection is actively playing. Mode is
      // sampled BEFORE this seat is torn down -- the leaver still counts as
      // present for their own run's classification.
      const mode = scoreMode();
      const targets = qualifies(s.score, mode);
      if (targets.length > 0) conn.pendingInitials.push({ local: localIdx, targets, score: s.score, mode });
    }
    S.slots[entry.slotIndex] = null;
  }
  S.spectatorQueue = S.spectatorQueue.filter(e => !(e.connId === connId && e.local === localIdx));
  if (S.joinOffer && S.joinOffer.connId === connId && S.joinOffer.local === localIdx) S.joinOffer = null;
  // Leaving during your own live initials prompt counts as declining it.
  const declinedOwnPrompt = conn.activeInitials && conn.activeInitials.local === localIdx;
  conn.locals[localIdx] = null;
  const anySeatLeft = conn.locals.some(l => l !== null && l !== undefined);
  if (!anySeatLeft) return true;
  maybeOfferSlot();
  // If the leaver declined their own live prompt, the flush must ADVANCE
  // (next queued prompt, or re-admit held seats), not merely stop.
  if (declinedOwnPrompt) advanceInitialsFlush(connId);
  else maybeStartInitialsFlush(connId);
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
  // Initials prompt timeouts (connection-scoped -- see the state machine
  // above handleDeath). A prompt that runs out its countdown is skipped and
  // the flush advances to the next queued score / re-admits held seats.
  for (const [connId, conn] of S.connections) {
    if (conn.activeInitials && now >= conn.activeInitials.deadline) {
      dlog && dlog("initials timeout", { connId, local: conn.activeInitials.local });
      advanceInitialsFlush(connId);
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
// ---------------------------------------------------------------
// High-score initials: connection-scoped state machine.
//
// States (per connection):
//   PLAYING   -- at least one local seat has a LIVING snake. Initials
//                prompts are NEVER shown here (shared-keyboard rule:
//                a prompt would steal keys from whoever is still alive).
//                Qualifying scores are banked in conn.pendingInitials.
//   FLUSHING  -- no local seat is alive and pendingInitials is non-empty:
//                prompts are shown ONE AT A TIME (conn.activeInitials),
//                each with its own timeout that only starts when the
//                prompt actually appears. Seats that died while a flush
//                was owed are parked as role "held" (their board slot is
//                freed for round-robin fairness) instead of respawning,
//                so play cannot restart underneath the prompts.
//   RESUMING  -- queue drained: every held seat is re-admitted through
//                the normal admitLocal path (respawn immediately if the
//                board is free, otherwise back of the spectator queue).
//
// Transitions are driven from exactly three events: a death, a leave, and
// an initials resolution (submit / timeout / leaver-declined).
// ---------------------------------------------------------------
function anyLocalAlive(conn) {
  return conn.locals.some(l => {
    if (!l || l.role !== "player" || l.slotIndex == null) return false;
    const s = S.slots[l.slotIndex];
    return s && s.alive;
  });
}
// Bank a qualifying score for a local seat. Called from death and leave.
// `mode` is the scoreMode() sampled at that moment; it rides along to
// recordScore so the score lands on the right board (local vs networked).
function queueInitials(conn, localIdx, targets, score, mode) {
  conn.pendingInitials.push({ local: localIdx, targets, score, mode });
  dlog && dlog("initials queued", { local: localIdx, score, mode, queued: conn.pendingInitials.length });
}
// PLAYING -> FLUSHING: begin showing prompts if nothing blocks them.
function maybeStartInitialsFlush(connId) {
  const conn = S.connections.get(connId);
  if (!conn || conn.activeInitials || conn.pendingInitials.length === 0) return;
  if (anyLocalAlive(conn)) return; // someone on this keyboard is still playing
  const next = conn.pendingInitials.shift();
  conn.activeInitials = { ...next, deadline: Date.now() + INITIALS_TIMEOUT_MS };
  sendTo(conn.ws, { type: "askInitials", targets: next.targets, score: next.score, deadlineMs: INITIALS_TIMEOUT_MS, local: next.local });
}
// One prompt resolved (submitted, timed out, or its seat left): show the
// next queued one, or -- FLUSHING -> RESUMING -- re-admit every held seat.
function advanceInitialsFlush(connId) {
  const conn = S.connections.get(connId);
  if (!conn) return;
  conn.activeInitials = null;
  if (conn.pendingInitials.length > 0) { maybeStartInitialsFlush(connId); return; }
  for (let i = 0; i < conn.locals.length; i++) {
    if (conn.locals[i] && conn.locals[i].role === "held") admitLocal(connId, i);
  }
}
function handleDeath(slotIndex) {
  const s = S.slots[slotIndex];
  if (!s) return;
  s.alive = false;
  s.boost = false;
  s.boostSince = null;
  s.driftDir = null;
  const conn = S.connections.get(s.connId);
  const localIdx = conn ? conn.locals.findIndex(l => l && l.role === "player" && l.slotIndex === slotIndex) : -1;
  if (conn && localIdx !== -1) {
    const mode = scoreMode();
    const targets = qualifies(s.score, mode);
    if (targets.length > 0) queueInitials(conn, localIdx, targets, s.score, mode);
  }
  const connId = s.connId;
  setTimeout(() => {
    if (!S.slots[slotIndex] || S.slots[slotIndex].connId !== connId) return;
    const c = S.connections.get(connId);
    if (c && (c.activeInitials || c.pendingInitials.length > 0)) {
      // An initials flush is owed (or running) on this connection: park the
      // seat as "held" instead of respawning, freeing the board slot for
      // others. advanceInitialsFlush re-admits it once the queue drains.
      S.slots[slotIndex] = null;
      if (localIdx !== -1) c.locals[localIdx] = { role: "held", slotIndex: null };
      maybeOfferSlot();
      maybeStartInitialsFlush(connId);
      broadcastState();
      return;
    }
    respawnOrSpectate(slotIndex);
  }, CFG.spectatorPromoteDelayMs);
  if (conn) maybeStartInitialsFlush(s.connId);
}

module.exports = {
  assignConnection, admitLocal, addLocalPlayer, removeLocalSeat,
  respawnOrSpectate, removeConnection, maybeOfferSlot, acceptJoin,
  lifecycleSweep, movePlayerToSpectator, anyLocalAlive, queueInitials,
  maybeStartInitialsFlush, advanceInitialsFlush, handleDeath
};
