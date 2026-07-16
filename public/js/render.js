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
// the LOCAL player's own snake(s), and are entirely controlled by the fx
// object main.js passes in (which itself reflects the server-side clientFx
// config; this module has no independent on/off logic of its own -- pass an
// empty/absent array to disable either effect).
//
// Phase 3 (dual local controls): a single connection may control more than
// one snake (couch co-op). fx.flashes and fx.glides are therefore arrays
// (0-2 entries), each tagged with the server slot it applies to, rather
// than a single object -- render.js looks up the matching entry, if any,
// per player while drawing. Everything else about the draw loop is
// unchanged and slot-count-agnostic.
//
// The optional eatenKeys argument is an array of food cells the local
// predictor(s) are provisionally treating as eaten; we hide those foods
// immediately so predicted eats look consistent. If the server later
// rejects an eat, predict.js rolls it back and the food reappears.
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).render = "render 2026-07-12.15";
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
  function draw(prevSnap, currSnap, localBodies, eatenKeys, fx) {
    if (!currSnap) return;
    if (!grid || grid.cols !== currSnap.grid.cols || grid.cellSize !== currSnap.grid.cellSize) {
      resize(currSnap.grid);
    }
    const flashes = (fx && fx.flashes) || [];
    const glides = (fx && fx.glides) || [];
    const now = performance.now();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (currSnap.food) {
      const key = currSnap.food.x + "," + currSnap.food.y;
      if (!eatenKeys || eatenKeys.indexOf(key) === -1) drawCell(currSnap.food, "#e33");
    }
    currSnap.players.forEach((p, i) => {
      if (!p) return;
      const body = (localBodies && localBodies.has(i)) ? localBodies.get(i) : p.body;
      if (!body || !body.length) return;
      const glide = glides.find(g => g.slot === i);
      let headPx = body[0].x * grid.cellSize;
      let headPy = body[0].y * grid.cellSize;
      if (glide) {
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
      const flash = flashes.find(f => f.slot === i);
      if (flash) {
        const alpha = Math.max(0, 1 - (now - flash.t) / flash.durationMs);
        drawInputFlash(headPx, headPy, flash.dir, alpha);
      }
    });
  }
  return { draw };
})();
