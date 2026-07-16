// Phase 7 WASM renderer core (AssemblyScript). Ports the entire per-frame
// draw logic of the old public/js/render.js: it consumes flat-encoded
// snapshots + per-frame fx state from linear memory and emits an ordered
// INSTANCE BUFFER of colored shapes (rects / ellipses / rings) in painter's
// order. A thin JS executor (public/js/render.js facade) walks that buffer
// against the 2D canvas context -- benchmarked as faster than a WebGL2
// instanced path on real hardware for this flat-tile workload (see
// tools/bench/ and the Phase 7 CHANGELOG round).
//
// Build: deno run --allow-read --allow-write --allow-env --allow-net \
//          tools/build-wasm.ts
// (compiles with --runtime stub: NO GC, no allocations after init() --
//  every region below is a fixed block bump-allocated once.)
//
// Memory protocol (all little-endian, offsets relative to the pointers the
// module exports):
//
// Snapshot region (x2: which=0 curr-candidate A, which=1 candidate B; JS
// alternates and tells render() which one is CURRENT):
//   0  seq        u32
//   4  tickMs     f32
//   8  foodX      i32   (-1 = no food)
//   12 foodY      i32
//   16 nPlayers   i32
//   20 nTrails    i32
//   24 nPickups   i32
//   28 nShells    i32
//   32 players[MAX_PLAYERS] stride 48:
//        0 present i32, 4 alive i32, 8 colorHead u32 (ABGR byte order:
//        r=low byte), 12 colorBody u32, 16 dirX i32, 20 dirY i32,
//        24 moveMs f32, 28 boost i32, 32 sliding i32, 36 bodyLen i32,
//        40 bodyOff i32 (segment index into body pool), 44 pad
//   +players: body pool, MAX_SEGS x {x:i16, y:i16}
//   +pool: trails, MAX_TRAILS stride 8: {x:i16, y:i16, type:i16, pad}
//   +trails: pickups, MAX_PICKUPS stride 16: {x:i32, y:i32, type:i32, id:i32}
//   +pickups: shells, MAX_SHELLS stride 8: {x:i32, y:i32}
//
// Frame-input region (written every frame BEFORE render()):
//   0  interpolate i32, 4 boostTrail i32, 8 slideDust i32, 12 foodHidden i32
//   16 recvElapsedMs f32   (now - currSnap.recvTime; relative so f32 is safe)
//   20 nFlashes i32
//   24 flashes[MAX_FLASHES] stride 16: {slot i32, dirIdx i32 (0 up/1 down/
//        2 left/3 right), elapsedMs f32, durMs f32}
//   152 nGlides i32
//   156 glides[MAX_GLIDES] stride 32: {slot, fromX, fromY, toX, toY (i32),
//        elapsedMs f32, durMs f32, pad}
//   412 nExplosions i32
//   416 explosions[MAX_EXPLOSIONS] stride 16: {x i32, y i32, radius f32, age f32}
//   672 nLocals i32
//   676 locals[MAX_LOCALS] stride 12: {slot i32, len i32, off i32 (into the
//        local body pool)}
//   724 pad, 728 local body pool, MAX_LOCAL_SEGS x {x:i16, y:i16}
//
// Instance buffer (output) stride 32:
//   0 x f32, 4 y f32, 8 w f32, 12 h f32, 16 color u32 (ABGR: r low byte,
//   alpha high byte), 20 kind f32 (0 rect / 1 ellipse / 2 ring), 24 rot f32,
//   28 param f32 (ring: inner radius as fraction of outer)

const MAX_PLAYERS: i32 = 8;
const MAX_SEGS: i32 = 16384;
const MAX_TRAILS: i32 = 8192;
const MAX_PICKUPS: i32 = 32;
const MAX_SHELLS: i32 = 16;
const MAX_FLASHES: i32 = 8;
const MAX_GLIDES: i32 = 8;
const MAX_EXPLOSIONS: i32 = 16;
const MAX_LOCALS: i32 = 4;
const MAX_LOCAL_SEGS: i32 = 16384;
const INSTANCE_CAP: i32 = 40960;

// snapshot-internal offsets
const SNAP_PLAYERS: i32 = 32;
const PLAYER_STRIDE: i32 = 48;
const SNAP_BODY: i32 = SNAP_PLAYERS + MAX_PLAYERS * PLAYER_STRIDE;
const SNAP_TRAILS: i32 = SNAP_BODY + MAX_SEGS * 4;
const SNAP_PICKUPS: i32 = SNAP_TRAILS + MAX_TRAILS * 8;
const SNAP_SHELLS: i32 = SNAP_PICKUPS + MAX_PICKUPS * 16;
const SNAP_SIZE: i32 = SNAP_SHELLS + MAX_SHELLS * 8;

