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
// Split across sibling files (asc bundles local imports from this entry
// point, so only THIS file's path goes on the asc command line):
//   layout.ts       -- the full memory-layout protocol doc + every offset/
//                      size constant (shared byte-for-byte with
//                      public/js/render.js).
//   colors.ts       -- the ABGR color palette + type/id -> color lookups.
//   art.ts          -- pixel-art bitmap lookups (banana/scissors/wall
//                      glyphs) + small interpolation/direction math helpers.
//   instbuf.ts       -- the output instance buffer + its inst() writer.
//   draw-players.ts -- the per-frame player-body draw loop (the single
//                      largest section of render(), split out for size).
// This file keeps the mutable snapshot/frame-input globals, init()/pointer
// exports, and render() itself (minus the player loop).
import {
  MAX_TRAILS, MAX_PICKUPS, MAX_SHELLS, MAX_WALLS, MAX_PORTALS,
  MAX_FLASHES, MAX_GLIDES, MAX_EXPLOSIONS, MAX_PFLASHES, MAX_DUST, MAX_FOODS,
  MAX_WALLSHATTERS, MAX_LOCALS, MAX_PLAYERS, INSTANCE_CAP,
  SNAP_NWALLS, SNAP_NPORTALS, SNAP_PORTALS, SNAP_SIZE,
  SNAP_TRAILS, SNAP_PICKUPS, SNAP_SHELLS, SNAP_WALLS,
  FR_FLAGS, FR_RECV_ELAPSED, FR_NFLASHES, FR_NGLIDES,
  FR_NEXPL, FR_EXPL, FR_NLOCALS, FR_HELDGLOW, FR_POWERFX,
  FR_NPFLASH, FR_NDUST, FR_DUST, FR_NFOODS,
  FR_FOODS, FR_NWALLSHATTER, FR_WALLSHATTER, FRAME_SIZE,
  KIND_RECT, KIND_ELLIPSE, KIND_RING,
} from "./layout";
import {
  COLOR_FOOD, COLOR_FOOD_BOUNTY, CANDY_N, WALLSHATTER_N, candyColor,
  COLOR_SHELL, COLOR_SHELL_HILIGHT, COLOR_DUST,
  COLOR_BANANA_TIP, COLOR_BANANA_SPOT, COLOR_BANANA_BODY,
  debrisColor, pickupColor, trailColor,
} from "./colors";
import { bananaVal, warnVal, warnColor, spikeVal, spikeColor, scissorsVal, scissorsColor } from "./art";
import { instBuf, allocInstBuf, resetInstN, getInstN, inst } from "./instbuf";
import { drawPlayers } from "./draw-players";

let snapA: usize = 0;
let snapB: usize = 0;
let frameIn: usize = 0;
let gridCols: i32 = 0;
let gridRows: i32 = 0;
let cellSize: i32 = 0;
let cellGap: i32 = 1;

