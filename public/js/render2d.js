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
// Phase 7: this file is the FALLBACK renderer (the pre-wasm 2D draw path,
// kept fully working). public/js/render.js is now a facade that prefers the
// wasm renderer core and falls back here when the wasm artifact is missing
// or fails to instantiate, or when the operator sets clientRender.renderer
// to "2d". The 2D context is acquired lazily on the first draw (NOT at load
// time): a canvas can only ever hold one context type, so grabbing "2d"
// eagerly would poison the facade's wasm path before it could decide.
(window.__BUILDS__ = window.__BUILDS__ || {}).render2d = "render2d 2026-07-16.5";
const Render2D = (() => {
  const canvas = document.getElementById("game");
  let ctx = null;
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
  // Trail tints sit directly on the black background, so they need far more
  // alpha than an overlay would: the old 0.35-0.4 read as near-black,
  // especially after a fractional downscale.
  const TRAIL_STYLE = { iceTrail: "rgba(150,225,255,0.65)", poisonTrail: "rgba(110,210,70,0.6)" };
  // Gap between cells, in internal-resolution pixels. Scales with cell size
  // so it survives fractional CSS downscales (a fixed 1px gap lands between
  // destination pixels below scale 1 and vanishes).
  let cellGap = 1;
  function resize(g) {
    grid = g;
    cellGap = Math.max(1, Math.round(g.cellSize * 0.08));
    canvas.width = g.cols * g.cellSize;
    canvas.height = g.rows * g.cellSize;
    fitCanvas();
  }
  // Phase 5 display scaling: the canvas's INTERNAL resolution above never
  // changes, but its CSS size is fit to the #boardWrap box at the board's
  // own aspect ratio (16:9 with the shipped presets) -- letterbox/pillarbox,
  // never distort. Upscales snap DOWN to an integer multiple so cells stay
  // pixel-crisp (with image-rendering: pixelated in index.html); downscales
  // use the fractional fit, since there is no integer scale below 1.
  function fitCanvas() {
    if (!grid) return;
    const box = canvas.parentElement;
    if (!box) return;
    const borderPx = 4; // 2px canvas border each side sits OUTSIDE the CSS size
    const availW = Math.max(1, box.clientWidth - borderPx);
    const availH = Math.max(1, box.clientHeight - borderPx);
    let scale = Math.min(availW / canvas.width, availH / canvas.height);
    if (scale >= 1) scale = Math.floor(scale);
    canvas.style.width = Math.floor(canvas.width * scale) + "px";
    canvas.style.height = Math.floor(canvas.height * scale) + "px";
    // Pixelated is only right for integer upscales; on a fractional
    // downscale nearest-neighbor eats the inter-cell gaps, so let the
    // browser's smooth filtering preserve them instead.
    canvas.style.imageRendering = scale >= 1 ? "pixelated" : "auto";
  }
  window.addEventListener("resize", fitCanvas);
  function drawCell(seg, color) {
    ctx.fillStyle = color;
    ctx.fillRect(seg.x * grid.cellSize, seg.y * grid.cellSize, grid.cellSize - cellGap, grid.cellSize - cellGap);
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
      ctx.fillRect(t.x * cs, t.y * cs, cs - cellGap, cs - cellGap);
    }
  }
  // Boost jetstream: a few semi-transparent squares trailing behind the head
  // opposite the direction of travel. Visual only -- no gameplay effect.
  // Reused for the hold-boost cue (color "#9df", gated by opts.boostTrail) and
  // the speedBoost-powerup ACTIVE cue (the powerup color, gated by
  // opts.powerupFx) so "you are moving fast" reads the same way for both.
  function drawBoostTrail(headPx, headPy, dir, now, color) {
    const cs = grid.cellSize;
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
    if (v.x === 1) ctx.fillRect(px + cs - stripW, py, stripW, cs - cellGap);
    else if (v.x === -1) ctx.fillRect(px, py, stripW, cs - cellGap);
    else if (v.y === 1) ctx.fillRect(px, py + cs - stripW, cs - cellGap, stripW);
    else if (v.y === -1) ctx.fillRect(px, py, cs - cellGap, stripW);
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
  // previous snapshot when it is a plausible one-step move; snapped otherwise
  // (respawn, first sight, or any teleport-sized jump). "Plausible" allows a
  // Manhattan distance up to 2, not just 1: during a boost drift the server
  // translates the whole body laterally in the SAME step the head advances,
  // so a drifting snake's segments legitimately step diagonally (or two
  // cells along the skid near the tail) and must still read as a glide.
  function segPixel(seg, prevBody, si, t) {
    const cs = grid.cellSize;
    if (t < 1 && prevBody && prevBody[si]) {
      const ps = prevBody[si];
      const dist = Math.abs(ps.x - seg.x) + Math.abs(ps.y - seg.y);
      if (dist >= 1 && dist <= 2) {
        return { x: lerp(ps.x, seg.x, t) * cs, y: lerp(ps.y, seg.y, t) * cs };
      }
    }
    return { x: seg.x * cs, y: seg.y * cs };
  }
  function draw(prevSnap, currSnap, localBodies, eatenKeys, fx, opts) {
    if (!currSnap) return;
    if (!ctx) ctx = canvas.getContext("2d");
    if (!grid || grid.cols !== currSnap.grid.cols || grid.cellSize !== currSnap.grid.cellSize) {
      resize(currSnap.grid);
    }
    const flashes = (fx && fx.flashes) || [];
    const glides = (fx && fx.glides) || [];
    const powerFlashes = (fx && fx.powerFlashes) || [];
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
      // Held-powerup glow: a pulsing halo in the powerup's color under every
      // segment, visible to EVERYONE (heldPowerup/wormholeCharge are in the
      // shared broadcast precisely so opponents can plan counterplay).
      // Drawn at grid positions (not interpolated) -- a soft halo reads fine
      // slightly trailing a gliding snake, and it keeps 2D/wasm parity exact.
      // With BOTH a held powerup and a wormhole charge ready, the glow
      // ALTERNATES between their colors (600ms each, keyed off the shared
      // clock so wasm parity stays exact) -- maintainer request 2026-07-16:
      // the charge must stay visible even while something is held.
      const readyGlows = [];
      if (p.heldPowerup) readyGlows.push(p.heldPowerup);
      if (p.wormholeCharge) readyGlows.push("wormhole");
      const heldType = readyGlows.length ? readyGlows[Math.floor(now / 600) % readyGlows.length] : null;
      if (opts && opts.heldGlow && p.alive && heldType) {
        const cs2 = grid.cellSize;
        const cell = cs2 - cellGap;
        const grow = cs2 * 0.35;
        ctx.save();
        ctx.globalAlpha = 0.22 + 0.13 * Math.sin(now / 250 + i);
        ctx.fillStyle = POWERUP_STYLE[heldType] || "#fff";
        for (const seg of body) {
          ctx.beginPath();
          ctx.ellipse(seg.x * cs2 + cell / 2, seg.y * cs2 + cell / 2, (cell + grow * 2) / 2, (cell + grow * 2) / 2, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      // Powerup timer tail-drain: while a timed powerup is active the head-side
      // N = ceil(activePct * length) segments are tinted the powerup color, so
      // at activation the whole snake is colored and the tint drains tail-first
      // as time runs out -- a built-in countdown (and the activation "pop").
      const powerFx = opts && opts.powerupFx;
      const activeColor = (powerFx && p.alive && p.activePowerup) ? POWERUP_STYLE[p.activePowerup] : null;
      const nActive = activeColor ? Math.ceil((p.activePct || 0) * body.length) : 0;
      const segFill = si => (activeColor && si < nActive) ? activeColor : (si === 0 ? p.color.head : p.color.body);
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
        ctx.fillStyle = segFill(0);
        ctx.fillRect(headPx, headPy, cs - cellGap, cs - cellGap);
        for (let si = 1; si < body.length; si++) drawCell(body[si], segFill(si));
      } else if (smooth) {
        for (let si = 0; si < body.length; si++) {
          const pos = segPixel(body[si], prevBody, si, t);
          if (si === 0) { headPx = pos.x; headPy = pos.y; }
          ctx.fillStyle = segFill(si);
          ctx.fillRect(pos.x, pos.y, cs - cellGap, cs - cellGap);
        }
      } else {
        body.forEach((seg, si) => drawCell(seg, segFill(si)));
      }
      if (!p.alive) {
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        body.forEach(seg => ctx.fillRect(seg.x * cs, seg.y * cs, cs - cellGap, cs - cellGap));
      }
      if (p.alive && p.boost && opts && opts.boostTrail && p.dir) drawBoostTrail(headPx, headPy, p.dir, now, "#9df");
      // Speed Boost ACTIVE: a persistent jetstream in the powerup color while
      // the buff runs, distinct from (and stacking with) the hold-boost one.
      if (p.alive && powerFx && p.activePowerup === "speedBoost" && p.dir) drawBoostTrail(headPx, headPy, p.dir, now, POWERUP_STYLE.speedBoost);
      if (p.alive && p.sliding && opts && opts.slideDust) drawSlideDust(headPx, headPy, now);
      const flash = flashes.find(f => f.slot === i);
      if (flash) {
        const alpha = Math.max(0, 1 - (now - flash.t) / flash.durationMs);
        drawInputFlash(headPx, headPy, flash.dir, alpha);
      }
      const pflash = powerFlashes.find(f => f.slot === i);
      if (pflash) drawPowerFlash(body, POWERUP_STYLE[pflash.type] || "#fff", pflash.age);
    });
  }
  // POWERUP_STYLE is exported (read-only by convention) so the facade
  // (render.js) can re-export it to ui.js's captcha-screen color legend --
  // one source of truth, the legend can never drift from the board.
  return { draw, POWERUP_STYLE };
})();
