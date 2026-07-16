// Wormhole: independent single-charge auto-trigger (see the state-machine
// doc-comment in server.js next to tryWormholeOrDie). This module only
// implements the pure lookahead/landing algorithm; server.js owns the
// charge flag and the collision-resolver interception.
const CARDINAL_DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];

function isCellSafe(x, y, grid, slots, ignoreSlotIndex) {
  if (x < 0 || x >= grid.cols || y < 0 || y >= grid.rows) return false;
  for (let k = 0; k < slots.length; k++) {
    const other = slots[k];
    if (!other || k === ignoreSlotIndex) continue;
    const body = other.body;
    for (let m = 0; m < body.length; m++) {
      if (body[m].x === x && body[m].y === y) return false;
    }
  }
  return true;
}

// From the fatal head cell, scan a shallow lookahead in EVERY cardinal
// direction (including reversing the current heading -- unlike a normal
// turn, this is an emergency rescue, and reversing is often the only way
// back onto the board from a wall hit); score each by how many consecutive
// cells stay in bounds and body-free. ALSO try teleporting straight across
// to the opposite side of the board (reflected through the center) --
// sometimes a crowded corner has no good local escape at all, and jumping
// clear across the map is the actually-safe option. Both kinds of
// candidate are scored the SAME way (consecutive safe cells ahead of the
// landing spot) and compared head-to-head, so the pick is always whichever
// is genuinely safer, not a fixed preference for one style over the other.
// Landing is the FIRST safe cell along the winning candidate's path (not
// necessarily the full lookahead depth) -- a shorter safe landing beats
// forcing full depth.
function attemptWormhole(slotIndex, s, fatalHead, slots, grid, lookaheadDepth) {
  let best = null;
  for (const dir of CARDINAL_DIRS) {
    let x = fatalHead.x, y = fatalHead.y;
    let score = 0;
    let landing = null;
    for (let step = 0; step < lookaheadDepth; step++) {
      x += dir.x; y += dir.y;
      if (!isCellSafe(x, y, grid, slots, slotIndex)) break;
      score++;
      if (landing === null) landing = { x, y };
    }
    if (landing && (best === null || score > best.score)) best = { dir, landing, score };
  }
  const oppX = grid.cols - 1 - fatalHead.x;
  const oppY = grid.rows - 1 - fatalHead.y;
  if (isCellSafe(oppX, oppY, grid, slots, slotIndex)) {
    let score = 0;
    let x = oppX, y = oppY;
    for (let step = 0; step < lookaheadDepth; step++) {
      if (!isCellSafe(x + s.dir.x, y + s.dir.y, grid, slots, slotIndex)) break;
      x += s.dir.x; y += s.dir.y; score++;
    }
    if (best === null || score > best.score) best = { dir: s.dir, landing: { x: oppX, y: oppY }, score };
  }
  return best; // null => nowhere safe to phase to; charge still consumed by caller
}

module.exports = {
  isCellSafe, attemptWormhole,
  title: "Wormhole",
  description: "You do not use a button for this one. It waits, held in reserve. The moment " +
    "a move would kill you, it fires on its own -- teleporting you to the nearest safe spot, " +
    "or clear across the board, whichever is safer. One-time use, then it is gone."
};
