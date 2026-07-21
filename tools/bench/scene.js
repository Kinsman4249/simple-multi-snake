// Deterministic synthetic scene generator for the Phase 7 renderer benchmark
// and parity tests (tools/bench/). Builds prev/curr snapshot objects in the
// exact shape the live client feeds Render.draw (see main.js frame() and
// server.js broadcastState), with every effect active: trails, food,
// pulsing pickups, blue shells, explosion rings, interpolating bodies,
// boost jetstream, slide dust, input flash, correction glide, dead overlay.
// No randomness -- layouts are arithmetic so 2D and GL render the same scene.
(function () {
  const PLAYER_COLORS = [
    { head: "#8f8", body: "#3c3" },
    { head: "#f88", body: "#c33" },
    { head: "#88f", body: "#33c" },
    { head: "#ff8", body: "#cc3" }
  ];
  const PICKUP_TYPES = ["wormhole", "growthSpurt", "iceTrail", "poisonTrail", "speedBoost", "blueShell", "bananaTrail", "helloWorld"];

  // Serpentine body of `len` segments inside the quadrant box, head first.
  function serpentine(x0, y0, w, h, len) {
    const body = [];
    let x = 0, y = 0;
    for (let i = 0; i < len; i++) {
      body.push({ x: x0 + x, y: y0 + y });
      if (y % 2 === 0) { if (x + 1 < w) x++; else y++; }
      else { if (x > 0) x--; else y++; }
      if (y >= h) { y = 0; }
    }
    return body;
  }

  function makeScene(cfg) {
    const { cols, rows, cellSize, segs, trailCount } = cfg;
    const grid = { cols, rows, cellSize };
    const qw = Math.floor(cols / 2) - 4, qh = Math.floor(rows / 2) - 4;
    const players = [];
    for (let s = 0; s < 4; s++) {
      const x0 = 2 + (s % 2) * (Math.floor(cols / 2) + 2);
      const y0 = 2 + Math.floor(s / 2) * (Math.floor(rows / 2) + 2);
      const body = serpentine(x0, y0, qw, qh, segs);
      players.push({
        slot: s, alive: s !== 3, score: 10 * s,
        color: PLAYER_COLORS[s], dir: { x: 1, y: 0 }, body,
        moveMs: 100, boost: true, sliding: s === 1,
        // exercise the held-powerup glow: slot 1 holds a type AND carries a
        // wormhole charge (the alternating both-ready glow), slot 2 is
        // charge-only.
        heldPowerup: s === 1 ? "speedBoost" : null,
        wormholeCharge: s === 1 || s === 2,
        // exercise the tail-drain countdown + speedBoost active jetstream:
        // slot 0 (local, non-smooth branch) speedBoost, slot 2 (smooth branch)
        // growthSpurt, at different remaining fractions.
        activePowerup: s === 0 ? "speedBoost" : (s === 2 ? "growthSpurt" : null),
        activePct: s === 0 ? 0.7 : (s === 2 ? 0.35 : 0),
        iceStacks: 0
      });
    }
    // Previous snapshot: every segment one step behind along its own path
    // (follow-the-leader), i.e. prevBody[si] = body[si+1] -- Manhattan
    // distance 1 everywhere, so the smooth-interpolation branch runs for
    // every non-local segment (the worst case).
    const prevPlayers = players.map(p => Object.assign({}, p, {
      body: p.body.map((seg, si) => p.body[Math.min(si + 1, p.body.length - 1)])
    }));
    const trails = [];
    for (let i = 0; i < trailCount; i++) {
      trails.push({
        x: 1 + ((i * 7) % (cols - 2)),
        y: 1 + ((i * 13) % (rows - 2)),
        type: i % 3 === 0 ? "bananaTrail" : (i % 2 ? "iceTrail" : "poisonTrail")
      });
    }
    const powerupPickups = PICKUP_TYPES.map((type, i) => ({
      id: i, type, x: 3 + i * 3, y: Math.floor(rows / 2)
    }));
    const blueShells = [
      { x: Math.floor(cols / 3), y: Math.floor(rows / 3) },
      { x: Math.floor(cols / 1.5), y: Math.floor(rows / 1.5) }
    ];
    // Multiple foods (v3.5.0): exercise the multi-food render path in both
    // renderers. `food` kept as the compat first-food field.
    const foods = [
      { x: Math.floor(cols / 2), y: Math.floor(rows / 2) },
      { x: Math.floor(cols / 3), y: Math.floor(rows / 4) },
      { x: Math.floor(cols * 2 / 3), y: Math.floor(rows * 3 / 4) }
    ];
    // Grid decay / anti-turtling obstacles (v3.8.0): one of each display
    // state (warn/solid/fading) so the parity diff exercises every wall
    // pulse branch in both renderers.
    const walls = [
      { id: 101, x: 6, y: Math.floor(rows / 2) + 3, state: "warn" },
      { id: 102, x: 9, y: Math.floor(rows / 2) + 3, state: "solid" },
      { id: 103, x: 12, y: Math.floor(rows / 2) + 3, state: "fading" }
    ];
    // Wormhole portals (2026-07-20): an entry/exit pair with different ids
    // (the id seeds the pulse phase) so the parity diff exercises the
    // portal ring + core in both renderers.
    const portalFx = [
      { id: 201, x: 4, y: Math.floor(rows / 2) + 6, ownerSlot: 0 },
      { id: 202, x: 14, y: Math.floor(rows / 2) + 6, ownerSlot: 0 }
    ];
    const curr = {
      seq: 1000, tickMs: 100, grid, food: foods[0], foods, powerupPickups, trails, blueShells,
      walls, portalFx, players, recvTime: 0
    };
    const prev = Object.assign({}, curr, { seq: 999, players: prevPlayers });
    // Slot 0 is the "local predicted" body (skips interpolation, like real
    // local seats).
    const localBodies = new Map([[0, players[0].body]]);
    const scene = {
      grid, prev, curr, localBodies, eatenKeys: [],
      fx: { flashes: [], glides: [], explosions: [], powerFlashes: [] },
      opts: { interpolate: true, boostTrail: true, slideDust: true, powerupFx: true, heldGlow: true },
      // Refresh time-anchored pieces each frame: keeps interpolation t~0.5,
      // flash alpha ~0.5, glide mid-flight -- stable worst-case work. Pass a
      // FROZEN `now` for parity screenshots.
      tick(now) {
        curr.recvTime = now - 50;
        scene.fx.flashes = [
          { slot: 0, dir: "down", t: now - 45, durationMs: 90 },
          { slot: 2, dir: "right", t: now - 30, durationMs: 90 }
        ];
        scene.fx.glides = [{
          slot: 0,
          from: { x: players[0].body[0].x - 1, y: players[0].body[0].y },
          to: { x: players[0].body[0].x, y: players[0].body[0].y },
          startTime: now - 45, durationMs: 90
        }];
        scene.fx.explosions = [
          { x: Math.floor(cols / 4), y: Math.floor(rows / 4), radius: 3, age: 0.5 },
          { x: Math.floor(cols / 4) * 3, y: Math.floor(rows / 4), radius: 3, age: 0.25 },
          // Piñata candy burst (v3.6.6): NEGATIVE radius flags the pixel-spray
          // variant; mid-fade so the deterministic candy math is diffed.
          { x: Math.floor(cols / 2), y: Math.floor(rows / 3), radius: -6, age: 0.4 }
        ];
        // Powerup activation flashes: mid-fade on two seats (one alive, one
        // the dead slot 3) so the overlay is exercised in both states.
        scene.fx.powerFlashes = [
          { slot: 1, type: "speedBoost", age: 0.3 },
          { slot: 3, type: "poisonTrail", age: 0.6 }
        ];
        // Drift dust (v3.4.0): a deterministic trail of slid-through cells
        // behind the "sliding" slot-1 snake, at staggered fade ages, so the
        // parity diff exercises the per-cell dust path in both renderers.
        scene.fx.dust = [];
        const dustBase = players[1].body[0];
        for (let d = 0; d < 8; d++) {
          scene.fx.dust.push({ x: dustBase.x - 1 - d, y: dustBase.y + 1, age: 0.1 + d * 0.1 });
        }
      }
    };
    return scene;
  }

  window.BenchScene = { makeScene };
})();
