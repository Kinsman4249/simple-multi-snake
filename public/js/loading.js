// ============================================================
// Boot loading screen. Loaded FIRST (before net.js) so Loading.begin()
// is available the instant later scripts want to register a task -- no
// race with main.js/ui.js's own top-level code.
//
// The page starts with <body class="app-loading"> (index.html), which
// hides the real UI (#layout/.panel/#overlay/etc, see the CSS) behind
// #loadingScreen. Two known async boot tasks -- main.js's /api/config
// fetch and ui.js's /api/captcha fetch -- each register via begin() and
// resolve via step(), success or failure alike (a failed fetch must not
// leave the spinner up forever). Once every registered task has stepped,
// the loading screen is removed and app-loading comes off in one shot, so
// the player never sees the captcha text / powerup legend / tip toggles
// populate piecemeal.
//
// A hard timeout is a safety net, not the expected path: if some task
// never calls step() (a hung request with no timeout of its own), the UI
// still reveals so nobody is stuck staring at a spinner forever.
// ============================================================
// `a || b` evaluates to b when a is falsy -- here "use the existing
// __BUILDS__ object, or create one if this is the first script to run" --
// see JS-CHEATSHEET.md "Nullish coalescing / defaults".
(window.__BUILDS__ = window.__BUILDS__ || {}).loading = "loading 2026-07-29.1";
// IIFE module pattern: everything below (MAX_WAIT_MS, total, done, ...) is
// private; only { begin, step } is exposed as `Loading.begin`/`Loading.step`
// -- see JS-CHEATSHEET.md.
const Loading = (() => {
  const MAX_WAIT_MS = 8000;
  let total = 0;
  let done = 0;
  let finished = false;
  const el = document.getElementById("loadingScreen");

  function begin(n) {
    total += (n || 1);
  }
  function step() {
    done++;
    if (done >= total) finish();
  }
  function finish() {
    if (finished) return;
    finished = true;
    document.body.classList.remove("app-loading");
    if (el) {
      el.classList.add("done");
      // Matches the CSS transition duration below; removed after so it
      // can't intercept clicks once invisible.
      setTimeout(() => el.remove(), 250);
    }
  }
  setTimeout(finish, MAX_WAIT_MS);
  return { begin, step };
})();
