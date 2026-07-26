// ABGR color palette (r = low byte, a = high byte, matching a little-endian
// Uint32Array view over RGBA bytes) + the type/id -> color lookup helpers.
// Values mirror the old render.js / must stay in sync with render2d.js's
// equivalent palettes for wasm/2D pixel parity -- see the per-constant
// comments below for which render2d.js const each one mirrors.

// @ts-ignore: decorator valid in AssemblyScript
@inline
export function rgba(r: u32, g: u32, b: u32, a: u32): u32 { return r | (g << 8) | (b << 16) | (a << 24); }

export const COLOR_FOOD: u32 = rgba(0xee, 0x33, 0x33, 255);        // #e33
export const COLOR_FOOD_BOUNTY: u32 = rgba(0xff, 0xcc, 0x00, 255); // #fc0 piñata gold
// Piñata candy-burst palette (mirrors render2d.js CANDY_COLORS): gold / pink /
// cyan / lime. CANDY_N particle count must match render2d.js CANDY_N.
export const CANDY_N: i32 = 14;
export const WALLSHATTER_N: i32 = 10;
const CANDY_GOLD: u32 = rgba(0xff, 0xcc, 0x00, 255); // #ffcc00
const CANDY_PINK: u32 = rgba(0xff, 0x44, 0x99, 255); // #ff4499
const CANDY_CYAN: u32 = rgba(0x44, 0xcc, 0xff, 255); // #44ccff
const CANDY_LIME: u32 = rgba(0x77, 0xee, 0x44, 255); // #77ee44
export function candyColor(i: i32): u32 {
  const m = i & 3;
  if (m == 0) return CANDY_GOLD;
  if (m == 1) return CANDY_PINK;
  if (m == 2) return CANDY_CYAN;
  return CANDY_LIME;
}
export const COLOR_TRAIL_ICE: u32 = rgba(150, 225, 255, 166);      // rgba(150,225,255,0.65)
export const COLOR_TRAIL_POISON: u32 = rgba(110, 210, 70, 153);    // rgba(110,210,70,0.6)
export const COLOR_TRAIL_BANANA: u32 = rgba(255, 221, 68, 153);    // rgba(255,221,68,0.6)
export const COLOR_TRAIL_FALLBACK: u32 = rgba(255, 255, 255, 51);  // rgba(255,255,255,0.2)
export const COLOR_SHELL: u32 = rgba(0x11, 0x44, 0xee, 255);       // #14e deep royal blue (v3.6.2)
export const COLOR_SHELL_HILIGHT: u32 = rgba(0xdd, 0xff, 0xff, 255); // #dff
export const COLOR_JETSTREAM: u32 = rgba(0x99, 0xdd, 0xff, 255);   // #9df
export const COLOR_DUST: u32 = rgba(0xcc, 0xcc, 0xcc, 255);        // #ccc
export const COLOR_WHITE: u32 = rgba(255, 255, 255, 255);
export const COLOR_BLACK: u32 = rgba(0, 0, 0, 255);
export const COLOR_BANANA_BODY: u32 = rgba(0xff, 0xdd, 0x44, 255); // #fd4
export const COLOR_BANANA_TIP: u32 = rgba(0xaa, 0x77, 0x00, 255);  // #a70
export const COLOR_BANANA_SPOT: u32 = rgba(0x66, 0x33, 0x00, 255); // #630 ripeness speckle
export const COLOR_SCISSORS_BLADE: u32 = rgba(0xdd, 0xdd, 0xee, 255); // #dde
export const COLOR_SCISSORS_TIP: u32 = rgba(0xff, 0xff, 0xff, 255);   // #fff
export const COLOR_SCISSORS_PIVOT: u32 = rgba(0x33, 0x33, 0x33, 255); // #333
export const COLOR_SCISSORS_HANDLE: u32 = rgba(0xee, 0x33, 0x33, 255); // #e33
// Scissors wall-shatter debris palette (v4.5.0): stone/gray, distinct from
// the pinata candy-burst gold/pink/cyan/lime above so "wall breaking" never
// reads as "food bursting." Must mirror render2d.js DEBRIS_COLORS exactly.
const DEBRIS_1: u32 = rgba(0x99, 0x99, 0x99, 255); // #999
const DEBRIS_2: u32 = rgba(0x77, 0x55, 0x33, 255); // #753
const DEBRIS_3: u32 = rgba(0x55, 0x55, 0x55, 255); // #555
const DEBRIS_4: u32 = rgba(0x44, 0x22, 0x00, 255); // #420
export function debrisColor(i: i32): u32 {
  const m = i & 3;
  if (m == 0) return DEBRIS_1;
  if (m == 1) return DEBRIS_2;
  if (m == 2) return DEBRIS_3;
  return DEBRIS_4;
}
// Grid decay / anti-turtling obstacles (v3.8.1): the solid state is a
// pixel-art spike trap (see spikeVal/spikeColor below), not a flat fill --
// a plain gray square read as just another powerup pickup (maintainer
// feedback on v3.8.0). The warn (telegraph) state was a translucent flat
// orange full-tile fill; recolored/reshaped to a small red "!"
// (see warnVal/warnColor in art.ts) since the flat orange read too close to
// the speedBoost powerup tint (#f50). Must mirror render2d.js
// WALL_WARN_COLORS exactly.
export const WALL_WARN_1: u32 = rgba(0xff, 0x33, 0x33, 255); // bright core
export const WALL_WARN_2: u32 = rgba(0x99, 0x00, 0x00, 255); // dark shade
export const WALL_SPIKE_1: u32 = rgba(0x9a, 0x9a, 0x9a, 255); // mid-gray body
export const WALL_SPIKE_2: u32 = rgba(0xee, 0xee, 0xee, 255); // bright tip highlight
export const WALL_SPIKE_3: u32 = rgba(0x4a, 0x4a, 0x4a, 255); // dark shadow/gap

// Pickup colors by type index (must match the facade's POWERUP_TYPE_INDEX
// order): 0 wormhole #a3f, 1 growthSpurt #fe0, 2 iceTrail #9df,
// 3 poisonTrail #4a2, 4 speedBoost #f50, 5 blueShell #14e,
// 6 bananaTrail #fd4, 7 helloWorld #0ff. growthSpurt/speedBoost recolored in
// v3.6.2 for contrast (vivid yellow vs hot red-orange); keep in sync with
// render2d.js POWERUP_STYLE.
export function pickupColor(t: i32): u32 {
  if (t == 0) return rgba(0xaa, 0x33, 0xff, 255);
  if (t == 1) return rgba(0xff, 0xee, 0x00, 255);
  if (t == 2) return rgba(0x99, 0xdd, 0xff, 255);
  if (t == 3) return rgba(0x44, 0xaa, 0x22, 255);
  if (t == 4) return rgba(0xff, 0x55, 0x00, 255);
  if (t == 5) return rgba(0x11, 0x44, 0xee, 255);
  if (t == 6) return rgba(0xff, 0xdd, 0x44, 255);
  if (t == 7) return rgba(0x00, 0xff, 0xff, 255);
  if (t == 8) return rgba(0xcc, 0xcc, 0xdd, 255); // scissors fallback swatch (drawn as pixel-art, not this flat color)
  return COLOR_WHITE;
}
export function trailColor(t: i32): u32 {
  if (t == 2) return COLOR_TRAIL_ICE;     // iceTrail
  if (t == 3) return COLOR_TRAIL_POISON;  // poisonTrail
  if (t == 6) return COLOR_TRAIL_BANANA;  // bananaTrail
  return COLOR_TRAIL_FALLBACK;
}
