// Headless benchmark runner (Phase 7): serves the repo root over HTTP,
// launches flatpak Chromium headless with a CDP port, opens
// /tools/bench/bench.html (or a page given as argv[0]), waits for
// window.__BENCH_RESULTS__ (or a custom expression via argv[1]), prints it
// as JSON, and cleans up. Run:
//
//   deno run --allow-net --allow-read --allow-run --allow-write --allow-env \
//     tools/bench/run-bench.js [pagePath] [resultExpr] [timeoutSec]
//
// Defaults: /tools/bench/bench.html, window.__BENCH_RESULTS__, 180s.
const PAGE = Deno.args[0] || "/tools/bench/bench.html";
const EXPR = Deno.args[1] || "window.__BENCH_RESULTS__";
const TIMEOUT_S = Number(Deno.args[2] || 180);
const HTTP_PORT = 8099;
const CDP_PORT = 9223;

const repoRoot = new URL("../..", import.meta.url).pathname;
// Plain object used as a lookup table: file extension -> Content-Type header value.
const MIME = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json", ".css": "text/css", ".wasm": "application/wasm" };

// --- tiny static server over the repo root ---
// Deno.serve takes an async request handler; `await Deno.readFile` below
// pauses until the file is read from disk before responding -- see docs/JS-CHEATSHEET.md
const server = Deno.serve({ port: HTTP_PORT, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
  const pathname = decodeURIComponent(new URL(req.url).pathname);
  const fsPath = repoRoot + pathname.replace(/^\//, "");
  if (!fsPath.startsWith(repoRoot)) return new Response("nope", { status: 403 });
  try {
    const data = await Deno.readFile(fsPath);
    const ext = pathname.slice(pathname.lastIndexOf("."));
    return new Response(data, { headers: { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" } });
  } catch (_) { return new Response("not found", { status: 404 }); }
});

// --- launch headless chromium ---
const profileDir = await Deno.makeTempDir({ prefix: "snake-bench-" });
const chrome = new Deno.Command("flatpak", {
  args: [
    "run", "org.chromium.Chromium",
    "--headless=new", `--remote-debugging-port=${CDP_PORT}`,
    "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${profileDir}`,
    "--disable-frame-rate-limit", "--disable-gpu-vsync",
    "--hide-scrollbars", "--mute-audio",
    "about:blank"
  ],
  stdout: "null", stderr: "null"
}).spawn();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function cleanup() {
  try { chrome.kill(); } catch (_) {}
  try { await server.shutdown(); } catch (_) {}
}

// --- minimal CDP client ---
let ws, msgId = 0;
// Map: tracks in-flight CDP requests by id so responses can be matched up -- see docs/JS-CHEATSHEET.md
const pending = new Map();
function cdp(method, params, sessionId) {
  const id = ++msgId;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}

try {
  // wait for the CDP endpoint
  let version = null;
  for (let i = 0; i < 100; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      break;
    } catch (_) { await sleep(200); }
  }
  if (!version) throw new Error("chromium CDP endpoint never came up");

  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
    }
  };

  const url = `http://127.0.0.1:${HTTP_PORT}${PAGE}`;
  const { targetId } = await cdp("Target.createTarget", { url });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Runtime.enable", {}, sessionId);

  const deadline = Date.now() + TIMEOUT_S * 1000;
  let result = null;
  // Poll the page every second until the expected global (e.g. window.__BENCH_RESULTS__) shows up.
  while (Date.now() < deadline) {
    const r = await cdp("Runtime.evaluate", {
      expression: `JSON.stringify(${EXPR} || null)`, returnByValue: true
    }, sessionId);
    const val = r.result && r.result.value ? JSON.parse(r.result.value) : null;
    if (val) { result = val; break; }
    await sleep(1000);
  }
  if (!result) throw new Error("timed out waiting for " + EXPR);
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error("BENCH RUNNER FAILED:", err.message);
  await cleanup();
  Deno.exit(1);
}
await cleanup();
Deno.exit(0);
