// ============================================================
// Seat lifecycle (request/leave/drop), session-bound initials, and boost
// key detection. Depends on state.js's globals (myPlayers, myLocals,
// seatPending, heldKeys, boostOn, boostOnSince, IS_TOUCH-adjacent
// touchBoost) and keymap.js's KEY_MAPS.
// ============================================================

// Session-bound initials per local seat (v3.4.0): P1's are entered on the
// captcha gate before play; P2's on its first join. Sent to the server via
// setInitials and used there to auto-record qualifying scores at death --
// there is no post-game prompt anymore. localStorage only PREFILLS the
// entry fields on the next page load; the prompt itself always runs.
const INITIALS_STORAGE_PREFIX = "snake.initials.local";
const sessionInitials = [null, null];
function storeInitials(localIdx, value) {
  sessionInitials[localIdx] = value;
  try { localStorage.setItem(INITIALS_STORAGE_PREFIX + localIdx, value); } catch (_) {}
  Net.send({ type: "setInitials", local: localIdx, value });
}
function storedInitials(localIdx) {
  try { return localStorage.getItem(INITIALS_STORAGE_PREFIX + localIdx) || ""; } catch (_) { return ""; }
}
// Post-initials-entry input grace (v3.4.0 listener-isolation fix): for a
// short window after ANY initials entry is confirmed, movement keys cannot
// REQUEST A SEAT -- residual/trailing keypresses from typing initials (WASD
// letters!) must not spawn P2. Movement of already-playing seats is
// unaffected.
const SEAT_REQUEST_GRACE_MS = 1800;
let seatRequestGraceUntil = 0;
function armSeatRequestGrace() { seatRequestGraceUntil = performance.now() + SEAT_REQUEST_GRACE_MS; }

function wireLocalPlayer(localIdx) {
  const p = myPlayers.get(localIdx);
  p.setSender((dir, clientSeq) => Net.send({ type: "dir", dir, cseq: clientSeq, local: localIdx }));
}
// Request (or re-request after a Leave) a seat for this local index. The
// server admits it round-robin fair like any fresh join: instant slot if the
// board is free and nobody waits, otherwise back of the spectator queue.
// v3.4.0: a seat with no session initials yet (P2's first join) prompts for
// them FIRST -- the join proceeds on confirm. While that prompt is open all
// game key handling is suspended (see the keydown gate), and confirming it
// arms the seat-request grace so trailing keypresses can't double-join.
function requestSeat(localIdx) {
  if (seatPending[localIdx]) return;
  if (myLocals && myLocals[localIdx]) return; // seat already exists in some role
  if (!sessionInitials[localIdx]) {
    UI.promptInitials(localIdx, storedInitials(localIdx), value => {
      storeInitials(localIdx, value);
      armSeatRequestGrace();
      doRequestSeat(localIdx);
    });
    return;
  }
  doRequestSeat(localIdx);
}
function doRequestSeat(localIdx) {
  if (seatPending[localIdx]) return;
  if (myLocals && myLocals[localIdx]) return;
  seatPending[localIdx] = true;
  if (!myPlayers.has(localIdx)) {
    myPlayers.set(localIdx, new LocalPlayerPredictor(localIdx === 0 ? "p1" : "p2"));
    wireLocalPlayer(localIdx);
  }
  Net.send({ type: "joinLocal" });
}
// Leave one seat completely (no spectator queue). Server-side this frees the
// slot / queue entry and, if it was our LAST seat, closes the connection --
// onClose below then shows the rejoin menu instead of a dead board.
function leaveSeat(localIdx) {
  if (!myLocals || !myLocals[localIdx]) return;
  if (boostOn[localIdx]) { boostOn[localIdx] = false; } // socket may close; no point sending off
  Net.send({ type: "leaveLocal", local: localIdx });
}
// Called from handleState when the server reports a seat as gone (null):
// tear down the local predictor and pending flags so the seat can be
// re-requested cleanly with a keypress or button later.
function dropSeat(localIdx) {
  if (!myPlayers.has(localIdx)) return;
  myPlayers.delete(localIdx);
  seatPending[localIdx] = false;
  boostOn[localIdx] = false;
  lastInputFlash[localIdx] = null;
  activeGlide[localIdx] = null;
}

// ---- Boost detection ------------------------------------------------
// Boost is "the key of the current direction of travel is held down".
// Evaluated on every keydown/keyup AND after every server state (the
// current direction can change under a held key); only on/off TRANSITIONS
// go over the wire.
function dirNameOfVec(v) {
  for (const name in DIR_TO_VEC) {
    if (DIR_TO_VEC[name].x === v.x && DIR_TO_VEC[name].y === v.y) return name;
  }
  return null;
}
function keyForDir(localIdx, dirName) {
  const map = KEY_MAPS[localIdx];
  for (const key in map) if (map[key] === dirName) return key;
  return null;
}
function refreshBoost() {
  if (!BOOST_CFG.enabled || !myLocals) return;
  for (let localIdx = 0; localIdx < KEY_MAPS.length; localIdx++) {
    seatSpeed(localIdx); // keep the lazy momentum clock fresh (runs every broadcast)
    const entry = myLocals[localIdx];
    const p = myPlayers.get(localIdx);
    const playing = entry && entry.role === "player" && p;
    let want = false;
    if (playing) {
      // Effective direction: the last queued (unacked) turn if any,
      // otherwise the authoritative direction -- matches what the server
      // will be traveling when the hold takes effect.
      const pending = p.inputBuffer.length > 0 ? p.inputBuffer[p.inputBuffer.length - 1].vec : p.dir;
      const dirName = dirNameOfVec(pending);
      const key = dirName && keyForDir(localIdx, dirName);
      want = !!(key && heldKeys.has(key));
      // The touch BOOST button has no direction of its own: holding it
      // boosts seat 0's current travel, whatever that is.
      if (localIdx === 0 && touchBoost) want = true;
    }
    if (want !== boostOn[localIdx]) {
      boostOn[localIdx] = want;
      if (want) boostOnSince[localIdx] = performance.now();
      Net.send({ type: "boost", on: want, local: localIdx });
    }
  }
}