export function init(cols: i32, rows: i32, cs: i32): void {
  if (snapA == 0) {
    snapA = heap.alloc(SNAP_SIZE);
    snapB = heap.alloc(SNAP_SIZE);
    frameIn = heap.alloc(FRAME_SIZE);
    allocInstBuf();
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

// Returns the number of instances written. `now` is performance.now() (f64
// for precision in the sin/phase animations); which selects the CURRENT
// snapshot region (the other one is the previous snapshot).
export function render(now: f64, which: i32): i32 {
  resetInstN();
  const curr = which == 0 ? snapA : snapB;
  const prev = which == 0 ? snapB : snapA;
  const cs = <f32>cellSize;
  const gap = <f32>cellGap;
  const cell = cs - gap;

  const interpolate = load<i32>(frameIn + FR_FLAGS) != 0;
  const boostTrail = load<i32>(frameIn + FR_FLAGS, 4) != 0;
  // (flags+8, the old slideDust toggle, is reserved: dust gating now happens
  // client-side when main.js decides whether to fill the dust array at all.
  // flags+12, the old foodHidden flag, is also reserved: foods now carry their
  // own per-frame hiding by simply being omitted from the foods array.)
  const heldGlow = load<i32>(frameIn + FR_HELDGLOW) != 0;
  const powerFx = load<i32>(frameIn + FR_POWERFX) != 0;
  const recvElapsed = load<f32>(frameIn + FR_RECV_ELAPSED);
  const tickMs = load<f32>(curr, 4);

  // trails (under everything)
  const nTrails = min(load<i32>(curr, 20), MAX_TRAILS);
  const trailBase = curr + SNAP_TRAILS;
  for (let i = 0; i < nTrails; i++) {
    const o = trailBase + <usize>(i << 3);
    const tx = <i32>load<i16>(o), ty = <i32>load<i16>(o, 2);
    const ttype = <i32>load<i16>(o, 4);
    if (ttype == 6) {
      // bananaTrail: pixel-art crescent (5x5), same edges as render2d.js.
      const bx = <f32>tx * cs, by = <f32>ty * cs;
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          const v = bananaVal(r, c);
          if (v == 0) continue;
          const x0 = <f32>(<i32>Math.round(<f64>c * <f64>cell / 5.0));
          const x1 = <f32>(<i32>Math.round(<f64>(c + 1) * <f64>cell / 5.0));
          const y0 = <f32>(<i32>Math.round(<f64>r * <f64>cell / 5.0));
          const y1 = <f32>(<i32>Math.round(<f64>(r + 1) * <f64>cell / 5.0));
          const bcol = v == 2 ? COLOR_BANANA_TIP : (v == 3 ? COLOR_BANANA_SPOT : COLOR_BANANA_BODY);
          inst(bx + x0, by + y0, x1 - x0, y1 - y0, bcol, 1, KIND_RECT, 0, 0);
        }
      }
    } else {
      inst(<f32>tx * cs, <f32>ty * cs, cell, cell, trailColor(ttype), 1, KIND_RECT, 0, 0);
    }
  }
  // Grid decay / anti-turtling obstacles (v3.8.1): "warn" (telegraph, not
  // yet collidable) shows a slow-throbbing pixel-art red "!" (only the
  // glyph pixels flash, not the whole tile -- keeps this well clear of
  // photosensitive-flash territory); "solid" is the pixel-art spike trap
  // at full alpha; "fading" (despawn cue) is the same spikes pulsing
  // faster/deeper. Must mirror render2d.js drawWalls/drawSpikeTile exactly
  // (same pulse formulas, keyed off wall id like pickups) for parity.
  const nWalls = min(load<i32>(curr, SNAP_NWALLS), MAX_WALLS);
  const wallBase = curr + SNAP_WALLS;
  for (let i = 0; i < nWalls; i++) {
    const o = wallBase + <usize>(i << 4);
    const wx = load<i32>(o), wy = load<i32>(o, 4);
    const wstate = load<i32>(o, 8), wid = load<i32>(o, 12);
    if (wstate == 0) {
      const pulse = <f32>(0.5 + 0.5 * Math.sin(now / 220.0 + <f64>wid));
      const alpha = <f32>0.55 + <f32>0.45 * pulse;
      const wbx0 = <f32>wx * cs, wby0 = <f32>wy * cs;
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          const v = warnVal(r, c);
          if (v == 0) continue;
          const x0 = <f32>(<i32>Math.round(<f64>c * <f64>cell / 5.0));
          const x1 = <f32>(<i32>Math.round(<f64>(c + 1) * <f64>cell / 5.0));
          const y0 = <f32>(<i32>Math.round(<f64>r * <f64>cell / 5.0));
          const y1 = <f32>(<i32>Math.round(<f64>(r + 1) * <f64>cell / 5.0));
          inst(wbx0 + x0, wby0 + y0, x1 - x0, y1 - y0, warnColor(v), alpha, KIND_RECT, 0, 0);
        }
      }
      continue;
    }
    let alpha: f32 = 1;
    if (wstate == 2) {
      const pulse = <f32>(0.5 + 0.5 * Math.sin(now / 90.0 + <f64>wid));
      alpha = <f32>0.5 + <f32>0.5 * pulse;
    }
    const wbx = <f32>wx * cs, wby = <f32>wy * cs;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const x0 = <f32>(<i32>Math.round(<f64>c * <f64>cell / 5.0));
        const x1 = <f32>(<i32>Math.round(<f64>(c + 1) * <f64>cell / 5.0));
        const y0 = <f32>(<i32>Math.round(<f64>r * <f64>cell / 5.0));
        const y1 = <f32>(<i32>Math.round(<f64>(r + 1) * <f64>cell / 5.0));
        inst(wbx + x0, wby + y0, x1 - x0, y1 - y0, spikeColor(spikeVal(r, c)), alpha, KIND_RECT, 0, 0);
      }
    }
  }
  // food (multi-food, from the frame region; eaten ones are omitted upstream).
  // Stride 12: {x, y, bounty} -- piñata bounty food (bounty!=0) draws gold.
  const nFoods = min(load<i32>(frameIn + FR_NFOODS), MAX_FOODS);
  for (let i = 0; i < nFoods; i++) {
    const fo = frameIn + FR_FOODS + <usize>(i * 12);
    const fCol = load<i32>(fo, 8) != 0 ? COLOR_FOOD_BOUNTY : COLOR_FOOD;
    inst(<f32>load<i32>(fo) * cs, <f32>load<i32>(fo, 4) * cs, cell, cell, fCol, 1, KIND_RECT, 0, 0);
  }
  // pickups (pulse)
  const nPickups = min(load<i32>(curr, 24), MAX_PICKUPS);
  const pkBase = curr + SNAP_PICKUPS;
  for (let i = 0; i < nPickups; i++) {
    const o = pkBase + <usize>(i << 4);
    const px = load<i32>(o), py = load<i32>(o, 4), pt = load<i32>(o, 8), pid = load<i32>(o, 12);
    const pulse = <f32>(0.5 + 0.5 * Math.sin(now / 220.0 + <f64>pid));
    const pkAlpha = <f32>0.6 + <f32>0.4 * pulse;
    if (pt == 6) {
      // banana pickup: pixel-art crescent (identical to the laid trail art),
      // pulsing only in alpha -- shape carries the identity, see render2d.js.
      const bx = <f32>px * cs, by = <f32>py * cs;
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          const v = bananaVal(r, c);
          if (v == 0) continue;
          const x0 = <f32>(<i32>Math.round(<f64>c * <f64>cell / 5.0));
          const x1 = <f32>(<i32>Math.round(<f64>(c + 1) * <f64>cell / 5.0));
          const y0 = <f32>(<i32>Math.round(<f64>r * <f64>cell / 5.0));
          const y1 = <f32>(<i32>Math.round(<f64>(r + 1) * <f64>cell / 5.0));
          const bcol = v == 2 ? COLOR_BANANA_TIP : (v == 3 ? COLOR_BANANA_SPOT : COLOR_BANANA_BODY);
          inst(bx + x0, by + y0, x1 - x0, y1 - y0, bcol, pkAlpha, KIND_RECT, 0, 0);
        }
      }
      continue;
    }
    if (pt == 8) {
      // scissors pickup: pixel-art scissors, canonical facing-up orientation
      // (ground pickups have no travel direction) -- see render2d.js.
      const sx = <f32>px * cs, sy = <f32>py * cs;
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          const v = scissorsVal(r, c, 0);
          if (v == 0) continue;
          const x0 = <f32>(<i32>Math.round(<f64>c * <f64>cell / 5.0));
          const x1 = <f32>(<i32>Math.round(<f64>(c + 1) * <f64>cell / 5.0));
          const y0 = <f32>(<i32>Math.round(<f64>r * <f64>cell / 5.0));
          const y1 = <f32>(<i32>Math.round(<f64>(r + 1) * <f64>cell / 5.0));
          inst(sx + x0, sy + y0, x1 - x0, y1 - y0, scissorsColor(v), pkAlpha, KIND_RECT, 0, 0);
        }
      }
      continue;
    }
    const size = (cs - 2) * (<f32>0.7 + <f32>0.3 * pulse);
    const off = (cs - size) / 2;
    inst(<f32>px * cs + off, <f32>py * cs + off, size, size, pickupColor(pt), pkAlpha, KIND_RECT, 0, 0);
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
    const cx = <f32>ex * cs + cs / 2, cy = <f32>ey * cs + cs / 2;
    if (radiusCells < 0) {
      // Piñata candy burst (negative radius flags it): a deterministic spray
      // of festive pixel bits flung outward, fading with age. Mirrors
      // render2d.js drawExplosion's candy branch exactly (f64 trig, same
      // constants) so wasm/2D stay pixel-parity.
      const dist = <f64>(-radiusCells) * <f64>cs * <f64>age;
      const phase = <f64>((ex + ey) % 7) * 0.897;
      const sz = <f32>(<f64>cs * 0.30 * (1.0 - 0.4 * <f64>age));
      const al = max<f32>(0, 1 - age);
      for (let k = 0; k < CANDY_N; k++) {
        const ang = <f64>k * 2.399963 + phase;
        const px = <f32>(<f64>cx + Math.cos(ang) * dist);
        const py = <f32>(<f64>cy + Math.sin(ang) * dist);
        inst(px - sz / 2, py - sz / 2, sz, sz, candyColor(k), al, KIND_RECT, 0, 0);
      }
      continue;
    }
    const r = radiusCells * cs * age;
    const lw = max<f32>(2, cs * <f32>0.15);
    const outer = r + lw / 2;
    if (outer > 0) {
      const inner = max<f32>(0, r - lw / 2) / outer;
      inst(cx - outer, cy - outer, outer * 2, outer * 2, COLOR_SHELL, max<f32>(0, 1 - age), KIND_RING, 0, inner);
    }
  }
  // scissors wall-shatter debris (v4.5.0): same deterministic flung-debris
  // technique as the pinata candy burst above, gray/brown palette instead of
  // festive candy colors. Must mirror render2d.js drawWallShatter exactly.
  const nWs = min(load<i32>(frameIn + FR_NWALLSHATTER), MAX_WALLSHATTERS);
  for (let i = 0; i < nWs; i++) {
    const o = frameIn + FR_WALLSHATTER + <usize>(i * 12);
    const wx = load<i32>(o), wy = load<i32>(o, 4);
    const wage = load<f32>(o, 8);
    const wcx = <f32>wx * cs + cs / 2, wcy = <f32>wy * cs + cs / 2;
    const wdist = <f64>cs * 1.1 * <f64>wage;
    const wphase = <f64>((wx + wy) % 7) * 0.897;
    const wsz = <f32>(<f64>cs * 0.28 * (1.0 - 0.4 * <f64>wage));
    const wal = max<f32>(0, 1 - wage);
    for (let k = 0; k < WALLSHATTER_N; k++) {
      const ang = <f64>k * 2.399963 + wphase;
      const wpx = <f32>(<f64>wcx + Math.cos(ang) * wdist);
      const wpy = <f32>(<f64>wcy + Math.sin(ang) * wdist);
      inst(wpx - wsz / 2, wpy - wsz / 2, wsz, wsz, debrisColor(k), wal, KIND_RECT, 0, 0);
    }
  }
  // players
  const nPlayers = min(load<i32>(curr, 16), MAX_PLAYERS);
  const nLocals = min(load<i32>(frameIn + FR_NLOCALS), MAX_LOCALS);
  const nFlashes = min(load<i32>(frameIn + FR_NFLASHES), MAX_FLASHES);
  const nGlides = min(load<i32>(frameIn + FR_NGLIDES), MAX_GLIDES);
  const nPflash = min(load<i32>(frameIn + FR_NPFLASH), MAX_PFLASHES);
  drawPlayers(
    curr, prev, frameIn, now, cs, cell, tickMs, recvElapsed,
    interpolate, heldGlow, powerFx, boostTrail,
    nPlayers, nLocals, nFlashes, nGlides, nPflash,
  );
  // Wormhole portals (2026-07-20 rework): purple pulsing ring + soft core
  // at each entry/exit cell, emitted after the player loop (portals sit ON
  // TOP of threading bodies) and before dust -- must match render2d.js
  // drawPortals exactly (same pulse/geometry formulas, id-seeded phase,
  // core ellipse first then KIND_RING) for parity. Color = the wormhole
  // pickup purple, pickupColor(0).
  const nPortals = min(load<i32>(curr, SNAP_NPORTALS), MAX_PORTALS);
  const poBase = curr + SNAP_PORTALS;
  for (let i = 0; i < nPortals; i++) {
    const o = poBase + <usize>(i * 12);
    const pox = load<i32>(o), poy = load<i32>(o, 4), poid = load<i32>(o, 8);
    const cx = <f32>pox * cs + cell / 2;
    const cy = <f32>poy * cs + cell / 2;
    const pulse = <f32>(0.5 + 0.5 * Math.sin(now / 180.0 + <f64>poid));
    const outer = cs * (<f32>0.55 + <f32>0.1 * pulse);
    const inner = outer - max<f32>(2, cs * <f32>0.12);
    const portalColor = pickupColor(0);
    inst(cx - cs * <f32>0.3, cy - cs * <f32>0.3, cs * <f32>0.6, cs * <f32>0.6, portalColor, <f32>0.25 + <f32>0.25 * pulse, KIND_ELLIPSE, 0, 0);
    inst(cx - outer, cy - outer, outer * 2, outer * 2, portalColor, <f32>0.9, KIND_RING, 0, inner / outer);
  }
  // Drift dust (v3.4.0): one fading square per cell a segment slid through,
  // emitted AFTER the player loop -- must match render2d.js drawDust exactly
  // (same alpha/size formula, same draw order) for parity.
  const nDust = min(load<i32>(frameIn + FR_NDUST), MAX_DUST);
  const dustSize = cs * <f32>0.4;
  const dustOff = (cs - dustSize) / 2;
  for (let i = 0; i < nDust; i++) {
    const o = frameIn + FR_DUST + <usize>(i * 12);
    const age = load<f32>(o, 8);
    const alpha = <f32>0.35 * (<f32>1 - age);
    if (alpha <= 0) continue;
    inst(<f32>load<i32>(o) * cs + dustOff, <f32>load<i32>(o, 4) * cs + dustOff, dustSize, dustSize, COLOR_DUST, alpha, KIND_RECT, 0, 0);
  }
  return getInstN();
}
