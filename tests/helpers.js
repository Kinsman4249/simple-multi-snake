// Shared test harness for the powerup e2e scripts (tests/pw_*.js). Deno
// WebSocket clients driving the LIVE, unmodified server -- no mocks, per
// this project's proven test method (see round ten/eleven's boost/slide and
// high-score-flush scripts). Run `node server.js` (or the deno-compatible
// equivalent) before running any of these.
const BASE = "http://127.0.0.1:8080";
const WS_BASE = "ws://127.0.0.1:8080/ws";

async function getToken() {
  const cap = await (await fetch(BASE + "/api/captcha")).json();
  const answer = cap.a + cap.b;
  const res = await fetch(BASE + "/api/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: cap.id, answer })
  });
  if (!res.ok) throw new Error("captcha verify failed");
  const { token } = await res.json();
  return token;
}

// Connects one client. Tracks the latest `state` broadcast (`client.state`)
// and resolves state-condition waits via waitFor().
function connectClient() {
  return getToken().then(token => new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_BASE + "?token=" + token);
    const client = {
      ws, state: null, waiters: [],
      send(msg) { ws.send(JSON.stringify(msg)); },
      // Resolves the next time `pred(client.state)` is true (checked against
      // the CURRENT state immediately, then on every subsequent message).
      waitFor(pred, timeoutMs) {
        return new Promise((res, rej) => {
          if (client.state && pred(client.state)) return res(client.state);
          const timer = setTimeout(() => {
            client.waiters = client.waiters.filter(w => w !== entry);
            rej(new Error("waitFor timed out after " + (timeoutMs || 5000) + "ms"));
          }, timeoutMs || 5000);
          const entry = { pred, res: (s) => { clearTimeout(timer); res(s); } };
          client.waiters.push(entry);
        });
      },
      close() { try { ws.close(); } catch (_) {} }
    };
    ws.onopen = () => resolve(client);
    ws.onerror = e => reject(e);
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") {
        client.state = msg;
        client.waiters = client.waiters.filter(w => {
          if (w.pred(msg)) { w.res(msg); return false; }
          return true;
        });
      }
      // Auto-resolve high-score initials prompts immediately: a real
      // highscores.json may have fewer than 5 entries, which makes even a
      // tiny test score "qualify" and would otherwise block respawn behind
      // a prompt this test harness never answers.
      if (msg.type === "askInitials") {
        client.send({ type: "initials", value: "BOT", score: msg.score, targets: msg.targets, local: msg.local });
      }
    };
  }));
}

function mySlot(state, local) {
  const you = state.you.locals[local == null ? 0 : local];
  return you && you.role === "player" ? you.slot : null;
}
function myPlayer(state, local) {
  const slot = mySlot(state, local);
  return slot == null ? null : state.players[slot];
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Steers a client's local seat one cell toward (tx,ty) each call, picking
// whichever of the two axis-aligned directions reduces distance and isn't a
// direct reversal of the snake's current heading. Prefers a candidate that
// does not land on the snake's OWN body (skipping the tail, which vacates
// this step, matching hitsBody's server-side rule) so a test steering a
// growing snake around an empty board doesn't accidentally self-collide;
// falls back to continuing straight if every distance-reducing option is
// blocked.
function stepToward(state, local, tx, ty) {
  const p = myPlayer(state, local);
  if (!p) return null;
  const head = p.body[0];
  const dx = tx - head.x, dy = ty - head.y;
  const dir = p.dir;
  const candidates = [];
  if (dx > 0) candidates.push({ name: "right", x: 1, y: 0 });
  if (dx < 0) candidates.push({ name: "left", x: -1, y: 0 });
  if (dy > 0) candidates.push({ name: "down", x: 0, y: 1 });
  if (dy < 0) candidates.push({ name: "up", x: 0, y: -1 });
  candidates.push({ name: dirName(dir), x: dir.x, y: dir.y }); // fallback: keep going straight
  const bodyNoTail = p.body.slice(0, -1);
  const grid = state.grid;
  const inBounds = c => {
    const nx = head.x + c.x, ny = head.y + c.y;
    return !grid || (nx >= 0 && nx < grid.cols && ny >= 0 && ny < grid.rows);
  };
  const safe = c => inBounds(c) && !bodyNoTail.some(seg => seg.x === head.x + c.x && seg.y === head.y + c.y);
  const notReversal = c => !(c.x === -dir.x && c.y === -dir.y);
  const choice = candidates.find(c => notReversal(c) && safe(c)) ||
                 candidates.find(c => notReversal(c) && inBounds(c)) ||
                 candidates.find(c => notReversal(c));
  return choice ? choice.name : null;
}
function dirName(v) {
  if (v.x === 1) return "right"; if (v.x === -1) return "left";
  if (v.y === 1) return "down"; if (v.y === -1) return "up";
  return "right";
}

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
}

