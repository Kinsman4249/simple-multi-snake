// Grid decay / anti-turtling obstacles e2e (v3.8.0): a telegraphed cell is a
// warning only (passable) until its telegraph elapses, then it's a solid,
// indestructible wall -- lethal to any snake that walks into it, same as the
// board edge (see server-rust/src/sim.rs resolve_wall_collisions), with death cause
// "obstacle" (not "wall", so the kill feed can tell them apart).
//
// Deterministic staging via SNAKE_TEST_SPAWNS (a forced snake on a known
// path) plus the SNAKE_TEST_HOOKS "spawnWall" op, which places a wall
// directly at (x,y) bypassing the real cell picker/gates -- telegraphMs:0
// makes it instantly solid, a large telegraphMs keeps it a warning-only cue
// for the whole test.
// Run: deno run --allow-net --allow-read --allow-write --allow-run --allow-env
// --unstable-detect-cjs tests/pw_walls.js
import { connectClient, myPlayer, startServer, stopServer, runTest, assert, testHook } from "./helpers.js";

const INTERVAL = 120;

async function boot() {
  return startServer(
    {
      grid: { cols: 40, rows: 30, cellSize: 20 },
      move: { startIntervalMs: INTERVAL, minIntervalMs: INTERVAL },
      maxConcurrentFood: 0,
      wallGraceTicks: 0,
      walls: { enabled: false }, // the real spawner stays off; the test drives S.walls directly
      powerups: { spawnIntervalMs: 999999, wormhole: { enabled: false }, growthSpurt: { enabled: false }, iceTrail: { enabled: false }, poisonTrail: { enabled: false }, speedBoost: { enabled: false }, blueShell: { enabled: false }, bananaTrail: { enabled: false } }
    },
    {
      SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 6, y: 15, dir: "right" }, { x: 30, y: 20, dir: "left" }]),
      SNAKE_TEST_HOOKS: "1"
    }
  );
}

async function main() {
  // --- A solid wall kills a snake that walks into it, cause "obstacle" ---
  {
    const server = await boot();
    try {
      const c = await connectClient();
      await c.waitFor(s => { const p = myPlayer(s, 0); return p && p.alive; }, 5000);
      // Second seat: purely to keep the room non-empty; unrelated to the wall.
      c.send({ type: "joinLocal" });
      await c.waitFor(s => myPlayer(s, 1) != null, 5000);
      // Solid immediately (telegraphMs 0), directly in slot 0's path (heading
      // right from x=6, y=15).
      testHook(c, "spawnWall", { x: 12, y: 15, telegraphMs: 0, lifetimeMs: 30000 });
      const solidState = await c.waitFor(s => s.walls && s.walls.some(w => w.x === 12 && w.y === 15), 2000);
      const w = solidState.walls.find(w => w.x === 12 && w.y === 15);
      assert(w.state === "solid", "an instantly-telegraphed wall should broadcast as solid (got " + w.state + ")");
      const dead = await c.waitFor(s => { const p = myPlayer(s, 0); return p && !p.alive; }, 6000);
      const kills = dead.kills || [];
      assert(kills.some(k => k.cause === "obstacle"), "death against a solid obstacle wall should carry cause 'obstacle' (got " + JSON.stringify(kills) + ")");
    } finally { await stopServer(server); }
  }

  // --- A telegraphed (warn-state) wall is NOT solid: the snake passes through ---
  {
    const server = await boot();
    try {
      const c = await connectClient();
      await c.waitFor(s => { const p = myPlayer(s, 0); return p && p.alive; }, 5000);
      c.send({ type: "joinLocal" });
      await c.waitFor(s => myPlayer(s, 1) != null, 5000);
      // Long telegraph (won't go solid for the life of this test), directly in
      // slot 0's path.
      testHook(c, "spawnWall", { x: 12, y: 15, telegraphMs: 60000, lifetimeMs: 30000 });
      const warnState = await c.waitFor(s => s.walls && s.walls.some(w => w.x === 12 && w.y === 15), 2000);
      const w = warnState.walls.find(w => w.x === 12 && w.y === 15);
      assert(w.state === "warn", "a fresh telegraph should broadcast as warn (got " + w.state + ")");
      // Let the forced snake (heading right, no steering) walk straight
      // through x=12 and well past it, alive the whole way.
      const past = await c.waitFor(s => { const p = myPlayer(s, 0); return p && p.body[0].x > 16; }, 8000);
      const p = myPlayer(past, 0);
      assert(p.alive, "a snake must pass freely through a cell still in its telegraph window (not yet solid)");
    } finally { await stopServer(server); }
  }
}

runTest(main);
