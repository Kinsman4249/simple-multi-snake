// Split leaderboards e2e test (Phase 12): "local" (one computer) vs
// "networked" (2+ computers) boards, mode sampled at death time, plus the
// flat-v1 highscores.json migration. Each scenario runs its own server with
// its own temp highscores file (helpers.js startServer default).
// Run: deno run --allow-net --allow-read --allow-write --allow-run
//      --allow-env tests/pw_leaderboards.js
import { connectClient, myPlayer, assert, startServer, stopServer, runTest, stepToward } from "./helpers.js";

function baseConfig(spawns) {
  return {
    maxPlayers: 4,
    grid: { cols: 40, rows: 30, cellSize: 20 },
    move: { startIntervalMs: 100, minIntervalMs: 100, rampIntervalSec: 3600, rampStepMs: 0 },
    enableDebug: false,
    powerups: { spawnIntervalMs: 3600000, maxConcurrentPickups: 8 }
  };
}

// One food eat via the proven greedy-steer pattern (score must be > 0 to
// qualify), then a deliberate wall death, then wait for the score to land.
async function eatOnce(client, local) {
  const before = myPlayer(client.state, local).body.length;
  const timer = setInterval(() => {
    const cur = client.state;
    const p = myPlayer(cur, local);
    if (!p || !cur.food) return;
    const dn = stepToward(cur, local, cur.food.x, cur.food.y);
    if (dn) client.send({ type: "dir", dir: dn, local });
  }, 70);
  try {
    await client.waitFor(s => { const p = myPlayer(s, local); return p && p.body.length !== before; }, 20000);
  } finally {
    clearInterval(timer);
  }
}
async function dieOnWall(client, local) {
  // Steer up and coast into the top wall (no further input = no saving turn).
  client.send({ type: "dir", dir: "up", local });
  await client.waitFor(s => { const p = myPlayer(s, local); return p && p.alive === false; }, 15000);
}

async function scenarioLocal() {
  const server = await startServer(baseConfig(), {
    SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 20, y: 15, dir: "right" }])
  });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    assert(c1.state.mode === "local", "one connection must classify as local (got " + c1.state.mode + ")");
    await eatOnce(c1, 0);
    assert(myPlayer(c1.state, 0).score > 0, "score must be positive before dying");
    await dieOnWall(c1, 0); // harness pre-bound initials "BOT"; score records instantly at death
    const st = await c1.waitFor(s => s.highScores.local.daily.length > 0, 10000);
    assert(st.highScores.local.daily[0].initials === "BOT", "local daily should hold the BOT score");
    assert(st.highScores.local.allTime.length > 0, "local allTime should hold the score too");
    assert(st.highScores.networked.daily.length === 0 && st.highScores.networked.allTime.length === 0,
      "networked boards must stay empty for a one-computer run");
    console.log("PASS: solo run lands on the LOCAL boards only.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

async function scenarioNetworked() {
  const server = await startServer(baseConfig(), {
    SNAKE_TEST_SPAWNS: JSON.stringify([
      { x: 10, y: 8, dir: "right" },
      { x: 10, y: 22, dir: "right" }
    ])
  });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    const c2 = await connectClient();
    await c2.waitFor(s => myPlayer(s, 0) != null, 5000);
    assert(c1.state.mode === "networked", "two connections must classify as networked (got " + c1.state.mode + ")");
    await eatOnce(c1, 0);
    await dieOnWall(c1, 0);
    const st = await c1.waitFor(s => s.highScores.networked.daily.length > 0, 10000);
    assert(st.highScores.networked.daily[0].initials === "BOT", "networked daily should hold the BOT score");
    assert(st.highScores.local.daily.length === 0 && st.highScores.local.allTime.length === 0,
      "local boards must stay empty for a two-computer run");
    console.log("PASS: two-computer run lands on the NETWORKED boards only.");
    c1.close(); c2.close();
  } finally {
    await stopServer(server);
  }
}

async function scenarioMigration() {
  // Pre-seed a FLAT v1 store; the server must boot it as the local board
  // and leave networked fresh.
  const repoRoot = new URL("..", import.meta.url).pathname;
  const name = ".test-highscores-" + crypto.randomUUID().slice(0, 8) + ".json";
  const today = new Date().toISOString().slice(0, 10);
  await Deno.writeTextFile(repoRoot + name, JSON.stringify({
    date: today,
    daily: [{ initials: "OLD", score: 42 }],
    allTime: [{ initials: "OLD", score: 77 }]
  }));
  const cfg = baseConfig();
  cfg.highscoresFile = name;
  const server = await startServer(cfg, {
    SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 20, y: 15, dir: "right" }])
  });
  try {
    const c1 = await connectClient();
    const st = await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    assert(st.highScores.local.daily[0] && st.highScores.local.daily[0].initials === "OLD" &&
           st.highScores.local.daily[0].score === 42, "v1 daily entries must migrate to the local board");
    assert(st.highScores.local.allTime[0] && st.highScores.local.allTime[0].score === 77,
      "v1 allTime entries must migrate to the local board");
    assert(st.highScores.networked.daily.length === 0, "networked board starts fresh after migration");
    console.log("PASS: flat v1 highscores migrate into the local board.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

// Session-bound initials (v3.4.0): setInitials overwrites the bound value
// any time before the death (the Change Initials button path); the score
// then records instantly at death with the LATEST value -- no prompt.
async function scenarioChangeInitials() {
  const server = await startServer(baseConfig(), {
    SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 20, y: 15, dir: "right" }])
  });
  try {
    const c1 = await connectClient(); // helpers bind "BOT" at connect
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    c1.send({ type: "setInitials", local: 0, value: "zz9" }); // lowercase: server sanitizes
    await eatOnce(c1, 0);
    await dieOnWall(c1, 0);
    const st = await c1.waitFor(s => s.highScores.local.daily.length > 0, 10000);
    assert(st.highScores.local.daily[0].initials === "ZZ9",
      "score must record with the OVERWRITTEN session initials (got " + st.highScores.local.daily[0].initials + ")");
    console.log("PASS: setInitials overwrites the session-bound initials before death.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

async function main() {
  await scenarioLocal();
  await scenarioNetworked();
  await scenarioMigration();
  await scenarioChangeInitials();
}

runTest(main, { attempts: 3, watchdogMs: 220000 });
