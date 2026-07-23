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
(window.__BUILDS__ = window.__BUILDS__ || {}).loading = "loading 2026-07-22.1";
const Loading = (() => {
  const MAX_WAIT_MS = 8000;
  let total = 0;
  let done = 0;
  let finished = false;
  const el = document.getElementById("loadingScreen");
  const bar = document.getElementById("loadingBar");

  function update() {
    if (!bar) return;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
    bar.style.width = pct + "%";
  }
  function begin(n) {
    total += (n || 1);
    update();
  }
  function step() {
    done++;
    update();
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
