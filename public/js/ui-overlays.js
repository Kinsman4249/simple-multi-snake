// ============================================================
// Full-screen / corner overlay prompts: session-initials prompt, spectator
// notice, offer-to-join countdown, couch-co-op button, Leave buttons, and
// the rejoin ("you left") screen. Depends on ui-core.js's `overlayBox()`,
// `topBar()`, `sanitizeInitials`, `textEntryCount`.
// ============================================================

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
  // `() => {...}` arrow function stored in a variable so it can be reused
  // below by both the button's click handler and the Enter keypress (see
  // docs/JS-CHEATSHEET.md).
  const submit = () => {
    if (done) return;
    const value = sanitizeInitials(input.value);
    if (!value) { input.focus(); return; } // initials are required to join
    done = true;
    box.remove();
    textEntryCount = Math.max(0, textEntryCount - 1);
    onDone(value);
  };
  // Assigning a function reference to `.onclick` wires up the click handler
  // (event-handler-property style, see docs/JS-CHEATSHEET.md).
  document.getElementById(submitId).onclick = submit;
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); submit(); } });
}

function showSpectator(msg, isCoOp) {
  // `msg.local || 0` defaults to seat 0 if msg.local is missing/falsy (see
  // docs/JS-CHEATSHEET.md).
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

// Server-pushed maintenance/shutdown warning ({"type":"systemNotice","text"}).
// Spans the top of the viewport (unlike the small joinLocalDenied corner
// toast) since the point is to make sure everyone sees it in time to finish
// their run and bank a high score before the server bounces.
function showSystemNotice(msg) {
  const existing = document.getElementById("systemNoticeBanner");
  if (existing) existing.remove();
  const box = document.createElement("div");
  box.id = "systemNoticeBanner";
  box.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:10000;background:#3a2a00;color:#fc3;border-bottom:1px solid #a70;font-family:monospace;font-size:14px;padding:8px 12px;text-align:center;";
  box.textContent = msg.text || "The server is restarting for maintenance shortly.";
  document.body.appendChild(box);
}

// Publish this file's public functions onto the shared UI object (shorthand
// properties -- see docs/JS-CHEATSHEET.md).
Object.assign(UI, {
  promptInitials, showSpectator, offerJoin, initCoOp, coOpJoined, coOpLeft,
  notifyJoinLocalDenied, initLeaveButtons, updateLeaveButtons, showRejoin,
  showSystemNotice,
});
