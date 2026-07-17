// ============================================================
// Render facade (Phase 7). Keeps the exact public surface the rest of the
// client has always used -- global `Render.draw(prevSnap, currSnap,
// localBodies, eatenKeys, fx, opts)` and `Render.POWERUP_STYLE` -- but the
// actual per-frame draw logic now lives in a WebAssembly core
// (wasm/renderer.ts, embedded base64 in render-wasm.js): JS encodes each
// snapshot into the module's linear memory ONCE per snapshot (broadcast
// cadence, not frame cadence), writes a small fx/local-bodies block per
// frame, and the wasm emits an ordered instance buffer of colored shapes
// that the thin executor below plays onto the 2D canvas context.
//
// Why a 2D-context executor and not WebGL: benchmarked (tools/bench/, real
// GPU): GPU-accelerated canvas 2D beat a WebGL2 instanced-quad pipeline on
// this flat-tile workload at every board size, decisively at the 4k preset.
// The instance-buffer architecture is executor-agnostic, so a WebGL executor
// can be swapped in later without touching the wasm if that ever changes.
// Frame pacing stays requestAnimationFrame-driven (main.js), i.e. vsync.
//
// Fallback: render2d.js is the complete pre-Phase-7 renderer, kept intact.
// Selection order: ?renderer= URL param > clientRender.renderer from
// /api/config (threaded through opts.renderer) > "auto" (try wasm, fall
// back on any failure -- including render-wasm.js simply not being built,
// since a source checkout works without any build step).
//
// Display scaling (fitCanvas) is CSS-only and identical for both paths.
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).render = "render 2026-07-16.5 (wasm facade)";
const Render = (() => {
  const canvas = document.getElementById("game");
  const POWERUP_STYLE = Render2D.POWERUP_STYLE;
  // Must match wasm/renderer.ts pickupColor()/trailColor() index order.
  const POWERUP_TYPE_INDEX = { wormhole: 0, growthSpurt: 1, iceTrail: 2, poisonTrail: 3, speedBoost: 4, blueShell: 5 };
  const DIR_INDEX = { up: 0, down: 1, left: 2, right: 3 };
  const PLAYER_STRIDE_I32 = 16;   // 64 bytes (activeIdx i32 + activePct f32, then wormholeCharge i32 + pad)
  const PLAYER_STRIDE_B = PLAYER_STRIDE_I32 * 4;
  const SNAP_PLAYERS_I32 = 8;     // header is 32 bytes
  const MAX_PLAYERS = 8, MAX_SEGS = 16384, MAX_TRAILS = 8192, MAX_PICKUPS = 32, MAX_SHELLS = 16;
  const MAX_FLASHES = 8, MAX_GLIDES = 8, MAX_EXPLOSIONS = 16, MAX_PFLASHES = 8, MAX_LOCALS = 4, MAX_LOCAL_SEGS = 16384;

  let wasm = null;          // instantiated exports, or null
  let wasmFailed = false;   // permanent this-session failure -> 2D
  let mode = null;          // "wasm" | "2d" once decided
  let ctx = null;           // 2D context (executor AND fallback share the canvas)
  let grid = null;
  let cellGap = 1;
  let mem = null;           // cached typed-array views over wasm memory
  let lastCurrSnap = null, lastPrevSnap = null, which = 0;

  const urlRenderer = (() => {
    try { return new URLSearchParams(location.search).get("renderer"); } catch (_) { return null; }
  })();

  // --- canvas sizing: same rules as always (see render2d.js for the full
  // rationale); duplicated here because whichever path is active owns the
  // canvas geometry, and the facade must size it for the wasm path.
  function resize(g) {
    grid = g;
    cellGap = Math.max(1, Math.round(g.cellSize * 0.08));
    canvas.width = g.cols * g.cellSize;
    canvas.height = g.rows * g.cellSize;
    fitCanvas();
    if (wasm) wasm.init(g.cols, g.rows, g.cellSize);
  }
  function fitCanvas() {
    if (!grid) return;
    const box = canvas.parentElement;
    if (!box) return;
    const borderPx = 4;
    const availW = Math.max(1, box.clientWidth - borderPx);
    const availH = Math.max(1, box.clientHeight - borderPx);
    let scale = Math.min(availW / canvas.width, availH / canvas.height);
    if (scale >= 1) scale = Math.floor(scale);
    canvas.style.width = Math.floor(canvas.width * scale) + "px";
    canvas.style.height = Math.floor(canvas.height * scale) + "px";
    canvas.style.imageRendering = scale >= 1 ? "pixelated" : "auto";
  }
  window.addEventListener("resize", fitCanvas);

  function views() {
    if (!mem || mem.buffer !== wasm.memory.buffer) {
      const buf = wasm.memory.buffer;
      mem = {
        buffer: buf,
        i32: new Int32Array(buf),
        u32: new Uint32Array(buf),
        f32: new Float32Array(buf),
        i16: new Int16Array(buf)
      };
    }
    return mem;
  }

  // Colors go to the wasm as u32 with r in the low byte (little-endian RGBA).
  const colorCache = new Map();
  function packColor(str) {
    let v = colorCache.get(str);
    if (v !== undefined) return v;
    let r = 255, g = 255, b = 255;
    if (str && str[0] === "#") {
      const hex = str.length === 4 ? str.slice(1).split("").map(h => h + h).join("") : str.slice(1);
      r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16);
    }
    v = (r | (g << 8) | (b << 16) | (255 << 24)) >>> 0;
    colorCache.set(str, v);
    return v;
  }
  // ...and come back from the instance buffer as u32 -> memoized fillStyle.
  const styleCache = new Map();
  function rgbStyle(c) {
    const key = c & 0xffffff;
    let s = styleCache.get(key);
    if (!s) {
      s = "rgb(" + (c & 255) + "," + ((c >>> 8) & 255) + "," + ((c >>> 16) & 255) + ")";
      styleCache.set(key, s);
    }
    return s;
  }

  // Encode one snapshot into region `w` (0/1). Runs once per NEW snapshot,
  // not per frame.
  function encodeSnapshot(snap, w) {
    const m = views();
    const base = wasm.snapPtr(w) >>> 2; // i32 index
    const i32 = m.i32, u32 = m.u32, f32 = m.f32, i16 = m.i16;
    i32[base] = snap.seq | 0;
    f32[base + 1] = snap.tickMs || 0;
    i32[base + 2] = snap.food ? snap.food.x : -1;
    i32[base + 3] = snap.food ? snap.food.y : 0;
    const players = snap.players || [];
    const nP = Math.min(players.length, MAX_PLAYERS);
    i32[base + 4] = nP;
    const bodyBase16 = (wasm.snapPtr(w) + 32 + MAX_PLAYERS * PLAYER_STRIDE_B) >>> 1; // i16 index
    let segOff = 0;
    for (let i = 0; i < nP; i++) {
      const p = players[i];
      const po = base + SNAP_PLAYERS_I32 + i * PLAYER_STRIDE_I32;
      if (!p) { i32[po] = 0; continue; }
      i32[po] = 1;
      i32[po + 1] = p.alive ? 1 : 0;
      u32[po + 2] = packColor(p.color && p.color.head);
      u32[po + 3] = packColor(p.color && p.color.body);
      i32[po + 4] = p.dir ? p.dir.x : 0;
      i32[po + 5] = p.dir ? p.dir.y : 0;
      f32[po + 6] = p.moveMs || 0;
      i32[po + 7] = p.boost ? 1 : 0;
      i32[po + 8] = p.sliding ? 1 : 0;
      const body = p.body || [];
      const len = Math.min(body.length, MAX_SEGS - segOff);
      i32[po + 9] = len;
      i32[po + 10] = segOff;
      // heldIdx (+11) is the HELD powerup only; the wormhole charge rides in
      // its own flag (+14) so the wasm can alternate the glow between both
      // colors when both are ready (must match render2d's readyGlows order:
      // held first, wormhole second).
      i32[po + 11] = p.heldPowerup != null && p.heldPowerup in POWERUP_TYPE_INDEX ? POWERUP_TYPE_INDEX[p.heldPowerup] : -1;
      // activeIdx (+12) and activePct (+13): the currently-active timed powerup
      // for the tail-drain countdown / speed jetstream (see wasm player loop).
      i32[po + 12] = p.activePowerup != null && p.activePowerup in POWERUP_TYPE_INDEX ? POWERUP_TYPE_INDEX[p.activePowerup] : -1;
      f32[po + 13] = typeof p.activePct === "number" ? p.activePct : 0;
      i32[po + 14] = p.wormholeCharge ? 1 : 0;
      for (let s = 0; s < len; s++) {
        i16[bodyBase16 + ((segOff + s) << 1)] = body[s].x;
        i16[bodyBase16 + ((segOff + s) << 1) + 1] = body[s].y;
      }
      segOff += len;
    }
    const trails = snap.trails || [];
    const nT = Math.min(trails.length, MAX_TRAILS);
    i32[base + 5] = nT;
    const trailBase16 = (wasm.snapPtr(w) + 32 + MAX_PLAYERS * PLAYER_STRIDE_B + MAX_SEGS * 4) >>> 1;
    for (let i = 0; i < nT; i++) {
      const t = trails[i];
      i16[trailBase16 + (i << 2)] = t.x;
      i16[trailBase16 + (i << 2) + 1] = t.y;
      i16[trailBase16 + (i << 2) + 2] = t.type in POWERUP_TYPE_INDEX ? POWERUP_TYPE_INDEX[t.type] : -1;
    }
    const pickups = snap.powerupPickups || [];
    const nPk = Math.min(pickups.length, MAX_PICKUPS);
    i32[base + 6] = nPk;
    const pkBase32 = (wasm.snapPtr(w) + 32 + MAX_PLAYERS * PLAYER_STRIDE_B + MAX_SEGS * 4 + MAX_TRAILS * 8) >>> 2;
    for (let i = 0; i < nPk; i++) {
      const p = pickups[i];
      i32[pkBase32 + (i << 2)] = p.x;
      i32[pkBase32 + (i << 2) + 1] = p.y;
      i32[pkBase32 + (i << 2) + 2] = p.type in POWERUP_TYPE_INDEX ? POWERUP_TYPE_INDEX[p.type] : -1;
      i32[pkBase32 + (i << 2) + 3] = p.id | 0;
    }
    const shells = snap.blueShells || [];
    const nSh = Math.min(shells.length, MAX_SHELLS);
    i32[base + 7] = nSh;
    const shBase32 = pkBase32 + MAX_PICKUPS * 4;
    for (let i = 0; i < nSh; i++) {
      i32[shBase32 + (i << 1)] = shells[i].x;
      i32[shBase32 + (i << 1) + 1] = shells[i].y;
    }
  }

  // Per-frame input block: fx, toggles, local predicted bodies.
  function encodeFrame(now, currSnap, localBodies, eatenKeys, fx, opts) {
    const m = views();
    const fp = wasm.frameInputPtr();
    const base = fp >>> 2;
    const i32 = m.i32, f32 = m.f32, i16 = m.i16;
    i32[base] = opts && opts.interpolate ? 1 : 0;
    i32[base + 1] = opts && opts.boostTrail ? 1 : 0;
    i32[base + 2] = opts && opts.slideDust ? 1 : 0;
    let foodHidden = 0;
    if (currSnap.food && eatenKeys && eatenKeys.indexOf(currSnap.food.x + "," + currSnap.food.y) !== -1) foodHidden = 1;
    i32[base + 3] = foodHidden;
    f32[base + 4] = now - (currSnap.recvTime || now);
    const flashes = (fx && fx.flashes) || [];
    const nF = Math.min(flashes.length, MAX_FLASHES);
    i32[base + 5] = nF;
    for (let i = 0; i < nF; i++) {
      const o = base + 6 + i * 4;
      i32[o] = flashes[i].slot;
      i32[o + 1] = DIR_INDEX[flashes[i].dir] != null ? DIR_INDEX[flashes[i].dir] : 3;
      f32[o + 2] = now - flashes[i].t;
      f32[o + 3] = flashes[i].durationMs || 90;
    }
    const glides = (fx && fx.glides) || [];
    const nG = Math.min(glides.length, MAX_GLIDES);
    i32[base + 38] = nG; // offset 152
    for (let i = 0; i < nG; i++) {
      const o = base + 39 + i * 8; // offset 156, stride 32
      const g = glides[i];
      i32[o] = g.slot;
      i32[o + 1] = g.from.x; i32[o + 2] = g.from.y;
      i32[o + 3] = g.to.x; i32[o + 4] = g.to.y;
      f32[o + 5] = now - g.startTime;
      f32[o + 6] = g.durationMs || 90;
    }
    const expl = (fx && fx.explosions) || [];
    const nE = Math.min(expl.length, MAX_EXPLOSIONS);
    i32[base + 103] = nE; // offset 412
    for (let i = 0; i < nE; i++) {
      const o = base + 104 + i * 4; // offset 416
      i32[o] = expl[i].x; i32[o + 1] = expl[i].y;
      f32[o + 2] = expl[i].radius; f32[o + 3] = expl[i].age;
    }
    i32[base + 181] = opts && opts.heldGlow ? 1 : 0; // offset 724
    i32[base + 182] = opts && opts.powerupFx ? 1 : 0; // offset 728
    // Powerup activation flashes (offset 732 count, 736 entries stride 16:
    // {slot i32, colorIdx i32, age f32, pad}).
    const pflashes = (fx && fx.powerFlashes) || [];
    const nPf = Math.min(pflashes.length, MAX_PFLASHES);
    i32[base + 183] = nPf;
    for (let i = 0; i < nPf; i++) {
      const o = base + 184 + i * 4; // offset 736
      i32[o] = pflashes[i].slot;
      i32[o + 1] = pflashes[i].type in POWERUP_TYPE_INDEX ? POWERUP_TYPE_INDEX[pflashes[i].type] : -1;
      f32[o + 2] = pflashes[i].age;
    }
    let nL = 0, segOff = 0;
    const localBase16 = (fp + 864) >>> 1; // after the pflash array
    if (localBodies) {
      localBodies.forEach((body, slot) => {
        if (nL >= MAX_LOCALS || !body) return;
        const o = base + 169 + nL * 3; // offset 676, stride 12
        const len = Math.min(body.length, MAX_LOCAL_SEGS - segOff);
        i32[o] = slot; i32[o + 1] = len; i32[o + 2] = segOff;
        for (let s = 0; s < len; s++) {
          i16[localBase16 + ((segOff + s) << 1)] = body[s].x;
          i16[localBase16 + ((segOff + s) << 1) + 1] = body[s].y;
        }
        segOff += len;
        nL++;
      });
    }
    i32[base + 168] = nL; // offset 672
  }

  // Walk the wasm's instance buffer onto the 2D context. Kinds: 0 rect,
  // 1 ellipse (rot honored), 2 ring (param = inner radius fraction).
  function executeInstances(n) {
    const m = views();
    const ip = wasm.instancePtr();
    const f32 = m.f32, u32 = m.u32;
    const b = ip >>> 2;
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < n; i++) {
      const o = b + i * 8;
      const color = u32[o + 4];
      const a = (color >>> 24) / 255;
      if (a <= 0) continue;
      const x = f32[o], y = f32[o + 1], w = f32[o + 2], h = f32[o + 3];
      const kind = f32[o + 5];
      ctx.globalAlpha = a;
      if (kind === 0) {
        ctx.fillStyle = rgbStyle(color);
        ctx.fillRect(x, y, w, h);
      } else if (kind === 1) {
        ctx.fillStyle = rgbStyle(color);
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, f32[o + 6], 0, Math.PI * 2);
        ctx.fill();
      } else {
        const outer = w / 2;
        const inner = f32[o + 7] * outer;
        ctx.strokeStyle = rgbStyle(color);
        ctx.lineWidth = Math.max(0.001, outer - inner);
        ctx.beginPath();
        ctx.arc(x + outer, y + outer, (outer + inner) / 2, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function tryInitWasm() {
    if (wasm || wasmFailed) return !!wasm;
    try {
      if (typeof window.instantiateRenderWasm !== "function") throw new Error("render-wasm.js not built/loaded");
      wasm = window.instantiateRenderWasm();
      if (grid) wasm.init(grid.cols, grid.rows, grid.cellSize);
    } catch (err) {
      wasmFailed = true;
      wasm = null;
      console.warn("[render] wasm renderer unavailable, using 2D fallback:", err && err.message);
    }
    return !!wasm;
  }

  function pickMode(opts) {
    const want = urlRenderer || (opts && opts.renderer) || "auto";
    if (want === "2d") return "2d";
    return tryInitWasm() ? "wasm" : "2d";
  }

  function draw(prevSnap, currSnap, localBodies, eatenKeys, fx, opts) {
    if (!currSnap) return;
    // Re-evaluated per frame but all cheap: an explicit "2d" arriving late
    // from /api/config (the fetch races the first frames) swaps cleanly,
    // because neither path keeps per-frame state outside its own module.
    const m = pickMode(opts);
    if (m !== mode) {
      mode = m;
      lastCurrSnap = lastPrevSnap = null; // force re-encode after a swap
    }
    if (mode === "2d") return Render2D.draw(prevSnap, currSnap, localBodies, eatenKeys, fx, opts);
    if (!ctx) ctx = canvas.getContext("2d");
    if (!ctx) { mode = "2d"; wasmFailed = true; return Render2D.draw(prevSnap, currSnap, localBodies, eatenKeys, fx, opts); }
    if (!grid || grid.cols !== currSnap.grid.cols || grid.cellSize !== currSnap.grid.cellSize) {
      resize(currSnap.grid);
    }
    const now = performance.now();
    if (currSnap !== lastCurrSnap) {
      // New snapshot: the old CURRENT region becomes the previous one (a
      // pointer flip, no re-encode) and the new snapshot is encoded over the
      // stale region. If the caller's prevSnap isn't what we have banked
      // (first frame, renderer swap), encode it explicitly.
      which ^= 1;
      encodeSnapshot(currSnap, which);
      if (prevSnap && prevSnap !== lastCurrSnap) encodeSnapshot(prevSnap, which ^ 1);
      else if (!prevSnap) views().i32[(wasm.snapPtr(which ^ 1) >>> 2) + 4] = 0; // no players -> no smoothing
      lastPrevSnap = prevSnap;
      lastCurrSnap = currSnap;
    }
    encodeFrame(now, currSnap, localBodies, eatenKeys, fx, opts);
    executeInstances(wasm.render(now, which));
  }

  return { draw, POWERUP_STYLE };
})();
