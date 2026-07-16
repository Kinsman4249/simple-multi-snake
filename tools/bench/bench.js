// Phase 7 benchmark driver: measures the current 2D renderer and the WebGL2
// prototype on the same synthetic scenes (scene.js). Two metrics per run:
// time spent inside the draw call (CPU cost of issuing the frame) and
// rAF-to-rAF frame time (what the player actually experiences; captures GPU/
// raster cost that 2D-canvas calls defer). Run headless with
// --disable-frame-rate-limit --disable-gpu-vsync so frame time reflects true
// per-frame cost instead of pinning at the 60Hz vsync.
(async function () {
  const SCENARIOS = [
    { name: "1080p-normal", cols: 96, rows: 54, cellSize: 20, segs: 40, trailCount: 40 },
    { name: "1080p-stress", cols: 96, rows: 54, cellSize: 20, segs: 400, trailCount: 300 },
    { name: "4k-stress", cols: 192, rows: 108, cellSize: 20, segs: 1000, trailCount: 800 }
  ];
  const MEASURE_MS = 8000;
  const out = document.getElementById("out");
  const glCanvas = document.getElementById("gl");

  const raf = () => new Promise(r => requestAnimationFrame(r));
  const stats = arr => {
    const s = arr.slice().sort((a, b) => a - b);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    return {
      mean: Math.round(mean * 1000) / 1000,
      p95: Math.round(s[Math.floor(s.length * 0.95)] * 1000) / 1000,
      n: s.length
    };
  };

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
    // 2D path: the real, shipped renderer.
    entry.canvas2d = await measure(now => {
      scene.tick(now);
      Render.draw(scene.prev, scene.curr, scene.localBodies, scene.eatenKeys, scene.fx, scene.opts);
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
    out.textContent = JSON.stringify(results, null, 2);
  }
  results.done = true;
  out.textContent = JSON.stringify(results, null, 2);
  window.__BENCH_RESULTS__ = results;
})();
