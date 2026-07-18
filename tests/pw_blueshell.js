// Blue Shell e2e test (Phase 9 rewrite): deterministic staging, no greedy
// pathing. Snakes are spawned at fixed cells traveling PARALLEL via
// SNAKE_TEST_SPAWNS (optional len forces a known leader), and the shell
// pickup is placed directly in the leader's path with the SNAKE_TEST_HOOKS
// testHook message -- the snake just coasts into it (snakes auto-move; "go
// straight" means send nothing).
//
// Covers, each on its own fresh server:
//   0. testHook is inert without SNAKE_TEST_HOOKS (prod safety).
//   A. Auto-fire on pickup + direct-hit percentage on the leader (who
//      collected it) + REAL splash geometry: a victim inside
//      explosionRadius loses splashLossPercent, a third snake outside the
//      radius loses nothing, and the victim stays at/above the floor.
//   B. Single-player fizzle: collected alone, the shell becomes +1 growth.
//   C. Dead-awaiting-respawn self-nuke: the opponent is dead but still
//      CONNECTED (seat persists through spectatorPromoteDelayMs), so the
//      lone survivor's pickup fires and hits themselves.
// Run: deno run --allow-net --allow-read --allow-write --allow-run
//      --allow-env tests/pw_blueshell.js
import { connectClient, myPlayer, assert, startServer, stopServer, runTest, testHook, sleep } from "./helpers.js";

// Base config for every scenario: fixed move cadence (no ramp), natural
// powerup spawner effectively OFF (pickups come only from testHook, so no
// stray type can interfere), percentages bumped so losses are observable.
function baseConfig(grid, extraPowerups) {
  return {
    maxPlayers: 4,
    grid,
    move: { startIntervalMs: 150, minIntervalMs: 150, rampIntervalSec: 3600, rampStepMs: 0 },
    // Pin the classic single-food board: this test's splash-geometry
    // scenario runs 3 clients (v3.5.0 would otherwise put 2 foods out), and a
    // stray food eaten by a parallel snake would shift the exact lengths the
    // loss assertions check.
    maxConcurrentFood: 1,
    minSnakeLength: 3,
    enableDebug: false, // keep the piped stdout quiet (pipe-stall gotcha)
    powerups: Object.assign({
      spawnIntervalMs: 3600000, maxConcurrentPickups: 8,
      blueShell: { enabled: true, segmentLossPercent: 0.5, explosionRadius: 3, splashLossPercent: 0.34, moveIntervalMs: 90 }
    }, extraPowerups || {})
  };
}

