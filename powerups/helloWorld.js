// Hello World: the teaching template for adding a powerup -- the worked
// example for powerups/README.md. Disabled by default (enabled: false in
// config.json/server defaults), so it never appears in a real game or in
// the join-screen legend; a test (tests/pw_helloworld.js) enables it via
// config override. On activation it logs "Hello World!" through dlog (the
// onActivate hook) and runs a barely-observable 1.02x speed multiplier for
// one second -- enough to assert against, small enough to be harmless.
module.exports = {
  // No requiresActivation: fires the instant it is picked up, like the
  // trails/growth. (Set requiresActivation: true to make it a held,
  // button-fired type like Speed Boost instead.)
  onActivate(slot, slotIndex, dlog) {
    dlog && dlog("Hello World!", { slot: slotIndex });
  },
  speedMultiplier(s, POWERUPS) {
    return (s.activePowerup && s.activePowerup.type === "helloWorld") ? POWERUPS.helloWorld.speedMult : 1;
  },
  title: "Hello World",
  description: "A tiny demo powerup for developers: it says hello in the server log and " +
    "makes you 2% faster for one second. Off by default."
};
