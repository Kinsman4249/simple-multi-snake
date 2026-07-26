// The output instance buffer + its single writer function. Split out of
// renderer.ts so draw-players.ts can call inst() too without a circular
// import between renderer.ts and draw-players.ts.
import { INSTANCE_CAP } from "./layout";

// `instBuf` is the address (see docs/JS-CHEATSHEET.md's AssemblyScript
// section for `usize`/pointers) of the output buffer; `export let` (mutable,
// unlike `const`) because it's set once by allocInstBuf() below and read by
// other files. `instN` is a private (not exported) counter of how many
// instances have been written so far this frame.
export let instBuf: usize = 0;
let instN: i32 = 0;

export function allocInstBuf(): void {
  // Reserve the buffer's memory exactly once (heap.alloc has no matching
  // "free" in this no-GC runtime) -- INSTANCE_CAP entries x 32 bytes each,
  // matching the "Instance buffer (output) stride 32" layout in layout.ts.
  if (instBuf == 0) instBuf = heap.alloc(INSTANCE_CAP * 32);
}
export function resetInstN(): void { instN = 0; }
export function getInstN(): i32 { return instN; }

// @ts-ignore: decorator valid in AssemblyScript
@inline
// The single place that writes one drawable "instance" (a rect/ellipse/ring)
// into the output buffer, called once per shape the renderer wants drawn
// this frame. Packing every shape into one flat 32-byte record (instead of
// separate JS objects) is what lets the JS facade in public/js/render.js
// walk the buffer with a typed array and draw thousands of shapes per frame
// cheaply.
export function inst(x: f32, y: f32, w: f32, h: f32, color: u32, alphaMul: f32, kind: f32, rot: f32, param: f32): void {
  if (instN >= INSTANCE_CAP) return; // silently drop shapes past capacity
  // `instN << 5` is instN * 32 (this record's stride) -- see cheatsheet's
  // bit-shift-as-multiply note. `o` is this instance's byte offset in the buffer.
  const o = instBuf + <usize>(instN << 5);
  store<f32>(o, x);
  store<f32>(o, y, 4);
  store<f32>(o, w, 8);
  store<f32>(o, h, 12);
  // Multiply the color's existing alpha byte (top byte, via >>> 24) by the
  // caller's alphaMul (clamped to 0..1), so callers can fade a shape out
  // without needing to know/recompute the base color's own alpha.
  let a = <u32>(<f32>(color >>> 24) * (alphaMul < 0 ? 0 : (alphaMul > 1 ? 1 : alphaMul)));
  store<u32>(o, (color & 0x00ffffff) | (a << 24), 16); // keep RGB, replace alpha byte
  store<f32>(o, kind, 20);
  store<f32>(o, rot, 24);
  store<f32>(o, param, 28);
  instN++;
}