// frame-input offsets
const FR_FLAGS: i32 = 0;
const FR_RECV_ELAPSED: i32 = 16;
const FR_NFLASHES: i32 = 20;
const FR_FLASHES: i32 = 24;
const FR_NGLIDES: i32 = 152;
const FR_GLIDES: i32 = 156;
const FR_NEXPL: i32 = 412;
const FR_EXPL: i32 = 416;
const FR_NLOCALS: i32 = 672;
const FR_LOCALS: i32 = 676;
const FR_LOCAL_BODY: i32 = 728;
const FRAME_SIZE: i32 = FR_LOCAL_BODY + MAX_LOCAL_SEGS * 4;

const KIND_RECT: f32 = 0;
const KIND_ELLIPSE: f32 = 1;
const KIND_RING: f32 = 2;

// Colors, packed ABGR (r = low byte, a = high byte) to match a little-endian
// Uint32Array view over RGBA bytes. Values mirror the old render.js exactly.
function rgba(r: u32, g: u32, b: u32, a: u32): u32 { return r | (g << 8) | (b << 16) | (a << 24); }
const COLOR_FOOD: u32 = rgba(0xee, 0x33, 0x33, 255);        // #e33
const COLOR_TRAIL_ICE: u32 = rgba(150, 225, 255, 166);      // rgba(150,225,255,0.65)
const COLOR_TRAIL_POISON: u32 = rgba(110, 210, 70, 153);    // rgba(110,210,70,0.6)
const COLOR_TRAIL_FALLBACK: u32 = rgba(255, 255, 255, 51);  // rgba(255,255,255,0.2)
const COLOR_SHELL: u32 = rgba(0x33, 0x99, 0xff, 255);       // #39f
const COLOR_SHELL_HILIGHT: u32 = rgba(0xdd, 0xff, 0xff, 255); // #dff
const COLOR_JETSTREAM: u32 = rgba(0x99, 0xdd, 0xff, 255);   // #9df
const COLOR_DUST: u32 = rgba(0xcc, 0xcc, 0xcc, 255);        // #ccc
const COLOR_WHITE: u32 = rgba(255, 255, 255, 255);
const COLOR_BLACK: u32 = rgba(0, 0, 0, 255);

// Pickup colors by type index (must match the facade's POWERUP_TYPE_INDEX
// order): 0 wormhole #a3f, 1 growthSpurt #fd6, 2 iceTrail #9df,
// 3 poisonTrail #4a2, 4 speedBoost #f93, 5 blueShell #39f.
function pickupColor(t: i32): u32 {
  if (t == 0) return rgba(0xaa, 0x33, 0xff, 255);
  if (t == 1) return rgba(0xff, 0xdd, 0x66, 255);
  if (t == 2) return rgba(0x99, 0xdd, 0xff, 255);
  if (t == 3) return rgba(0x44, 0xaa, 0x22, 255);
  if (t == 4) return rgba(0xff, 0x99, 0x33, 255);
  if (t == 5) return rgba(0x33, 0x99, 0xff, 255);
  return COLOR_WHITE;
}
function trailColor(t: i32): u32 {
  if (t == 2) return COLOR_TRAIL_ICE;     // iceTrail
  if (t == 3) return COLOR_TRAIL_POISON;  // poisonTrail
  return COLOR_TRAIL_FALLBACK;
}

let snapA: usize = 0;
let snapB: usize = 0;
let frameIn: usize = 0;
let instBuf: usize = 0;
let gridCols: i32 = 0;
let gridRows: i32 = 0;
let cellSize: i32 = 0;
let cellGap: i32 = 1;
let instN: i32 = 0;

export function init(cols: i32, rows: i32, cs: i32): void {
  if (snapA == 0) {
    snapA = heap.alloc(SNAP_SIZE);
    snapB = heap.alloc(SNAP_SIZE);
    frameIn = heap.alloc(FRAME_SIZE);
    instBuf = heap.alloc(INSTANCE_CAP * 32);
  }
  gridCols = cols;
  gridRows = rows;
  cellSize = cs;
  cellGap = max(1, <i32>Math.round(<f64>cs * 0.08));
}
export function snapPtr(which: i32): usize { return which == 0 ? snapA : snapB; }
export function frameInputPtr(): usize { return frameIn; }
export function instancePtr(): usize { return instBuf; }
export function instanceCapacity(): i32 { return INSTANCE_CAP; }

