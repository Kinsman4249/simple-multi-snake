// Boost ramp/grace e2e test (Phase 7 boost redesign):
//   1. HOLD GRACE: a boost hold shorter than boost.holdGraceMs never engages
//      -- no speed change (moveMs stays at the shared interval), no boost
//      flag in the broadcast, and a turn made inside the grace starts NO
//      drift (short taps don't interfere with queued commands).
//   2. RAMP: once engaged, the speed multiplier climbs to boostSpeed over
//      boost.rampMs -- mid-ramp the broadcast moveMs sits strictly between
//      the unboosted interval and the full-boost value, and reaches full
//      after the ramp completes.
//   3. DRIFT SCALING: the skid window is boost.driftMs * rampProgress at the
//      moment the turn was pressed -- a turn right after engagement produces
//      a much shorter `sliding` window than a turn at full ramp.
// Run: deno run --allow-net --allow-read --allow-write --allow-run
// --allow-env tests/pw_boostramp.js
//
// In plain terms: this checks the fine details of how boosting ramps up.
// A very short tap of boost should do nothing at all (a "hold grace"
// period). Once boost is actually held long enough, speed should climb
// smoothly up to full boost speed over a set ramp time, rather than
// snapping instantly. And the sideways "drift" from turning while boosted
// should be shorter if you turn early in the ramp than if you turn once
// fully ramped up.
import { connectClient, myPlayer, assert, sleep, stepToward, startServer, stopServer, runTest } from "./helpers.js";

const COLS = 96, ROWS = 54;
const INTERVAL = 160;
const BOOST = { enabled: true, boostSpeed: 2, driftMs: 900, rampMs: 900, holdGraceMs: 300 };

async function steerTo(client, tx, ty, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 25000);
  while (Date.now() < deadline) {
    const cur = client.state;
    const p = myPlayer(cur, 0);
    if (!p) throw new Error("seat not playing");
    const head = p.body[0];
    if (Math.abs(head.x - tx) <= 1 && Math.abs(head.y - ty) <= 1) return;
    const dirName = stepToward(cur, 0, tx, ty);
    if (dirName) client.send({ type: "dir", dir: dirName, local: 0 });
    // s => s !== cur is an arrow function (see docs/JS-CHEATSHEET.md);
    // .catch(() => {}) swallows the timeout error if we never see a new state
    await client.waitFor(s => s !== cur, 2000).catch(() => {});
  }
  throw new Error("timed out steering to staging point");
}
async function ensureHeadingRight(client) {
  let p = myPlayer(client.state, 0);
  if (p.dir.x === 1) return;
  if (p.dir.x === -1) {
    const perp = p.body[0].y > ROWS / 2 ? "up" : "down";
    client.send({ type: "dir", dir: perp, local: 0 });
    await client.waitFor(s => myPlayer(s, 0).dir.x === 0, 3000);
  }
  client.send({ type: "dir", dir: "right", local: 0 });
  await client.waitFor(s => myPlayer(s, 0).dir.x === 1, 3000);
}
// Measures how long `sliding` stays true after a turn, by watching
// broadcasts. Returns 0 if sliding never shows (a sub-broadcast-window
// drift, or none at all).
async function measureSlide(client, timeoutMs) {
  let start = null;
  try {
    // timeoutMs || 1200: use timeoutMs if it was passed in, else default to
    // 1200 -- see "Nullish coalescing / defaults" in docs/JS-CHEATSHEET.md
    await client.waitFor(s => { const p = myPlayer(s, 0); return p && p.sliding === true; }, timeoutMs || 1200);
    start = Date.now();
  } catch (_) { return 0; }
  await client.waitFor(s => { const p = myPlayer(s, 0); return p && p.sliding === false; }, 5000);
  return Date.now() - start;
}
function boostOff(client) { client.send({ type: "boost", on: false, local: 0 }); }

