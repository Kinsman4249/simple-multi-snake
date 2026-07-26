// The per-frame player-body draw loop: held-glow halo, scissors-equipped
// icon, body segments (glide/interpolated/plain), death tint, boost/
// speedBoost jetstreams, input flash, and powerup-activation flash. Split
// out of renderer.ts's render() (its single largest section) purely for
// file size; every formula here must stay byte-identical to the block it
// was extracted from, and must keep mirroring render2d.js's player-draw
// path for wasm/2D pixel parity.
import {
  SNAP_PLAYERS, PLAYER_STRIDE, SNAP_BODY,
  FR_FLASHES, FR_GLIDES, FR_LOCALS, FR_LOCAL_BODY, FR_PFLASH,
  KIND_RECT, KIND_ELLIPSE,
} from "./layout";
import { COLOR_WHITE, COLOR_BLACK, COLOR_JETSTREAM, pickupColor } from "./colors";
import { scissorsVal, scissorsColor, dirIdxFromDelta, easeOutCubic, lerpf, dirVX, dirVY, segX, segY } from "./art";
import { inst } from "./instbuf";

export function drawPlayers(
  curr: usize, prev: usize, frameIn: usize,
  now: f64, cs: f32, cell: f32, tickMs: f32, recvElapsed: f32,
  interpolate: bool, heldGlow: bool, powerFx: bool, boostTrail: bool,
  nPlayers: i32, nLocals: i32, nFlashes: i32, nGlides: i32, nPflash: i32,
): void {
  for (let i = 0; i < nPlayers; i++) {
    // `p` is this player's byte address within the snapshot's player array
    // (index * fixed-size stride, see layout.ts). `load<i32>(p)` reads the
    // "present" flag at offset 0 -- see docs/JS-CHEATSHEET.md's
    // AssemblyScript section for what load<T>/store<T> do.
    const p = curr + SNAP_PLAYERS + <usize>(i * PLAYER_STRIDE);
    if (!load<i32>(p)) continue; // not present
    const alive = load<i32>(p, 4) != 0;
    const colorHead = load<u32>(p, 8);
    const colorBody = load<u32>(p, 12);
    // Powerup timer tail-drain: head-side nActive segments tinted the powerup
    // color (must match render2d.js segFill exactly for parity).
    const activeIdx = load<i32>(p, 48);
    const activePct = load<f32>(p, 52);
    const powerActive = powerFx && alive && activeIdx >= 0;
    const activeColor = powerActive ? pickupColor(activeIdx) : 0;
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
    // t is how far (0 = just moved, 1 = fully arrived) between the previous
    // and current grid position this player should visually be right now,
    // based on how much time has passed since the snapshot arrived. This is
    // what makes movement look smooth between discrete server ticks instead
    // of snapping.
    let t: f32 = 1;
    if (smooth) {
      const moveMs = load<f32>(p, 24);
      const span = moveMs > 0 ? moveMs : (tickMs > 0 ? tickMs : 100);
      t = recvElapsed / span;
      if (t < 0) t = 0; // clamp into 0..1
      if (t > 1) t = 1;
    }
    const prevPool = prev + SNAP_BODY;
    const prevLen = smooth ? load<i32>(pPrev, 36) : 0;
    const prevOff = smooth ? load<i32>(pPrev, 40) : 0;
    // Held-powerup glow: a pulsing halo in the powerup's color under every
    // segment, visible to EVERYONE (the server broadcasts heldPowerup to all
    // players precisely so opponents can plan counterplay). When BOTH a held
    // powerup and a wormhole charge are ready, the glow alternates colors
    // every 600ms -- same list order and clock formula as render2d.js's
    // readyGlows (held first, wormhole second) so parity stays exact.
    const heldIdx = load<i32>(p, 44);
    const wormCharge = load<i32>(p, 56) != 0;
    if (heldGlow && alive && (heldIdx >= 0 || wormCharge)) {
      let glowIdx = heldIdx >= 0 ? heldIdx : 0; // 0 = wormhole type index
      if (heldIdx >= 0 && wormCharge) {
        if (<i32>Math.floor(now / 600.0) % 2 == 1) glowIdx = 0;
      }
      const glowAlpha = <f32>(0.22 + 0.13 * Math.sin(now / 250.0 + <f64>i));
      const grow = cs * <f32>0.35;
      const glowColor = pickupColor(glowIdx);
      for (let si = 0; si < bodyLen; si++) {
        inst(<f32>segX(bodyPool, bodyOff + si) * cs - grow, <f32>segY(bodyPool, bodyOff + si) * cs - grow, cell + grow * 2, cell + grow * 2, glowColor, glowAlpha, KIND_ELLIPSE, 0, 0);
      }
    }
    // Scissors equipped (v4.5.0): the pixel-art scissors icon superimposed
    // directly over the head, rotated to face the current direction of
    // travel -- a SEPARATE, new primitive from the held-glow halo above
    // (maintainer request: "just have scissors superimposed", not also the
    // pulsing halo). Grid-aligned (not interpolated), same reasoning as the
    // halo, for 2D/wasm parity. Must mirror render2d.js's equivalent block.
    const scissorsCharge = load<i32>(p, 60) != 0;
    if (alive && scissorsCharge) {
      const sHeadX = segX(bodyPool, bodyOff), sHeadY = segY(bodyPool, bodyOff);
      const sDirIdx = dirIdxFromDelta(load<i32>(p, 16), load<i32>(p, 20));
      const sox = <f32>sHeadX * cs, soy = <f32>sHeadY * cs;
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          const v = scissorsVal(r, c, sDirIdx);
          if (v == 0) continue;
          const x0 = <f32>(<i32>Math.round(<f64>c * <f64>cell / 5.0));
          const x1 = <f32>(<i32>Math.round(<f64>(c + 1) * <f64>cell / 5.0));
          const y0 = <f32>(<i32>Math.round(<f64>r * <f64>cell / 5.0));
          const y1 = <f32>(<i32>Math.round(<f64>(r + 1) * <f64>cell / 5.0));
          inst(sox + x0, soy + y0, x1 - x0, y1 - y0, scissorsColor(v), 1, KIND_RECT, 0, 0);
        }
      }
    }
    const nActive = powerActive ? <i32>Math.ceil(<f64>activePct * <f64>bodyLen) : 0;
    let headPx = <f32>segX(bodyPool, bodyOff) * cs;
    let headPy = <f32>segY(bodyPool, bodyOff) * cs;
    if (glideAt != 0) {
      const gt0 = load<f32>(glideAt, 20) / load<f32>(glideAt, 24);
      const et = easeOutCubic(gt0 < 0 ? 0 : (gt0 > 1 ? 1 : gt0));
      headPx = lerpf(<f32>load<i32>(glideAt, 4) * cs, <f32>load<i32>(glideAt, 12) * cs, et);
      headPy = lerpf(<f32>load<i32>(glideAt, 8) * cs, <f32>load<i32>(glideAt, 16) * cs, et);
      inst(headPx, headPy, cell, cell, nActive > 0 ? activeColor : colorHead, 1, KIND_RECT, 0, 0);
      for (let si = 1; si < bodyLen; si++) {
        inst(<f32>segX(bodyPool, bodyOff + si) * cs, <f32>segY(bodyPool, bodyOff + si) * cs, cell, cell, si < nActive ? activeColor : colorBody, 1, KIND_RECT, 0, 0);
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
        inst(x, y, cell, cell, si < nActive ? activeColor : (si == 0 ? colorHead : colorBody), 1, KIND_RECT, 0, 0);
      }
    } else {
      for (let si = 0; si < bodyLen; si++) {
        inst(<f32>segX(bodyPool, bodyOff + si) * cs, <f32>segY(bodyPool, bodyOff + si) * cs, cell, cell, si < nActive ? activeColor : (si == 0 ? colorHead : colorBody), 1, KIND_RECT, 0, 0);
      }
    }
    if (!alive) {
      for (let si = 0; si < bodyLen; si++) {
        inst(<f32>segX(bodyPool, bodyOff + si) * cs, <f32>segY(bodyPool, bodyOff + si) * cs, cell, cell, COLOR_BLACK, <f32>0.5, KIND_RECT, 0, 0);
      }
    }
    // boost jetstream (hold-boost)
    const dirX = load<i32>(p, 16), dirY = load<i32>(p, 20);
    if (alive && load<i32>(p, 28) != 0 && boostTrail && (dirX != 0 || dirY != 0)) {
      for (let n = 0; n < 3; n++) {
        const phase = <f32>(((now / 90.0) + <f64>n * 0.33) % 1.0);
        const dist = phase * cs * <f32>1.5;
        inst(headPx + cs / 2 - <f32>dirX * dist - cs * <f32>0.15, headPy + cs / 2 - <f32>dirY * dist - cs * <f32>0.15, cs * <f32>0.3, cs * <f32>0.3, COLOR_JETSTREAM, <f32>0.5 * (1 - phase), KIND_RECT, 0, 0);
      }
    }
    // speedBoost-powerup ACTIVE jetstream (same shape, powerup color)
    if (alive && powerFx && activeIdx == 4 && (dirX != 0 || dirY != 0)) {
      const speedColor = pickupColor(4);
      for (let n = 0; n < 3; n++) {
        const phase = <f32>(((now / 90.0) + <f64>n * 0.33) % 1.0);
        const dist = phase * cs * <f32>1.5;
        inst(headPx + cs / 2 - <f32>dirX * dist - cs * <f32>0.15, headPy + cs / 2 - <f32>dirY * dist - cs * <f32>0.15, cs * <f32>0.3, cs * <f32>0.3, speedColor, <f32>0.5 * (1 - phase), KIND_RECT, 0, 0);
      }
    }
    // input flash
    for (let f = 0; f < nFlashes; f++) {
      const fo = frameIn + FR_FLASHES + <usize>(f << 4);
      if (load<i32>(fo) != i) continue;
      const alpha: f32 = <f32>1 - load<f32>(fo, 8) / load<f32>(fo, 12);
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
    // powerup activation flash: brief bright pop over every segment (grid
    // positions, like heldGlow) -- matches render2d.js drawPowerFlash.
    for (let f = 0; f < nPflash; f++) {
      const fo = frameIn + FR_PFLASH + <usize>(f << 4);
      if (load<i32>(fo) != i) continue;
      const age = load<f32>(fo, 8);
      const pfAlpha = (<f32>1 - age) * <f32>0.85;
      if (pfAlpha > 0) {
        const pfColor = pickupColor(load<i32>(fo, 4));
        for (let si = 0; si < bodyLen; si++) {
          inst(<f32>segX(bodyPool, bodyOff + si) * cs, <f32>segY(bodyPool, bodyOff + si) * cs, cell, cell, pfColor, pfAlpha, KIND_RECT, 0, 0);
        }
      }
      break;
    }
  }
}
