// ============================================================
// Non-engine UI: captcha gate, status line, high score lists, initials
// prompt with countdown, spectator overlay, explicit JOIN offer button,
// and a DEBUG button/panel (recording enabled only while open).
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).ui = "ui 2026-07-12.8";
const UI = (() => {
  const statusEl = document.getElementById("status");
  let captchaId = null;

  async function loadCaptcha() {
    const res = await fetch("/api/captcha");
    const data = await res.json();
    captchaId = data.id;
    document.getElementById("captchaQuestion").textContent = data.a + " + " + data.b + " = ?";
  }
  function initCaptchaGate(onSuccess) {
    loadCaptcha();
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
    if (curr.you.role === "player") {
      const me = curr.players[curr.you.slot];
      statusEl.textContent = "You: slot " + (curr.you.slot + 1) + " | score " +
        (me ? me.score : 0) + (me && !me.alive ? " | waiting" : "");
    } else {
      statusEl.textContent = "Spectating. Queue position: " +
        curr.you.queuePos + " of " + curr.you.queueLen;
    }
  }
  function updateLeaderboards(hs) {
    const fmt = list => list.map(e => "<li>" + e.initials + " - " + e.score + "</li>").join("");
    document.getElementById("dailyList").innerHTML = fmt(hs.daily);
    document.getElementById("allTimeList").innerHTML = fmt(hs.allTime);
  }

  function overlayBox(id) {
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    const box = document.createElement("div");
    box.id = id;
    box.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:9998;";
    return box;
  }

  function askInitials(targets, score, deadlineMs) {
    const box = overlayBox("initialsOverlay");
    const end = Date.now() + (deadlineMs || 20000);
    box.innerHTML =
      "<div style=\"background:#1a1a1a;border:1px solid #444;padding:24px;text-align:center;font-family:monospace;color:#eee;\">" +
      "<div>New high score: " + score + "</div>" +
      "<div style=\"margin:8px 0;color:#fa6;\">Enter initials before <span id=\"initCountdown\">20</span>s or you become a spectator</div>" +
      "<div><input id=\"initialsInput\" maxlength=\"3\" style=\"background:#000;color:#6f6;border:1px solid #666;font-family:monospace;font-size:20px;text-align:center;width:4ch;\"></div>" +
      "<div><button id=\"initialsSubmit\" style=\"background:#333;color:#eee;border:1px solid #666;padding:6px 14px;margin-top:10px;cursor:pointer;font-family:monospace;\">Submit</button></div>" +
      "</div>";
    document.body.appendChild(box);
    document.getElementById("initialsInput").focus();
    let done = false;
    const submit = () => {
      if (done) return;
      done = true;
      clearInterval(t);
      const value = (document.getElementById("initialsInput").value || "AAA").toUpperCase();
      Net.send({ type: "initials", value, score, targets });
      box.remove();
    };
    document.getElementById("initialsSubmit").onclick = submit;
    const t = setInterval(() => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      const el = document.getElementById("initCountdown");
      if (el) el.textContent = String(left);
      if (left <= 0) submit();
    }, 250);
  }

  function showSpectator(msg) {
    const box = overlayBox("spectatorOverlay");
    box.style.background = "rgba(0,0,0,0.6)";
    box.innerHTML =
      "<div style=\"background:#141414;border:1px solid #444;padding:20px;text-align:center;font-family:monospace;color:#ddd;\">" +
      "<div style=\"font-size:18px;\">Spectating</div>" +
      "<div style=\"margin-top:8px;color:#9cf;\">Queue position: " + (msg.queuePos || "-") + " of " + (msg.queueLen || "-") + "</div>" +
      (msg.disconnectMs ? "<div style=\"margin-top:8px;color:#f88;\">Idle disconnect in " + Math.round(msg.disconnectMs / 1000) + "s</div>" : "") +
      "</div>";
    document.body.appendChild(box);
    setTimeout(() => { const b = document.getElementById("spectatorOverlay"); if (b) b.remove(); }, 2500);
  }

  function offerJoin(msg, onAccept) {
    const box = overlayBox("joinOverlay");
    const end = Date.now() + (msg.acceptMs || 10000);
    box.innerHTML =
      "<div style=\"background:#10240f;border:1px solid #3a3;padding:24px;text-align:center;font-family:monospace;color:#dfd;\">" +
      "<div style=\"font-size:18px;\">A slot is open</div>" +
      "<div style=\"margin:8px 0;\">Join in <span id=\"joinCountdown\">10</span>s</div>" +
      "<div><button id=\"joinBtn\" style=\"background:#2a5;color:#031;border:1px solid #6f6;padding:8px 18px;font-size:16px;cursor:pointer;font-family:monospace;\">JOIN NOW</button></div>" +
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
    document.getElementById("joinBtn").onclick = () => finish(true);
    const t = setInterval(() => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      const el = document.getElementById("joinCountdown");
      if (el) el.textContent = String(left);
      if (left <= 0) finish(false);
    }, 250);
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
    btn.style.cssText = "position:fixed;top:6px;left:6px;z-index:9999;background:#222;color:#6f6;border:1px solid #666;font-family:monospace;font-size:12px;padding:4px 8px;cursor:pointer;";
    document.body.appendChild(btn);

    const panel = document.createElement("div");
    panel.id = "debugPanel";
    panel.style.cssText = "position:fixed;top:34px;left:6px;z-index:9999;display:none;width:360px;max-height:70vh;overflow:auto;background:rgba(0,0,0,0.9);color:#ddd;border:1px solid #666;font-family:monospace;font-size:11px;padding:8px;white-space:pre-wrap;";
    document.body.appendChild(panel);

    btn.onclick = () => {
      const open = panel.style.display === "none";
      panel.style.display = open ? "block" : "none";
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
    lines.push("  role:   " + (info.role || "-") + "   slot: " + (info.slot == null ? "-" : info.slot));
    lines.push("");
    lines.push("== PENDING INPUTS ==");
    const pend = info.pending || [];
    if (pend.length === 0) lines.push("  none");
    else pend.forEach(x => lines.push("  #" + x.seq + " " + x.dir + " retries=" + x.retries + (x.confirmed ? " CONFIRMED" : " pending")));
    lines.push("");
    lines.push("== SERVER CORRECTIONS (" + (info.correctionCount || 0) + " total) ==");
    const c = info.corrections || [];
    if (c.length === 0) lines.push("  none");
    else c.slice().reverse().forEach(x => {
      lines.push("  seq " + (x.seq == null ? "-" : x.seq) + " [" + x.type + "] pred(" +
        x.predicted.x + "," + x.predicted.y + ") -> act(" + x.actual.x + "," + x.actual.y + ")");
    });
    panel.textContent = lines.join("\n");
  }

  return { initCaptchaGate, setConnectionStatus, updateStatus, updateLeaderboards,
           askInitials, showSpectator, offerJoin, initDebug };
})();
