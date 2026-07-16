// One segment removed per distinct poison tile a snake lands on, floored at
// the global MIN_SNAKE_LENGTH (server.js) so repeated crossings can drain a
// snake down to that floor but never below it.
// See base.js for how this fits alongside the other four powerups
// (wormhole in particular does NOT use this held-slot/activate model).
module.exports = {
  onCross(victimSlot, layerSlot, tile, MIN_SNAKE_LENGTH) {
    if (victimSlot.body.length > MIN_SNAKE_LENGTH) victimSlot.body.pop();
  },
  title: "Poison Trail",
  description: "While active, you leave a poison trail behind you. Any snake that crosses " +
    "it (even you) loses one segment, down to a safe minimum length."
};
