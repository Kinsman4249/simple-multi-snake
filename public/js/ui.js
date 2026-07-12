// ============================================================
// Non-engine UI: the captcha join gate, the status line, the two
// high score lists, and the arcade-style initials entry prompt.
// Kept separate from net/predict/render so those three stay focused
// on the game engine itself.
// ============================================================
const UI = (() => {
  const statusEl = document.getElementById("status");
  let captchaId = null;

  async function loadCaptcha() {
    const res = await fetch("/api/captcha");
    const data = await res.json();
    captchaId = data.id;
    document.getElementById("captchaQuestion").textContent = data.a + " + " + data.b + " = ?";
  }

  // Wires the captcha overlay's submit button. Calls onSuccess(token)
  // once verified and removes the overlay.
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
      const { token } = await res.json();
      document.getElementById("overlay").remove();
      onSuccess(token);
    };
  }

  function setConnectionStatus(text) {
    statusEl.textContent = text;
  }

  function updateStatus(curr) {
    if (curr.you.role === "player") {
      const me = curr.players[curr.you.slot];
      statusEl.textContent = "You: slot " + (curr.you.slot + 1) + " | score " + (me ? me.score : 0) +
        (me && !me.alive ? " | waiting to respawn" : "");
    } else {
      statusEl.textContent = "Spectating. Position in queue: " + curr.you.queuePos + " of " + curr.you.queueLen;
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
      '<div style="background:#1a1a1a;border:1px solid #444;padding:24px;text-align:center;">' +
      "<div>New high score: " + score + "</div>" +
      '<input id="initialsInput" maxlength="3" style="background:#000;color:#6f6;border:1px solid #666;font-family:monospace;font-size:24px;text-align:center;width:4ch;margin-top:10px;text-transform:uppercase;">' +
      '<div><button id="initialsSubmit" style="background:#333;color:#eee;border:1px solid #666;padding:6px 14px;margin-top:10px;cursor:pointer;font-family:monospace;">Submit</button></div>' +
      "</div>";
    document.body.appendChild(box);
    document.getElementById("initialsInput").focus();
    document.getElementById("initialsSubmit").onclick = () => {
      const value = document.getElementById("initialsInput").value || "AAA";
      Net.send({ type: "initials", value, score, targets });
      box.remove();
    };
  }

  return { initCaptchaGate, setConnectionStatus, updateStatus, updateLeaderboards, askInitials };
})();
