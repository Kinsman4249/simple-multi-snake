// Solo-play pickup spawn contract (regression guard, 2026-07-20): powerup
// pickups MUST keep spawning with a single player seated -- with the sole
// exception of the blue shell, which needs someone to fire it at and is
// presence-gated to >= 2 player seats (server sim.rs
// maybe_spawn_powerup_pickup). Three scenarios:
//   1. Solo, all default types enabled: pickups appear, none is blueShell.
//   2. Solo, ONLY blueShell enabled: nothing ever spawns (the gate holds
//      even when the shell is the only candidate).
//   3. Two players, ONLY blueShell enabled, unequal lengths: a blueShell
//      pickup appears (the gate lifts; the equal-length gate is dodged by
//      forcing different spawn lengths).
// Run: deno run --allow-net --allow-read --allow-write --allow-run
//      --allow-env tests/pw_solospawn.js
import { connectClient, myPlayer, assert, sleep, startServer, stopServer, runTest } from "./helpers.js";

// Fast spawn cadence; big board so rejection sampling never runs dry.
function cfg(powerupOverrides) {
  return {
    maxPlayers: 4,
    grid: { cols: 60, rows: 30, cellSize: 20 },
    move: { startIntervalMs: 150, minIntervalMs: 150 },
    enableDebug: false,
    walls: { enabled: false },
    powerups: Object.assign({ spawnIntervalMs: 200, maxConcurrentPickups: 4 }, powerupOverrides || {})
  };
}

// Watch broadcasts for `ms`, returning every distinct pickup (type@x,y) seen.
async function watchPickups(client, ms) {
  const seen = new Map(); // key -> type
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const list = (client.state && client.state.powerupPickups) || [];
    for (const p of list) seen.set(p.type + "@" + p.x + "," + p.y, p.type);
    await sleep(50);
  }
  return [...seen.values()];
}

async function soloSpawnsEverythingButShell() {
  const server = await startServer(cfg());
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    // First spawn lands one interval (200ms) after the seat fills; give it
    // ample room, then keep watching so several spawn/collect cycles can
    // pass (solo pickup cap is 1, so new spawns need collections -- the
    // auto-moving snake will stumble into some on a busy interval).
    await c1.waitFor(s => (s.powerupPickups || []).length > 0, 10000);
    const types = await watchPickups(c1, 4000);
    assert(types.length >= 1, "solo play must keep spawning powerup pickups");
    assert(!types.includes("blueShell"),
      "blueShell must NEVER spawn with one player seated (saw: " + types.join(",") + ")");
    console.log("PASS: solo pickups spawn (" + types.join(",") + "), no blueShell.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

async function soloShellOnlyStaysEmpty() {
  const server = await startServer(cfg({
    wormhole: { enabled: false }, growthSpurt: { enabled: false },
    iceTrail: { enabled: false }, poisonTrail: { enabled: false },
    speedBoost: { enabled: false }, bananaTrail: { enabled: false },
    scissors: { enabled: false },
    blueShell: { enabled: true }
  }));
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    await sleep(2500); // a dozen 200ms spawn intervals
    const list = (c1.state && c1.state.powerupPickups) || [];
    assert(list.length === 0,
      "with only blueShell enabled and one player, NOTHING may spawn (saw " + JSON.stringify(list) + ")");
    console.log("PASS: solo + blueShell-only spawns nothing (presence gate holds).");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

async function duoShellSpawns() {
  const server = await startServer(cfg({
    wormhole: { enabled: false }, growthSpurt: { enabled: false },
    iceTrail: { enabled: false }, poisonTrail: { enabled: false },
    speedBoost: { enabled: false }, bananaTrail: { enabled: false },
    scissors: { enabled: false },
    blueShell: { enabled: true }
  }), {
    // Unequal forced lengths so the equal-length shell gate doesn't hide
    // the presence gate under test.
    SNAKE_TEST_SPAWNS: JSON.stringify([
      { x: 10, y: 10, dir: "right", len: 3 },
      { x: 10, y: 20, dir: "right", len: 10 }
    ])
  });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    const c2 = await connectClient();
    await c2.waitFor(s => myPlayer(s, 0) != null, 5000);
    const got = await c1.waitFor(s => (s.powerupPickups || []).length > 0, 10000);
    const types = got.powerupPickups.map(p => p.type);
    assert(types.includes("blueShell"),
      "with two players seated the blueShell must spawn again (saw: " + types.join(",") + ")");
    console.log("PASS: blueShell spawns once a second player is seated.");
    c1.close();
    c2.close();
  } finally {
    await stopServer(server);
  }
}

async function main() {
  await soloSpawnsEverythingButShell();
  await soloShellOnlyStaysEmpty();
  await duoShellSpawns();
}

runTest(main);
