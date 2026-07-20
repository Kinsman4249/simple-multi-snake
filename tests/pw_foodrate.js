// Speed-run / food-rate score mode (v3.7.0) e2e test: provisional-before-
// floor, locking + leaderboard recording once the play-time floor is
// cleared, death-independence (the accumulator survives a death/respawn),
// and the spectator pause (a seat bumped to spectator stops accruing play
// time until it resumes). Each scenario runs its own server with fast
// foodRate knobs (bucketMs/floorMs/windowMs) so nothing waits out the real
// 5-minute production defaults.
// Run: deno run --allow-net --allow-read --allow-write --allow-run
//      --allow-env tests/pw_foodrate.js
import { connectClient, myPlayer, mySlot, assert, startServer, stopServer, runTest, stepToward, sleep } from "./helpers.js";

function baseConfig(overrides) {
  return Object.assign({
    maxPlayers: 4,
    grid: { cols: 40, rows: 30, cellSize: 20 },
    move: { startIntervalMs: 60, minIntervalMs: 60, speedEaseMs: 0 },
    enableDebug: false,
    powerups: { spawnIntervalMs: 3600000, maxConcurrentPickups: 8 },
    spectatorPromoteDelayMs: 50
  }, overrides || {});
}
function foodRateOf(state, local) {
  const you = state.you.locals[local == null ? 0 : local];
  return you ? you.foodRate : undefined;
}
async function steerTowardFoodFor(client, local, ms) {
  const timer = setInterval(() => {
    const cur = client.state;
    const p = myPlayer(cur, local);
    if (!p || !cur.food) return;
    const dn = stepToward(cur, local, cur.food.x, cur.food.y);
    if (dn) client.send({ type: "dir", dir: dn, local });
  }, 40);
  try { await sleep(ms); } finally { clearInterval(timer); }
}
async function dieOnWall(client, local) {
  client.send({ type: "dir", dir: "up", local });
  await client.waitFor(s => { const p = myPlayer(s, local); return p && p.alive === false; }, 15000);
}