// Spawns the server against a TEMPORARY config file (merged over the repo's
// real config.json via configOverrides) so a test can get, e.g., a fast
// powerup spawn cadence and multiple concurrent pickups without touching
// the real config.json or waiting out production timings. Tries `node`
// first (the project's documented run command); falls back to the
// deno-compatible invocation this repo's dev environment actually has.
async function startServer(configOverrides, extraEnv) {
  const repoRoot = new URL("..", import.meta.url).pathname;
  const base = JSON.parse(await Deno.readTextFile(repoRoot + "config.json"));
  const merged = Object.assign({}, base, configOverrides);
  if (configOverrides && configOverrides.powerups) {
    merged.powerups = Object.assign({}, base.powerups, configOverrides.powerups);
  }
  // SNAKE_CONFIG is resolved by server.js relative to __dirname (the repo
  // root), so the temp config must live there. Give it a recognizable,
  // gitignored prefix (.test-config-*.json) so that if a test is killed
  // before stopServer() cleans up, the leaked file is obviously a test
  // artifact and can never be accidentally committed.
  const name = ".test-config-" + crypto.randomUUID().slice(0, 8) + ".json";
  const destPath = repoRoot + name;
  // Point every test server at its OWN temp highscores file (same
  // recognizable gitignored .test-* prefix) unless the test explicitly set
  // one -- tests used to auto-submit BOT scores into the repo's REAL
  // highscores.json. Removed by stopServer alongside the temp config.
  if (!merged.highscoresFile) {
    merged.highscoresFile = ".test-highscores-" + crypto.randomUUID().slice(0, 8) + ".json";
  }
  await Deno.writeTextFile(destPath, JSON.stringify(merged));
  const env = Object.assign({}, Deno.env.toObject(), { SNAKE_CONFIG: name }, extraEnv || {});

  let child;
  try {
    child = new Deno.Command("node", {
      args: ["server.js"], cwd: repoRoot, env,
      stdout: "piped", stderr: "piped"
    }).spawn();
    await sleep(300);
    if ((await Promise.race([child.status, sleep(50).then(() => null)])) != null) throw new Error("node exited immediately");
  } catch (_) {
    child = new Deno.Command("deno", {
      args: ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-run", "--allow-env", "--unstable-detect-cjs", "server.js"],
      cwd: repoRoot, env, stdout: "piped", stderr: "piped"
    }).spawn();
  }
  // Poll /api/config until the server is actually accepting connections.
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + "/api/config"); return { child, configPath: destPath, highscoresPath: repoRoot + merged.highscoresFile }; }
    catch (_) { await sleep(100); }
  }
  throw new Error("server did not become ready");
}
async function stopServer(handle) {
  if (!handle) return;
  try { handle.child.kill(); } catch (_) {}
  try { await Deno.remove(handle.configPath); } catch (_) {}
  if (handle.highscoresPath) { try { await Deno.remove(handle.highscoresPath); } catch (_) {} }
}

// Sugar for the server's test-only "testHook" message (requires the server
// to have been started with startServer(cfg, { SNAKE_TEST_HOOKS: "1" });
// silently ignored otherwise). Ops:
//   testHook(c, "spawnPickup", { ptype, x, y })          -- place a pickup
//   testHook(c, "grantPowerup", { slot, ptype, held? })  -- arm/fire/hold
//   testHook(c, "placeFood")                             -- re-roll food
function testHook(client, op, args) {
  client.send(Object.assign({ type: "testHook", op }, args || {}));
}

// Waits for a powerup pickup to appear on the board and steers the given
// client's seat onto it. Each test starts its own server with ONLY the
// powerup type under test enabled (see startServer configOverrides), so
// whatever spawns is guaranteed to be the type being tested -- no need to
// filter by type here.
async function collectNextPickup(client, local, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  const state = await client.waitFor(s => s.powerupPickups && s.powerupPickups.length > 0, deadline - Date.now());
  const pk = state.powerupPickups[0];
  while (Date.now() < deadline) {
    const cur = client.state;
    const p = myPlayer(cur, local);
    if (!p) throw new Error("seat not playing");
    if (p.body[0].x === pk.x && p.body[0].y === pk.y) return;
    const dirName = stepToward(cur, local, pk.x, pk.y);
    if (dirName) client.send({ type: "dir", dir: dirName, local });
    await client.waitFor(s => s !== cur, 2000).catch(() => {});
  }
  throw new Error("timed out steering onto pickup");
}

// Runs an async test body against a FRESH server each attempt, retrying on
// failure up to `attempts` times, with a hard overall watchdog. This is the
// standard entry point for every pw_*.js test.
//
// Why retries at all: these are true end-to-end tests -- real WebSocket
// clients steering real snakes on a live server, no mocks (the method that
// has caught actual interaction bugs in this project). The cost is that
// STEERING is nondeterministic: a greedy "head toward the pickup/food"
// heuristic occasionally walks a snake into a wall or itself before it
// reaches its goal, and the seat respawns at the floor. That is a flaw in
// the TEST's navigation, never in the feature under test -- every failure
// observed while building these was a nav mishap, never a wrong game
// outcome once the scenario actually played out. A bounded retry absorbs
// that harness-level noise; each attempt still has to pass every assertion
// on its own merits against a clean server, so a real regression fails all
// attempts and still surfaces.
function runTest(mainFn, opts) {
  const attempts = (opts && opts.attempts) || 4;
  const watchdogMs = (opts && opts.watchdogMs) || 240000;
  const watchdog = setTimeout(() => { console.error("FAIL: watchdog timeout (test hung)"); Deno.exit(1); }, watchdogMs);
  (async () => {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try { await mainFn(); clearTimeout(watchdog); console.log("ALL PASS"); Deno.exit(0); }
      catch (err) { lastErr = err; console.error("Attempt " + i + "/" + attempts + " failed (" + err.message + "), retrying..."); }
    }
    clearTimeout(watchdog);
    console.error("FAIL:", lastErr);
    Deno.exit(1);
  })();
}

export { connectClient, mySlot, myPlayer, sleep, stepToward, assert, BASE, startServer, stopServer, collectNextPickup, runTest, testHook };
