// ============================================================
// Keybind remap (Phase 4): 100% client-side, localStorage-persisted, never
// sent to the server (the server only ever needs to know WHICH local index
// activated, not the physical key). "activate" is a distinct action, not a
// movement direction, stored per-seat alongside up/down/left/right -- it is
// looked up against e.code (e.g. "Space", "ShiftRight") rather than e.key so
// left/right Shift can be told apart, which e.key cannot do.
// ============================================================
const KEYMAP_STORAGE_PREFIX = "snake.keymap.local";
const DEFAULT_KEY_MAPS = [
  // p1 plays with the arrow keys (right side of the keyboard), so its activate
  // key is Right Shift (right there by the arrows). p2 plays WASD (left side)
  // and activates with Space -- easy reach for the left hand. (Swapped
  // 2026-07-16: the old p1=Space/p2=RightShift mapping was the source of the
  // "speed boost won't activate" confusion.)
  { arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", activate: "ShiftRight" }, // local 0 (p1): arrows
  { w: "up", s: "down", a: "left", d: "right", activate: "Space" }                                      // local 1 (p2): WASD
];
function loadKeyMaps() {
  const maps = [];
  for (let i = 0; i < DEFAULT_KEY_MAPS.length; i++) {
    let map = null;
    try {
      const raw = localStorage.getItem(KEYMAP_STORAGE_PREFIX + i);
      // JSON.parse turns the saved JSON text back into a real JS object
      // (see docs/JS-CHEATSHEET.md).
      if (raw) map = JSON.parse(raw);
    } catch (_) { /* localStorage unavailable or corrupt entry: fall back to default */ }
    // `map || Object.assign({}, DEFAULT_KEY_MAPS[i])`: use the saved map if
    // we got one, otherwise make a COPY of the default (Object.assign into a
    // fresh {} so callers can't accidentally mutate the shared default --
    // see docs/JS-CHEATSHEET.md).
    maps.push(map || Object.assign({}, DEFAULT_KEY_MAPS[i]));
  }
  return maps;
}
function saveKeyMap(localIdx, map) {
  KEY_MAPS[localIdx] = map;
  // JSON.stringify converts the map object to JSON text for storage (see
  // docs/JS-CHEATSHEET.md); JSON.parse (above) reverses it on load.
  try { localStorage.setItem(KEYMAP_STORAGE_PREFIX + localIdx, JSON.stringify(map)); } catch (_) {}
}
// Swaps which local index uses WASD vs. arrows -- movement keys only, each
// seat keeps its OWN activation key rebind across the swap.
function swapKeyMaps() {
  const a = KEY_MAPS[0], b = KEY_MAPS[1];
  // `m => { ... }` is an arrow function stored in a variable (see
  // docs/JS-CHEATSHEET.md). `for (const k in m)` loops over an object's own
  // property names (keys), unlike `for...of` which loops over an
  // array's/iterable's values.
  const moveOnly = m => { const o = {}; for (const k in m) if (k !== "activate") o[k] = m[k]; return o; };
  saveKeyMap(0, Object.assign({ activate: a.activate }, moveOnly(b)));
  saveKeyMap(1, Object.assign({ activate: b.activate }, moveOnly(a)));
}
const KEY_MAPS = loadKeyMaps();
