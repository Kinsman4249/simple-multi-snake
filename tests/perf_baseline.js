// Server performance baseline harness (Phase 7). NOT a pass/fail e2e test:
// it drives the LIVE server (same method as the pw_*.js suite -- real Deno
// WebSocket clients, no mocks) through a matrix of board-size / snake-length
// scenarios with the server's SNAKE_PERF instrumentation enabled, collects
// the "[perf] {json}" summary lines the server prints every 5s, and prints a
// comparison table. Run:
//
//   deno run --allow-net --allow-read --allow-write --allow-run --allow-env \
//     tests/perf_baseline.js
//
// Notes:
// - Long snakes come from a minSnakeLength override so they exist instantly
//   (growing 4 snakes to 120 segments by feeding would take minutes and is
//   nav-fragile). spawnSnake builds the body leftward from x within
//   [3, cols-3], so a large minSnakeLength puts TAIL segments at negative x.
//   That is inert for profiling purposes -- segments are only coordinates,
//   and every collision scan / serialization still iterates all of them,
//   which is exactly the cost being measured -- but keep it in mind if a
//   number looks odd (e.g. wall checks only ever apply to the head).
// - Clients circle fixed waypoint boxes (keepAlive-style steering) with
//   boost held, and a trail powerup is enabled on a fast spawn cadence so
//   trails/pickups appear in the broadcast like a real session.
import { connectClient, myPlayer, sleep, stepToward, startServer, stopServer } from "./helpers.js";

const MEASURE_MS = 30000;
const SCENARIOS = [];
for (const preset of ["1080p", "4k"]) {
  for (const minLen of [3, 60, 120]) {
    SCENARIOS.push({ name: `${preset} minLen=${minLen}`, preset, minLen });
  }
}

// Circles a seat around a rectangle of waypoints forever (until stopped).
function circle(client, local, corners) {
  let target = 0;
  const timer = setInterval(() => {
    const cur = client.state;
    const p = myPlayer(cur, local);
    if (!p) return;
    const [tx, ty] = corners[target];
    const head = p.body[0];
    if (Math.abs(head.x - tx) + Math.abs(head.y - ty) <= 2) target = (target + 1) % corners.length;
    const dn = stepToward(cur, local, tx, ty);
    if (dn) client.send({ type: "dir", dir: dn, local });
  }, 70);
  return () => clearInterval(timer);
}

// Reads the server child's stdout, collecting parsed [perf] lines.
function collectPerfLines(child, sink) {
  (async () => {
    const reader = child.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          const at = line.indexOf("[perf] ");
          if (at !== -1) { try { sink.push(JSON.parse(line.slice(at + 7))); } catch (_) {} }
        }
      }
    } catch (_) { /* child killed at scenario end */ }
  })();
}

function avg(rows, key) { return rows.length ? rows.reduce((a, r) => a + r[key], 0) / rows.length : 0; }
function max(rows, key) { return rows.length ? Math.max(...rows.map(r => r[key])) : 0; }

async function runScenario(sc) {
  const handle = await startServer({
    grid: { preset: sc.preset, cellSize: 20 },
    minSnakeLength: sc.minLen,
    boost: { enabled: true, boostSpeed: 2.0, driftMs: 250 },
    powerups: { spawnIntervalMs: 3000, maxConcurrentPickups: 3 }
  }, { SNAKE_PERF: "1" });
  const perfRows = [];
  collectPerfLines(handle.child, perfRows);

  const clients = [];
  const stops = [];
  try {
    // Grid dims for waypoint boxes (fetch the served config; presets resolve
    // server-side).
    const cfgRes = await fetch("http://127.0.0.1:8080/api/config");
    await cfgRes.body?.cancel();
    for (let n = 0; n < 4; n++) {
      const c = await connectClient();
      await c.waitFor(s => myPlayer(s, 0) != null, 8000);
      clients.push(c);
    }
    const grid = clients[0].state.grid;
    const W = grid.cols, H = grid.rows;
    // Four disjoint quadrant boxes, inset from walls.
    const boxes = [
      [[6, 6], [Math.floor(W / 2) - 6, 6], [Math.floor(W / 2) - 6, Math.floor(H / 2) - 4], [6, Math.floor(H / 2) - 4]],
      [[Math.floor(W / 2) + 6, 6], [W - 7, 6], [W - 7, Math.floor(H / 2) - 4], [Math.floor(W / 2) + 6, Math.floor(H / 2) - 4]],
      [[6, Math.floor(H / 2) + 4], [Math.floor(W / 2) - 6, Math.floor(H / 2) + 4], [Math.floor(W / 2) - 6, H - 7], [6, H - 7]],
      [[Math.floor(W / 2) + 6, Math.floor(H / 2) + 4], [W - 7, Math.floor(H / 2) + 4], [W - 7, H - 7], [Math.floor(W / 2) + 6, H - 7]]
    ];
    clients.forEach((c, n) => {
      stops.push(circle(c, 0, boxes[n]));
      c.send({ type: "boost", on: true, local: 0 });
    });
    // Let the session settle (ramp, powerup spawns), then measure.
    await sleep(3000);
    perfRows.length = 0; // discard warmup windows
    await sleep(MEASURE_MS);
  } finally {
    stops.forEach(f => f());
    clients.forEach(c => c.close());
    await stopServer(handle);
  }
  return {
    name: sc.name,
    windows: perfRows.length,
    mvAvgUs: avg(perfRows, "mvAvgUs"), mvMaxUs: max(perfRows, "mvMaxUs"),
    bcAvgUs: avg(perfRows, "bcAvgUs"), bcMaxUs: max(perfRows, "bcMaxUs"),
    baseBytesAvg: avg(perfRows, "baseBytesAvg"), sendBytesAvg: avg(perfRows, "sendBytesAvg"),
    bcPerSec: avg(perfRows, "bcCalls") / 5,
    rssMb: max(perfRows, "rssMb"),
    totalSegs: max(perfRows, "totalSegs"), alive: max(perfRows, "alive")
  };
}

const results = [];
for (const sc of SCENARIOS) {
  console.log(`--- scenario: ${sc.name} (${MEASURE_MS / 1000}s) ---`);
  try {
    const r = await runScenario(sc);
    results.push(r);
    console.log(JSON.stringify(r));
  } catch (err) {
    console.error(`scenario ${sc.name} failed: ${err.message}`);
    results.push({ name: sc.name, error: err.message });
  }
  await sleep(500);
}

console.log("\n=== BASELINE SUMMARY ===");
const cols = ["name", "alive", "totalSegs", "mvAvgUs", "mvMaxUs", "bcAvgUs", "bcMaxUs", "baseBytesAvg", "sendBytesAvg", "bcPerSec", "rssMb"];
console.log(cols.join("\t"));
for (const r of results) {
  console.log(cols.map(k => typeof r[k] === "number" ? Math.round(r[k] * 10) / 10 : (r[k] ?? "-")).join("\t"));
}
Deno.exit(0);