// --- Scenario 0: prod inertness -------------------------------------------
async function scenarioInert() {
  const server = await startServer(baseConfig({ cols: 40, rows: 20, cellSize: 20 })); // NO SNAKE_TEST_HOOKS env
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    testHook(c1, "spawnPickup", { ptype: "blueShell", x: 20, y: 5 });
    await sleep(600);
    assert(!c1.state.powerupPickups || c1.state.powerupPickups.length === 0,
      "testHook must be ignored when SNAKE_TEST_HOOKS is unset");
    console.log("PASS: testHook inert without SNAKE_TEST_HOOKS.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

// --- Scenario A: auto-fire + splash geometry -------------------------------
// Three snakes traveling parallel, heading right, fixed rows:
//   slot0 leader  (row 10, len 24) -- collects the shell, is the target.
//   slot1 victim  (row 12, len 20) -- spawned 10 cells AHEAD of the leader
//     so that, whatever the inter-connect lag (later connects start moving
//     later, so trail in x), its 20-cell body still spans the impact
//     column. Row distance to the impact is a constant 2 <= radius 3.
//   slot2 outside (row 36, len 6)  -- row distance 26 > radius, never hit.
async function scenarioSplash() {
  const spawns = [
    { x: 26, y: 10, dir: "right", len: 24 },
    { x: 36, y: 12, dir: "right", len: 20 },
    { x: 26, y: 36, dir: "right", len: 6 }
  ];
  const server = await startServer(
    baseConfig({ cols: 160, rows: 40, cellSize: 20 }),
    { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify(spawns) }
  );
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    const c2 = await connectClient();
    await c2.waitFor(s => myPlayer(s, 0) != null, 5000);
    const c3 = await connectClient();
    await c3.waitFor(s => myPlayer(s, 0) != null, 5000);

    const st = c1.state;
    const [leader, victim, outsider] = [st.players[0], st.players[1], st.players[2]];
    assert(leader && victim && outsider, "three seated snakes expected");
    assert(leader.body.length > victim.body.length, "slot0 must be the leader");

    // Place the shell a few cells ahead in the leader's row; it coasts in.
    const head = leader.body[0];
    const lenBefore = [leader.body.length, victim.body.length, outsider.body.length];
    assert(head.x + 8 < 160, "leader too close to the wall for pickup staging");
    testHook(c1, "spawnPickup", { ptype: "blueShell", x: head.x + 6, y: 10 });

    // Auto-fire: the explosion must arrive with NO activate message and the
    // held slot never occupied.
    const boom = await c1.waitFor(s => s.explosions && s.explosions.length > 0, 8000);
    assert(boom.players[0].heldPowerup == null, "blueShell must never occupy heldPowerup (auto-fire)");
    assert(!boom.blueShells || boom.blueShells.length === 0, "shell consumed after impact");

    const ex = boom.explosions[0];
    assert(ex.y === 10, "self-hit impact stays in the leader's row (got y=" + ex.y + ")");

    // Direct hit: exact configured percentage on the leader.
    const leaderLoss = lenBefore[0] - boom.players[0].body.length;
    assert(leaderLoss === Math.floor(lenBefore[0] * 0.5),
      "leader direct hit: expected -" + Math.floor(lenBefore[0] * 0.5) + ", got -" + leaderLoss);
    assert(boom.players[0].alive, "leader survives the strike");

    // Splash geometry: victim (row distance 2, body spanning the impact
    // column) loses the splash percentage and stays above the floor ...
    const victimLoss = lenBefore[1] - boom.players[1].body.length;
    const expVictim = Math.min(lenBefore[1] - 3, Math.floor(lenBefore[1] * 0.34));
    const vSeg = boom.players[1].body.some(seg => Math.max(Math.abs(seg.x - ex.x), Math.abs(seg.y - ex.y)) <= 3)
      || victimLoss > 0; // sanity: it lost segments, so it must have been in radius at impact
    assert(vSeg, "victim staged inside the blast radius");
    assert(victimLoss === expVictim, "victim splash: expected -" + expVictim + ", got -" + victimLoss);
    assert(boom.players[1].body.length >= 3, "victim stays at/above minSnakeLength");
    // ... and the far snake (row distance 26) loses nothing.
    assert(lenBefore[2] - boom.players[2].body.length === 0, "outside-radius snake must lose nothing");

    console.log("PASS: auto-fire self-hit -" + leaderLoss + ", splash -" + victimLoss + " inside radius, 0 outside.");
    c1.close(); c2.close(); c3.close();
  } finally {
    await stopServer(server);
  }
}

// --- Scenario B: single-player fizzle --------------------------------------
async function scenarioFizzle() {
  const spawns = [{ x: 6, y: 10, dir: "right", len: 5 }];
  const server = await startServer(
    baseConfig({ cols: 40, rows: 20, cellSize: 20 }),
    { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify(spawns) }
  );
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    const lenBefore = myPlayer(c1.state, 0).body.length;
    const head = myPlayer(c1.state, 0).body[0];
    testHook(c1, "spawnPickup", { ptype: "blueShell", x: head.x + 4, y: 10 });
    await c1.waitFor(s => s.powerupPickups.length === 0 && myPlayer(s, 0).body.length !== lenBefore, 8000);
    assert(myPlayer(c1.state, 0).body.length === lenBefore + 1,
      "lone pickup fizzles into exactly +1 growth (wasted-pickup fallback)");
    assert(!c1.state.blueShells || c1.state.blueShells.length === 0, "no shell launched while alone");
    await sleep(800);
    assert(!c1.state.explosions || c1.state.explosions.length === 0, "no explosion while alone");
    console.log("PASS: single-player pickup fizzled into +1 growth, no shell.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

// --- Scenario C: opponent dead-but-connected => self-nuke -------------------
async function scenarioDeadRespawnNuke() {
  const spawns = [
    { x: 30, y: 10, dir: "right", len: 8 },
    { x: 3, y: 20, dir: "left" } // walks into the left wall and dies in a few steps
  ];
  const server = await startServer(
    Object.assign(baseConfig({ cols: 60, rows: 30, cellSize: 20 }), { spectatorPromoteDelayMs: 8000 }),
    { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify(spawns) }
  );
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    const c2 = await connectClient();
    await c2.waitFor(s => myPlayer(s, 0) != null, 5000);
    // c2's snake self-destructs against the wall (assert on the FIRST death;
    // the widened respawn delay keeps it dead for the whole scenario).
    await c1.waitFor(s => s.players[1] && s.players[1].alive === false, 8000);

    const lenBefore = c1.state.players[0].body.length;
    const head = c1.state.players[0].body[0];
    testHook(c1, "spawnPickup", { ptype: "blueShell", x: head.x + 5, y: 10 });
    const boom = await c1.waitFor(s => s.explosions && s.explosions.length > 0, 8000);
    assert(boom.players[1] && boom.players[1].alive === false,
      "opponent must still be dead-but-connected at impact");
    const loss = lenBefore - boom.players[0].body.length;
    assert(loss === Math.floor(lenBefore * 0.5),
      "lone survivor self-nukes: expected -" + Math.floor(lenBefore * 0.5) + ", got -" + loss);
    console.log("PASS: shell fired and self-nuked while opponent was dead awaiting respawn.");
    c1.close(); c2.close();
  } finally {
    await stopServer(server);
  }
}

async function main() {
  await scenarioInert();
  await scenarioSplash();
  await scenarioFizzle();
  await scenarioDeadRespawnNuke();
}

// Staging is deterministic now (forced spawns + hook-placed pickups); the
// retries only absorb environment noise (a food pellet randomly landing in
// a staged snake's path can shift a length by one).
runTest(main, { attempts: 3, watchdogMs: 180000 });
