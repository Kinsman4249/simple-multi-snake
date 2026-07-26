// ============================================================
// Persistent top-bar buttons + their panels: Change Initials, DEBUG, KEYS
// (keybind remap), and the POWERUPS reference toggle. Depends on
// ui-core.js's `topBar()`/`topBarPin()`, `sanitizeInitials`,
// `textEntryCount`.
// ============================================================

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
      // `() => {...}` is an arrow function; assigning it to `.onclick` wires
      // up a click handler (event-handler-property style -- see
      // docs/JS-CHEATSHEET.md).
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
  // `|| {}` falls back to an empty object if debugInfoFn() returned nothing
  // yet, so the `b.xxx` lookups below never throw (see docs/JS-CHEATSHEET.md).
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
    // Object.assign({}, a, b) builds a NEW object by copying `a`'s
    // properties onto a fresh `{}`, then `b`'s on top (so `b` wins on
    // conflicts) -- a shallow-merge that doesn't mutate `maps[capturing]`
    // (see docs/JS-CHEATSHEET.md).
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

// Publish this file's public functions onto the shared UI object.
Object.assign(UI, { initInitialsPanel, initDebug, initKeymapPanel, initPowerupRefButton });
