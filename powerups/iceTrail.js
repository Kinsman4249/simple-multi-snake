// Crossing an ice tile refreshes the victim's slow duration AND increases
// severity incrementally, floored at minSpeedMultiplier so a dense ice
// patch slows a snake hard but never freezes it solid. server.js stamps
// the sim-clock expiry (s.iceExpiresAtTick) right after calling onCross,
// since that needs moveSeq/duration-in-ticks math this module doesn't own.
// See base.js for how this fits alongside the other four powerups
// (wormhole in particular does NOT use this held-slot/activate model).
module.exports = {
  onCross(victimSlot) {
    victimSlot.iceStacks = (victimSlot.iceStacks || 0) + 1;
  },
  speedMultiplier(s, POWERUPS) {
    if (!s.iceStacks) return 1;
    return Math.max(
      POWERUPS.iceTrail.minSpeedMultiplier,
      1 - s.iceStacks * POWERUPS.iceTrail.slowMultiplierPerStack
    );
  },
  title: "Ice Trail",
  description: "While active, you leave a trail of ice behind you. Any snake that crosses " +
    "it (even you) slows down more each time, but never stops completely."
};
