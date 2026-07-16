// Renderer parity driver: with a FROZEN clock (both renderers read
// performance.now() for every animation phase), draw each scenario once via
// the wasm path and once via the 2D fallback on the same canvas, and diff
// the pixels. Not expected to be bit-exact -- the wasm path plays ellipses/
// rings through a slightly different canvas call sequence, so anti-aliased
// edges can round differently -- but structural output must match: tiny
// per-channel tolerance, tiny fraction of differing pixels.
(function () {
  const SCENARIOS = [
    { name: "1080p-normal", cols: 96, rows: 54, cellSize: 20, segs: 40, trailCount: 40 },
    { name: "1080p-stress", cols: 96, rows: 54, cellSize: 20, segs: 400, trailCount: 300 },
    { name: "4k-stress", cols: 192, rows: 108, cellSize: 20, segs: 1000, trailCount: 800 }
  ];
  const FROZEN_NOW = 987654.3;
  const TOL = 6;        // per-channel tolerance (AA rounding)
  const canvas = document.getElementById("game");
  const out = document.getElementById("out");

  const realNow = performance.now.bind(performance);
  performance.now = () => FROZEN_NOW;

  const results = { scenarios: [], done: false };
  try {
    for (const sc of SCENARIOS) {
      const scene = BenchScene.makeScene(sc);
      scene.tick(FROZEN_NOW);
      const opts = { interpolate: true, boostTrail: true, slideDust: true, heldGlow: true };
      // wasm path first
      Render.draw(scene.prev, scene.curr, scene.localBodies, scene.eatenKeys, scene.fx,
        Object.assign({ renderer: "wasm" }, opts));
      const ctx = canvas.getContext("2d");
      const a = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      // 2D fallback on the same canvas
      Render2D.draw(scene.prev, scene.curr, scene.localBodies, scene.eatenKeys, scene.fx, opts);
      const b = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let diffPx = 0, maxD = 0, sumD = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        if (d > maxD) maxD = d;
        sumD += d;
        if (d > TOL) diffPx++;
      }
      const totalPx = a.length / 4;
      results.scenarios.push({
        name: sc.name,
        wasmActive: typeof window.instantiateRenderWasm === "function",
        diffPct: Math.round(diffPx / totalPx * 100000) / 1000,
        maxChannelDiff: maxD,
        meanChannelDiff: Math.round(sumD / totalPx * 1000) / 1000,
        pass: diffPx / totalPx < 0.01 && maxD < 128
      });
    }
    results.build = window.__BUILDS__ && window.__BUILDS__.renderWasm;
  } catch (err) {
    results.error = String(err && err.stack || err);
  }
  performance.now = realNow;
  results.done = true;
  out.textContent = JSON.stringify(results, null, 2);
  window.__PARITY__ = results;
})();
