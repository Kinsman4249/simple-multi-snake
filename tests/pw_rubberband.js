// Rubberband e2e test (Phase 8): two catch-up mechanics, both statistical
// but with wide margins so real regressions fail and noise doesn't.
//   A. Food bias: with a long leader and a short trailer staged via
//      SNAKE_TEST_SPAWNS, repeated testHook placeFood re-rolls must land
//      near the TRAILING snake far more often than uniform would; a control
//      server with foodBias disabled must not.
//   B. Shell pressure: with the leader >= 30% longer, blue shells must
//      dominate the spawn stream; with equal lengths they must not. A lone
//      connection must still never see a blueShell spawn (presence gate
//      wins over pressure).
// Run: deno run --allow-net --allow-read --allow-write --allow-run
//      --allow-env tests/pw_rubberband.js
import { connectClient, myPlayer, assert, startServer, stopServer, runTest, testHook } from "./helpers.js";

const RADIUS = 10, STRENGTH = 8, SAMPLES = 100;

function cheb(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }

// Roll `n` food placements via the placeFood hook; for each, measure the
// Chebyshev distance from the new food cell to both heads (same broadcast).
async function sampleFood(c1, n) {
  const near = { trail: 0 }, dist = { trail: [], lead: [] };
  let lastKey = c1.state.food ? c1.state.food.x + "," + c1.state.food.y : null;
  for (let k = 0; k < n; k++) {
    testHook(c1, "placeFood");
    const st = await c1.waitFor(s => {
      const key = s.food ? s.food.x + "," + s.food.y : null;
      return key !== null && key !== lastKey;
    }, 4000);
    lastKey = st.food.x + "," + st.food.y;
    const dT = cheb(st.food, st.players[1].body[0]);
    const dL = cheb(st.food, st.players[0].body[0]);
    dist.trail.push(dT); dist.lead.push(dL);
    if (dT <= RADIUS) near.trail++;
  }
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  return { nearTrail: near.trail, meanTrail: mean(dist.trail), meanLead: mean(dist.lead) };
}

async function foodBiasScenario(biasEnabled) {
  const spawns = [
    { x: 25, y: 6, dir: "right", len: 20 },  // leader, top of the board
    { x: 25, y: 24, dir: "right", len: 3 }   // trailer, bottom
  ];
  const server = await startServer({
    maxPlayers: 4,
    grid: { cols: 200, rows: 30, cellSize: 20 },
    move: { startIntervalMs: 150, minIntervalMs: 150, rampIntervalSec: 3600, rampStepMs: 0 },
    enableDebug: false,
    powerups: { spawnIntervalMs: 3600000, maxConcurrentPickups: 8 },
    rubberband: {
      foodBias: { enabled: biasEnabled, radius: RADIUS, strength: STRENGTH },
      shellPressure: { enabled: false }
    }
  }, { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify(spawns) });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    const c2 = await connectClient();
    await c2.waitFor(s => myPlayer(s, 0) != null, 5000);
    assert(c1.state.players[0].body.length > c1.state.players[1].body.length, "slot0 must lead");
    const r = await sampleFood(c1, SAMPLES);
    c1.close(); c2.close();
    return r;
  } finally {
    await stopServer(server);
  }
}

// Count the types of the first `n` NEW pickups the spawner produces.
async function sampleSpawns(client, n, timeoutMs) {
  const seen = new Set();
  const counts = {};
  const deadline = Date.now() + timeoutMs;
  let total = 0;
  while (total < n && Date.now() < deadline) {
    const cur = client.state;
    let sawNew = false;
    for (const p of (cur.powerupPickups || [])) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      counts[p.type] = (counts[p.type] || 0) + 1;
      total++;
      sawNew = true;
    }
    // Drain the board so the spawner keeps producing a fresh pickup each
    // interval under the v3.5.0 player-count pickup cap (as low as 1). We are
    // sampling the per-spawn TYPE roll, not how many pickups can coexist.
    if (sawNew && (cur.powerupPickups || []).length > 0) testHook(client, "clearPickups");
    if (total < n) await client.waitFor(s => s !== cur, 3000).catch(() => {});
  }
  assert(total >= n, "expected " + n + " pickup spawns, saw " + total);
  return counts;
}

