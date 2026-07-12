// ============================================================
// Rendering: grid-snapped board draw. Whole cells only, integer coords,
// zero sub-cell interpolation. Tail drops, a cell appears at the head.
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).render = "render 2026-07-12.7";
const Render = (() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  let grid = null;
  function resize(g) {
    grid = g;
    canvas.width = g.cols * g.cellSize;
    canvas.height = g.rows * g.cellSize;
  }
  function drawCell(seg, color) {
    ctx.fillStyle = color;
    ctx.fillRect(seg.x * grid.cellSize, seg.y * grid.cellSize, grid.cellSize - 1, grid.cellSize - 1);
  }
  function draw(prevSnap, currSnap, localBodies) {
    if (!currSnap) return;
    if (!grid || grid.cols !== currSnap.grid.cols || grid.cellSize !== currSnap.grid.cellSize) {
      resize(currSnap.grid);
    }
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (currSnap.food) drawCell(currSnap.food, "#e33");
    currSnap.players.forEach((p, i) => {
      if (!p) return;
      const body = (localBodies && localBodies.has(i)) ? localBodies.get(i) : p.body;
      if (!body) return;
      body.forEach((seg, si) => drawCell(seg, si === 0 ? p.color.head : p.color.body));
      if (!p.alive) {
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        body.forEach(seg => ctx.fillRect(seg.x * grid.cellSize, seg.y * grid.cellSize, grid.cellSize - 1, grid.cellSize - 1));
      }
    });
  }
  return { draw };
})();