// @ts-ignore: decorator valid in AssemblyScript
@inline
function inst(x: f32, y: f32, w: f32, h: f32, color: u32, alphaMul: f32, kind: f32, rot: f32, param: f32): void {
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

@inline
function easeOutCubic(t: f32): f32 { const u = 1 - t; return 1 - u * u * u; }
@inline
function lerpf(a: f32, b: f32, t: f32): f32 { return a + (b - a) * t; }

// dirIdx vectors: 0 up, 1 down, 2 left, 3 right
@inline
function dirVX(d: i32): i32 { return d == 2 ? -1 : (d == 3 ? 1 : 0); }
@inline
function dirVY(d: i32): i32 { return d == 0 ? -1 : (d == 1 ? 1 : 0); }

@inline
function segX(pool: usize, idx: i32): i32 { return <i32>load<i16>(pool + <usize>(idx << 2)); }
@inline
function segY(pool: usize, idx: i32): i32 { return <i32>load<i16>(pool + <usize>(idx << 2), 2); }

// Returns the number of instances written. `now` is performance.now() (f64
// for precision in the sin/phase animations); which selects the CURRENT
// snapshot region (the other one is the previous snapshot).
export function render(now: f64, which: i32): i32 {
  instN = 0;
  const curr = which == 0 ? snapA : snapB;
  const prev = which == 0 ? snapB : snapA;
  const cs = <f32>cellSize;
  const gap = <f32>cellGap;
  const cell = cs - gap;

  const interpolate = load<i32>(frameIn + FR_FLAGS) != 0;
  const boostTrail = load<i32>(frameIn + FR_FLAGS, 4) != 0;
  const slideDust = load<i32>(frameIn + FR_FLAGS, 8) != 0;
  const foodHidden = load<i32>(frameIn + FR_FLAGS, 12) != 0;
  const recvElapsed = load<f32>(frameIn + FR_RECV_ELAPSED);
  const tickMs = load<f32>(curr, 4);

  // trails (under everything)
  const nTrails = min(load<i32>(curr, 20), MAX_TRAILS);
  const trailBase = curr + SNAP_TRAILS;
  for (let i = 0; i < nTrails; i++) {
    const o = trailBase + <usize>(i << 3);
    const tx = <f32>load<i16>(o), ty = <f32>load<i16>(o, 2);
    inst(tx * cs, ty * cs, cell, cell, trailColor(<i32>load<i16>(o, 4)), 1, KIND_RECT, 0, 0);
  }
  // food
  const foodX = load<i32>(curr, 8);
  if (foodX >= 0 && !foodHidden) {
    const foodY = load<i32>(curr, 12);
    inst(<f32>foodX * cs, <f32>foodY * cs, cell, cell, COLOR_FOOD, 1, KIND_RECT, 0, 0);
  }
  // pickups (pulse)
  const nPickups = min(load<i32>(curr, 24), MAX_PICKUPS);
  const pkBase = curr + SNAP_PICKUPS;
  for (let i = 0; i < nPickups; i++) {
    const o = pkBase + <usize>(i << 4);
    const px = load<i32>(o), py = load<i32>(o, 4), pt = load<i32>(o, 8), pid = load<i32>(o, 12);
    const pulse = <f32>(0.5 + 0.5 * Math.sin(now / 220.0 + <f64>pid));
    const size = (cs - 2) * (<f32>0.7 + <f32>0.3 * pulse);
    const off = (cs - size) / 2;
    inst(<f32>px * cs + off, <f32>py * cs + off, size, size, pickupColor(pt), <f32>0.6 + <f32>0.4 * pulse, KIND_RECT, 0, 0);
  }
  // blue shells (spinning ellipse + highlight)
  const nShells = min(load<i32>(curr, 28), MAX_SHELLS);
  const shBase = curr + SNAP_SHELLS;
  for (let i = 0; i < nShells; i++) {
    const o = shBase + <usize>(i << 3);
    const cx = <f32>load<i32>(o) * cs + cs / 2;
    const cy = <f32>load<i32>(o, 4) * cs + cs / 2;
    const spin = <f32>((now / 300.0) % (Math.PI * 2));
    inst(cx - cs * <f32>0.42, cy - cs * <f32>0.32, cs * <f32>0.84, cs * <f32>0.64, COLOR_SHELL, 1, KIND_ELLIPSE, spin, 0);
    // the highlight sits 0.05*cs "above" center in shell-local space, so its
    // world position rotates with the spin (matches ctx.translate+rotate).
    const hx = cx + <f32>Math.sin(spin) * cs * <f32>0.05;
    const hy = cy - <f32>Math.cos(spin) * cs * <f32>0.05;
    inst(hx - cs * <f32>0.12, hy - cs * <f32>0.12, cs * <f32>0.24, cs * <f32>0.24, COLOR_SHELL_HILIGHT, 1, KIND_ELLIPSE, 0, 0);
  }
  // explosion rings
  const nExpl = min(load<i32>(frameIn + FR_NEXPL), MAX_EXPLOSIONS);
  for (let i = 0; i < nExpl; i++) {
    const o = frameIn + FR_EXPL + <usize>(i << 4);
    const ex = load<i32>(o), ey = load<i32>(o, 4);
    const radiusCells = load<f32>(o, 8), age = load<f32>(o, 12);
    const r = radiusCells * cs * age;
    const lw = max<f32>(2, cs * <f32>0.15);
    const outer = r + lw / 2;
    if (outer > 0) {
      const inner = max<f32>(0, r - lw / 2) / outer;
      inst(<f32>ex * cs + cs / 2 - outer, <f32>ey * cs + cs / 2 - outer, outer * 2, outer * 2, COLOR_SHELL, max<f32>(0, 1 - age), KIND_RING, 0, inner);
    }
  }
  // players
  const nPlayers = min(load<i32>(curr, 16), MAX_PLAYERS);
  const nLocals = min(load<i32>(frameIn + FR_NLOCALS), MAX_LOCALS);
  const nFlashes = min(load<i32>(frameIn + FR_NFLASHES), MAX_FLASHES);
  const nGlides = min(load<i32>(frameIn + FR_NGLIDES), MAX_GLIDES);
  for (let i = 0; i < nPlayers; i++) {
    const p = curr + SNAP_PLAYERS + <usize>(i * PLAYER_STRIDE);
    if (!load<i32>(p)) continue; // not present
    const alive = load<i32>(p, 4) != 0;
    const colorHead = load<u32>(p, 8);
    const colorBody = load<u32>(p, 12);
    // local predicted body override?
    let bodyPool = curr + SNAP_BODY;
    let bodyLen = load<i32>(p, 36);
    let bodyOff = load<i32>(p, 40);
    let isLocal = false;
    for (let l = 0; l < nLocals; l++) {
      const lo = frameIn + FR_LOCALS + <usize>(l * 12);
      if (load<i32>(lo) == i) {
        isLocal = true;
        bodyLen = load<i32>(lo, 4);
        bodyOff = load<i32>(lo, 8);
        bodyPool = frameIn + FR_LOCAL_BODY;
        break;
      }
    }
    if (bodyLen <= 0) continue;
    // glide?
    let glideAt: usize = 0;
    for (let g = 0; g < nGlides; g++) {
      const go = frameIn + FR_GLIDES + <usize>(g << 5);
      if (load<i32>(go) == i) { glideAt = go; break; }
    }
    // smooth interpolation eligible?
    const pPrev = prev + SNAP_PLAYERS + <usize>(i * PLAYER_STRIDE);
    const smooth = interpolate && !isLocal && alive && load<i32>(pPrev) != 0 && load<i32>(pPrev, 36) > 0;
    let t: f32 = 1;
    if (smooth) {
      const moveMs = load<f32>(p, 24);
      const span = moveMs > 0 ? moveMs : (tickMs > 0 ? tickMs : 100);
      t = recvElapsed / span;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
    }
    const prevPool = prev + SNAP_BODY;
    const prevLen = smooth ? load<i32>(pPrev, 36) : 0;
    const prevOff = smooth ? load<i32>(pPrev, 40) : 0;
    let headPx = <f32>segX(bodyPool, bodyOff) * cs;
    let headPy = <f32>segY(bodyPool, bodyOff) * cs;
    if (glideAt != 0) {
      const gt0 = load<f32>(glideAt, 20) / load<f32>(glideAt, 24);
      const et = easeOutCubic(gt0 < 0 ? 0 : (gt0 > 1 ? 1 : gt0));
      headPx = lerpf(<f32>load<i32>(glideAt, 4) * cs, <f32>load<i32>(glideAt, 12) * cs, et);
      headPy = lerpf(<f32>load<i32>(glideAt, 8) * cs, <f32>load<i32>(glideAt, 16) * cs, et);
      inst(headPx, headPy, cell, cell, colorHead, 1, KIND_RECT, 0, 0);
      for (let si = 1; si < bodyLen; si++) {
        inst(<f32>segX(bodyPool, bodyOff + si) * cs, <f32>segY(bodyPool, bodyOff + si) * cs, cell, cell, colorBody, 1, KIND_RECT, 0, 0);
      }
    } else if (smooth) {
      for (let si = 0; si < bodyLen; si++) {
        const sx = segX(bodyPool, bodyOff + si), sy = segY(bodyPool, bodyOff + si);
        let x = <f32>sx * cs, y = <f32>sy * cs;
        if (t < 1 && si < prevLen) {
          const px2 = segX(prevPool, prevOff + si), py2 = segY(prevPool, prevOff + si);
          const dist = abs(px2 - sx) + abs(py2 - sy);
          if (dist >= 1 && dist <= 2) {
            x = lerpf(<f32>px2, <f32>sx, t) * cs;
            y = lerpf(<f32>py2, <f32>sy, t) * cs;
          }
        }
        if (si == 0) { headPx = x; headPy = y; }
        inst(x, y, cell, cell, si == 0 ? colorHead : colorBody, 1, KIND_RECT, 0, 0);
      }
    } else {
      for (let si = 0; si < bodyLen; si++) {
        inst(<f32>segX(bodyPool, bodyOff + si) * cs, <f32>segY(bodyPool, bodyOff + si) * cs, cell, cell, si == 0 ? colorHead : colorBody, 1, KIND_RECT, 0, 0);
      }
    }
    if (!alive) {
      for (let si = 0; si < bodyLen; si++) {
        inst(<f32>segX(bodyPool, bodyOff + si) * cs, <f32>segY(bodyPool, bodyOff + si) * cs, cell, cell, COLOR_BLACK, <f32>0.5, KIND_RECT, 0, 0);
      }
    }
    // boost jetstream
    const dirX = load<i32>(p, 16), dirY = load<i32>(p, 20);
    if (alive && load<i32>(p, 28) != 0 && boostTrail && (dirX != 0 || dirY != 0)) {
      for (let n = 0; n < 3; n++) {
        const phase = <f32>(((now / 90.0) + <f64>n * 0.33) % 1.0);
        const dist = phase * cs * <f32>1.5;
        inst(headPx + cs / 2 - <f32>dirX * dist - cs * <f32>0.15, headPy + cs / 2 - <f32>dirY * dist - cs * <f32>0.15, cs * <f32>0.3, cs * <f32>0.3, COLOR_JETSTREAM, <f32>0.5 * (1 - phase), KIND_RECT, 0, 0);
      }
    }
    // slide dust
    if (alive && load<i32>(p, 32) != 0 && slideDust) {
      for (let n = 0; n < 4; n++) {
        const phase = <f32>(((now / 140.0) + <f64>n * 0.25) % 1.0);
        const angle = <f64>n / 4.0 * Math.PI * 2;
        const dist = phase * cs * <f32>0.6;
        inst(headPx + cs / 2 + <f32>Math.cos(angle) * dist - cs * <f32>0.08, headPy + cs / 2 + <f32>Math.sin(angle) * dist - cs * <f32>0.08, cs * <f32>0.16, cs * <f32>0.16, COLOR_DUST, <f32>0.35 * (1 - phase), KIND_RECT, 0, 0);
      }
    }
    // input flash
    for (let f = 0; f < nFlashes; f++) {
      const fo = frameIn + FR_FLASHES + <usize>(f << 4);
      if (load<i32>(fo) != i) continue;
      const alpha = 1 - load<f32>(fo, 8) / load<f32>(fo, 12);
      if (alpha > 0) {
        const d = load<i32>(fo, 4);
        const vx = dirVX(d), vy = dirVY(d);
        const stripW = max<f32>(3, <f32>Math.round(<f64>cs * 0.28));
        if (vx == 1) inst(headPx + cs - stripW, headPy, stripW, cell, COLOR_WHITE, alpha, KIND_RECT, 0, 0);
        else if (vx == -1) inst(headPx, headPy, stripW, cell, COLOR_WHITE, alpha, KIND_RECT, 0, 0);
        else if (vy == 1) inst(headPx, headPy + cs - stripW, cell, stripW, COLOR_WHITE, alpha, KIND_RECT, 0, 0);
        else if (vy == -1) inst(headPx, headPy, cell, stripW, COLOR_WHITE, alpha, KIND_RECT, 0, 0);
      }
      break;
    }
  }
  return instN;
}
