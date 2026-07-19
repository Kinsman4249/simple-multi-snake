// "Piñata" bounties e2e (v3.6.6): when a snake at/over pinata.minLength dies,
// it POPS -- a candy burst scatters fast-decaying "bounty" food (foods flagged
// bounty:true, on their own TTL) over a wide area, and a candy-burst explosion
// (radius encoded NEGATIVE) is emitted for the client visual. A snake UNDER
// the threshold pops nothing.
//
// Deterministic staging via SNAKE_TEST_SPAWNS: one forced snake facing a wall
// so it auto-walks into it and dies (no steering). Normal food is disabled
// (maxConcurrentFood:0) so every food in the broadcast is unambiguously bounty
// candy. Assertions are taken on the FIRST death (a forced respawn re-pops).
// Run: deno run --allow-net --allow-read --allow-write --allow-run --allow-env
// --unstable-detect-cjs tests/pw_pinata.js
import { connectClient, myPlayer, sleep, startServer, stopServer, runTest, assert } from "./helpers.js";

const INTERVAL = 120;

const PINATA = { enabled: true, minLength: 30, percent: 0.30, maxFood: 12, ttlMs: 6000, spread: 6, bias: 0.6 };

// Boots a server with a forced snake of the given length facing the left wall
// plus a SECOND seat far to the right (piñatas are gated to >=2 player seats,
// so a lone snake never pops -- that gate is exercised via popSnake's second
// seat here). Waits for the first snake to die and returns the post-death
// broadcast state.
async function popSnake(len) {
  const server = await startServer(
    {
      grid: { cols: 40, rows: 30, cellSize: 20 },
      move: { startIntervalMs: INTERVAL, minIntervalMs: INTERVAL },
      maxConcurrentFood: 0,
      wallGraceTicks: 1,
      pinata: PINATA,
      powerups: { spawnIntervalMs: 999999, wormhole:{enabled:false}, growthSpurt:{enabled:false}, iceTrail:{enabled:false}, poisonTrail:{enabled:false}, speedBoost:{enabled:false}, blueShell:{enabled:false}, bananaTrail:{enabled:false} }
    },
    { SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 6, y: 15, dir: "left", len }, { x: 20, y: 15, dir: "right" }]) }
  );
  try {
    const c = await connectClient();
    // Wait for the forced snake to spawn at the intended length.
    await c.waitFor(s => { const p = myPlayer(s, 0); return p && p.alive && p.body.length === len; }, 5000);
    // Add the second seat so the >=2-player piñata gate is satisfied; it spawns
    // at x=20 moving right, well clear of seat 0's wall death.
    c.send({ type: "joinLocal" });
    await c.waitFor(s => myPlayer(s, 1) != null, 5000);
    // Auto-moves left into the wall; wait for the death broadcast (alive false).
    const dead = await c.waitFor(s => { const p = myPlayer(s, 0); return p && !p.alive; }, 6000);
    // The bounty food + explosion ride the SAME broadcast the death does, but
    // grab a couple more frames' worth in case the pop lands one tick later.
    let snap = dead;
    for (let t = 0; t < 3; t++) {
      if ((snap.foods && snap.foods.some(f => f.bounty)) || (snap.explosions && snap.explosions.some(e => e.radius < 0))) break;
      const cur = c.state;
      snap = await c.waitFor(s => s !== cur, INTERVAL * 3).catch(() => snap);
    }
    return { server, snap };
  } catch (e) {
    await stopServer(server);
    throw e;
  }
}

async function main() {
  // --- Big snake pops ---
  const big = await popSnake(35);
  try {
    const bounty = (big.snap.foods || []).filter(f => f.bounty);
    assert(bounty.length >= 1, "a 35-long snake should drop bounty candy (got " + bounty.length + ")");
    assert(bounty.length <= PINATA.maxFood, "candy count must be capped at maxFood (got " + bounty.length + ")");
    // percent=0.30 of 35 = ~11 (capped at 12); allow slack for scatter-cell
    // collisions that skip a candy, but it must clearly be the "% of length"
    // amount, not the whole 35-cell body.
    assert(bounty.length <= 12 && bounty.length >= 6, "candy count should be ~30% of length (got " + bounty.length + ")");
    assert(bounty.every(f => typeof f.expiresAtTick === "number"), "every bounty candy needs an expiresAtTick TTL");
    const candyBurst = (big.snap.explosions || []).some(e => e.radius < 0);
    assert(candyBurst, "a pop should emit a candy-burst explosion (negative radius)");
  } finally { await stopServer(big.server); }

  // --- Small snake pops nothing ---
  const small = await popSnake(6);
  try {
    const bounty = (small.snap.foods || []).filter(f => f.bounty);
    assert(bounty.length === 0, "a 6-long snake is under the threshold and must drop no candy (got " + bounty.length + ")");
    const candyBurst = (small.snap.explosions || []).some(e => e.radius < 0);
    assert(!candyBurst, "a sub-threshold death must not emit a candy burst");
  } finally { await stopServer(small.server); }

  // --- Lone snake pops nothing even when big (>=2 player gate) ---
  await soloPopsNothing();
}

// A single player seat: a big snake dying should NOT pop -- piñatas are gated
// to multiplayer, so a lone snake never rewards itself with gold.
async function soloPopsNothing() {
  const server = await startServer(
    {
      grid: { cols: 40, rows: 30, cellSize: 20 },
      move: { startIntervalMs: INTERVAL, minIntervalMs: INTERVAL },
      maxConcurrentFood: 0,
      wallGraceTicks: 1,
      pinata: PINATA,
      powerups: { spawnIntervalMs: 999999, wormhole:{enabled:false}, growthSpurt:{enabled:false}, iceTrail:{enabled:false}, poisonTrail:{enabled:false}, speedBoost:{enabled:false}, blueShell:{enabled:false}, bananaTrail:{enabled:false} }
    },
    { SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 6, y: 15, dir: "left", len: 35 }]) }
  );
  try {
    const c = await connectClient(); // seat 0 only -- no joinLocal
    await c.waitFor(s => { const p = myPlayer(s, 0); return p && p.alive && p.body.length === 35; }, 5000);
    const dead = await c.waitFor(s => { const p = myPlayer(s, 0); return p && !p.alive; }, 6000);
    // Sample a few frames after death to be sure nothing pops.
    let snap = dead;
    for (let t = 0; t < 3; t++) {
      const cur = c.state;
      snap = await c.waitFor(s => s !== cur, INTERVAL * 3).catch(() => snap);
    }
    const bounty = (snap.foods || []).filter(f => f.bounty);
    assert(bounty.length === 0, "a lone snake must not pop (got " + bounty.length + " candy)");
    assert(!(snap.explosions || []).some(e => e.radius < 0), "a lone snake must not emit a candy burst");
  } finally { await stopServer(server); }
}

runTest(main);
