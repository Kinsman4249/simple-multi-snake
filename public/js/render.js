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
// Phase 4 -- lock-step interpolation (opts.interpolate, operator-configured
// via config.json clientRender, served through /api/config): the server
// broadcasts on a FIXED, known movement cadence and now includes each
// player's effective ms-per-cell (players[i].moveMs, boost included). For
// snakes rendered from server state (i.e. NOT the local predicted bodies),
// each segment is eased from its previous-snapshot cell to its current cell
// over exactly that interval, so travel on screen is smooth and in lock
// step with the server tick instead of jumping a whole cell per broadcast.
// Segments that teleport (respawn, growth, first sight) snap instantly.
// Purely cosmetic and entirely client-side: server collision, authority and
// the wire format of inputs are untouched.
(window.__BUILDS__ = window.__BUILDS__ || {}).render = "render 2026-07-15.3";
const Render = (() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  let grid = null;
  const FLASH_DIR_VECTORS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
  // Powerup pickup + trail styling. Purely cosmetic lookups, no gameplay
  // meaning -- see server.js POWERUPS for the actual config/behavior.
  const POWERUP_STYLE = {
    wormhole: "#a3f",
    growthSpurt: "#fd6",
    iceTrail: "#9df",
    poisonTrail: "#4a2",
    speedBoost: "#f93",
    blueShell: "#39f"
  };
  const TRAIL_STYLE = { iceTrail: "rgba(140,220,255,0.35)", poisonTrail: "rgba(70,160,50,0.4)" };
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
  // Powerup pickups: a small pulsing square colored per type, so a pickup
  // reads as "alive" on the board without needing a sprite/animation asset.
  function drawPickup(p, now) {
    const cs = grid.cellSize;
    const color = POWERUP_STYLE[p.type] || "#fff";
    const pulse = 0.5 + 0.5 * Math.sin(now / 220 + p.id);
    const size = (cs - 2) * (0.7 + 0.3 * pulse);
    const offset = (cs - size) / 2;
    ctx.save();
    ctx.globalAlpha = 0.6 + 0.4 * pulse;
    ctx.fillStyle = color;
    ctx.fillRect(p.x * cs + offset, p.y * cs + offset, size, size);
    ctx.restore();
  }
  // Laid trail tiles (ice/poison): flat, dim tint drawn UNDER snake bodies.
  function drawTrails(trailList) {
    if (!trailList) return;
    const cs = grid.cellSize;
    for (const t of trailList) {
      ctx.fillStyle = TRAIL_STYLE[t.type] || "rgba(255,255,255,0.2)";
      ctx.fillRect(t.x * cs, t.y * cs, cs - 1, cs - 1);
    }
  }
  // Boost jetstream: a few semi-transparent squares trailing behind the head
  // opposite the direction of travel. Visual only -- no gameplay effect,
  // gated by CLIENT_FX.boostTrail (opts.boostTrail).
  function drawBoostTrail(headPx, headPy, dir, now) {
    const cs = grid.cellSize;
    ctx.save();
    for (let n = 0; n < 3; n++) {
      const phase = (now / 90 + n * 0.33) % 1;
      const dist = phase * cs * 1.5;
      ctx.globalAlpha = 0.5 * (1 - phase);
      ctx.fillStyle = "#9df";
      const px = headPx + cs / 2 - dir.x * dist - cs * 0.15;
      const py = headPy + cs / 2 - dir.y * dist - cs * 0.15;
      ctx.fillRect(px, py, cs * 0.3, cs * 0.3);
    }
    ctx.restore();
  }
  // Slide dust: a light particle scatter at the head while a queued turn is
  // drifting (boost slide penalty). Visual only, gated by
  // CLIENT_FX.slideDust (opts.slideDust).
  function drawSlideDust(headPx, headPy, now) {
    const cs = grid.cellSize;
    ctx.save();
    for (let n = 0; n < 4; n++) {
      const phase = (now / 140 + n * 0.25) % 1;
      const angle = (n / 4) * Math.PI * 2;
      const dist = phase * cs * 0.6;
      ctx.globalAlpha = 0.35 * (1 - phase);
      ctx.fillStyle = "#ccc";
      const px = headPx + cs / 2 + Math.cos(angle) * dist - cs * 0.08;
      const py = headPy + cs / 2 + Math.sin(angle) * dist - cs * 0.08;
      ctx.fillRect(px, py, cs * 0.16, cs * 0.16);
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
    ctx.fillStyle = "#39f";
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
  // Per-segment interpolation factor between the previous and current
  // snapshot, clamped to [0,1]. t is time elapsed since the current snapshot
  // arrived, over this player's own ms-per-cell -- so a boosting snake's
  // on-screen glide is exactly as fast as its server cadence.
  function interpT(now, currSnap, moveMs) {
    const span = moveMs || currSnap.tickMs || 100;
    return Math.min(1, Math.max(0, (now - currSnap.recvTime) / span));
  }
  // Pixel position for segment si, eased from the matching segment of the
  // previous snapshot when it is a plausible one-cell move; snapped otherwise
  // (growth, respawn, first sight, or any teleport-sized jump).
  function segPixel(seg, prevBody, si, t) {
    const cs = grid.cellSize;
    if (t < 1 && prevBody && prevBody[si]) {
      const ps = prevBody[si];
      if (Math.abs(ps.x - seg.x) + Math.abs(ps.y - seg.y) === 1) {
        return { x: lerp(ps.x, seg.x, t) * cs, y: lerp(ps.y, seg.y, t) * cs };
      }
    }
    return { x: seg.x * cs, y: seg.y * cs };
  }
  function draw(prevSnap, currSnap, localBodies, eatenKeys, fx, opts) {
    if (!currSnap) return;
    if (!grid || grid.cols !== currSnap.grid.cols || grid.cellSize !== currSnap.grid.cellSize) {
      resize(currSnap.grid);
    }
    const flashes = (fx && fx.flashes) || [];
    const glides = (fx && fx.glides) || [];
    const interpolate = !!(opts && opts.interpolate);
    const now = performance.now();
    const cs = grid.cellSize;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawTrails(currSnap.trails);
    if (currSnap.food) {
      const key = currSnap.food.x + "," + currSnap.food.y;
      if (!eatenKeys || eatenKeys.indexOf(key) === -1) drawCell(currSnap.food, "#e33");
    }
    if (currSnap.powerupPickups) currSnap.powerupPickups.forEach(p => drawPickup(p, now));
    if (currSnap.blueShells) currSnap.blueShells.forEach(sh => drawBlueShell(sh, now));
    const explosions = (fx && fx.explosions) || [];
    explosions.forEach(e => drawExplosion(e.x, e.y, e.radius, e.age));
    currSnap.players.forEach((p, i) => {
      if (!p) return;
      const isLocal = localBodies && localBodies.has(i);
      const body = isLocal ? localBodies.get(i) : p.body;
      if (!body || !body.length) return;
      const glide = glides.find(g => g.slot === i);
      // Lock-step smoothing applies to server-rendered snakes only: the
      // local predicted body is already ahead of the wire by design, and
      // its corrections have their own glide effect below.
      const smooth = interpolate && !isLocal && p.alive &&
        prevSnap && prevSnap.players && prevSnap.players[i] && prevSnap.players[i].body;
      const t = smooth ? interpT(now, currSnap, p.moveMs) : 1;
      const prevBody = smooth ? prevSnap.players[i].body : null;
      let headPx = body[0].x * cs;
      let headPy = body[0].y * cs;
      if (glide) {
        const gt = Math.min(1, (now - glide.startTime) / glide.durationMs);
        const et = easeOutCubic(gt);
        headPx = lerp(glide.from.x * cs, glide.to.x * cs, et);
        headPy = lerp(glide.from.y * cs, glide.to.y * cs, et);
        ctx.fillStyle = p.color.head;
        ctx.fillRect(headPx, headPy, cs - 1, cs - 1);
        for (let si = 1; si < body.length; si++) drawCell(body[si], p.color.body);
      } else if (smooth) {
        for (let si = 0; si < body.length; si++) {
          const pos = segPixel(body[si], prevBody, si, t);
          if (si === 0) { headPx = pos.x; headPy = pos.y; }
          ctx.fillStyle = si === 0 ? p.color.head : p.color.body;
          ctx.fillRect(pos.x, pos.y, cs - 1, cs - 1);
        }
      } else {
        body.forEach((seg, si) => drawCell(seg, si === 0 ? p.color.head : p.color.body));
      }
      if (!p.alive) {
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        body.forEach(seg => ctx.fillRect(seg.x * cs, seg.y * cs, cs - 1, cs - 1));
      }
      if (p.alive && p.boost && opts && opts.boostTrail && p.dir) drawBoostTrail(headPx, headPy, p.dir, now);
      if (p.alive && p.sliding && opts && opts.slideDust) drawSlideDust(headPx, headPy, now);
      const flash = flashes.find(f => f.slot === i);
      if (flash) {
        const alpha = Math.max(0, 1 - (now - flash.t) / flash.durationMs);
        drawInputFlash(headPx, headPy, flash.dir, alpha);
      }
    });
  }
  return { draw };
})();
