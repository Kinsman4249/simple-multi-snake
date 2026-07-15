// ============================================================
// Rendering: grid-snapped board draw. Whole cells only, integer coords,
// zero sub-cell interpolation, with two narrow, deliberate exceptions:
//
//   - Input flash: the instant a keypress is accepted, a short fading strip
//     is drawn on the leading edge of OUR OWN head cell, in the pressed
//     direction. This is driven purely by elapsed wall-clock time since the
//     keypress (fx.flash.t), not by network ticks or body movement at all --
//     it renders identically whether or not the body actually steps that
//     tick, which is what makes input feel instant regardless of RTT.
//   - Correction glide: on the rare tick where our own predicted head didn't
//     match the server's actual head, instead of a hard grid-snap we ease
//     OUR OWN head from the mispredicted cell to the corrected cell over
//     fx.glide.durationMs. This is the one place sub-cell pixel positions
//     are used; every other segment, every other player, and every other
//     frame remain exactly grid-snapped as before.
//
// Both effects are purely cosmetic (never affect gameplay), apply only to
// the local player's own snake, and are entirely controlled by the fx object
// main.js passes in (which itself reflects the server-side clientFx config;
// this module has no independent on/off logic of its own -- pass null/absent
// to disable either effect).
//
// The optional eatenKey argument is the food cell the local predictor is
// provisionally treating as eaten; we hide that food immediately so the
// client's predicted eat looks consistent. If the server later rejects the
// eat, predict.js rolls back and the food reappears.
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).render = "render 2026-07-12.14";
const Render = (() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  let grid = null;
  const FLASH_DIR_VECTORS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
  function resize(g) {
    grid = g;
    canvas.width = g.cols * g.cellSize;
    canvas.height = g.rows * g.cellSize;
  }
  function drawCell(seg, color) {
    ctx.fillStyle = color;
    ctx.fillRect(seg.x * grid.cellSize, seg.y * grid.cellSize, grid.cellSize - 1, grid.cellSize - 1);
  }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function lerp(a, b, t) { return a + (b - a) * t; }
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
    if (v.x === 1) ctx.fillRect(px + cs - stripW, py, stripW, cs - 1);
    else if (v.x === -1) ctx.fillRect(px, py, stripW, cs - 1);
    else if (v.y === 1) ctx.fillRect(px, py + cs - stripW, cs - 1, stripW);
    else if (v.y === -1) ctx.fillRect(px, py, cs - 1, stripW);
    ctx.restore();
  }
  function draw(prevSnap, currSnap, localBodies, eatenKey, fx) {
    if (!currSnap) return;
    if (!grid || grid.cols !== currSnap.grid.cols || grid.cellSize !== currSnap.grid.cellSize) {
      resize(currSnap.grid);
    }
    const flash = fx && fx.flash;
    const glide = fx && fx.glide;
    const now = performance.now();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (currSnap.food) {
      const key = currSnap.food.x + "," + currSnap.food.y;
      if (key !== eatenKey) drawCell(currSnap.food, "#e33");
    }
    currSnap.players.forEach((p, i) => {
      if (!p) return;
      const body = (localBodies && localBodies.has(i)) ? localBodies.get(i) : p.body;
      if (!body || !body.length) return;
      const isGliding = glide && glide.slot === i;
      let headPx = body[0].x * grid.cellSize;
      let headPy = body[0].y * grid.cellSize;
      if (isGliding) {
        const t = Math.min(1, (now - glide.startTime) / glide.durationMs);
        const et = easeOutCubic(t);
        headPx = lerp(glide.from.x * grid.cellSize, glide.to.x * grid.cellSize, et);
        headPy = lerp(glide.from.y * grid.cellSize, glide.to.y * grid.cellSize, et);
        ctx.fillStyle = p.color.head;
        ctx.fillRect(headPx, headPy, grid.cellSize - 1, grid.cellSize - 1);
        for (let si = 1; si < body.length; si++) drawCell(body[si], p.color.body);
      } else {
        body.forEach((seg, si) => drawCell(seg, si === 0 ? p.color.head : p.color.body));
      }
      if (!p.alive) {
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        body.forEach(seg => ctx.fillRect(seg.x * grid.cellSize, seg.y * grid.cellSize, grid.cellSize - 1, grid.cellSize - 1));
      }
      if (flash && flash.slot === i) {
        const alpha = Math.max(0, 1 - (now - flash.t) / flash.durationMs);
        drawInputFlash(headPx, headPy, flash.dir, alpha);
      }
    });
  }
  return { draw };
})();
