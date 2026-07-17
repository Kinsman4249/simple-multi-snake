// Duration-gated speed multiplier, deliberately namespaced apart from
// boost.* (the existing hold-to-boost mechanic) -- both stack
// multiplicatively into the same s.moveAccumMs increment in simLoop.
// See base.js for how this fits alongside the other four powerups
// (wormhole in particular does NOT use this held-slot/activate model).
module.exports = {
  speedMultiplier(s, POWERUPS) {
    return (s.activePowerup && s.activePowerup.type === "speedBoost") ? POWERUPS.speedBoost.speedMult : 1;
  },
  // The ONLY powerup you fire with a button (the activate key). Every other
  // type goes off the moment you pick it up; this one you hold and trigger
  // when you want the speed. See server.js HELD_TYPES.
  requiresActivation: true,
  title: "Speed Boost",
  description: "Press your activate key to move faster for a short time. Works together with " +
    "holding the boost key, so both speed-ups add up."
};
