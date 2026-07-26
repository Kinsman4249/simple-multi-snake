// Banana Trail e2e test (Phase 11): auto-fires on pickup, lays tiles, and
// crossing a tile INVERTS the crosser's controls for invertDurationMs --
// including the layer's own. Staged deterministically: parallel forced
// spawns (SNAKE_TEST_SPAWNS) + a hook-placed pickup, no greedy pathing.
//
// Geometry note: the layer stripes its whole row with tiles, so a crosser
// that turns ALONG that row keeps slipping and the inversion refreshes
// forever (a real property of the mechanic, first seen as a test hang).
// The crosser therefore queues TWO presses after slipping: "left" (flips to
// a RIGHT turn -- the reversal assertion) immediately followed by "down"
// (flips to UP), so whichever row the right-turn landed in, the next step
// leaves the striped row for good.
// Run: deno run --allow-net --allow-read --allow-write --allow-run
//      --allow-env tests/pw_bananatrail.js
//
// In plain terms: this checks the "banana trail" power-up. Picking one up
// should fire it immediately (not sit in inventory) and start dropping
// tiles behind the snake. Any snake -- including the one that laid the
// trail -- that steps on a tile gets its steering controls reversed for a
// while, then goes back to normal once that wears off.
import { connectClient, myPlayer, assert, startServer, stopServer, runTest, testHook, sleep, assertTrailContiguous } from "./helpers.js";

const STEP_MS = 150;

async function main() {
  const spawns = [
    { x: 20, y: 30, dir: "right" },  // layer, mid-board
    { x: 20, y: 45, dir: "right" }   // crosser (turns up into the trail row)
  ];
  const server = await startServer({
    maxPlayers: 4,
    grid: { cols: 120, rows: 60, cellSize: 20 },
    move: { startIntervalMs: STEP_MS, minIntervalMs: STEP_MS, rampIntervalSec: 3600, rampStepMs: 0 },
    minSnakeLength: 3,
    enableDebug: false,
    powerups: {
      spawnIntervalMs: 3600000, maxConcurrentPickups: 8,
      bananaTrail: { enabled: true, durationMs: 15000, tileDurationMs: 30000, invertDurationMs: 2000 }
    }
  }, { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify(spawns) });
  try {
    const c1 = await connectClient();
    // s => myPlayer(s, 0) != null is an arrow function: shorthand for
    // "given a state s, return whether myPlayer(...) is non-null" -- see
    // docs/JS-CHEATSHEET.md
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    const c2 = await connectClient();
    await c2.waitFor(s => myPlayer(s, 0) != null, 5000);

    // Auto-fire through the REAL pickup path: the layer coasts into a
    // hook-placed banana pickup; it must activate instantly, never held.
    const head0 = c1.state.players[0].body[0];
    testHook(c1, "spawnPickup", { ptype: "bananaTrail", x: head0.x + 4, y: 30 });
    const fired = await c1.waitFor(s => s.players[0].activePowerup === "bananaTrail", 5000);
    assert(fired.players[0].heldPowerup == null, "bananaTrail must auto-fire, never occupy the held slot");
    // (s.trails || []) falls back to an empty array if s.trails is missing --
    // see "Nullish coalescing / defaults" in docs/JS-CHEATSHEET.md
    await c1.waitFor(s => (s.trails || []).some(t => t.type === "bananaTrail"), 5000);
    console.log("PASS: banana auto-fired on pickup and lays trail tiles.");

    // Let the layer stripe the corridor behind it so the crosser's column
    // (which trails the layer in x) is guaranteed to hold a tile laid AFTER
    // activation.
    await sleep(2500);
    assertTrailContiguous(c1.state, "bananaTrail");

    // Crosser turns up into the trail row; the moment its head lands on a
    // banana tile it must be flagged inverted.
    c2.send({ type: "dir", dir: "up", local: 0 });
    const crossed = await c2.waitFor(s => s.players[1] && s.players[1].inverted === true, 8000);
    assert(crossed.players[1].alive, "crosser should be alive right after slipping");
    console.log("PASS: crossing a banana tile sets inverted.");

    // Core mechanic: while inverted and heading up, pressing LEFT must come
    // out as a RIGHT turn. The chased "down" press (flipped to UP) then
    // steps off the striped row so the inversion can actually expire.
    const hx = c2.state.players[1].body[0].x;
    c2.send({ type: "dir", dir: "left", local: 0 });
    c2.send({ type: "dir", dir: "down", local: 0 });
    await c2.waitFor(s => s.players[1].body[0].x !== hx, 4000);
    assert(c2.state.players[1].body[0].x > hx,
      "inverted LEFT while heading up must turn the snake RIGHT (+x), got x " +
      c2.state.players[1].body[0].x + " from " + hx);
    console.log("PASS: controls are reversed while slipping.");

    // Expiry: after invertDurationMs (measured from the LAST slip) the flag
    // clears and controls act normally again (RIGHT while heading up = +x).
    await c2.waitFor(s => s.players[1].alive && !s.players[1].inverted, 8000);
    const hx2 = c2.state.players[1].body[0].x;
    c2.send({ type: "dir", dir: "right", local: 0 });
    await c2.waitFor(s => s.players[1].body[0].x !== hx2, 4000);
    assert(c2.state.players[1].body[0].x > hx2, "after expiry a RIGHT press must move +x again");
    console.log("PASS: inversion expires on schedule.");

    // The layer is NOT immune: a queued up/left/down hook walks its head
    // back onto its own freshly-laid row-30 tiles.
    assert(c1.state.players[0].activePowerup === "bananaTrail", "layer should still be laying");
    c1.send({ type: "dir", dir: "up", local: 0 });
    c1.send({ type: "dir", dir: "left", local: 0 });
    c1.send({ type: "dir", dir: "down", local: 0 });
    await c1.waitFor(s => s.players[0] && s.players[0].inverted === true, 8000);
    console.log("PASS: the layer slips on their own bananas too.");

    c1.close(); c2.close();
  } finally {
    await stopServer(server);
  }
}

runTest(main, { attempts: 3, watchdogMs: 180000 });
