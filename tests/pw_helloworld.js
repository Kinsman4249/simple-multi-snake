// Hello World powerup e2e test: the teaching template from
// powerups/README.md, exercised end-to-end. Disabled by default in prod;
// this test enables it via config override, hook-places a pickup in the
// snake's path, and asserts auto-fire, the 1.02x speed effect (via the
// broadcast moveMs), and the 1s expiry.
// Run: deno run --allow-net --allow-read --allow-write --allow-run
//      --allow-env tests/pw_helloworld.js
import { connectClient, myPlayer, assert, startServer, stopServer, runTest, testHook } from "./helpers.js";

// async function + await: pauses here until each Promise resolves,
// instead of chaining .then() -- see docs/JS-CHEATSHEET.md
async function main() {
  const server = await startServer({
    maxPlayers: 4,
    grid: { cols: 80, rows: 30, cellSize: 20 },
    move: { startIntervalMs: 150, minIntervalMs: 150, rampIntervalSec: 3600, rampStepMs: 0 },
    enableDebug: false,
    powerups: {
      spawnIntervalMs: 3600000, maxConcurrentPickups: 8,
      helloWorld: { enabled: true, durationMs: 1500, speedMult: 1.5 } // bumped so moveMs visibly drops (150 -> 100)
    }
  // JSON.stringify turns this JS array into text to pass as an env var --
  // see docs/JS-CHEATSHEET.md
  }, { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 10, y: 15, dir: "right" }]) });
  try {
    const c1 = await connectClient();
    // arrow function passed as a callback -- see docs/JS-CHEATSHEET.md
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    const baseMoveMs = myPlayer(c1.state, 0).moveMs;
    const head = myPlayer(c1.state, 0).body[0];
    testHook(c1, "spawnPickup", { ptype: "helloWorld", x: head.x + 4, y: 15 });
    const fired = await c1.waitFor(s => myPlayer(s, 0).activePowerup === "helloWorld", 5000);
    assert(fired.players[0].heldPowerup == null, "helloWorld must auto-fire, never occupy the held slot");
    assert(myPlayer(fired, 0).moveMs < baseMoveMs,
      "speedMultiplier hook must lower moveMs (base " + baseMoveMs + ", got " + myPlayer(fired, 0).moveMs + ")");
    console.log("PASS: helloWorld auto-fired and its speedMultiplier hook is live (moveMs " +
      baseMoveMs + " -> " + myPlayer(fired, 0).moveMs + ").");
    await c1.waitFor(s => myPlayer(s, 0).activePowerup === null, 6000);
    assert(myPlayer(c1.state, 0).moveMs === baseMoveMs, "moveMs must return to base after expiry");
    console.log("PASS: helloWorld expired on schedule.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

runTest(main, { attempts: 3, watchdogMs: 120000 });
