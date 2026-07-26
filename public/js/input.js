// ============================================================
// Physical input: keydown/keyup/blur listeners and touch swipe-to-steer.
// Depends on state.js's globals and keymap.js's KEY_MAPS, seats.js's
// requestSeat/refreshBoost/driftyTurn/seatInverted.
// ============================================================

// Swipe-to-turn (Phase 6): dominant axis of the drag, one turn per swipe
// (the start point is consumed once the threshold trips; a new turn needs a
// new touch). Feeds the exact same predictor path as a keypress --
// queueInput + input flash -- so netcode and prediction need no changes.
// A swipe when seat 0 doesn't exist is the rejoin gesture, mirroring the
// keydown rejoin rule ("the input itself is the join request").
function steerTouch(dir) {
  if (!myLocals) return;
  const entry = myLocals[0];
  if (!entry) {
    if (!seatPending[0]) requestSeat(0);
    return;
  }
  if (entry.role !== "player") return;
  const p = myPlayers.get(0);
  if (!p) return;
  const accepted = p.queueInput(dir, driftyTurn(0) || seatInverted(0));
  if (accepted && CLIENT_FX.inputFlash) lastInputFlash[0] = { dir, t: performance.now() };
}
function initSwipeSteering() {
  const board = document.getElementById("game");
  let start = null;
  // addEventListener registers a handler without overwriting any other
  // listener on the same event (unlike the el.onclick = fn style used
  // elsewhere in this codebase -- see JS-CHEATSHEET.md). `e => {...}` is an
  // arrow function used as the callback.
  board.addEventListener("touchstart", e => {
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  board.addEventListener("touchmove", e => {
    if (!start) return;
    const t = e.touches[0];
    const dx = t.clientX - start.x, dy = t.clientY - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_MIN_PX) return;
    start = null; // consumed: one turn per swipe
    steerTouch(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"));
  }, { passive: true });
  board.addEventListener("touchend", () => { start = null; });
}
document.addEventListener("keydown", e => {
  // Listener isolation (v3.4.0): while any text entry is active -- the
  // captcha/initials gate, a P2 initials prompt, the Change Initials panel,
  // or focus sitting in ANY input -- the game must not see keys at all. No
  // movement, no boost, no seat requests; nothing leaks from typing "WAS"
  // into a WASD listener. This is a gate on WHEN the listener acts, not a
  // remap of any key.
  if (UI.isTextEntryActive() || (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA"))) return;
  if (!myLocals) return;
  // Powerup activation: a distinct action from movement, looked up against
  // e.code (not e.key) so left/right Shift can be told apart. This is its
  // own branch, NOT folded into the movement loop's break-after-first-match
  // below, since "activate" is not a direction and the two must not compete
  // for the same physical key.
  let didActivate = false;
  for (let localIdx = 0; localIdx < KEY_MAPS.length; localIdx++) {
    if (KEY_MAPS[localIdx].activate === e.code) {
      const entry = myLocals[localIdx];
      if (entry && entry.role === "player") Net.send({ type: "activatePowerup", local: localIdx });
      e.preventDefault();
      didActivate = true;
      break; // activation key belongs to at most one local player
    }
  }
  if (didActivate) {
    // Always refresh boost even after activation, since a keystroke doesn't
    // erase the held direction keys. This ensures boost state is current.
    refreshBoost();
    return;
  }
  const key = e.key.toLowerCase();
  // Rejoin rule: pressing a seat's own movement keys when that seat does not
  // currently exist (never joined, or left via the Leave button) re-requests
  // it. The keypress itself is the join request and moves nothing yet.
  // Suppressed during the post-initials grace window: trailing keypresses
  // from an initials entry must not count as a join request.
  for (let localIdx = 0; localIdx < KEY_MAPS.length; localIdx++) {
    if (KEY_MAPS[localIdx][key] !== undefined && !myLocals[localIdx] && !seatPending[localIdx]) {
      if (performance.now() < seatRequestGraceUntil) return;
      requestSeat(localIdx);
      return;
    }
  }
  // heldKeys is a Set: it only stores unique values, so re-adding a key
  // that's already held is a no-op -- see JS-CHEATSHEET.md "Map / Set".
  const wasHeld = heldKeys.has(key);
  heldKeys.add(key);
  for (let localIdx = 0; localIdx < KEY_MAPS.length; localIdx++) {
    const dir = KEY_MAPS[localIdx][key];
    if (!dir) continue;
    const entry = myLocals[localIdx];
    if (!myPlayers.has(localIdx) || !entry || entry.role !== "player") break;
    if (!wasHeld) {
      // A turn typed at SPEED (momentum >= driftThreshold, whether or not
      // the boost key is still held) drifts the body server-side; tell the
      // predictor not to pre-play it (see predict.js). Below the threshold
      // it's a plain, predictable turn. A turn typed while banana-INVERTED
      // is flipped server-side -- same rule.
      const accepted = myPlayers.get(localIdx).queueInput(dir, driftyTurn(localIdx) || seatInverted(localIdx));
      if (accepted && CLIENT_FX.inputFlash) lastInputFlash[localIdx] = { dir, t: performance.now() };
    }
    if (key.startsWith("arrow")) e.preventDefault();
    break; // a key belongs to at most one local player's map
  }
  refreshBoost();
});
document.addEventListener("keyup", e => {
  heldKeys.delete(e.key.toLowerCase());
  refreshBoost();
});
// Alt-tab etc.: the browser stops delivering keyups, so treat everything as
// released rather than leave a snake boosting forever.
window.addEventListener("blur", () => { heldKeys.clear(); refreshBoost(); });
