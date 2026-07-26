// The output instance buffer + its single writer function. Split out of
// renderer.ts so draw-players.ts can call inst() too without a circular
// import between renderer.ts and draw-players.ts.
import { INSTANCE_CAP } from "./layout";

export let instBuf: usize = 0;
let instN: i32 = 0;

export function allocInstBuf(): void {
  if (instBuf == 0) instBuf = heap.alloc(INSTANCE_CAP * 32);
}
export function resetInstN(): void { instN = 0; }
export function getInstN(): i32 { return instN; }

// @ts-ignore: decorator valid in AssemblyScript
@inline
export function inst(x: f32, y: f32, w: f32, h: f32, color: u32, alphaMul: f32, kind: f32, rot: f32, param: f32): void {
  if (instN >= INSTANCE_CAP) return;
  const o = instBuf + <usize>(instN << 5);
  store<f32>(o, x);
  store<f32>(o, y, 4);
  store<f32>(o, w, 8);
  store<f32>(o, h, 12);
  let a = <u32>(<f32>(color >>> 24) * (alphaMul < 0 ? 0 : (alphaMul > 1 ? 1 : alphaMul)));
  store<u32>(o, (color & 0x00ffffff) | (a << 24), 16);
  store<f32>(o, kind, 20);
  store<f32>(o, rot, 24);
  store<f32>(o, param, 28);
  instN++;
}
