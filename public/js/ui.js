// ============================================================
// Non-engine UI: captcha gate, status line, high score lists, initials
// prompt with countdown, spectator overlay, explicit JOIN offer button,
// and a DEBUG button/panel (recording enabled only while open).
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).ui = "ui 2026-07-22.1";
const UI = (() => {
  const statusEl = document.getElementById("status");
  let captchaId = null;
  // Count of open text-entry surfaces (captcha/initials gate, P2 initials
  // prompt, Change Initials panel). While > 0, main.js's game key handlers
  // early-return -- the listener-isolation rule (v3.4.0): no keystroke typed
  // into a text field may reach movement/boost/seat-request handling.
  let textEntryCount = 0;
  function isTextEntryActive() { return textEntryCount > 0; }
  function sanitizeInitials(v) {
    return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
  }

  // The very first loadCaptcha() call (from initCaptchaGate) is a boot task
  // gating the loading screen; retries after a wrong answer are not -- the
  // screen is long gone by then. isBootTask tells the two apart.
  async function loadCaptcha(isBootTask) {
    try {
      const res = await fetch("/api/captcha");
      const data = await res.json();
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
    document.querySelectorAll(".tip").forEach(el => {
      const btn = el.querySelector(".tip-toggle");
      if (!btn) return;
      let shown = loadTipShown(el.id, false);
      const apply = () => { el.classList.toggle("collapsed", !shown); btn.textContent = shown ? "Hide" : "Show"; };
      apply();
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
  function setConnectionStatus(text) { statusEl.textContent = text; }

  function updateStatus(curr) {
    const locals = curr.you.locals || [];
    const present = locals.filter(e => e);
    // Speed-run / food-rate readout (v3.7.0): best-5-minutes food/min,
    // provisional until floorMs of play accrues (see server-rust/src/state.rs),
    // shown for both roles since the accumulator outlives any one life.
    const frText = entry => entry.foodRate
      ? " | " + entry.foodRate.ratePerMin.toFixed(1) + " food/min" + (entry.foodRate.locked ? "" : " (provisional)")
      : "";
    const parts = locals.map(entry => {
      if (!entry) return ""; // seat left (null hole): nothing to report
      const label = present.length > 1 ? (entry.local === 0 ? "P1" : "P2") + ": " : "You: ";
      if (entry.role === "player") {
        const me = curr.players[entry.slot];
        // Banana slip: the server flips this seat's controls while
        // `inverted` -- say so where the player is already looking.
        return label + "slot " + (entry.slot + 1) + " | score " +
          (me ? me.score : 0) + (me && !me.alive ? " | waiting" : "") +
          frText(entry) +
          (me && me.alive && me.inverted ? " | ⇄ CONTROLS REVERSED" : "");
      }
      return label + "spectating (queue " + entry.queuePos + " of " + entry.queueLen + ")" + frText(entry);
    }).filter(s => s);
    statusEl.textContent = parts.join("   ");
  }
  // Phase 12: hs is { local: {daily, allTime}, networked: {daily, allTime} }
  // and `mode` is the session's CURRENT classification ("local" |
  // "networked") -- the matching section gets the .current highlight so a
  // player knows which board this run lands on.
  function updateLeaderboards(hs, mode) {
    const fmt = list => (list || []).map(e => "<li>" + e.initials + " - " + e.score + "</li>").join("");
    const local = hs.local || hs; // tolerate a pre-split server during a rolling deploy
    const net = hs.networked || { daily: [], allTime: [], foodRateDaily: [], foodRateAllTime: [] };
    document.getElementById("dailyList").innerHTML = fmt(local.daily);
    document.getElementById("allTimeList").innerHTML = fmt(local.allTime);
    const nd = document.getElementById("netDailyList");
    const na = document.getElementById("netAllTimeList");
    if (nd) nd.innerHTML = fmt(net.daily);
    if (na) na.innerHTML = fmt(net.allTime);
    // Speed-run / food-rate boards (v3.7.0) -- optional elements so an older
    // cached index.html (pre this feature) doesn't throw.
    const frd = document.getElementById("frDailyList");
    const fra = document.getElementById("frAllTimeList");
    if (frd) frd.innerHTML = fmt(local.foodRateDaily);
    if (fra) fra.innerHTML = fmt(local.foodRateAllTime);
    const nfrd = document.getElementById("netFrDailyList");
    const nfra = document.getElementById("netFrAllTimeList");
    if (nfrd) nfrd.innerHTML = fmt(net.foodRateDaily);
    if (nfra) nfra.innerHTML = fmt(net.foodRateAllTime);
    const secLocal = document.getElementById("hsLocal");
    const secNet = document.getElementById("hsNetworked");
    if (secLocal) secLocal.classList.toggle("current", mode !== "networked");
    if (secNet) secNet.classList.toggle("current", mode === "networked");
  }

  // ---- Fading top menu (Phase 5) --------------------------------------
  // One shared bar replaces the four always-on corner buttons (DEBUG,
  // coop, KEYS, Leave). It sits hidden at the top edge and fades in when
  // the pointer nears the top (or on a tap up there, for touch), fading
  // back out after a short idle. While any of its panels (DEBUG/KEYS) is
  // open the bar is pinned visible so its toggle button can't vanish from
  // under an open panel. Buttons keep their exact behavior -- this is a
  // relocation, not a redesign.
  const TOPBAR_REVEAL_PX = 80;
  const TOPBAR_HIDE_DELAY_MS = 1500;
  let topBarEl = null;
  let topBarHideTimer = null;
  let topBarPinned = 0;
  function topBarSetVisible(on) {
    if (!topBarEl) return;
    topBarEl.style.opacity = on ? "1" : "0";
    topBarEl.style.pointerEvents = on ? "auto" : "none";
  }
  // Hiding is TIME-BASED from the last activity that revealed the bar: every
  // show (re)arms one idle timer, and the bar fades when it fires (unless a
  // panel has it pinned). It never waits for a pointer move BELOW the reveal
  // zone -- a pointer parked on the bar, or gone out the top of the window,
  // previously produced no qualifying move and left the bar visible forever.
  function topBarShow() {
    topBarSetVisible(true);
    topBarScheduleHide();
  }
  function topBarScheduleHide() {
    if (topBarHideTimer) clearTimeout(topBarHideTimer);
    topBarHideTimer = setTimeout(() => {
      topBarHideTimer = null;
      if (topBarPinned === 0) topBarSetVisible(false);
    }, TOPBAR_HIDE_DELAY_MS);
  }
  // Panels opened FROM the bar call this with true/false so the bar stays
  // up while they're open (counted, since DEBUG and KEYS can both be open).
  function topBarPin(on) {
    topBarPinned = Math.max(0, topBarPinned + (on ? 1 : -1));
    if (topBarPinned > 0) {
      if (topBarHideTimer) { clearTimeout(topBarHideTimer); topBarHideTimer = null; }
      topBarSetVisible(true);
    } else topBarScheduleHide();
  }
  function topBar() {
    if (topBarEl) return topBarEl;
    topBarEl = document.createElement("div");
    topBarEl.id = "topBar";
    topBarEl.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;" +
      "display:flex;gap:6px;align-items:center;padding:4px 8px;" +
      "background:rgba(17,17,17,0.92);border-bottom:1px solid #444;" +
      "opacity:0;pointer-events:none;transition:opacity 0.25s;";
    document.body.appendChild(topBarEl);
    // pointermove covers mouse; pointerdown covers a tap near the top edge
    // on touch (touch produces no hover-style moves worth trusting). Each
    // in-zone event re-shows AND re-arms the idle timer; moves below the
    // zone need no handler at all, since hiding is time-based.
    document.addEventListener("pointermove", e => {
      if (e.clientY <= TOPBAR_REVEAL_PX) topBarShow();
    });
    document.addEventListener("pointerdown", e => {
      if (e.clientY <= TOPBAR_REVEAL_PX) topBarShow();
    });
    // Pointer left the window entirely (e.g. out the top edge): no further
    // pointer events will arrive, so make sure a hide is armed.
    document.addEventListener("pointerleave", () => {
      if (topBarPinned === 0) topBarScheduleHide();
    });
    return topBarEl;
  }

  function overlayBox(id) {
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    const box = document.createElement("div");
    box.id = id;
    box.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:9998;";
    return box;
  }

  // Session-initials prompt (v3.4.0): shown BEFORE a seat first joins (P2's
  // WASD/add-player request), never after a death -- scores auto-record
  // server-side with the bound initials. While open it counts as an active
  // text entry, so typing "WAS" here can never steer or spawn anything; the
  // caller (main.js requestSeat) proceeds with the join only on confirm.
  function promptInitials(local, prefill, onDone) {
    const boxId = "initialsPromptOverlay" + local;
    if (document.getElementById(boxId)) return; // already prompting this seat
    const box = overlayBox(boxId);
    const inputId = "initialsPromptInput" + local;
    const submitId = "initialsPromptSubmit" + local;
    const label = local === 0 ? "" : "P" + (local + 1) + " ";
    textEntryCount++;
    box.innerHTML =
      "<div style=\"background:#1a1a1a;border:1px solid #444;padding:24px;text-align:center;font-family:monospace;color:#eee;\">" +
      "<div>" + label + "Enter your initials</div>" +
      "<div style=\"margin:6px 0;color:#999;font-size:12px;\">Used for the leaderboards, for this whole session.</div>" +
      "<div><input id=\"" + inputId + "\" maxlength=\"3\" style=\"background:#000;color:#6f6;border:1px solid #666;font-family:monospace;font-size:20px;text-align:center;width:4ch;\"></div>" +
      "<div><button id=\"" + submitId + "\" style=\"background:#333;color:#eee;border:1px solid #666;padding:6px 14px;margin-top:10px;cursor:pointer;font-family:monospace;\">OK</button></div>" +
      "</div>";
    document.body.appendChild(box);
    const input = document.getElementById(inputId);
    input.value = sanitizeInitials(prefill);
    input.focus();
    let done = false;
    const submit = () => {
      if (done) return;
      const value = sanitizeInitials(input.value);
      if (!value) { input.focus(); return; } // initials are required to join
      done = true;
      box.remove();
      textEntryCount = Math.max(0, textEntryCount - 1);
      onDone(value);
    };
    document.getElementById(submitId).onclick = submit;
    input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); submit(); } });
  }

  // Change Initials (v3.4.0): a persistent top-bar button opening a small
  // panel with one row per local seat -- retype and Save to overwrite the
  // session-bound initials at any time, no refresh needed. getFn(idx)
  // returns the current value; saveFn(idx, value) binds + persists it.
  function initInitialsPanel(getFn, saveFn) {
    if (document.getElementById("initialsBtn")) return;
    const btn = document.createElement("button");
    btn.id = "initialsBtn";
    btn.textContent = "INITIALS";
    btn.style.cssText = "background:#222;color:#9f9;border:1px solid #666;font-family:monospace;font-size:12px;padding:4px 8px;cursor:pointer;";
    topBar().appendChild(btn);

    const panel = document.createElement("div");
    panel.id = "initialsPanel";
    panel.style.cssText = "position:fixed;top:34px;left:150px;z-index:9999;display:none;width:220px;background:rgba(0,0,0,0.9);color:#ddd;border:1px solid #666;font-family:monospace;font-size:12px;padding:10px;";
    document.body.appendChild(panel);

    function renderPanel() {
      panel.innerHTML = "";
      for (let idx = 0; idx < 2; idx++) {
        const row = document.createElement("div");
        row.style.cssText = "margin-bottom:8px;display:flex;gap:6px;align-items:center;";
        const label = document.createElement("span");
        label.textContent = "P" + (idx + 1) + ":";
        row.appendChild(label);
        const input = document.createElement("input");
        input.maxLength = 3;
        input.value = sanitizeInitials(getFn(idx));
        input.style.cssText = "background:#000;color:#6f6;border:1px solid #666;font-family:monospace;font-size:14px;text-align:center;width:4ch;";
        row.appendChild(input);
        const save = document.createElement("button");
        save.textContent = "Save";
        save.style.cssText = "background:#333;color:#eee;border:1px solid #666;padding:2px 8px;cursor:pointer;font-family:monospace;font-size:11px;";
        save.onclick = () => {
          const v = sanitizeInitials(input.value);
          if (v) { saveFn(idx, v); input.value = v; }
        };
        row.appendChild(save);
        panel.appendChild(row);
      }
    }
    btn.onclick = () => {
      const open = panel.style.display === "none";
      panel.style.display = open ? "block" : "none";
      topBarPin(open);
      textEntryCount = Math.max(0, textEntryCount + (open ? 1 : -1));
      if (open) renderPanel();
    };
  }

  function showSpectator(msg, isCoOp) {
    const local = msg.local || 0;
    const boxId = "spectatorOverlay" + local;
    const box = overlayBox(boxId);
    const label = local === 0 ? "" : "P" + (local + 1) + " ";
    if (isCoOp) {
      // Non-blocking corner notice: with couch co-op, one local seat can be
      // queued as a spectator while the OTHER seat on the same connection
      // is still actively playing, and a full-screen block would wrongly
      // cover that seat's board too.
      box.style.cssText = "position:fixed;bottom:20px;" + (local === 0 ? "left:20px;" : "right:20px;") +
        "background:transparent;z-index:9998;";
    } else {
      box.style.background = "rgba(0,0,0,0.6)";
    }
    box.innerHTML =
      "<div style=\"background:#141414;border:1px solid #444;padding:" + (isCoOp ? "14px 18px" : "20px") + ";text-align:center;font-family:monospace;color:#ddd;\">" +
      "<div style=\"font-size:" + (isCoOp ? "15px" : "18px") + ";\">" + label + "Spectating</div>" +
      "<div style=\"margin-top:8px;color:#9cf;\">Queue position: " + (msg.queuePos || "-") + " of " + (msg.queueLen || "-") + "</div>" +
      (msg.disconnectMs ? "<div style=\"margin-top:8px;color:#f88;\">Idle disconnect in " + Math.round(msg.disconnectMs / 1000) + "s</div>" : "") +
      "</div>";
    document.body.appendChild(box);
    setTimeout(() => { const b = document.getElementById(boxId); if (b) b.remove(); }, 2500);
  }

  function offerJoin(msg, onAccept, isCoOp) {
    const local = msg.local || 0;
    const boxId = "joinOverlay" + local;
    const box = overlayBox(boxId);
    const label = local === 0 ? "" : "P" + (local + 1) + " ";
    if (isCoOp) {
      // Non-blocking corner prompt, same reasoning as showSpectator: this
      // offer is per local seat, and the OTHER seat on this connection may
      // still be actively playing and must not have its board covered.
      box.style.cssText = "position:fixed;bottom:20px;" + (local === 0 ? "left:20px;" : "right:20px;") +
        "background:transparent;z-index:9998;";
    }
    const end = Date.now() + (msg.acceptMs || 10000);
    const countdownId = "joinCountdown" + local;
    const btnId = "joinBtn" + local;
    box.innerHTML =
      "<div style=\"background:#10240f;border:1px solid #3a3;padding:" + (isCoOp ? "16px 20px" : "24px") + ";text-align:center;font-family:monospace;color:#dfd;\">" +
      "<div style=\"font-size:" + (isCoOp ? "15px" : "18px") + ";\">" + label + "A slot is open</div>" +
      "<div style=\"margin:" + (isCoOp ? "6px 0;font-size:12px;" : "8px 0;") + "\">Join in <span id=\"" + countdownId + "\">10</span>s</div>" +
      "<div><button id=\"" + btnId + "\" style=\"background:#2a5;color:#031;border:1px solid #6f6;padding:" + (isCoOp ? "6px 14px;font-size:14px;" : "8px 18px;font-size:16px;") + "cursor:pointer;font-family:monospace;\">JOIN NOW</button></div>" +
      "</div>";
    document.body.appendChild(box);
    let done = false;
    const finish = accepted => {
      if (done) return;
      done = true;
      clearInterval(t);
      box.remove();
      if (accepted) onAccept();
    };
    document.getElementById(btnId).onclick = () => finish(true);
    const t = setInterval(() => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      const el = document.getElementById(countdownId);
      if (el) el.textContent = String(left);
      if (left <= 0) finish(false);
    }, 250);
  }

  // Phase 3: couch co-op. A button in the top bar that requests a second
  // local player (WASD) on the same connection. Disabled once clicked;
  // re-enabled if the server refuses (denial toast below).
  function initCoOp(onRequest) {
    if (document.getElementById("coopBtn")) return;
    const btn = document.createElement("button");
    btn.id = "coopBtn";
    btn.textContent = "+ Add Player 2 (or just press WASD)";
    btn.style.cssText = "background:#222;color:#6cf;border:1px solid #666;font-family:monospace;font-size:12px;padding:4px 8px;cursor:pointer;";
    btn.onclick = () => {
      btn.disabled = true;
      btn.textContent = "Player 2 requested...";
      onRequest();
    };
    topBar().appendChild(btn);
  }
  function coOpJoined() {
    const btn = document.getElementById("coopBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Player 2 (WASD) active"; }
  }
  // P2's seat is gone (left via the Leave button): restore the add/play
  // button so clicking it -- or just pressing WASD -- can re-request a seat.
  // Idempotent; called on every state where seat 1 is a null hole.
  function coOpLeft() {
    const btn = document.getElementById("coopBtn");
    if (btn && btn.disabled) { btn.disabled = false; btn.textContent = "+ Add Player 2 (or just press WASD)"; }
  }

  // ---- Leave buttons + rejoin menu -----------------------------------
  // One "Leave" button per existing local seat, kept in sync with the
  // server's view of our seats on every state broadcast. Leaving is a full
  // exit for that seat (no spectator queue); leaving the last seat closes
  // the connection and showRejoin() takes over.
  let leaveHandler = null;
  function initLeaveButtons(onLeave) {
    leaveHandler = onLeave;
    if (document.getElementById("leaveBar")) return;
    const bar = document.createElement("div");
    bar.id = "leaveBar";
    // margin-left:auto pushes the Leave group to the bar's right edge, away
    // from the join/debug/keys buttons on the left.
    bar.style.cssText = "margin-left:auto;display:flex;gap:6px;";
    topBar().appendChild(bar);
  }
  function updateLeaveButtons(locals) {
    const bar = document.getElementById("leaveBar");
    if (!bar || !locals) return;
    const present = locals.filter(e => e);
    locals.forEach((entry, idx) => {
      const id = "leaveBtn" + idx;
      let btn = document.getElementById(id);
      if (!entry) { if (btn) btn.remove(); return; }
      if (!btn) {
        btn = document.createElement("button");
        btn.id = id;
        btn.style.cssText = "background:#2a1616;color:#f88;border:1px solid #844;font-family:monospace;font-size:12px;padding:4px 10px;cursor:pointer;";
        btn.onclick = () => { if (leaveHandler) leaveHandler(idx); };
        bar.appendChild(btn);
      }
      btn.textContent = (present.length > 1 ? "Leave (P" + (idx + 1) + ")" : "Leave");
    });
  }
  // Main menu / rejoin screen, shown whenever the connection ends (solo
  // leave, idle kick, server restart). A full reload re-runs the captcha
  // gate from a clean slate -- no idling on a dead board.
  function showRejoin() {
    if (document.getElementById("rejoinOverlay")) return;
    const box = overlayBox("rejoinOverlay");
    box.innerHTML =
      "<div style=\"background:#1a1a1a;border:1px solid #444;padding:28px;text-align:center;font-family:monospace;color:#eee;\">" +
      "<div style=\"font-size:18px;\">You left the game</div>" +
      "<div style=\"margin:10px 0;color:#999;\">Thanks for playing.</div>" +
      "<button id=\"rejoinBtn\" style=\"background:#2a5;color:#031;border:1px solid #6f6;padding:8px 18px;font-size:16px;cursor:pointer;font-family:monospace;\">Play</button>" +
      "</div>";
    document.body.appendChild(box);
    document.getElementById("rejoinBtn").onclick = () => location.reload();
  }
  function notifyJoinLocalDenied(msg) {
    const btn = document.getElementById("coopBtn");
    if (btn) { btn.disabled = false; btn.textContent = "+ Add Player 2 (WASD)"; }
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;top:34px;right:6px;z-index:9999;background:#3a1a1a;color:#f88;border:1px solid #844;font-family:monospace;font-size:12px;padding:6px 10px;max-width:220px;";
    box.textContent = "Can't add Player 2: " + (msg.reason || "unavailable");
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 3000);
  }

  let debugInfoFn = null;
  let debugToggleFn = null;
  let debugTimer = null;

  function initDebug(getInfoFn, toggleFn) {
    debugInfoFn = getInfoFn;
    debugToggleFn = toggleFn || function () {};
    if (document.getElementById("debugBtn")) return;

    const btn = document.createElement("button");
    btn.id = "debugBtn";
    btn.textContent = "DEBUG";
    btn.style.cssText = "background:#222;color:#6f6;border:1px solid #666;font-family:monospace;font-size:12px;padding:4px 8px;cursor:pointer;";
    topBar().appendChild(btn);

    const panel = document.createElement("div");
    panel.id = "debugPanel";
    panel.style.cssText = "position:fixed;top:34px;left:6px;z-index:9999;display:none;width:360px;max-height:70vh;overflow:auto;background:rgba(0,0,0,0.9);color:#ddd;border:1px solid #666;font-family:monospace;font-size:11px;padding:8px;white-space:pre-wrap;";
    document.body.appendChild(panel);

    btn.onclick = () => {
      const open = panel.style.display === "none";
      panel.style.display = open ? "block" : "none";
      topBarPin(open); // keep the fading bar up while its panel is open
      debugToggleFn(open);
      if (open) {
        renderDebug();
        debugTimer = setInterval(renderDebug, 250);
      } else if (debugTimer) {
        clearInterval(debugTimer);
        debugTimer = null;
      }
    };
  }
  function renderDebug() {
    const panel = document.getElementById("debugPanel");
    if (!panel || !debugInfoFn) return;
    const info = debugInfoFn() || {};
    const b = info.builds || {};
    const lines = [];
    lines.push("== CLIENT BUILDS ==");
    ["net", "predict", "render", "ui", "main"].forEach(k => {
      lines.push("  " + k + ": " + (b[k] || "MISSING (stale deploy?)"));
    });
    lines.push("");
    lines.push("== SERVER ==");
    lines.push("  build:  " + (info.serverBuild || "unknown"));
    lines.push("  seq:    " + (info.seq == null ? "-" : info.seq));
    lines.push("  tickMs: " + (info.tickMs == null ? "-" : info.tickMs));
    lines.push("  role:   " + (info.role || "-"));
    lines.push("  boostSpeed: " + (info.boostSpeed == null ? "-" : info.boostSpeed));
    lines.push("  driftMs:    " + (info.driftMs == null ? "-" : info.driftMs));
    lines.push("  rampMs:     " + (info.rampMs == null ? "-" : info.rampMs));
    lines.push("  holdGraceMs:" + (info.holdGraceMs == null ? "-" : info.holdGraceMs));
    const locals = info.locals || [];
    locals.forEach(loc => {
      lines.push("");
      const status = [loc.label.toUpperCase(), "slot " + (loc.slot == null ? "-" : loc.slot)];
      if (loc.boost) status.push("BOOST");
      if (loc.isDrifting) status.push("DRIFTING");
      if (loc.isPressingActivation) status.push("PRESSING-ACTIVATE");
      lines.push("== " + status.join(" | ") + " ==");
      if (loc.heldPowerup) lines.push("  held:   " + loc.heldPowerup);
      if (loc.activePowerup) lines.push("  active: " + loc.activePowerup);
      lines.push("-- PENDING INPUTS --");
      const pend = loc.pending || [];
      if (pend.length === 0) lines.push("  none");
      else pend.forEach(x => lines.push("  #" + x.seq + " " + x.dir + " retries=" + x.retries));
      lines.push("-- SERVER CORRECTIONS (" + (loc.correctionCount || 0) + " total) --");
      const c = loc.corrections || [];
      if (c.length === 0) lines.push("  none");
      else c.slice().reverse().forEach(x => {
        lines.push("  seq " + (x.seq == null ? "-" : x.seq) + " [" + x.type + "] pred(" +
          x.predicted.x + "," + x.predicted.y + ") -> act(" + x.actual.x + "," + x.actual.y + ")");
      });
    });
    panel.textContent = lines.join("\n");
  }

  // ---- Keybind remap panel (top bar, next to DEBUG) -- rebind each seat's
  // activation key, or swap which local index uses WASD vs. arrows. 100%
  // client-side; getKeyMapsFn/saveKeyMapFn/swapFn are main.js's
  // localStorage-backed KEY_MAPS accessors -- this module has no opinion on
  // persistence, it only drives the UI.
  function initKeymapPanel(getKeyMapsFn, saveKeyMapFn, swapFn) {
    if (document.getElementById("keymapBtn")) return;
    const btn = document.createElement("button");
    btn.id = "keymapBtn";
    btn.textContent = "KEYS";
    btn.style.cssText = "background:#222;color:#fc6;border:1px solid #666;font-family:monospace;font-size:12px;padding:4px 8px;cursor:pointer;";
    topBar().appendChild(btn);

    const panel = document.createElement("div");
    panel.id = "keymapPanel";
    panel.style.cssText = "position:fixed;top:34px;left:76px;z-index:9999;display:none;width:260px;background:rgba(0,0,0,0.9);color:#ddd;border:1px solid #666;font-family:monospace;font-size:12px;padding:10px;";
    document.body.appendChild(panel);

    let capturing = null; // local index currently waiting for a keypress, or null
    function renderPanel() {
      const maps = getKeyMapsFn();
      panel.innerHTML = "";
      maps.forEach((map, idx) => {
        const row = document.createElement("div");
        row.style.cssText = "margin-bottom:8px;";
        const label = document.createElement("div");
        label.textContent = "P" + (idx + 1) + " activate: " + (capturing === idx ? "press a key..." : map.activate);
        row.appendChild(label);
        const rebindBtn = document.createElement("button");
        rebindBtn.textContent = "Rebind";
        rebindBtn.style.cssText = "margin-top:4px;background:#333;color:#eee;border:1px solid #666;padding:2px 8px;cursor:pointer;font-family:monospace;font-size:11px;";
        rebindBtn.onclick = () => { capturing = idx; renderPanel(); };
        row.appendChild(rebindBtn);
        panel.appendChild(row);
      });
      const swapBtn = document.createElement("button");
      swapBtn.textContent = "Swap P1/P2 controls (Arrows <-> WASD)";
      swapBtn.style.cssText = "margin-top:6px;background:#333;color:#eee;border:1px solid #666;padding:4px 8px;cursor:pointer;font-family:monospace;font-size:11px;width:100%;";
      swapBtn.onclick = () => { swapFn(); renderPanel(); };
      panel.appendChild(swapBtn);
    }
    // Capture phase, ahead of main.js's own (bubble-phase) keydown handler,
    // so a keypress used to rebind is never ALSO processed as movement/
    // activate by the game itself.
    document.addEventListener("keydown", e => {
      if (capturing == null) return;
      const maps = getKeyMapsFn();
      const newMap = Object.assign({}, maps[capturing], { activate: e.code });
      saveKeyMapFn(capturing, newMap);
      capturing = null;
      e.preventDefault();
      e.stopPropagation();
      renderPanel();
    }, true);
    btn.onclick = () => {
      const open = panel.style.display === "none";
      panel.style.display = open ? "block" : "none";
      topBarPin(open); // keep the fading bar up while its panel is open
      if (open) renderPanel();
    };
  }

  // ---- Powerup reference button (top bar, next to KEYS/INITIALS) -- toggles
  // the #powerupRef dropdown that setPowerupInfo already fills from the same
  // POWERUP_INFO the gate uses (v3.6.7). Replaces the old hover-to-reveal
  // panel so checking what a pickup does is an explicit press, consistent with
  // Leave/KEYS/INITIALS. Content lives in the DOM (index.html #powerupRef);
  // this only owns the button and the show/hide.
  function initPowerupRefButton() {
    if (document.getElementById("powerupRefBtn")) return;
    const ref = document.getElementById("powerupRef");
    if (!ref) return;
    const btn = document.createElement("button");
    btn.id = "powerupRefBtn";
    btn.textContent = "POWERUPS";
    btn.style.cssText = "background:#222;color:#c9f;border:1px solid #666;font-family:monospace;font-size:12px;padding:4px 8px;cursor:pointer;";
    topBar().appendChild(btn);
    btn.onclick = () => {
      const open = ref.style.display !== "block";
      ref.style.display = open ? "block" : "none";
      topBarPin(open); // keep the fading bar up while the panel is open
    };
  }

  // ---- Kill feed (v3.6.8) ----------------------------------------------
  // Server queues one event per death (server-rust/src/lifecycle.rs
  // handle_death, one-shot like explosions -- see server-rust/src/net.rs)
  // with cause "body" (a
  // credited kill), "wall"/"obstacle"/"self" (no killer -- "obstacle" is a
  // grid-decay wall, v3.8.0), or "headon" (mutual, credit stripped by
  // clearMutualKills). This turns each into a fading DOM line in
  // #killFeed (index.html), color-coded: a credited "body" kill uses the
  // KILLER's snake color so the feed also reads who's doing the killing at a
  // glance; wall/self/headon have no killer to credit, so they use the
  // VICTIM's own color instead. Rivalry escalation (server-tallied
  // killer->victim count, S.rivalries) only applies to credited kills.
  function killFeedLine(ev) {
    if (ev.cause === "body" && ev.killer) {
      let text = ev.killer + " killed " + ev.victim;
      const n = ev.rivalryCount || 1;
      if (n >= 5) text += " -- DOMINATING (x" + n + ")";
      else if (n >= 3) text += " -- RIVALRY (x" + n + ")";
      else if (n >= 2) text += " (x" + n + ")";
      return { text, color: ev.killerColor && ev.killerColor.head };
    }
    const suffix = ev.cause === "wall" ? " hit the wall"
      : ev.cause === "obstacle" ? " hit an obstacle"
      : ev.cause === "self" ? " ran into itself"
      : ev.cause === "headon" ? " collided head-on"
      : " died";
    return { text: ev.victim + suffix, color: ev.victimColor && ev.victimColor.head };
  }
  // Caps the number of simultaneously visible lines so a multi-kill tick (or
  // a laggy tab) can't pile up an unbounded stack -- oldest just drops early.
  const KILL_FEED_MAX_LINES = 6;
  const KILL_FEED_LINGER_MS = 4000;
  function pushKillFeed(events) {
    const el = document.getElementById("killFeed");
    if (!el) return;
    for (const ev of events) {
      const { text, color } = killFeedLine(ev);
      const line = document.createElement("div");
      line.className = "kf-line";
      line.style.borderLeftColor = color || "#888";
      line.textContent = text;
      el.appendChild(line);
      requestAnimationFrame(() => line.classList.add("show"));
      setTimeout(() => {
        line.classList.add("fade");
        setTimeout(() => line.remove(), 300);
      }, KILL_FEED_LINGER_MS);
      while (el.children.length > KILL_FEED_MAX_LINES) el.removeChild(el.firstChild);
    }
  }

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

  // On-page build stamp for cache-bust confirmation. Only revealed when the
  // server reports debug is on (main.js passes cfg.enableDebug); it lists the
  // server build plus the self-registered per-file client stamps, so a stale
  // ui.js or index.html shows up immediately after a deploy/refresh.
  function showVersionStamp(enableDebug, serverBuild) {
    const el = document.getElementById("versionStamp");
    if (!el) return;
    if (enableDebug === false) { el.style.display = "none"; return; }
    const b = window.__BUILDS__ || {};
    el.textContent = [
      serverBuild || "server ?",
      b.index || "index ?",
      b.ui || "ui ?"
    ].join("  ·  ");
    el.style.display = "block";
  }

  return { initCaptchaGate, setConnectionStatus, updateStatus, updateLeaderboards,
           promptInitials, initInitialsPanel, isTextEntryActive,
           showSpectator, offerJoin, initDebug, showVersionStamp,
           initCoOp, coOpJoined, coOpLeft, notifyJoinLocalDenied,
           initLeaveButtons, updateLeaveButtons, showRejoin, initKeymapPanel,
           initPowerupRefButton, setPowerupInfo, initTouchControls, initMobileUiToggle,
           pushKillFeed };
})();
