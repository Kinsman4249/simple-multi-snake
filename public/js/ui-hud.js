// ============================================================
// Always-visible HUD text: connection status line, high score lists, the
// kill feed, and the debug build-stamp footer. Depends on ui-core.js's
// `statusEl`.
// ============================================================
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

Object.assign(UI, { setConnectionStatus, updateStatus, updateLeaderboards, pushKillFeed, showVersionStamp });
