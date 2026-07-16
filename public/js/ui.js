// ============================================================
// Non-engine UI: captcha gate, status line, high score lists, initials
// prompt with countdown, spectator overlay, explicit JOIN offer button,
// and a DEBUG button/panel (recording enabled only while open).
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).ui = "ui 2026-07-16.2";
const UI = (() => {
  const statusEl = document.getElementById("status");
  let captchaId = null;

  async function loadCaptcha() {
    const res = await fetch("/api/captcha");
    const data = await res.json();
    captchaId = data.id;
    document.getElementById("captchaQuestion").textContent = data.a + " + " + data.b + " = ?";
  }
  // One-tap, non-blocking acknowledgement of the boost/slide tip (see
  // index.html #boostTip): hides the tip text entirely (not just dimmed --
  // dimming alone made the click look like it did nothing). Does not gate
  // Join, and is entirely independent of captcha state -- dismissing this
  // tip has nothing to do with whether the captcha has been solved yet.
  function initBoostTip() {
    const tip = document.getElementById("boostTip");
    const btn = document.getElementById("boostTipAck");
    if (!tip || !btn) return;
    btn.onclick = () => { tip.style.display = "none"; };
  }
  // Plain toggle button + popup explaining ALL powerups (see index.html
  // #powerupInfoBtn/#powerupInfoPopup). Independent of the captcha form and
  // the boost tip -- purely informational, never gates Join. The button is
  // wired up immediately so it's clickable from page load; its CONTENT is
  // filled in later by setPowerupInfo(), once main.js's /api/config fetch
  // resolves with each powerup's title/description (sourced from the
  // powerup's own JS file -- see powerups/*.js -- so this list can never
  // drift out of sync with what powerups actually exist).
  function initPowerupInfo() {
    const btn = document.getElementById("powerupInfoBtn");
    const popup = document.getElementById("powerupInfoPopup");
    if (!btn || !popup) return;
    btn.onclick = () => popup.classList.toggle("open");
  }
  // Builds the popup's content from { type: {title, description} } and
  // sizes the popup to the number of entries -- a couple of powerups gets a
  // small, tight box; many get a taller one, capped and scrollable (see the
  // max-height/overflow-y in index.html's #powerupInfoPopup rule) so it
  // never runs off the top of the screen.
  function setPowerupInfo(info, powerupsCfg) {
    const popup = document.getElementById("powerupInfoPopup");
    if (!popup) return;
    const entries = Object.values(info || {});
    if (entries.length === 0) { popup.innerHTML = "<h4>Powerups</h4>No powerups are enabled."; return; }
    popup.innerHTML = "<h4>Powerups</h4>" + entries.map(e =>
      "<div class=\"entry\"><span class=\"name\">" + e.title + ":</span> " + e.description + "</div>"
    ).join("");
    // Scale the popup's height with entry count (small list = tight box,
    // large list = taller box up to the CSS max-height/scroll fallback).
    popup.style.minHeight = Math.min(400, 40 + entries.length * 55) + "px";
    // Captcha-screen color legend (index.html #powerupLegend): swatch +
    // name per powerup so a new player knows what each pickup color means
    // before their snake ever moves. Colors come from render.js's own
    // POWERUP_STYLE (the exact draw colors); types the operator disabled
    // (powerupsCfg[type].enabled === false) are skipped -- never teach a
    // color that can't appear on this server's board.
    const legend = document.getElementById("powerupLegend");
    if (!legend) return;
    // Render is a top-level const (script load order: render.js before
    // ui.js), so it's a global binding but NOT a window property.
    const style = (typeof Render !== "undefined" && Render.POWERUP_STYLE) || {};
    legend.innerHTML = Object.keys(info || {}).filter(type => {
      const pc = powerupsCfg && powerupsCfg[type];
      return !(pc && pc.enabled === false);
    }).map(type =>
      "<span><span class=\"sw\" style=\"background:" + (style[type] || "#fff") + "\"></span>" +
      (info[type].title || type) + "</span>"
    ).join("");
  }
  function initCaptchaGate(onSuccess) {
    loadCaptcha();
    initBoostTip();
    initPowerupInfo();
    document.getElementById("captchaSubmit").onclick = async () => {
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
      onSuccess(data.token);
    };
  }
  function setConnectionStatus(text) { statusEl.textContent = text; }

  function updateStatus(curr) {
    const locals = curr.you.locals || [];
    const present = locals.filter(e => e);
    const parts = locals.map(entry => {
      if (!entry) return ""; // seat left (null hole): nothing to report
      const label = present.length > 1 ? (entry.local === 0 ? "P1" : "P2") + ": " : "You: ";
      if (entry.role === "player") {
        const me = curr.players[entry.slot];
        return label + "slot " + (entry.slot + 1) + " | score " +
          (me ? me.score : 0) + (me && !me.alive ? " | waiting" : "");
      }
      if (entry.role === "held") return label + "high score entry pending...";
      return label + "spectating (queue " + entry.queuePos + " of " + entry.queueLen + ")";
    }).filter(s => s);
    statusEl.textContent = parts.join("   ");
  }
  function updateLeaderboards(hs) {
    const fmt = list => list.map(e => "<li>" + e.initials + " - " + e.score + "</li>").join("");
    document.getElementById("dailyList").innerHTML = fmt(hs.daily);
    document.getElementById("allTimeList").innerHTML = fmt(hs.allTime);
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

  function askInitials(targets, score, deadlineMs, local, isCoOp) {
    local = local || 0;
    // Distinct id per local index: in couch co-op, p1 and p2 can die and
    // qualify for initials independently, and overlayBox() would otherwise
    // clobber the first prompt when the second one appears.
    const boxId = "initialsOverlay" + local;
    const box = overlayBox(boxId);
    const inputId = "initialsInput" + local;
    const submitId = "initialsSubmit" + local;
    const countdownId = "initCountdown" + local;
    const label = local === 0 ? "" : "P" + (local + 1) + " ";
    if (isCoOp) {
      // Non-blocking corner prompt: with round-robin seating either local
      // seat can be the one asking while the OTHER seat on this connection
      // is still actively playing, and a full block would wrongly cover
      // its board.
      box.style.cssText = "position:fixed;top:20px;" + (local === 0 ? "left:20px;" : "right:20px;") +
        "background:transparent;z-index:9998;";
    }
    const end = Date.now() + (deadlineMs || 20000);
    box.innerHTML =
      "<div style=\"background:#1a1a1a;border:1px solid #444;padding:" + (isCoOp ? "20px" : "24px") + ";text-align:center;font-family:monospace;color:#eee;\">" +
      "<div>" + label + "New high score: " + score + "</div>" +
      "<div style=\"margin:8px 0;color:#fa6;\">Enter initials before <span id=\"" + countdownId + "\">20</span>s or you become a spectator</div>" +
      "<div><input id=\"" + inputId + "\" maxlength=\"3\" style=\"background:#000;color:#6f6;border:1px solid #666;font-family:monospace;font-size:20px;text-align:center;width:4ch;\"></div>" +
      "<div><button id=\"" + submitId + "\" style=\"background:#333;color:#eee;border:1px solid #666;padding:6px 14px;margin-top:10px;cursor:pointer;font-family:monospace;\">Submit</button></div>" +
      "</div>";
    document.body.appendChild(box);
    document.getElementById(inputId).focus();
    let done = false;
    const submit = () => {
      if (done) return;
      done = true;
      clearInterval(t);
      const value = (document.getElementById(inputId).value || "AAA").toUpperCase();
      Net.send({ type: "initials", value, score, targets, local });
      box.remove();
    };
    document.getElementById(submitId).onclick = submit;
    const t = setInterval(() => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      const el = document.getElementById(countdownId);
      if (el) el.textContent = String(left);
      if (left <= 0) submit();
    }, 250);
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
    const locals = info.locals || [];
    locals.forEach(loc => {
      lines.push("");
      lines.push("== " + loc.label.toUpperCase() + " (slot " + (loc.slot == null ? "-" : loc.slot) + (loc.boost ? ", BOOST" : "") + ") ==");
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

  return { initCaptchaGate, setConnectionStatus, updateStatus, updateLeaderboards,
           askInitials, showSpectator, offerJoin, initDebug,
           initCoOp, coOpJoined, coOpLeft, notifyJoinLocalDenied,
           initLeaveButtons, updateLeaveButtons, showRejoin, initKeymapPanel,
           setPowerupInfo, initTouchControls };
})();