async function main() {
  const server = await startServer({
    grid: { cols: COLS, rows: ROWS, cellSize: 20 },
    move: { startIntervalMs: INTERVAL, minIntervalMs: INTERVAL, rampIntervalSec: 3600, rampStepMs: 0 },
    boost: BOOST,
    powerups: { spawnIntervalMs: 600000 }
  });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);

    // ---- Part 1: hold grace ----
    await steerTo(c1, 14, Math.floor(ROWS / 2), 25000);
    await ensureHeadingRight(c1);
    c1.send({ type: "boost", on: true, local: 0 });
    await sleep(60); // well inside holdGraceMs (300)
    c1.send({ type: "dir", dir: "down", local: 0 });
    await sleep(60);
    boostOff(c1); // the tap: ~120ms total, under the grace
    let sawEngagedOrSliding = false;
    const graceWatchUntil = Date.now() + 900;
    while (Date.now() < graceWatchUntil) {
      const p = myPlayer(c1.state, 0);
      if (p && (p.boost === true || p.sliding === true)) { sawEngagedOrSliding = true; break; }
      if (p && p.moveMs < INTERVAL - 5) { sawEngagedOrSliding = true; break; }
      await sleep(30);
    }
    assert(!sawEngagedOrSliding, "a tap shorter than holdGraceMs must not engage boost, speed up, or start a drift");
    const pAfterTap = myPlayer(c1.state, 0);
    assert(pAfterTap.dir.y === 1, "the turn made during the tap must still apply as a plain turn");
    console.log("PASS: sub-grace boost tap changed nothing but the direction.");

    // ---- Part 2: ramp to full speed ----
    await steerTo(c1, Math.floor(COLS / 2), 10, 30000);
    await ensureHeadingRight(c1);
    c1.send({ type: "boost", on: true, local: 0 });
    // Sample mid-ramp: grace(300) + ~half the 900ms ramp.
    await sleep(300 + 450);
    const mid = myPlayer(c1.state, 0);
    assert(mid.boost === true, "boost must be engaged after the grace");
    assert(mid.moveMs < INTERVAL - 10 && mid.moveMs > Math.round(INTERVAL / BOOST.boostSpeed) + 10,
      "mid-ramp moveMs must sit strictly between unboosted and full boost (got " + mid.moveMs + ")");
    await sleep(600); // past the end of the ramp
    const full = myPlayer(c1.state, 0);
    const fullMoveMs = Math.round(INTERVAL / BOOST.boostSpeed);
    assert(Math.abs(full.moveMs - fullMoveMs) <= 3,
      "post-ramp moveMs must be the full-boost value (" + fullMoveMs + "), got " + full.moveMs);
    console.log("PASS: boost ramps through intermediate speed to full (" + mid.moveMs + " -> " + full.moveMs + "ms/cell).");

    // ---- Part 3: drift scales with ramp progress ----
    // (boost still held and fully ramped from Part 2; snake heading right)
    c1.send({ type: "dir", dir: "down", local: 0 });
    const fullSlideMs = await measureSlide(c1);
    boostOff(c1);
    await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.sliding === false; }, 5000);
    await sleep(300);
    // Early turn: re-engage and turn just after the grace ends (~10% ramp).
    await steerTo(c1, Math.floor(COLS / 2), Math.floor(ROWS / 2), 30000);
    await ensureHeadingRight(c1);
    c1.send({ type: "boost", on: true, local: 0 });
    await sleep(BOOST.holdGraceMs + 90);
    c1.send({ type: "dir", dir: "down", local: 0 });
    const earlySlideMs = await measureSlide(c1);
    boostOff(c1);
    assert(fullSlideMs >= 500, "full-ramp drift should last close to driftMs=900 (measured " + fullSlideMs + "ms)");
    assert(earlySlideMs < fullSlideMs - 300,
      "an early-ramp turn must skid much shorter than a full-ramp turn (early " + earlySlideMs + "ms vs full " + fullSlideMs + "ms)");
    console.log("PASS: drift scales with ramp progress (early " + earlySlideMs + "ms vs full " + fullSlideMs + "ms).");
  } finally {
    await stopServer(server);
  }
}

runTest(main);