async function shellPressureScenario(leaderLen, expectPressure) {
  const spawns = [
    { x: 25, y: 6, dir: "right", len: leaderLen },
    { x: 25, y: 24, dir: "right", len: 8 }
  ];
  const server = await startServer({
    maxPlayers: 4,
    grid: { cols: 200, rows: 30, cellSize: 20 },
    move: { startIntervalMs: 150, minIntervalMs: 150, rampIntervalSec: 3600, rampStepMs: 0 },
    enableDebug: false,
    powerups: {
      spawnIntervalMs: 250, maxConcurrentPickups: 24,
      wormhole: { enabled: false }, iceTrail: { enabled: false },
      poisonTrail: { enabled: false }, speedBoost: { enabled: false },
      growthSpurt: { enabled: true }, blueShell: { enabled: true }
    },
    rubberband: {
      foodBias: { enabled: false },
      shellPressure: { enabled: true, leadRatio: 1.3, typeWeight: 6, intervalScale: 0.5 }
    }
  }, { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify(spawns) });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    const c2 = await connectClient();
    await c2.waitFor(s => myPlayer(s, 0) != null, 5000);
    const counts = await sampleSpawns(c1, 24, 25000);
    const frac = (counts.blueShell || 0) / 24;
    if (expectPressure) {
      // weight 6 vs 1 => expected 6/7 ~ 0.86 of spawns
      assert(frac > 0.55, "pressure run: blueShell fraction should dominate (got " + frac.toFixed(2) + ")");
    } else {
      // uniform two types => expected 0.5
      assert(frac < 0.8, "no-pressure run: blueShell fraction should stay near uniform (got " + frac.toFixed(2) + ")");
    }
    c1.close(); c2.close();
    return frac;
  } finally {
    await stopServer(server);
  }
}

// Presence gate beats pressure: a lone connection sees NO blueShell spawns
// even with pressure enabled and blueShell the heavier weight.
async function gateBeatsPressureScenario() {
  const server = await startServer({
    maxPlayers: 4,
    grid: { cols: 200, rows: 30, cellSize: 20 },
    move: { startIntervalMs: 150, minIntervalMs: 150, rampIntervalSec: 3600, rampStepMs: 0 },
    enableDebug: false,
    powerups: {
      spawnIntervalMs: 250, maxConcurrentPickups: 24,
      wormhole: { enabled: false }, iceTrail: { enabled: false },
      poisonTrail: { enabled: false }, speedBoost: { enabled: false },
      growthSpurt: { enabled: true }, blueShell: { enabled: true }
    },
    rubberband: {
      foodBias: { enabled: false },
      shellPressure: { enabled: true, leadRatio: 1.3, typeWeight: 6, intervalScale: 0.5 }
    }
  }, { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 25, y: 15, dir: "right", len: 20 }]) });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    const counts = await sampleSpawns(c1, 8, 15000);
    assert(!counts.blueShell, "lone player must never see a blueShell spawn (got " + (counts.blueShell || 0) + ")");
    console.log("PASS: presence gate wins over shell pressure when alone.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

async function main() {
  const biased = await foodBiasScenario(true);
  const control = await foodBiasScenario(false);
  console.log("food bias: near-trailer " + biased.nearTrail + "/" + SAMPLES +
    " (control " + control.nearTrail + "), meanDist trailer " + biased.meanTrail.toFixed(1) +
    " vs leader " + biased.meanLead.toFixed(1));
  // Expected near-fraction ~0.32 biased vs ~0.06 uniform (radius 10 around a
  // row-24 head on a 200x30 board, strength 8) -- thresholds sit between the
  // two distributions with wide margins on n=100.
  assert(biased.nearTrail >= 15, "biased run: food should cluster near the trailer (near=" + biased.nearTrail + ")");
  assert(control.nearTrail <= 14, "control run: no clustering expected with foodBias off (near=" + control.nearTrail + ")");
  assert(biased.meanTrail < biased.meanLead, "biased run: food should average closer to the trailer than the leader");
  console.log("PASS: food bias pulls food toward the trailing snake, control does not.");

  const pFrac = await shellPressureScenario(20, true);   // 20 vs 8 = 2.5x >= 1.3
  const cFrac = await shellPressureScenario(8, false);   // 8 vs 8 = 1.0 < 1.3
  assert(pFrac > cFrac, "pressure run must out-spawn blueShell vs the equal-length run (" + pFrac.toFixed(2) + " vs " + cFrac.toFixed(2) + ")");
  console.log("PASS: shell pressure weights blueShell spawns when the leader is >=30% ahead (" + pFrac.toFixed(2) + " vs " + cFrac.toFixed(2) + ").");

  await gateBeatsPressureScenario();
}

runTest(main, { attempts: 3, watchdogMs: 220000 });
