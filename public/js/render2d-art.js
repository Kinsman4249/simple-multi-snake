// ============================================================
// Style/art constants + pixel-art tile drawers: powerup pickup/trail
// colors, wall warn/spike glyphs, the banana and scissors pixel-art
// bitmaps, and the trail/wall/pickup draw functions. Every bitmap function
// here must mirror its wasm/renderer.ts counterpart exactly (same rows/
// values) for wasm/2D pixel parity. Depends on render2d-core.js's `ctx`,
// `grid`, `cellGap`, `Render2D`.
// ============================================================

// Powerup pickup + trail styling. Purely cosmetic lookups, no gameplay
// meaning -- see server-rust/src/config.rs PowerupsCfg for the actual
// config/behavior.
const POWERUP_STYLE = {
  wormhole: "#a3f",
  // growthSpurt & speedBoost used to be near-identical warm yellows/oranges
  // (#fd6 vs #f93) that read the same as the banana pickup at a glance
  // (v3.6.2). They are now pushed to opposite ends of the warm range for
  // maximum contrast: growthSpurt a vivid pure yellow, speedBoost a hot
  // red-orange. The banana pickup no longer competes for a flat color at all
  // -- it renders as a pixel-art banana (see drawPickup / BANANA_ART).
  growthSpurt: "#fe0",
  iceTrail: "#9df",
  poisonTrail: "#4a2",
  speedBoost: "#f50",
  // blueShell was #39f, an azure too close to iceTrail's pale #9df -- the two
  // pickup icons read as the same blue at a glance (v3.6.2). Pushed to a deep
  // royal blue that's clearly darker/richer than the icy powder blue.
  blueShell: "#14e",
  bananaTrail: "#fd4",
  helloWorld: "#0ff",
  // Fallback swatch for any generic UI/info-popup use -- the pickup and
  // head-icon themselves draw as pixel-art (SCISSORS_ART), not this flat
  // color (same treatment as bananaTrail above).
  scissors: "#ccd"
};
// Grid decay / anti-turtling obstacles (v3.8.1): a telegraphed cell shows
// a pixel-art red "!" for the warning window, then becomes a pixel-art
// SPIKE trap once solid (not a flat block -- v3.8.0's plain gray square
// read as just another powerup pickup, maintainer feedback), pulsing
// again (faster) during its despawn-telegraph tail. The warn glyph was
// recolored/reshaped from a translucent flat-orange full-tile fill
// (v3.8.1) to a small red "!" -- the flat orange read too close
// to the speedBoost powerup tint (#f50) at a glance (maintainer
// feedback). Only the glyph pixels flash (not the whole tile), and the
// pulse period is kept slow (~1.3s) with a bounded alpha floor -- no
// full-tile strobing, so this stays well clear of photosensitive-flash
// territory. Colors chosen to read as distinct from every powerup/trail/
// food tint on the board.
const WALL_WARN_COLORS = { 1: "#f33", 2: "#900" };
// "!" pixel-art (5x5 sub-grid): a 3-wide shaded stem (cols 1-3, dark-
// bright-dark) for rows 0-2, a blank gap row, then the dot on row 4.
// Outer columns (0, 4) stay empty so the glyph reads as a narrow mark,
// not a block. Must mirror wasm/renderer.ts warnVal()/warnColor()
// exactly for parity.
function warnVal(r, c) {
  if (r === 3) return 0;
  if (c === 0 || c === 4) return 0;
  return c === 2 ? 1 : 2;
}
// Spike pixel-art (5x5 sub-grid), same rect-composition technique as
// BANANA_ART below: 1 = mid-gray body, 2 = bright tip highlight, 3 = dark
// shadow/gap. Three spike columns (0/2/4) alternate tip-then-body down the
// cell so it reads as a row of stalagmite spikes, not a solid block. Must
// mirror wasm/renderer.ts spikeVal()/spikeColor() exactly for parity.
const SPIKE_COLORS = { 1: "#9a9a9a", 2: "#eee", 3: "#4a4a4a" };
function spikeVal(r, c) {
  if (r === 0) return c % 2 === 0 ? 2 : 3;
  if (r === 1) return c % 2 === 0 ? 1 : 2;
  if (r === 2) return 1;
  if (r === 3) return c % 2 === 0 ? 3 : 1;
  return 3;
}
// Trail tints sit directly on the black background, so they need far more
// alpha than an overlay would: the old 0.35-0.4 read as near-black,
// especially after a fractional downscale.
const TRAIL_STYLE = {
  iceTrail: "rgba(150,225,255,0.65)",
  poisonTrail: "rgba(110,210,70,0.6)"
  // bananaTrail is drawn as pixel-art bananas (drawBananaTile), not a flat
  // tint -- see BANANA_ART below.
};
// Pixel-art banana (5x5 sub-grid): 0 empty / 1 body / 2 tip / 3 ripeness
// spot -- a yellow crescent with brown tips AND a couple of dark-brown
// speckles on the body (v3.6.2), drawn grid-aligned so a banana tile reads
// unmistakably as a banana instead of yet another warm-colored square. The
// wasm renderer draws the identical shape (bananaVal + the same
// round(i*cell/5) pixel edges) so parity stays exact.
const BANANA_ART = [
  [0, 0, 0, 1, 2],
  [0, 0, 1, 3, 0], // ripeness spot at (1,3)
  [0, 1, 1, 0, 0],
  [3, 1, 0, 0, 0], // ripeness spot at (3,0)
  [2, 1, 0, 0, 0]
];
const BANANA_BODY = "#fd4", BANANA_TIP = "#a70", BANANA_SPOT = "#630";
// Pixel-art scissors (5x5 sub-grid), canonical "facing up" orientation --
// blade tips (2) at the top narrowing to a pivot rivet (3) at center,
// handle loops (4) at the bottom. 1 = blade shaft. Rotated 0/90/180/270
// degrees by scissorsVal() below to face whichever way the snake is
// currently traveling (equipped head icon) -- the ground pickup always
// draws the canonical un-rotated orientation. Must mirror
// wasm/renderer.ts scissorsVal() exactly for parity.
const SCISSORS_ART = [
  [0, 2, 0, 2, 0],
  [0, 1, 0, 1, 0],
  [0, 0, 3, 0, 0],
  [4, 0, 0, 0, 4],
  [4, 0, 0, 0, 4]
];
const SCISSORS_BLADE = "#dde", SCISSORS_TIP = "#fff", SCISSORS_PIVOT = "#333", SCISSORS_HANDLE = "#e33";
function scissorsColor(v) {
  return v === 2 ? SCISSORS_TIP : v === 3 ? SCISSORS_PIVOT : v === 4 ? SCISSORS_HANDLE : SCISSORS_BLADE;
}
// dirIdx: 0 up, 1 down, 2 left, 3 right -- matches wasm/renderer.ts
// dirVX/dirVY convention. Rotates the 5x5 lookup by remapping (r,c)
// before indexing into the canonical up-facing array.
function scissorsVal(r, c, dirIdx) {
  if (dirIdx === 1) return SCISSORS_ART[4 - r][4 - c];
  if (dirIdx === 3) return SCISSORS_ART[4 - c][r];
  if (dirIdx === 2) return SCISSORS_ART[c][4 - r];
  return SCISSORS_ART[r][c];
}
function dirIdxFromVec(dir) {
  if (!dir) return 0;
  if (dir.y === -1) return 0;
  if (dir.y === 1) return 1;
  if (dir.x === -1) return 2;
  if (dir.x === 1) return 3;
  return 0;
}
// A single pixel-art scissors icon on tile (cx,cy), oriented by dirIdx.
// Same round(i*cell/5) pixel edges as drawBananaTile for parity.
function drawScissorsTile(cx, cy, dirIdx) {
  const cs = grid.cellSize, cell = cs - cellGap;
  const ox = cx * cs, oy = cy * cs;
  // Draws the icon as a 5x5 grid of small filled rectangles (a "pixel-art"
  // sprite built from plain fillRect calls, no image file needed): loop
  // over each of the 25 sub-cells, skip empty ones, fill the rest in that
  // sub-cell's color.
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const v = scissorsVal(r, c, dirIdx);
      if (!v) continue;
      const x0 = Math.round(c * cell / 5), x1 = Math.round((c + 1) * cell / 5);
      const y0 = Math.round(r * cell / 5), y1 = Math.round((r + 1) * cell / 5);
      ctx.fillStyle = scissorsColor(v);
      ctx.fillRect(ox + x0, oy + y0, x1 - x0, y1 - y0);
    }
  }
}
// Powerup pickups: a small pulsing square colored per type, so a pickup
// reads as "alive" on the board without needing a sprite/animation asset.
function drawPickup(p, now) {
  const cs = grid.cellSize;
  const pulse = 0.5 + 0.5 * Math.sin(now / 220 + p.id);
  // Banana pickup: draw the pixel-art banana (crescent + brown tips/spots)
  // rather than a flat square, so it can never be mistaken for the warm-
  // colored growthSpurt/speedBoost pickups (v3.6.2). It still "breathes" via
  // the shared alpha pulse; the shape carries the identity instead of color.
  if (p.type === "bananaTrail") {
    ctx.save();
    ctx.globalAlpha = 0.6 + 0.4 * pulse;
    drawBananaTile(p.x, p.y);
    ctx.restore();
    return;
  }
  // Scissors pickup: pixel-art scissors (canonical facing-up orientation --
  // ground pickups don't have a travel direction), same "breathing" alpha
  // pulse as the banana pickup above.
  if (p.type === "scissors") {
    ctx.save();
    ctx.globalAlpha = 0.6 + 0.4 * pulse;
    drawScissorsTile(p.x, p.y, 0);
    ctx.restore();
    return;
  }
  const color = POWERUP_STYLE[p.type] || "#fff";
  const size = (cs - 2) * (0.7 + 0.3 * pulse);
  const offset = (cs - size) / 2;
  ctx.save();
  ctx.globalAlpha = 0.6 + 0.4 * pulse;
  ctx.fillStyle = color;
  ctx.fillRect(p.x * cs + offset, p.y * cs + offset, size, size);
  ctx.restore();
}
// Laid trail tiles (drawn UNDER snake bodies). Ice/poison are a flat dim
// tint; banana is pixel-art (drawBananaTile) so it reads distinctly.
function drawTrails(trailList) {
  if (!trailList) return;
  const cs = grid.cellSize;
  for (const t of trailList) {
    if (t.type === "bananaTrail") { drawBananaTile(t.x, t.y); continue; }
    ctx.fillStyle = TRAIL_STYLE[t.type] || "rgba(255,255,255,0.2)";
    ctx.fillRect(t.x * cs, t.y * cs, cs - cellGap, cs - cellGap);
  }
}
// A single pixel-art spike trap on tile (cx,cy), same 5x5 sub-cell edge
// math as drawBananaTile below so both stay gaplessly tiled and pixel-
// aligned with the wasm path.
function drawSpikeTile(cx, cy, alpha) {
  const cs = grid.cellSize, cell = cs - cellGap;
  const ox = cx * cs, oy = cy * cs;
  ctx.save();
  if (alpha != null) ctx.globalAlpha = alpha;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const x0 = Math.round(c * cell / 5), x1 = Math.round((c + 1) * cell / 5);
      const y0 = Math.round(r * cell / 5), y1 = Math.round((r + 1) * cell / 5);
      ctx.fillStyle = SPIKE_COLORS[spikeVal(r, c)];
      ctx.fillRect(ox + x0, oy + y0, x1 - x0, y1 - y0);
    }
  }
  ctx.restore();
}
// Grid decay / anti-turtling obstacles (v3.8.1): "warn" pulses hazard
// orange at low alpha (the telegraph -- not yet collidable); "solid" is
// the pixel-art spike trap at full alpha; "fading" is the same spikes
// pulsing (faster, deeper) as a despawn cue. Must mirror wasm/renderer.ts's
// wall instance emission exactly (same pulse formulas, keyed off wall id
// like pickups) for parity.
function drawWalls(wallList, now) {
  if (!wallList) return;
  const cs = grid.cellSize;
  for (const w of wallList) {
    if (w.state === "warn") {
      // Slow throb (~1.3s period), alpha floor kept well above 0 so this
      // never reads as a hard strobe.
      const pulse = 0.5 + 0.5 * Math.sin(now / 220 + w.id);
      const alpha = 0.55 + 0.45 * pulse;
      const cell = cs - cellGap;
      const ox = w.x * cs, oy = w.y * cs;
      ctx.save();
      ctx.globalAlpha = alpha;
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          const v = warnVal(r, c);
          if (v === 0) continue;
          const x0 = Math.round(c * cell / 5), x1 = Math.round((c + 1) * cell / 5);
          const y0 = Math.round(r * cell / 5), y1 = Math.round((r + 1) * cell / 5);
          ctx.fillStyle = WALL_WARN_COLORS[v];
          ctx.fillRect(ox + x0, oy + y0, x1 - x0, y1 - y0);
        }
      }
      ctx.restore();
      continue;
    }
    let alpha = 1;
    if (w.state === "fading") {
      const pulse = 0.5 + 0.5 * Math.sin(now / 90 + w.id);
      alpha = 0.5 + 0.5 * pulse;
    }
    drawSpikeTile(w.x, w.y, alpha);
  }
}
// A single pixel-art banana on tile (cx,cy). Pixel edges are round(i*cell/5)
// so the 5 sub-columns/rows tile the cell gaplessly; the wasm path uses the
// exact same edges for parity.
function drawBananaTile(cx, cy) {
  const cs = grid.cellSize, cell = cs - cellGap;
  const ox = cx * cs, oy = cy * cs;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const v = BANANA_ART[r][c];
      if (!v) continue;
      const x0 = Math.round(c * cell / 5), x1 = Math.round((c + 1) * cell / 5);
      const y0 = Math.round(r * cell / 5), y1 = Math.round((r + 1) * cell / 5);
      ctx.fillStyle = v === 2 ? BANANA_TIP : (v === 3 ? BANANA_SPOT : BANANA_BODY);
      ctx.fillRect(ox + x0, oy + y0, x1 - x0, y1 - y0);
    }
  }
}

Object.assign(Render2D, { POWERUP_STYLE });
