// Pixel-art bitmap lookups (banana, scissors, wall warn/spike glyphs, all
// on a 5x5 sub-grid) + small math helpers used by the render loop. Every
// bitmap function here must mirror its render2d.js counterpart exactly
// (same rows/values) for wasm/2D pixel parity -- see each function's
// comment for which render2d.js function it mirrors.
import { WALL_WARN_1, WALL_WARN_2, WALL_SPIKE_1, WALL_SPIKE_2, WALL_SPIKE_3, COLOR_SCISSORS_TIP, COLOR_SCISSORS_PIVOT, COLOR_SCISSORS_HANDLE, COLOR_SCISSORS_BLADE } from "./colors";

// "!" pixel-art (5x5 sub-grid): 3-wide shaded stem (cols 1-3) for rows
// 0-2, blank gap row 3, dot on row 4. Outer columns (0, 4) stay empty so
// the glyph reads as a narrow mark, not a block. Must mirror render2d.js
// warnVal()/WALL_WARN_COLORS exactly for parity.
// @ts-ignore: decorator valid in AssemblyScript -- see docs/JS-CHEATSHEET.md
@inline
// r/c step through the rows/columns of the 5x5 sub-grid; the return value is
// a small integer code (0 = empty pixel, 1/2/... = which color to use --
// see warnColor()/spikeColor() below) that the caller looks up per pixel to
// draw the glyph one tiny rect at a time.
export function warnVal(r: i32, c: i32): i32 {
  if (r == 3) return 0;
  if (c == 0 || c == 4) return 0;
  return c == 2 ? 1 : 2; // ternary: 1 if c==2, else 2 -- shorthand for if/else returning a value
}
// @ts-ignore: decorator valid in AssemblyScript
@inline
export function warnColor(v: i32): u32 {
  return v == 1 ? WALL_WARN_1 : WALL_WARN_2;
}
// Spike pixel-art (5x5 sub-grid): three spike columns (0/2/4) alternate
// tip-then-body down the cell, same rect-composition technique as
// bananaVal() below -- must mirror render2d.js spikeVal()/SPIKE_COLORS
// exactly for parity.
// @ts-ignore: decorator valid in AssemblyScript
@inline
export function spikeVal(r: i32, c: i32): i32 {
  if (r == 0) return (c % 2 == 0) ? 2 : 3;
  if (r == 1) return (c % 2 == 0) ? 1 : 2;
  if (r == 2) return 1;
  if (r == 3) return (c % 2 == 0) ? 3 : 1;
  return 3;
}
// @ts-ignore: decorator valid in AssemblyScript
@inline
export function spikeColor(v: i32): u32 {
  if (v == 2) return WALL_SPIKE_2;
  if (v == 3) return WALL_SPIKE_3;
  return WALL_SPIKE_1;
}

// Pixel-art banana bitmap (5x5), 0 empty / 1 body / 2 tip / 3 ripeness spot
// -- must match render2d.js BANANA_ART exactly (same rows) so the two
// renderers agree. Spots at (1,3) and (3,0) added in v3.6.2.
// @ts-ignore: decorator valid in AssemblyScript
@inline
export function bananaVal(r: i32, c: i32): i32 {
  if (r == 0) return c == 3 ? 1 : (c == 4 ? 2 : 0);
  if (r == 1) return c == 2 ? 1 : (c == 3 ? 3 : 0);
  if (r == 2) return (c == 1 || c == 2) ? 1 : 0;
  if (r == 3) return c == 0 ? 3 : (c == 1 ? 1 : 0);
  return c == 0 ? 2 : (c == 1 ? 1 : 0);
}
// Pixel-art scissors bitmap (5x5), canonical "facing up" orientation --
// must match render2d.js SCISSORS_ART exactly (same rows): 1 blade shaft,
// 2 blade tip, 3 pivot rivet, 4 handle loop.
// @ts-ignore: decorator valid in AssemblyScript
@inline
export function scissorsArt(r: i32, c: i32): i32 {
  if (r == 0) return (c == 1 || c == 3) ? 2 : 0;
  if (r == 1) return (c == 1 || c == 3) ? 1 : 0;
  if (r == 2) return c == 2 ? 3 : 0;
  return (c == 0 || c == 4) ? 4 : 0;
}
// dirIdx: 0 up, 1 down, 2 left, 3 right (matches dirVX/dirVY below). Rotates
// the 5x5 lookup by remapping (r,c) before indexing the canonical up-facing
// bitmap -- must mirror render2d.js scissorsVal() exactly for parity.
// @ts-ignore: decorator valid in AssemblyScript
@inline
export function scissorsVal(r: i32, c: i32, dirIdx: i32): i32 {
  if (dirIdx == 1) return scissorsArt(4 - r, 4 - c);
  if (dirIdx == 3) return scissorsArt(4 - c, r);
  if (dirIdx == 2) return scissorsArt(c, 4 - r);
  return scissorsArt(r, c);
}
// @ts-ignore: decorator valid in AssemblyScript
@inline
export function scissorsColor(v: i32): u32 {
  if (v == 2) return COLOR_SCISSORS_TIP;
  if (v == 3) return COLOR_SCISSORS_PIVOT;
  if (v == 4) return COLOR_SCISSORS_HANDLE;
  return COLOR_SCISSORS_BLADE;
}
// dx/dy (a snake's dir vector) -> the 0 up/1 down/2 left/3 right dirIdx
// scissorsVal expects. Mirrors render2d.js dirIdxFromVec().
// @ts-ignore: decorator valid in AssemblyScript
@inline
export function dirIdxFromDelta(dx: i32, dy: i32): i32 {
  if (dy == -1) return 0;
  if (dy == 1) return 1;
  if (dx == -1) return 2;
  if (dx == 1) return 3;
  return 0;
}
// @ts-ignore: decorator valid in AssemblyScript
@inline
export function easeOutCubic(t: f32): f32 { const u: f32 = <f32>1 - t; return <f32>1 - u * u * u; }
// @ts-ignore: decorator valid in AssemblyScript
@inline
export function lerpf(a: f32, b: f32, t: f32): f32 { return a + (b - a) * t; }

// dirIdx vectors: 0 up, 1 down, 2 left, 3 right
// @ts-ignore: decorator valid in AssemblyScript
@inline
export function dirVX(d: i32): i32 { return d == 2 ? -1 : (d == 3 ? 1 : 0); }
// @ts-ignore: decorator valid in AssemblyScript
@inline
export function dirVY(d: i32): i32 { return d == 0 ? -1 : (d == 1 ? 1 : 0); }

// @ts-ignore: decorator valid in AssemblyScript
@inline
// Reads one body-segment's x coordinate out of a packed segment pool: each
// segment is 4 bytes ({x:i16, y:i16}), so `idx << 2` (idx * 4) finds its
// byte offset, and load<i16> reads the 2-byte x value there (y is the same
// offset +2 bytes, read by segY below). `<i32>` casts the loaded i16 up.
export function segX(pool: usize, idx: i32): i32 { return <i32>load<i16>(pool + <usize>(idx << 2)); }
// @ts-ignore: decorator valid in AssemblyScript
@inline
export function segY(pool: usize, idx: i32): i32 { return <i32>load<i16>(pool + <usize>(idx << 2), 2); }
