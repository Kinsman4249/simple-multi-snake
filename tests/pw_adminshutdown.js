// Admin maintenance-shutdown broadcast e2e test (POST /api/admin/notify-
// shutdown, routes.rs api_admin_notify_shutdown). Covers the two things
// install-lib/service.sh's restart_multisnake_with_warning relies on:
//   1. the route is closed by default / to a wrong token (fail-closed, since
//      Apache proxies "/" straight through -- this route is internet-
//      reachable, not loopback-only).
//   2. with the right token it reports an accurate connected count AND
//      actually broadcasts a "systemNotice" WS message to every connection,
//      which is what net.js/ui-overlays.js render as the on-page warning.
// Run: deno run --allow-net --allow-read --allow-write --allow-run
//      --allow-env tests/pw_adminshutdown.js
//
// In plain terms: this test makes sure the "shut the server down for
// maintenance" admin endpoint is locked shut by default, rejects a wrong
// token, and -- once given the correct token -- reports how many players
// are connected and actually sends them a warning message.
import { connectClient, assert, startServer, stopServer, runTest, BASE } from "./helpers.js";

const ADMIN_TOKEN = "test-admin-token-" + crypto.randomUUID().slice(0, 8);

function notify(token, text) {
  return fetch(BASE + "/api/admin/notify-shutdown", {
    method: "POST",
    headers: token != null ? { "X-Admin-Token": token } : {},
    body: JSON.stringify(text != null ? { text } : {})
  });
}

// Wraps a connected client's socket with a second "message" listener (added
// via addEventListener so it does not clobber helpers.js's own onmessage,
// which only tracks "state" broadcasts) and resolves the first time a
// message of the given type arrives.
function waitForMessageType(client, type, timeoutMs) {
  // new Promise(...) hands back a value that "resolves" later; (resolve,
  // reject) => {...} is an arrow function -- see docs/JS-CHEATSHEET.md
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.ws.removeEventListener("message", onMsg);
      reject(new Error("timed out waiting for \"" + type + "\" message"));
    }, timeoutMs || 5000);
    function onMsg(ev) {
      const msg = JSON.parse(ev.data); // JSON.parse: turn the WS text back into an object -- see docs/JS-CHEATSHEET.md
      if (msg.type === type) {
        clearTimeout(timer);
        client.ws.removeEventListener("message", onMsg);
        resolve(msg);
      }
    }
    client.ws.addEventListener("message", onMsg);
  });
}

async function main() {
  // Part 1: no ADMIN_TOKEN configured on the server at all -> the route
  // must fail closed regardless of what header a caller sends.
  // await pauses here until the promise from startServer() resolves --
  // see docs/JS-CHEATSHEET.md
  const noTokenServer = await startServer({ maxPlayers: 4 });
  try {
    const res = await notify(ADMIN_TOKEN, "should never be sent");
    assert(res.status === 403, "route must 403 when the server has no ADMIN_TOKEN configured, got " + res.status);
    console.log("PASS: notify-shutdown is closed when ADMIN_TOKEN is unset.");
  } finally {
    await stopServer(noTokenServer);
  }

  // Part 2: server configured with a real ADMIN_TOKEN.
  const server = await startServer({ maxPlayers: 4 }, { ADMIN_TOKEN });
  try {
    const wrong = await notify("not-the-right-token");
    assert(wrong.status === 403, "wrong/missing token must 403, got " + wrong.status);
    console.log("PASS: wrong token rejected.");

    const empty = await notify(ADMIN_TOKEN);
    assert(empty.status === 200, "correct token must be accepted, got " + empty.status);
    const emptyBody = await empty.json();
    assert(emptyBody.connected === 0, "expected connected:0 with nobody joined, got " + JSON.stringify(emptyBody));
    console.log("PASS: correct token + nobody connected reports connected:0 and skips the broadcast.");

    const c1 = await connectClient();
    await c1.waitFor(s => s.players != null, 5000); // first state broadcast has landed

    const noticeText = "Server restarting for maintenance in 30s -- finish your run!";
    const noticeWait = waitForMessageType(c1, "systemNotice", 5000);
    const withPlayer = await notify(ADMIN_TOKEN, noticeText);
    assert(withPlayer.status === 200, "correct token must be accepted, got " + withPlayer.status);
    const withPlayerBody = await withPlayer.json();
    assert(withPlayerBody.connected === 1, "expected connected:1 with one client joined, got " + JSON.stringify(withPlayerBody));

    const notice = await noticeWait;
    assert(notice.text === noticeText, "systemNotice text must echo the requested text, got " + JSON.stringify(notice));
    console.log("PASS: connected client received the systemNotice broadcast with the right text.");

    c1.close();
  } finally {
    await stopServer(server);
  }
}

runTest(main, { attempts: 3, watchdogMs: 60000 });
