// ============================================================
// One-shot/transient effects: boost jetstream, powerup activation flash,
// drift dust, blue shell (projectile + explosion), scissors wall-shatter
// debris, wormhole portals, and the input-flash strip. Every deterministic
// (non-RNG) formula here must mirror its wasm/renderer.ts counterpart
// exactly for wasm/2D pixel parity. Depends on render2d-core.js's `ctx`,
// `grid`, `cellGap`, and render2d-art.js's `POWERUP_STYLE`.
// ============================================================
const FLASH_DIR_VECTORS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
// Piñata candy burst (v3.6.6): a fixed spray of festive pixel bits. Count +
// palette MUST mirror wasm/renderer.ts CANDY_N / candyColor for parity.
const CANDY_N = 14;
const CANDY_COLORS = ["#ffcc00", "#ff4499", "#44ccff", "#77ee44"]; // gold / pink / cyan / lime

// Boost jetstream: a few semi-transparent squares trailing behind the head
// opposite the direction of travel. Visual only -- no gameplay effect.
// Reused for the hold-boost cue (color "#9df", gated by opts.boostTrail) and
// the speedBoost-powerup ACTIVE cue (the powerup color, gated by
// opts.powerupFx) so "you are moving fast" reads the same way for both.
function drawBoostTrail(headPx, headPy, dir, now, color) {
  const cs = grid.cellSize;
  // ctx.save()/ctx.restore() bracket a group of drawing calls: save()
  // remembers the current canvas settings (fillStyle, globalAlpha, ...) so
  // they can be restored afterward, letting this function tweak alpha/color
  // freely without leaking those changes to whatever draws next.
  ctx.save();
  for (let n = 0; n < 3; n++) {
    const phase = (now / 90 + n * 0.33) % 1;
    const dist = phase * cs * 1.5;
    ctx.globalAlpha = 0.5 * (1 - phase);
    ctx.fillStyle = color;
    const px = headPx + cs / 2 - dir.x * dist - cs * 0.15;
    const py = headPy + cs / 2 - dir.y * dist - cs * 0.15;
    ctx.fillRect(px, py, cs * 0.3, cs * 0.3);
  }
  ctx.restore();
}
// Powerup activation flash: a brief bright pop of the powerup color over
// every body segment on the tick a powerup fires. Drawn at GRID positions
// (like heldGlow) so 2D/wasm parity is exact. `age` is 0..1 elapsed.
function drawPowerFlash(body, color, age) {
  const alpha = Math.max(0, 1 - age) * 0.85;
  if (alpha <= 0) return;
  const cs = grid.cellSize, cell = cs - cellGap;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  for (const seg of body) ctx.fillRect(seg.x * cs, seg.y * cs, cell, cell);
  ctx.restore();
}
// Drift dust (v3.4.0, replaces the old fixed head scatter): one fading
// translucent square per grid cell a body segment slid through. main.js
// owns spawning/aging (fx.dust = [{x, y, age}], age 0..1); this just draws
// whatever it's given, deterministically -- wasm parity depends on the
// exact same alpha/size formula.
function drawDust(dustList) {
  if (!dustList || !dustList.length) return;
  const cs = grid.cellSize;
  const size = cs * 0.4;
  const off = (cs - size) / 2;
  ctx.save();
  ctx.fillStyle = "#ccc";
  for (const d of dustList) {
    const alpha = 0.35 * (1 - d.age);
    if (alpha <= 0) continue;
    ctx.globalAlpha = alpha;
    ctx.fillRect(d.x * cs + off, d.y * cs + off, size, size);
  }
  ctx.restore();
}
// Blue Shell projectile: a small spinning shell shape, colored distinctly
// from every pickup/trail so it reads as "a moving threat," not a static
// tile.
function drawBlueShell(shell, now) {
  const cs = grid.cellSize;
  const cx = shell.x * cs + cs / 2, cy = shell.y * cs + cs / 2;
  const spin = (now / 300) % (Math.PI * 2);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(spin);
  ctx.fillStyle = "#14e"; // matches the deep-royal blueShell pickup (v3.6.2)
  ctx.beginPath();
  ctx.ellipse(0, 0, cs * 0.42, cs * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#dff";
  ctx.beginPath();
  ctx.arc(0, -cs * 0.05, cs * 0.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
// Blue Shell explosion: one-shot expanding, fading ring at the impact
// point, radius scaled to the server's actual explosionRadius so the
// visual honestly reflects the splash area. `age` is 0..1 elapsed
// fraction of EXPLOSION_DURATION_MS (see main.js, which owns the timing
// since this module has no per-call memory of its own).
function drawExplosion(x, y, radiusCells, age) {
  const cs = grid.cellSize;
  const cx = x * cs + cs / 2, cy = y * cs + cs / 2;
  // Piñata candy burst (v3.6.6): a NEGATIVE radius flags this as a candy
  // pop (server encodes -spread) rather than a blue-shell ring. Draw a
  // fixed spray of festive pixel bits flung outward, fading with age. The
  // math is fully deterministic (no RNG, no wall-clock) so it stays pixel-
  // parity with the wasm core -- see wasm/renderer.ts CANDY_* mirror.
  if (radiusCells < 0) {
    const dist = -radiusCells * cs * age;
    const phase = ((x + y) % 7) * 0.897;
    const sz = cs * 0.30 * (1 - 0.4 * age);
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - age);
    for (let i = 0; i < CANDY_N; i++) {
      const ang = i * 2.399963 + phase;
      const px = cx + Math.cos(ang) * dist;
      const py = cy + Math.sin(ang) * dist;
      ctx.fillStyle = CANDY_COLORS[i & 3];
      ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
    }
    ctx.restore();
    return;
  }
  const maxR = radiusCells * cs;
  ctx.save();
  ctx.globalAlpha = Math.max(0, 1 - age);
  ctx.strokeStyle = "#39f";
  ctx.lineWidth = Math.max(2, cs * 0.15);
  ctx.beginPath();
  ctx.arc(cx, cy, maxR * age, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
// Scissors wall-shatter (v4.5.0): a dynamic wall broken through by a
// scissors-armed snake. Same deterministic flung-debris technique as the
// pinata candy burst above (drawExplosion's negative-radius branch), but a
// stone/gray palette so it reads as "wall breaking" rather than "food
// bursting." Must mirror wasm/renderer.ts drawWallShatter exactly.
const WALLSHATTER_N = 10;
const DEBRIS_COLORS = ["#999", "#753", "#555", "#420"];
function drawWallShatter(x, y, age) {
  const cs = grid.cellSize;
  const cx = x * cs + cs / 2, cy = y * cs + cs / 2;
  const dist = cs * 1.1 * age;
  const phase = ((x + y) % 7) * 0.897;
  const sz = cs * 0.28 * (1 - 0.4 * age);
  ctx.save();
  ctx.globalAlpha = Math.max(0, 1 - age);
  for (let i = 0; i < WALLSHATTER_N; i++) {
    const ang = i * 2.399963 + phase;
    const px = cx + Math.cos(ang) * dist;
    const py = cy + Math.sin(ang) * dist;
    ctx.fillStyle = DEBRIS_COLORS[i & 3];
    ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
  }
  ctx.restore();
}
// Wormhole portals (2026-07-20 rework): a purple pulsing ring with a soft
// core at each entry/exit cell of a fired wormhole. The server owns the
// lifecycle (portalFx appears in the broadcast while a snake is threading
// through, plus a short linger); this just draws whatever is in the
// snapshot. Color is the wormhole powerup purple (#a3f) so the effect
// reads as "that powerup did this". Pulse is keyed off the portal id,
// exactly like pickups/walls, and the ring geometry mirrors the wasm
// core's KIND_RING math (mid-radius stroke of width outer-inner) so the
// two renderers stay pixel-parity.
function drawPortals(portalList, now) {
  if (!portalList) return;
  const cs = grid.cellSize, cell = cs - cellGap;
  for (const p of portalList) {
    const cx = p.x * cs + cell / 2, cy = p.y * cs + cell / 2;
    const pulse = 0.5 + 0.5 * Math.sin(now / 180 + p.id);
    const outer = cs * (0.55 + 0.1 * pulse);       // breathing outer radius
    const inner = outer - Math.max(2, cs * 0.12);  // ring thickness
    ctx.save();
    // Soft core glow first (under the ring), alpha breathing with the
    // same pulse.
    ctx.globalAlpha = 0.25 + 0.25 * pulse;
    ctx.fillStyle = POWERUP_STYLE.wormhole;
    ctx.beginPath();
    ctx.ellipse(cx, cy, cs * 0.3, cs * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    // The ring: stroked at the mid-radius with lineWidth = outer-inner,
    // the same composition the wasm executor uses for KIND_RING.
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = POWERUP_STYLE.wormhole;
    ctx.lineWidth = outer - inner;
    ctx.beginPath();
    ctx.arc(cx, cy, (outer + inner) / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
// Draws a short fading strip on the leading edge of the head cell at
// (px, py), in the direction the player just pressed.
function drawInputFlash(px, py, dirName, alpha) {
  const v = FLASH_DIR_VECTORS[dirName];
  if (!v || alpha <= 0) return;
  const cs = grid.cellSize;
  const stripW = Math.max(3, Math.round(cs * 0.28));
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#fff";
  if (v.x === 1) ctx.fillRect(px + cs - stripW, py, stripW, cs - cellGap);
  else if (v.x === -1) ctx.fillRect(px, py, stripW, cs - cellGap);
  else if (v.y === 1) ctx.fillRect(px, py + cs - stripW, cs - cellGap, stripW);
  else if (v.y === -1) ctx.fillRect(px, py, cs - cellGap, stripW);
  ctx.restore();
}
