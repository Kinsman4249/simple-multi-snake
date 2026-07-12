// ============================================================
// Non-engine UI: the captcha join gate, the status line, the two high
// score lists, the arcade initials prompt, and a DEBUG button/panel that
// shows client+server build stamps and recent server corrections.
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).ui = "ui 2026-07-12.5";
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

  function setConnectionStatus(text) {
    statusEl.textContent = text;
  }

  function updateStatus(curr) {
    if (curr.you.role === "player") {
      const me = curr.players[curr.you.slot];
      statusEl.textContent = "You: slot " + (curr.you.slot + 1) + " | score " +
        (me ? me.score : 0) + (me && !me.alive ? " | waiting to respawn" : "");
    } else {
      statusEl.textContent = "Spectating. Position in queue: " +
        curr.you.queuePos + " of " + curr.you.queueLen;
    }
  }

  function updateLeaderboards(hs) {
    const fmt = list => list.map(e => "<li>" + e.initials + " - " + e.score + "</li>").join("");
    document.getElementById("dailyList").innerHTML = fmt(hs.daily);
    document.getElementById("allTimeList").innerHTML = fmt(hs.allTime);
  }

  function askInitials(targets, score) {
    const box = document.createElement("div");
    box.id = "initialsOverlay";
    box.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;";
    box.innerHTML =
      "<div style=\"background:#1a1a1a;border:1px solid #444;padding:24px;text-align:center;\">" +
      "<div>New high score: " + score + "</div>" +
      "<div><input id=\"initialsInput\" maxlength=\"3\" style=\"background:#000;color:#6f6;border:1px solid #666;font-family:monospace;font-size:20px;text-align:center;width:4ch;margin-top:10px;\"></div>" +
      "<div><button id=\"initialsSubmit\" style=\"background:#333;color:#eee;border:1px solid #666;padding:6px 14px;margin-top:10px;cursor:pointer;font-family:monospace;\">Submit</button></div>" +
      "</div>";
    document.body.appendChild(box);
    document.getElementById("initialsInput").focus();
    document.getElementById("initialsSubmit").onclick = () => {
      const value = document.getElementById("initialsInput").value || "AAA";
      Net.send({ type: "initials", value, score, targets });
      box.remove();
    };
  }

  let debugInfoFn = null;
  let debugTimer = null;

  function initDebug(getInfoFn) {
    debugInfoFn = getInfoFn;
    if (document.getElementById("debugBtn")) return;

    const btn = document.createElement("button");
    btn.id = "debugBtn";
    btn.textContent = "DEBUG";
    btn.style.cssText = "position:fixed;top:6px;left:6px;z-index:9999;background:#222;color:#6f6;border:1px solid #666;font-family:monospace;font-size:12px;padding:4px 8px;cursor:pointer;";
    document.body.appendChild(btn);

    const panel = document.createElement("div");
    panel.id = "debugPanel";
    panel.style.cssText = "position:fixed;top:34px;left:6px;z-index:9999;display:none;width:340px;max-height:70vh;overflow:auto;background:rgba(0,0,0,0.9);color:#ddd;border:1px solid #666;font-family:monospace;font-size:11px;padding:8px;white-space:pre-wrap;";
    document.body.appendChild(panel);

    btn.onclick = () => {
      const open = panel.style.display === "none";
      panel.style.display = open ? "block" : "none";
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
    lines.push("== SERVER CORRECTIONS (" + (info.correctionCount || 0) + " total) ==");
    const c = info.corrections || [];
    if (c.length === 0) {
      lines.push("  none");
    } else {
      c.slice().reverse().forEach(x => {
        lines.push("  seq " + (x.seq == null ? "-" : x.seq) + " [" + x.type + "] pred(" +
          x.predicted.x + "," + x.predicted.y + ") -> act(" + x.actual.x + "," + x.actual.y + ")");
      });
    }
    panel.textContent = lines.join("\n");
  }

  return { initCaptchaGate, setConnectionStatus, updateStatus, updateLeaderboards, askInitials, initDebug };
})();
