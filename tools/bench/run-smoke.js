// Live smoke test (Phase 7): starts the real server, opens the real game
// page in headless flatpak Chromium via CDP, solves the captcha through the
// actual DOM, joins, and asserts on the renderer that actually drew frames:
//   - default page  -> wasm renderer active (build stamp + non-black canvas)
//   - ?renderer=2d  -> 2D fallback active, canvas still non-black
// Screenshots land in tools/bench/out/. Run:
//
//   deno run --allow-net --allow-read --allow-run --allow-write --allow-env \
//     tools/bench/run-smoke.js
const CDP_PORT = 9224;
const BASE = "http://127.0.0.1:8080";
const repoRoot = new URL("../..", import.meta.url).pathname;
const outDir = repoRoot + "tools/bench/out";
await Deno.mkdir(outDir, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- start the game server (same fallback logic as tests/helpers.js) ---
let server;
try {
  server = new Deno.Command("node", { args: ["server.js"], cwd: repoRoot, stdout: "null", stderr: "null" }).spawn();
  await sleep(300);
  if ((await Promise.race([server.status, sleep(50).then(() => null)])) != null) throw new Error("node exited");
} catch (_) {
  server = new Deno.Command("deno", {
    args: ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-run", "--allow-env", "--unstable-detect-cjs", "server.js"],
    cwd: repoRoot, stdout: "null", stderr: "null"
  }).spawn();
}
let ready = false;
for (let i = 0; i < 50 && !ready; i++) {
  try { await (await fetch(BASE + "/api/config")).body?.cancel(); ready = true; } catch (_) { await sleep(100); }
}
if (!ready) { console.error("server never came up"); try { server.kill(); } catch (_) {} Deno.exit(1); }

// --- chromium + CDP plumbing ---
const profileDir = await Deno.makeTempDir({ prefix: "snake-smoke-" });
const chrome = new Deno.Command("flatpak", {
  args: ["run", "org.chromium.Chromium", "--headless=new", `--remote-debugging-port=${CDP_PORT}`,
    "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profileDir}`,
    "--window-size=1280,800", "--hide-scrollbars", "--mute-audio", "about:blank"],
  stdout: "null", stderr: "null"
}).spawn();

let ws, msgId = 0;
const pending = new Map();
function cdp(method, params, sessionId) {
  const id = ++msgId;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}
async function evalIn(sessionId, expression) {
  const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) throw new Error("page eval failed: " + JSON.stringify(r.exceptionDetails.exception));
  return r.result ? r.result.value : undefined;
}

let failures = 0;
async function cleanup() {
  try { chrome.kill(); } catch (_) {}
  try { server.kill(); } catch (_) {}
}

try {
  let version = null;
  for (let i = 0; i < 100 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); }
    catch (_) { await sleep(200); }
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

  async function smokeOne(label, url, expectStamp) {
    const { targetId } = await cdp("Target.createTarget", { url });
    const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
    await cdp("Runtime.enable", {}, sessionId);
    await cdp("Page.enable", {}, sessionId);
    await sleep(1500); // page load + /api/config + captcha fetch
    // Solve the captcha through the real DOM.
    await evalIn(sessionId, `(function(){
      const q = document.getElementById("captchaQuestion").textContent;
      const m = q.match(/(\\d+)\\s*\\+\\s*(\\d+)/);
      document.getElementById("captchaAnswer").value = String(Number(m[1]) + Number(m[2]));
      document.getElementById("captchaSubmit").click();
      return q;
    })()`);
    await sleep(2500); // join + a couple seconds of live frames
    const info = await evalIn(sessionId, `JSON.stringify({
      builds: window.__BUILDS__,
      overlayGone: (function(){
        const ov = document.getElementById("overlay");
        return !ov || getComputedStyle(ov).display === "none";
      })(),
      canvasLit: (function(){
        const c = document.getElementById("game");
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] | d[i+1] | d[i+2]) lit++;
        return lit;
      })()
    })`);
    const r = JSON.parse(info);
    const shot = await cdp("Page.captureScreenshot", { format: "png" }, sessionId);
    await Deno.writeFile(`${outDir}/smoke-${label}.png`, Uint8Array.from(atob(shot.data), c => c.charCodeAt(0)));
    const stampOk = expectStamp === "wasm"
      ? !!(r.builds && r.builds.renderWasm && r.builds.render && r.builds.render.indexOf("wasm facade") !== -1)
      : !!(r.builds && r.builds.render2d);
    const ok = stampOk && r.overlayGone && r.canvasLit > 100;
    console.log(`${ok ? "PASS" : "FAIL"}: ${label} -- overlayGone=${r.overlayGone} canvasLitPx=${r.canvasLit} builds=${JSON.stringify(r.builds)}`);
    if (!ok) failures++;
    await cdp("Target.closeTarget", { targetId });
  }

  await smokeOne("wasm-default", BASE + "/", "wasm");
  await smokeOne("2d-fallback", BASE + "/?renderer=2d", "2d");
} catch (err) {
  console.error("SMOKE RUNNER FAILED:", err.message);
  failures++;
}
await cleanup();
console.log(failures === 0 ? "ALL PASS" : "FAILURES: " + failures);
Deno.exit(failures === 0 ? 0 : 1);
