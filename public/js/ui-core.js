// ============================================================
// UI shared infrastructure: the text-entry-lock counter, initials
// sanitizer, the fading top-menu bar, and the full-screen overlay-box
// helper. Every other ui-*.js file (loaded after this one) reads these as
// plain globals and calls `Object.assign(UI, {...})` to add its own piece
// of the UI API onto the shared `UI` object defined here.
// ============================================================
// `x || {}` is the "use x if it's already set, otherwise create a fresh
// value" default idiom (see docs/JS-CHEATSHEET.md) -- lets any script that
// loads first create window.__BUILDS__ without clobbering one another script
// already made.
(window.__BUILDS__ = window.__BUILDS__ || {}).ui = "ui 2026-07-22.1";
const UI = {};

const statusEl = document.getElementById("status");
// Count of open text-entry surfaces (captcha/initials gate, P2 initials
// prompt, Change Initials panel). While > 0, main.js's game key handlers
// early-return -- the listener-isolation rule (v3.4.0): no keystroke typed
// into a text field may reach movement/boost/seat-request handling.
let textEntryCount = 0;
function isTextEntryActive() { return textEntryCount > 0; }
function sanitizeInitials(v) {
  // Chain of built-ins: coerce to a string (in case v is null/undefined),
  // uppercase it, strip anything that isn't A-Z or 0-9 via a regex, then
  // keep only the first 3 characters.
  return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
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
  // `() => { ... }` is an arrow function -- a shorthand function used
  // constantly in this codebase for short callbacks (see
  // docs/JS-CHEATSHEET.md).
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

// Object.assign copies properties onto UI (see docs/JS-CHEATSHEET.md);
// `{ isTextEntryActive }` is object-literal shorthand for
// `{ isTextEntryActive: isTextEntryActive }` -- every ui-*.js file ends with
// a call like this to publish its functions onto the shared UI namespace.
Object.assign(UI, { isTextEntryActive });