// Provisional before the floor, locked (and leaderboard-recorded) after it.
async function scenarioProvisionalThenLocked() {
  const server = await startServer(baseConfig({
    foodRate: { enabled: true, bucketMs: 25, floorMs: 300, windowMs: 300 }
  }), {
    SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 20, y: 15, dir: "right" }])
  });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    // Early on (well before the 300ms floor), the seat already has an
    // accumulator, but it must not be locked yet.
    const early = foodRateOf(c1.state, 0);
    assert(early, "an accumulator must exist as soon as the seat is a player");
    assert(early.locked === false, "must be provisional-only before the floor");
    // Eat food and keep playing past the floor. Wait for BOTH conditions
    // together -- locked can flip true before this run's food happens to
    // land in the (still-filling) top-K window, so checking them separately
    // can catch the split second where it's locked at rate 0.
    const steering = steerTowardFoodFor(c1, 0, 4000);
    const locked = await c1.waitFor(s => {
      const fr = foodRateOf(s, 0);
      return fr && fr.locked === true && fr.ratePerMin > 0;
    }, 6000);
    await steering;
    const fr = foodRateOf(locked, 0);
    assert(fr.ratePerMin > 0, "a locked rate after eating food must be positive (got " + fr.ratePerMin + ")");
    // Die: the length score AND the (now-locked) food-rate score both
    // qualify and record instantly, same trigger point.
    await dieOnWall(c1, 0);
    const st = await c1.waitFor(s => s.highScores.local.foodRateDaily.length > 0, 10000);
    assert(st.highScores.local.foodRateDaily[0].initials === "BOT",
      "food-rate daily board should hold the BOT run");
    assert(st.highScores.local.foodRateAllTime.length > 0, "food-rate allTime board should hold the run too");
    console.log("PASS: provisional before the floor, locked + leaderboard-recorded after it.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

// Death does NOT reset the accumulator. Provisional (pre-lock) rate is a
// running average that can legitimately drift either way as more of the
// window samples in, so that is not a reliable reset signal by itself.
// Instead: get the seat LOCKED first (floorMs small enough to reach within
// normal play), at which point the metric is the top-K-buckets-ever-seen and
// is monotonic non-decreasing by construction (a worse bucket never evicts a
// better one already kept) -- so a reset would show up unambiguously as
// `locked` flipping back to false and/or the rate dropping right after
// respawn, neither of which a genuine "still accumulating" seat can do.
async function scenarioDeathIndependence() {
  const server = await startServer(baseConfig({
    foodRate: { enabled: true, bucketMs: 25, floorMs: 150, windowMs: 150 }
  }), {
    SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 20, y: 15, dir: "right" }])
  });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    const eating = steerTowardFoodFor(c1, 0, 5000);
    const locked = await c1.waitFor(s => {
      const fr = foodRateOf(s, 0);
      return fr && fr.locked === true && fr.ratePerMin > 0;
    }, 6000);
    const beforeDeath = foodRateOf(locked, 0);
    await dieOnWall(c1, 0);
    // Respawn happens automatically (no one is queued).
    const respawned = await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.alive === true; }, 10000);
    await eating;
    const afterRespawn = foodRateOf(respawned, 0);
    assert(afterRespawn, "accumulator must survive the respawn (same connection/seat)");
    assert(afterRespawn.locked === true, "must still be locked right after respawn -- a reset would un-lock it");
    assert(afterRespawn.ratePerMin >= beforeDeath.ratePerMin,
      "a locked rate is monotonic non-decreasing -- a drop right after respawn means the accumulator was reset " +
      "(before=" + beforeDeath.ratePerMin + " immediately-after-respawn=" + afterRespawn.ratePerMin + ")");
    console.log("PASS: the food-rate accumulator survives a death/respawn on the same connection.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

// Spectator pause: a seat bumped to spectator (a second connection was
// queued when it died) must stop accruing play time -- the rate/lock state
// freezes for as long as it sits in the queue, even well past the floor's
// wall-clock equivalent.
async function scenarioSpectatorPause() {
  const server = await startServer(baseConfig({
    maxPlayers: 1,
    // Spawn 2 cells from the top wall so dieOnWall (steer up, coast in) is
    // fast -- the floor below is sized with generous headroom over the total
    // real time this scenario takes to reach death (steer window + a real
    // second WS connection/handshake for c2, which keeps c1 playing the
    // whole time + the short walk into the wall).
    foodRate: { enabled: true, bucketMs: 25, floorMs: 4000, windowMs: 4000 }
  }), {
    SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 20, y: 2, dir: "right" }])
  });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    // Play briefly -- short of the floor -- then let a second connection
    // queue up as a spectator (the only slot is taken).
    await steerTowardFoodFor(c1, 0, 80);
    const c2 = await connectClient();
    await c2.waitFor(s => { const you = s.you.locals[0]; return you && you.role === "spectator"; }, 5000);
    // Kill c1: with someone queued, respawnOrSpectate demotes it to
    // spectator instead of respawning it.
    await dieOnWall(c1, 0);
    await c1.waitFor(s => { const you = s.you.locals[0]; return you && you.role === "spectator"; }, 5000);
    const paused = foodRateOf(c1.state, 0);
    assert(paused, "the accumulator must survive the demotion to spectator");
    assert(paused.locked === false, "must not have reached the floor yet at the moment of demotion");
    // Sit in the queue for well past the floor's wall-clock equivalent (the
    // slot is occupied by c2 the whole time). If the timer did NOT pause,
    // this would lock by now.
    await sleep(4500);
    const stillPaused = foodRateOf(c1.state, 0);
    assert(stillPaused.locked === false,
      "spectating must PAUSE the timer -- it locked despite not being on the board");
    assert(stillPaused.ratePerMin === paused.ratePerMin,
      "the rate must stay frozen while spectating (was " + paused.ratePerMin + ", now " + stillPaused.ratePerMin + ")");
    console.log("PASS: spectating pauses the food-rate timer (frozen rate, no false lock).");
    c1.close(); c2.close();
  } finally {
    await stopServer(server);
  }
}

async function main() {
  await scenarioProvisionalThenLocked();
  await scenarioDeathIndependence();
  await scenarioSpectatorPause();
}

runTest(main, { attempts: 3, watchdogMs: 120000 });
