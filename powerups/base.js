// Shared no-op interface every powerup module may override. Not every hook
// is meaningful for every type (e.g. wormhole never uses onActivate -- it
// auto-fires from the collision resolvers instead, see server.js
// tryWormholeOrDie/attemptWormhole; blueShell's onActivate launches a
// projectile instead of setting a timed self-buff, see server.js's
// activatePowerup handler and updateBlueShells).
//
// The six powerups, briefly:
//   wormhole    -- Held in reserve (independent charge, not the shared
//                   activation slot below). No button press: the instant a
//                   move would otherwise kill the holder (wall or another
//                   snake), it automatically phases them through walls/
//                   bodies to the nearest safe path, or teleports them
//                   clear across the board, whichever is safer. One-time
//                   use -- firing (or failing to find a landing) always
//                   consumes the charge. See wormhole.js.
//   growthSpurt -- Duration-gated: doubles food growth and adds bonus
//                  kill-growth while active. See growthSpurt.js.
//   speedBoost  -- Duration-gated speed multiplier, separate from (and
//                  stacking with) the base hold-to-boost mechanic. See
//                  speedBoost.js.
//   iceTrail    -- While active, lays slowing trail tiles behind the
//                  holder; crossing one (including the layer's own) slows
//                  further per crossing, floored so it never fully halts.
//                  See iceTrail.js.
//   poisonTrail -- While active, lays damaging trail tiles; crossing one
//                  removes a body segment, floored at the global minimum
//                  snake length. See poisonTrail.js.
//   blueShell   -- Activating it launches a seeking projectile that
//                  re-targets the CURRENT longest snake every tick (even
//                  the activator, if they are or become the leader),
//                  ignoring every other snake in transit. On impact the
//                  leader loses a large percentage of their length, then
//                  it explodes and every OTHER living snake within a
//                  radius loses a smaller percentage. See blueShell.js.
//
// wormhole is the one exception with its own independent charge slot
// (never the shared one below). The other five -- including blueShell --
// share ONE held slot per player: picking one up occupies the slot if it's
// free, or grants a food-like +1 segment fallback if it's already occupied
// by that type. blueShell only differs in what activating it DOES (launch
// a projectile) rather than in how it's picked up/held.
module.exports = {
  onPickup(s, CFG) {},
  onActivate(s, now, moveSeq) {},
  onTick(s, now, dtMs, moveSeq) {},
  onExpire(s) {},
  onCross(victimSlot, layerSlot, tile, CFG) {}
};
