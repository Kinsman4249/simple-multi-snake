// Duration-gated only: doubles food growth and adds bonus kill-growth while
// s.activePowerup.type === "growthSpurt". server.js owns setting/clearing
// activePowerup (onActivate/expiry); this module just exposes pure readers
// so applyMovementAndFood/applyKillBonuses don't need to know the shape.
// See base.js for how this fits alongside the other four powerups
// (wormhole in particular does NOT use this held-slot/activate model).
module.exports = {
  foodGrowthMultiplier(s, POWERUPS) {
    return (s.activePowerup && s.activePowerup.type === "growthSpurt") ? POWERUPS.growthSpurt.foodMultiplier : 1;
  },
  killBonusGrowthBonus(s, POWERUPS) {
    return (s.activePowerup && s.activePowerup.type === "growthSpurt") ? POWERUPS.growthSpurt.killBonusGrowth : 0;
  },
  title: "Growth Spurt",
  description: "For a short time, food makes you grow twice as much, and killing another " +
    "snake gives you extra length too. Good for getting big fast."
};
