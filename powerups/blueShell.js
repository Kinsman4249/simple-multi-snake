// Blue Shell: activating it launches a seeking projectile (not a
// self-buff) that homes in on whoever currently has the MOST segments,
// re-targeting every tick, so the lead can change mid-flight. It passes
// through every other snake harmlessly while traveling -- only the strike
// itself does damage. On arrival: the leader loses a large chunk of their
// segments (segmentLossPercent, default 33%), then it explodes, and every
// OTHER living snake within explosionRadius (default 3 cells) loses a
// smaller splash amount (splashLossPercent, default 1/6). The activator is
// NOT exempt: if they are (or become) the leader, it hits them too -- this
// is what makes leading risky and picking up every powerup NOT automatic.
// See base.js for how this fits alongside the other five powerups.
module.exports = {
  segmentsLost(bodyLength, percent, floor) {
    return Math.max(0, Math.min(bodyLength - floor, Math.floor(bodyLength * percent)));
  },
  title: "Blue Shell",
  description: "Launches at whoever has the longest snake right now, even if that is you. " +
    "It flies through every other snake with no effect. When it hits the leader, they lose " +
    "about a third of their length, and it explodes -- everyone else nearby loses a little too."
};
