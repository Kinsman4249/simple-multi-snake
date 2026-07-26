// Phase 14 investigation: quantify client prediction corrections under a
// fixed input script, against whichever repo checkout is passed as arg 0.
// Usage: deno run -A measure-corrections.js /path/to/repo [label]
const repoRoot = Deno.args[0];
const label = Deno.args[1] || repoRoot;
const CDP_PORT = 9226;
const BASE = "http://127.0.0.1:8080";
// Arrow function returning a Promise that resolves after `ms` milliseconds
// -- lets other code `await sleep(...)` to pause. See docs/JS-CHEATSHEET.md
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Prefer the checkout's compiled Rust server binary; an older worktree
// without one (a pre-rewrite baseline) falls back to its JS server.
const binPath = repoRoot.replace(/\/$/, "") + "/server-rust/target/release/multisnake-server";
let haveBin = false;
// await pauses this async script until the Promise from Deno.stat resolves -- see docs/JS-CHEATSHEET.md
try { haveBin = (await Deno.stat(binPath)).isFile; } catch (_) { /* not built */ }
const server = haveBin
  ? new Deno.Command(binPath, { cwd: repoRoot, stdout: "null", stderr: "null" }).spawn()
  : new Deno.Command("deno", {
      args: ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-run", "--allow-env", "--unstable-detect-cjs", "server.js"],
      cwd: repoRoot, stdout: "null", stderr: "null"
    }).spawn();
let ready = false;
for (let i = 0; i < 50 && !ready; i++) {
  try { await (await fetch(BASE + "/api/config")).body?.cancel(); ready = true; } catch (_) { await sleep(100); }
}
if (!ready) { console.error("server never came up"); try { server.kill(); } catch (_) {} Deno.exit(1); }

const profileDir = await Deno.makeTempDir({ prefix: "snake-corr-" });
const chrome = new Deno.Command("flatpak", {
  args: ["run", "org.chromium.Chromium", "--headless=new", `--remote-debugging-port=${CDP_PORT}`,
    "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profileDir}`,
    "--window-size=1280,800", "--hide-scrollbars", "--mute-audio", "about:blank"],
  stdout: "null", stderr: "null"
}).spawn();

let ws, msgId = 0;
// pending: tracks CDP (Chrome DevTools Protocol) requests awaiting a reply,
// keyed by message id, so ws.onmessage below can resolve the right Promise.
const pending = new Map();
// Sends one CDP command over the WebSocket and returns a Promise that
// resolves when the matching response arrives (see ws.onmessage below).
function cdp(method, params, sessionId) {
  const id = ++msgId;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    // JSON.stringify converts this JS object to a text message for the socket -- see docs/JS-CHEATSHEET.md
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}
// Runs `expression` as JS code inside the browser tab (via CDP) and returns its value.
async function evalIn(sessionId, expression) {
  const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) throw new Error("page eval failed: " + JSON.stringify(r.exceptionDetails.exception));
  return r.result ? r.result.value : undefined;
}

try {
  let version = null;
  for (let i = 0; i < 100 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); }
    catch (_) { await sleep(200); }
  }
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  // ws.onmessage: assigning a function to this property is how WebSocket
  // events are handled here, instead of addEventListener -- see docs/JS-CHEATSHEET.md
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
    }
  };
  const { targetId } = await cdp("Target.createTarget", { url: BASE + "/" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Runtime.enable", {}, sessionId);
  await sleep(1500);
  await evalIn(sessionId, `(function(){
    const ie = document.getElementById("initialsEntry"); if (ie) ie.value = "BOT";
    const q = document.getElementById("captchaQuestion").textContent;
    const m = q.match(/(\\d+)\\s*\\+\\s*(\\d+)/);
    document.getElementById("captchaAnswer").value = String(Number(m[1]) + Number(m[2]));
    document.getElementById("captchaSubmit").click();
  })()`);
  await sleep(2000);
  await evalIn(sessionId, `myPlayers.forEach(p => p.setDebug(true)); "on"`);

  // Fixed input script: alternate Up / Down (each perpendicular to the
  // rightward travel that follows the previous vertical move being followed
  // by ArrowRight), ~2 turns/sec for 45s. Sequence: Up, Right, Down, Right...
  const keys = ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowRight"];
  const t0 = Date.now();
  let presses = 0;
  // Loops for 45s, cycling through the key sequence above.
  while (Date.now() - t0 < 45000) {
    const key = keys[presses % keys.length];
    for (const type of ["rawKeyDown", "keyUp"]) {
      await cdp("Input.dispatchKeyEvent", {
        type, key, code: key, windowsVirtualKeyCode: { ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[key],
        nativeVirtualKeyCode: { ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[key]
      }, sessionId);
      await sleep(30);
    }
    presses++;
    await sleep(420);
  }
  const out = await evalIn(sessionId, `(function(){
    const d = window.__DEBUG_SOURCE__();
    const l = d.locals[0] || {};
    const types = {};
    (l.corrections || []).forEach(c => { types[c.type] = (types[c.type] || 0) + 1; });
    return JSON.stringify({ build: d.serverBuild, correctionCount: l.correctionCount, lastTypes: types });
  })()`);
  console.log(label + ": presses=" + presses + " " + out);
} catch (err) {
  console.error("RUNNER FAILED:", err.message);
} finally {
  try { chrome.kill(); } catch (_) {}
  try { server.kill(); } catch (_) {}
}
