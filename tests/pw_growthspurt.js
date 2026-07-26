// Growth Spurt e2e test: pickup -> held slot -> activate -> food grows by
// foodMultiplier while active -> reverts after durationMs. Run:
// deno run --allow-net --allow-read --allow-write --allow-run --allow-env
// tests/pw_growthspurt.js
//
// In plain terms: this checks the "growth spurt" power-up -- picking it up
// should fire immediately (no button press needed), doubling how much the
// snake grows from eating food for a set duration, then the growth amount
// should go back to normal once the effect times out.
import { connectClient, myPlayer, assert, startServer, stopServer, collectNextPickup, stepToward, runTest } from "./helpers.js";

// Steers toward the current food cell on a fixed cadence until the local
// snake's body length changes, then returns the delta. Deliberately does
// NOT try to detect "head landed exactly on the food cell" from a snapshot:
// eating and food-replacement happen atomically server-side, so by the time
// a state broadcast is observed the reported food position may already be
// the NEXT food, not the one actually reached -- a length-change check
// sidesteps that race entirely.
async function eatOnceAndMeasureGrowth(client, local) {
  const before = myPlayer(client.state, local).body.length;
  // setInterval repeats the arrow-function callback every 70ms until
  // clearInterval stops it below -- see docs/JS-CHEATSHEET.md
  const timer = setInterval(() => {
    const cur = client.state;
    const p = myPlayer(cur, local);
    if (!p || !cur.food) return;
    const dir = stepToward(cur, local, cur.food.x, cur.food.y);
    if (dir) client.send({ type: "dir", dir, local });
  }, 70);
  try {
    await client.waitFor(s => { const p = myPlayer(s, local); return p && p.body.length !== before; }, 15000);
  } finally {
    clearInterval(timer);
  }
  return myPlayer(client.state, local).body.length - before;
}

async function main() {
  const server = await startServer({
    grid: { cols: 20, rows: 20, cellSize: 20 },
    move: { startIntervalMs: 60, minIntervalMs: 60, rampIntervalSec: 3600, rampStepMs: 0 },
    powerups: {
      spawnIntervalMs: 300, maxConcurrentPickups: 3,
      wormhole: { enabled: false },
      growthSpurt: { enabled: true, durationMs: 9000, foodMultiplier: 2, killBonusGrowth: 2 },
      iceTrail: { enabled: false }, poisonTrail: { enabled: false }, speedBoost: { enabled: false }, blueShell: { enabled: false },
      scissors: { enabled: false }
    }
  });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);

    console.log("Collecting growthSpurt pickup...");
    await collectNextPickup(c1, 0, 20000);
    // growthSpurt AUTO-activates on pickup (only speedBoost is button-fired).
    await c1.waitFor(s => { const pp = myPlayer(s, 0); return pp && pp.activePowerup === "growthSpurt"; }, 3000);
    let p = myPlayer(c1.state, 0);
    assert(p.heldPowerup == null, "auto-fire powerup should NOT occupy the held slot");
    console.log("PASS: pickup auto-activates the timed effect (no button press).");

    const delta1 = await eatOnceAndMeasureGrowth(c1, 0);
    assert(delta1 === 2, "food growth should be doubled while growthSpurt is active (got +" + delta1 + ")");
    console.log("PASS: food growth doubled while active.");

    // Wait out the duration and confirm reversion.
    await c1.waitFor(s => { const pp = myPlayer(s, 0); return pp.activePowerup !== "growthSpurt"; }, 12000);
    console.log("PASS: effect expired.");

    const delta2 = await eatOnceAndMeasureGrowth(c1, 0);
    assert(delta2 === 1, "food growth should be back to +1 after expiry (got +" + delta2 + ")");
    console.log("PASS: food growth reverted to normal after expiry.");

    c1.close();
  } finally {
    await stopServer(server);
  }
}

runTest(main);
