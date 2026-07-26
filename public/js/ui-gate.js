// ============================================================
// Captcha/initials gate screen: the combined overlay shown before the game
// connects, its persisted "tip" explainer blocks, and the powerup-info
// popup/legend/in-game reference panel content (all built from the same
// POWERUP_INFO the server sends). Depends on ui-core.js's `UI`,
// `textEntryCount`, `sanitizeInitials`.
// ============================================================

// The very first loadCaptcha() call (from initCaptchaGate) is a boot task
// gating the loading screen; retries after a wrong answer are not -- the
// screen is long gone by then. isBootTask tells the two apart.
let captchaId = null;
// `async function` + `await` (see docs/JS-CHEATSHEET.md): `fetch` returns a
// Promise that resolves once the network request completes; `await` pauses
// this function until that happens, so the code below reads top-to-bottom
// instead of chaining `.then()` callbacks.
async function loadCaptcha(isBootTask) {
  try {
    const res = await fetch("/api/captcha");
    const data = await res.json(); // .json() is ALSO async -- another await
    captchaId = data.id;
    document.getElementById("captchaQuestion").textContent = data.a + " + " + data.b + " = ?";
  } finally {
    if (isBootTask) Loading.step();
  }
}
// Persisted show/hide state for the captcha/gate screen's static explainer
// blocks (boost/slide, piñata, grid-decay -- every ".tip" -- plus the
// powerup info popup below). Remembers your last choice across reloads,
// the SAME localStorage-backed pattern main.js uses for session initials
// (storeInitials/storedInitials): once you hide a block it stays hidden
// next time, and vice versa. Replaces the old boostTip-only one-shot "Got
// it" ack (which didn't persist and didn't let you bring the tip back).
const TIP_STORAGE_PREFIX = "snake.tipShown.";
function loadTipShown(key, defaultShown) {
  try {
    const v = localStorage.getItem(TIP_STORAGE_PREFIX + key);
    return v === null ? defaultShown : v === "1";
  } catch (_) { return defaultShown; }
}
function saveTipShown(key, shown) {
  try { localStorage.setItem(TIP_STORAGE_PREFIX + key, shown ? "1" : "0"); } catch (_) {}
}
// Wires every ".tip" block's header toggle button (see index.html
// #boostTip/#pinataTip/#wallsTip, each now a `.tip` with a `.tip-head`
// containing a `.tip-toggle` button and a `.tip-body`). Keyed by the
// block's own element id so each tip remembers independently; defaults to
// collapsed the first time, same as the powerup info popup below -- the
// captcha form itself always stays visible, only these info blurbs start
// hidden behind a Show button.
function initTipToggles() {
  // .forEach(el => {...}) runs the arrow function once per element in the
  // list (see docs/JS-CHEATSHEET.md for arrow function syntax).
  document.querySelectorAll(".tip").forEach(el => {
    const btn = el.querySelector(".tip-toggle");
    if (!btn) return;
    let shown = loadTipShown(el.id, false);
    const apply = () => { el.classList.toggle("collapsed", !shown); btn.textContent = shown ? "Hide" : "Show"; };
    apply();
    // Assigning a function to `btn.onclick` wires up the click handler
    // (event-handler-property style, see docs/JS-CHEATSHEET.md) -- simpler
    // than addEventListener when only one handler is ever needed.
    btn.onclick = () => { shown = !shown; saveTipShown(el.id, shown); apply(); };
  });
}
// Plain toggle button + popup explaining ALL powerups (see index.html
// #powerupInfoBtn/#powerupInfoPopup). Independent of the captcha form and
// the boost tip -- purely informational, never gates Join. The button is
// wired up immediately so it's clickable from page load; its CONTENT is
// filled in later by setPowerupInfo(), once main.js's /api/config fetch
// resolves with each powerup's title/description (sourced from the
// powerup's own JS file -- see powerups/*.js -- so this list can never
// drift out of sync with what powerups actually exist). Open/closed state
// persists via the same loadTipShown/saveTipShown mechanism as the .tip
// blocks above, defaulting to CLOSED the first time (unlike the tips,
// which default open) -- this popup has always started collapsed.
function initPowerupInfo() {
  const btn = document.getElementById("powerupInfoBtn");
  const popup = document.getElementById("powerupInfoPopup");
  if (!btn || !popup) return;
  let open = loadTipShown("powerupInfoPopup", false);
  const apply = () => popup.classList.toggle("open", open);
  apply();
  btn.onclick = () => { open = !open; saveTipShown("powerupInfoPopup", open); apply(); };
}
// Pixel-art banana as an SVG data-URI for the captcha legend swatch, so the
// key shows the SAME crescent the pickup draws on-board (not a flat square).
// The grid mirrors render2d.js BANANA_ART exactly: 1=body #fd4, 2=tip #a70,
// 3=ripeness spot #630, 0=transparent. Built once and cached.
let _bananaUri = null;
function bananaSwatchUri() {
  if (_bananaUri) return _bananaUri;
  const art = [
    [0, 0, 0, 1, 2],
    [0, 0, 1, 3, 0],
    [0, 1, 1, 0, 0],
    [3, 1, 0, 0, 0],
    [2, 1, 0, 0, 0]
  ];
  const col = { 1: "#fd4", 2: "#a70", 3: "#630" };
  let rects = "";
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const v = art[r][c];
      if (v === 0) continue;
      rects += "<rect x=\"" + c + "\" y=\"" + r + "\" width=\"1\" height=\"1\" fill=\"" + col[v] + "\"/>";
    }
  }
  // Double-quoted attributes: encodeURIComponent escapes " (to %22) but NOT
  // ' -- quoting with " keeps the encoded URI entirely quote-free, so the
  // url('...') single-quote wrapper in the swatch style can't be broken by a
  // stray literal quote. width/height give the SVG an intrinsic size so
  // background-size:contain has a ratio to work from in every browser.
  const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\" " +
    "viewBox=\"0 0 5 5\" shape-rendering=\"crispEdges\">" + rects + "</svg>";
  _bananaUri = "data:image/svg+xml," + encodeURIComponent(svg);
  return _bananaUri;
}
// Builds the popup's content from { type: {title, description} } and
// sizes the popup to the number of entries -- a couple of powerups gets a
// small, tight box; many get a taller one, capped and scrollable (see the
// max-height/overflow-y in index.html's #powerupInfoPopup rule) so it
// never runs off the top of the screen.
function setPowerupInfo(info, powerupsCfg) {
  const popup = document.getElementById("powerupInfoPopup");
  if (!popup) return;
  // Operator-disabled powerups (powerupsCfg[type].enabled === false, e.g. the
  // helloWorld demo) never spawn on this server's board, so they must not
  // appear in EITHER the "what do the powerups do?" popup or the legend --
  // teaching a powerup a player can never pick up is just noise.
  const isEnabled = type => {
    const pc = powerupsCfg && powerupsCfg[type];
    return !(pc && pc.enabled === false);
  };
  const infoTypes = Object.keys(info || {}).filter(isEnabled);
  // Render is a top-level const (script load order: render.js before ui.js),
  // so it's a global binding but NOT a window property. POWERUP_STYLE holds
  // the exact on-board draw colors -- the single source for every swatch.
  // `expr || {}` falls back to an empty object when the left side is
  // falsy/missing (the `x || fallback` default idiom, see
  // docs/JS-CHEATSHEET.md), so later lookups like `style[type]` never throw.
  const style = (typeof Render !== "undefined" && Render.POWERUP_STYLE) || {};
  // The banana pickup is drawn on-board as the pixel-art banana crescent (not
  // a flat square), so its swatch must be that exact sprite too (v3.6.2) -- a
  // plain/spotted square would mis-teach the icon. The SVG mirrors render2d.js
  // BANANA_ART cell-for-cell (5x5, 1=body 2=tip 3=spot). NB: the data-URI is
  // wrapped in SINGLE quotes -- the swatch is emitted into an HTML style="..."
  // attribute (double-quoted), so double quotes around url() would terminate
  // the attribute early and blank the icon. One helper drives the captcha
  // legend AND the in-game reference panel so they can never diverge.
  const swatchStyle = type => type === "bananaTrail"
    ? "background:transparent;background-image:url('" + bananaSwatchUri() + "');" +
      "background-size:contain;background-repeat:no-repeat;background-position:center"
    : "background:" + (style[type] || "#fff");

  if (infoTypes.length === 0) {
    popup.innerHTML = "<h4>Powerups</h4>No powerups are enabled.";
  } else {
    popup.innerHTML = "<h4>Powerups</h4>" + infoTypes.map(type =>
      "<div class=\"entry\"><span class=\"name\">" + info[type].title + ":</span> " + info[type].description + "</div>"
    ).join("");
    // Scale the popup's height with entry count (small list = tight box,
    // large list = taller box up to the CSS max-height/scroll fallback).
    popup.style.minHeight = Math.min(400, 40 + infoTypes.length * 55) + "px";
  }

  // Captcha-screen color legend (index.html #powerupLegend): swatch + name
  // per powerup so a new player knows what each pickup color means before
  // their snake ever moves. Types the operator disabled (isEnabled filter)
  // are skipped -- never teach a color that can't appear on this board.
  const legend = document.getElementById("powerupLegend");
  if (legend) {
    legend.innerHTML = infoTypes.map(type =>
      "<span><span class=\"sw\" style=\"" + swatchStyle(type) + "\"></span>" +
      (info[type].title || type) + "</span>").join("");
  }

  // In-game reference panel (v3.6.5, index.html #powerupRef): the SAME
  // legend + descriptions the gate shows, kept available DURING play so a
  // player can check what a pickup does without quitting back to the gate.
  // Opened by the top-bar POWERUPS button (initPowerupRefButton, v3.6.7) --
  // an explicit press like KEYS/INITIALS/Leave, not a hover. This block just
  // fills the content; the button toggles its visibility. Reuses the same
  // POWERUP_INFO copy, isEnabled filter, and swatchStyle -- no duplicated data.
  const ref = document.getElementById("powerupRef");
  if (ref) {
    ref.innerHTML = infoTypes.length === 0
      ? "<h3>Powerups</h3><div class=\"pr-desc\">No powerups are enabled.</div>"
      : "<h3>Powerups</h3>" + infoTypes.map(type =>
          "<div class=\"pr-entry\"><span class=\"sw\" style=\"" + swatchStyle(type) + "\"></span>" +
          "<span class=\"pr-name\">" + (info[type].title || type) + "</span>" +
          "<div class=\"pr-desc\">" + info[type].description + "</div></div>").join("");
  }
}
// The gate overlay is one combined screen (v3.4.0): initials entry + the
// captcha, both required before the game connects. The whole overlay
// counts as an active text entry until it is dismissed, so no keystroke
// typed here can reach the game's key handlers.
function initCaptchaGate(onSuccess) {
  Loading.begin(1); // boot task: the captcha question must be in before reveal
  loadCaptcha(true);
  initTipToggles();
  initPowerupInfo();
  textEntryCount++;
  const initialsEl = document.getElementById("initialsEntry");
  // Prefill from the last session's choice (main.js persists it); entry is
  // still required -- prefilled just means one less thing to retype.
  try { if (initialsEl) initialsEl.value = localStorage.getItem("snake.initials.local0") || ""; } catch (_) {}
  document.getElementById("captchaSubmit").onclick = async () => {
    const initials = sanitizeInitials(initialsEl ? initialsEl.value : "");
    if (!initials) {
      document.getElementById("captchaError").textContent = "Enter your initials first.";
      if (initialsEl) initialsEl.focus();
      return;
    }
    const answer = document.getElementById("captchaAnswer").value;
    // JSON.stringify turns the JS object into a JSON text string to send in
    // the request body (see docs/JS-CHEATSHEET.md); the server parses it back.
    const res = await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: captchaId, answer })
    });
    if (!res.ok) {
      document.getElementById("captchaError").textContent = "Wrong answer, try again.";
      loadCaptcha();
      document.getElementById("captchaAnswer").value = "";
      return;
    }
    const data = await res.json();
    document.getElementById("overlay").remove();
    textEntryCount = Math.max(0, textEntryCount - 1);
    onSuccess(data.token, initials);
  };
}

// Publish this file's public functions onto the shared UI object (see
// docs/JS-CHEATSHEET.md for Object.assign and shorthand property syntax).
Object.assign(UI, { initCaptchaGate, setPowerupInfo });
