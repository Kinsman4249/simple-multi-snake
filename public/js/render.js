// ============================================================
// Rendering: draws the board every animation frame from interpolated
// positions rather than raw per-tick snapshots.
//
// Remote snakes and food are rendered slightly in the past (about one
// tick behind real time) and interpolated between the two most recent
// authoritative snapshots. Rendering in the past rather than
// extrapolating forward means we are always interpolating between two
// values we actually have, so there is nothing to overshoot or guess
// at; the cost is a small, constant, deliberate latency, which is
// the intended tradeoff (locally controlled snakes use predict.js
// instead and are not delayed).
//
// The one place this constant delay becomes visible as a hitch is
// exactly when tickMs itself changes (a speed-ramp step): the
// interpolation window resizes on that tick, since it is read fresh
// from tickMs every frame. That is the "latency only matters during
// speed changes" behavior called for -- ordinary jitter is absorbed,
// a ramp step can cause at most one frame's worth of visible catch-up.
// ============================================================
const Render = (() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  let grid = null;

  function resize(g) {
    grid = g;
    canvas.width = g.cols * g.cellSize;
    canvas.height = g.rows * g.cellSize;
  }

  // A jump of more than one cell between ticks means this was not an
  // ordinary step (death/respawn now, wormhole teleport in Phase 4).
  // Snap instead of smearing a line across the board.
  function isTeleport(prevBody, currBody) {
    if (!prevBody || !prevBody.length || !currBody.length) return true;
    const dx = Math.abs(currBody[0].x - prevBody[0].x);
    const dy = Math.abs(currBody[0].y - prevBody[0].y);
    return dx + dy > 1;
  }

  function lerpSeg(a, b, alpha) {
    return { x: a.x + (b.x - a.x) * alpha, y: a.y + (b.y - a.y) * alpha };
  }

  function interpolatedBody(prevP, currP, alpha) {
    if (!prevP || isTeleport(prevP.body, currP.body)) return currP.body;
    const len = Math.min(prevP.body.length, currP.body.length);
    const out = [];
    for (let i = 0; i < len; i++) out.push(lerpSeg(prevP.body[i], currP.body[i], alpha));
    for (let i = len; i < currP.body.length; i++) out.push(currP.body[i]); // growth tail, nothing to lerp from
    return out;
  }

  function drawCell(seg, color) {
    ctx.fillStyle = color;
    ctx.fillRect(seg.x * grid.cellSize, seg.y * grid.cellSize, grid.cellSize - 1, grid.cellSize - 1);
  }

  // localBodies: Map<slotIndex, {x,y}[]> from predict.js, for any
  // slot(s) this connection controls. Those override interpolation
  // and are drawn at their own predicted/blended position instead.
  function draw(prevSnap, currSnap, localBodies) {
    if (!currSnap) return;
    if (!grid || grid.cols !== currSnap.grid.cols || grid.cellSize !== currSnap.grid.cellSize) {
      resize(currSnap.grid);
    }

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (currSnap.food) drawCell(currSnap.food, "#e33");

    // Render ~tickMs behind now, interpolating between prevSnap and
    // currSnap's arrival times. See module comment for why "behind"
    // rather than extrapolating forward.
    const now = performance.now();
    let alpha = 1;
    if (prevSnap) {
      const span = currSnap.recvTime - prevSnap.recvTime;
      const renderTime = now - currSnap.tickMs;
      alpha = span > 0 ? Math.min(1, Math.max(0, (renderTime - prevSnap.recvTime) / span)) : 1;
    }

    currSnap.players.forEach((p, i) => {
      if (!p) return;
      const prevP = prevSnap ? prevSnap.players[i] : null;
      const body = (localBodies && localBodies.has(i))
        ? localBodies.get(i)
        : interpolatedBody(prevP, p, alpha);
      body.forEach((seg, si) => drawCell(seg, si === 0 ? p.color.head : p.color.body));
      if (!p.alive) {
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        body.forEach(seg => ctx.fillRect(seg.x * grid.cellSize, seg.y * grid.cellSize, grid.cellSize - 1, grid.cellSize - 1));
      }
    });
  }

  return { draw };
})();
