// Banana Trail: auto-fires on pickup (no requiresActivation) and lays
// banana-peel tiles behind the layer while active, like ice/poison.
// Crossing a banana tile INVERTS the crosser's controls for
// invertDurationMs -- left/right and up/down swap. The transform is applied
// server-side in the dir handler BEFORE the reversal/duplicate validation,
// which has two deliberate consequences: (a) pressing "forward" while
// inverted becomes a rejected reversal, so the snake just coasts (no new
// self-death mode); (b) the inversion commits at KEYPRESS time, matching
// the drift tag's philosophy. The layer is NOT immune to their own bananas
// (same rule as ice/poison). server.js stamps the sim-clock expiry
// (s.invertUntilTick) right after calling onCross, since that needs
// moveSeq/duration-in-ticks math this module doesn't own.
module.exports = {
  onCross(victimSlot) {
    // Marker hook for framework symmetry: the real state (invertUntilTick)
    // is stamped by the caller, exactly like iceExpiresAtTick for ice.
  },
  title: "Banana Trail",
  description: "Fires the moment you grab it: you leave banana peels behind you for a while. " +
    "Any snake that slips on one (even you) gets its controls REVERSED for a few seconds -- " +
    "left is right, up is down. Pressing straight ahead does nothing while slipping."
};
