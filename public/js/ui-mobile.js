// ============================================================
// Touch/mobile UI: the info-overlays hide toggle and the on-screen PWR/
// BOOST buttons. Depends on ui-core.js's `topBarPin()`.
// ============================================================

// ---- Mobile UI hide toggle (v3.6.0; scope fixed v3.6.1) -------------
// On touch devices the INFO overlays are hidden by DEFAULT (main.js calls
// this only when IS_TOUCH) so they can't cover the board or eat touches; a
// small fixed button flips the body's .mobile-hidden class to reveal/hide
// them. The PWR and BOOST touch buttons are PLAY controls, not info UI, so
// the .mobile-hidden CSS deliberately leaves them alone -- they stay on
// screen at all times (see index.html). The class IS the state -- it lives
// only in the DOM, so a reload starts hidden again (session-scoped, resets
// on reload, as specified). Swipe-to-steer is on the board itself, so play
// continues while the overlays are hidden. The toggle preventDefaults its
// touch so the tap neither steers the board nor double-fires as a
// synthesized click.
function initMobileUiToggle() {
  if (document.getElementById("mobileUiToggle")) return;
  document.body.classList.add("mobile-hidden"); // default hidden on load
  const btn = document.createElement("button");
  btn.id = "mobileUiToggle";
  btn.textContent = "☰"; // hamburger
  btn.setAttribute("aria-label", "Toggle UI");
  btn.style.cssText = "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);" +
    "z-index:10000;width:40px;height:40px;border-radius:50%;font-size:18px;" +
    "background:rgba(20,20,20,0.6);color:#ccc;border:1px solid #555;" +
    "font-family:monospace;opacity:0.55;touch-action:none;-webkit-user-select:none;user-select:none;";
  const toggle = e => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    const hidden = document.body.classList.toggle("mobile-hidden");
    btn.textContent = hidden ? "☰" : "✕"; // hamburger vs x
    // The top bar normally fades to opacity 0 until the pointer nears the
    // top edge; when the UI is REVEALED, pin it solidly visible so the tap
    // shows the full control bar (Leave/KEYS/INITIALS), not just the
    // leaderboard and status. Unpin (and .mobile-hidden's display:none
    // takes over) when hidden again.
    topBarPin(!hidden);
  };
  btn.addEventListener("touchstart", toggle, { passive: false });
  btn.addEventListener("click", toggle); // desktop fallback; touchstart's preventDefault stops a double-fire on touch
  document.body.appendChild(btn);
}

// ---- Touch controls (Phase 6) ---------------------------------------
// Two semi-transparent buttons overlaying the bottom corners on
// coarse-pointer devices (main.js decides WHEN to build these; this
// module only builds the DOM). PWR fires the activation action on tap;
// BOOST is hold-to-boost -- handlers.onBoost(true/false) on press/release,
// with touchcancel treated as release so an interrupted touch can never
// leave a snake boosting forever (same reasoning as main.js's window blur
// handler for held keys). Steering is swipe-on-board, handled in main.js.
function initTouchControls(handlers) {
  if (document.getElementById("touchPwrBtn")) return;
  const base = "position:fixed;bottom:16px;z-index:9995;width:76px;height:76px;" +
    "border-radius:50%;font-family:monospace;font-size:14px;opacity:0.45;" +
    "touch-action:none;-webkit-user-select:none;user-select:none;";
  const pwr = document.createElement("button");
  pwr.id = "touchPwrBtn";
  pwr.textContent = "PWR";
  pwr.style.cssText = base + "left:16px;background:#241a2e;color:#c9f;border:2px solid #758;";
  pwr.addEventListener("touchstart", e => { e.preventDefault(); handlers.onActivate(); }, { passive: false });
  document.body.appendChild(pwr);

  const boost = document.createElement("button");
  boost.id = "touchBoostBtn";
  boost.textContent = "BOOST";
  boost.style.cssText = base + "right:16px;background:#14201a;color:#9f9;border:2px solid #3a5;";
  const press = e => { e.preventDefault(); boost.style.opacity = "0.8"; handlers.onBoost(true); };
  const release = e => { e.preventDefault(); boost.style.opacity = "0.45"; handlers.onBoost(false); };
  boost.addEventListener("touchstart", press, { passive: false });
  boost.addEventListener("touchend", release, { passive: false });
  boost.addEventListener("touchcancel", release, { passive: false });
  document.body.appendChild(boost);
}

Object.assign(UI, { initMobileUiToggle, initTouchControls });
