// Phase 7 benchmark driver: measures the current 2D renderer and the WebGL2
// prototype on the same synthetic scenes (scene.js). Two metrics per run:
// time spent inside the draw call (CPU cost of issuing the frame) and
// rAF-to-rAF frame time (what the player actually experiences; captures GPU/
// raster cost that 2D-canvas calls defer). Run headless with
// --disable-frame-rate-limit --disable-gpu-vsync so frame time reflects true
// per-frame cost instead of pinning at the 60Hz vsync.
// IIFE: runs immediately, keeps everything below private -- see docs/JS-CHEATSHEET.md
(async function () {
  const SCENARIOS = [
    { name: "1080p-normal", cols: 96, rows: 54, cellSize: 20, segs: 40, trailCount: 40 },
    { name: "1080p-stress", cols: 96, rows: 54, cellSize: 20, segs: 400, trailCount: 300 },
    { name: "4k-stress", cols: 192, rows: 108, cellSize: 20, segs: 1000, trailCount: 800 }
  ];
  const MEASURE_MS = 8000;
  const out = document.getElementById("out");
  const glCanvas = document.getElementById("gl");

  // Arrow function returning a Promise that resolves on the next animation
  // frame -- lets us `await raf()` to pause until the browser is ready to
  // paint. See docs/JS-CHEATSHEET.md for arrow function / Promise / await syntax.
  const raf = () => new Promise(r => requestAnimationFrame(r));
  // Computes mean and 95th-percentile from an array of sample timings.
  const stats = arr => {
    const s = arr.slice().sort((a, b) => a - b);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    return {
      mean: Math.round(mean * 1000) / 1000,
      p95: Math.round(s[Math.floor(s.length * 0.95)] * 1000) / 1000,
      n: s.length
    };
  };

  // Warms up 30 frames (JIT/GC settle), then samples draw-call time and
  // frame-to-frame time for MEASURE_MS milliseconds.
  async function measure(drawFn) {
    for (let i = 0; i < 30; i++) { drawFn(performance.now()); await raf(); }
    const draws = [], frames = [];
    let last = await raf();
    const end = performance.now() + MEASURE_MS;
    while (performance.now() < end) {
      const t0 = performance.now();
      drawFn(t0);
      draws.push(performance.now() - t0);
      const ts = await raf();
      frames.push(ts - last);
      last = ts;
    }
    return { drawMs: stats(draws), frameMs: stats(frames), fps: Math.round(1000 / stats(frames).mean) };
  }

  const results = { scenarios: [] };
  let glState = null;
  try { glState = GLProto.init(glCanvas); } catch (err) { results.glError = String(err); }
  if (glState) results.glRenderer = String(glState.rendererInfo);

  for (const sc of SCENARIOS) {
    const scene = BenchScene.makeScene(sc);
    const entry = { name: sc.name, instances: null };
    // 2D fallback path (the pre-Phase-7 renderer).
    entry.canvas2d = await measure(now => {
      scene.tick(now);
      Render2D.draw(scene.prev, scene.curr, scene.localBodies, scene.eatenKeys, scene.fx, scene.opts);
    });
    // Shipped wasm path (facade -> wasm core -> 2D executor). A new snapshot
    // identity every 6th frame forces the snapshot re-encode at roughly the
    // broadcast cadence, so the encode cost is included realistically.
    let frameN = 0;
    entry.wasm = await measure(now => {
      scene.tick(now);
      // Object.assign copies properties onto a target object -- see docs/JS-CHEATSHEET.md
      if (++frameN % 6 === 0) scene.curr = Object.assign({}, scene.curr);
      Render.draw(scene.prev, scene.curr, scene.localBodies, scene.eatenKeys, scene.fx,
        Object.assign({ renderer: "wasm" }, scene.opts));
    });
    // WebGL2 prototype on the same scene.
    if (glState) {
      glCanvas.width = sc.cols * sc.cellSize;
      glCanvas.height = sc.rows * sc.cellSize;
      entry.webgl2 = await measure(now => {
        scene.tick(now);
        GLProto.drawScene(glState, scene, now);
      });
      entry.instances = glState.n;
    }
    results.scenarios.push(entry);
    // JSON.stringify turns the results object into readable text for the page -- see docs/JS-CHEATSHEET.md
    out.textContent = JSON.stringify(results, null, 2);
  }
  results.done = true;
  out.textContent = JSON.stringify(results, null, 2);
  window.__BENCH_RESULTS__ = results;
})();
