# The powerup framework

How powerups work in this codebase and, more importantly, how to add one.
The worked example is `powerups/helloWorld.js` (disabled by default): a
complete, tested powerup in ~20 lines whose whole integration diff is a
good template to copy. Its end-to-end test is `tests/pw_helloworld.js`.

## 1. Philosophy: one module per type

Each powerup is one CommonJS file in this directory exporting plain data
(title, description, flags) and small pure-ish hook functions. The server
core (`server/sim.js` and friends) owns all state and timing; a module only
answers questions ("what's your speed multiplier for this snake?") or gets
poked at well-defined moments ("you were just activated"). Modules never
require server files, never touch the network, and never keep their own
mutable state -- per-snake effect state lives on the slot object
(`s.activePowerup`, `s.iceStacks`, `s.invertUntilTick`, ...), reset by
`spawnSnake` on every (re)spawn so effects can't be banked across runs.

## 2. Module anatomy

Everything is optional except `title`/`description`:

```js
module.exports = {
  requiresActivation: true,   // held + button-fired (see section 7)
  onActivate(slot, slotIndex, dlog) {},          // once, at activation
  onCross(victimSlot, _unused, trail, floor) {}, // victim crossed your trail tile
  speedMultiplier(s, POWERUPS) { return 1; },    // per-snake, every sim tick
  foodGrowthMultiplier(s, POWERUPS) { return 1; }, // growthSpurt-style food bonus
  killBonusGrowthBonus(s, POWERUPS) { return 0; }, // extra growth on a kill
  title: "Name",              // shown in the legend + info popup
  description: "One or two ESL-friendly sentences, self-contained."
};
```

Hook notes:
- `speedMultiplier` hooks are discovered automatically
  (`SPEED_MULT_TYPES` in server/config.js) and multiplied into BOTH the
  movement accumulator (server/sim.js `simLoop`) and the broadcast `moveMs`
  (server/net.js) -- write the hook, touch neither call site. They stack
  multiplicatively with each other and with hold-to-boost.
- `onActivate` fires once from `firePowerup` for both the auto-fire and the
  button path. It receives `dlog` (null when debug is off) so a module can
  log without importing anything.
- `onCross` is called when a snake's head lands on a laid trail tile of
  your type; the CALLER stamps any sim-clock expiry (see how ice stamps
  `iceExpiresAtTick` and banana stamps `invertUntilTick` right after the
  hook in server/sim.js) because tick math belongs to the core.
- Wormhole is special: it exports `attemptWormhole` (the pure
  landing-search algorithm) and is driven from the collision resolvers, not
  from this hook set. Read server/sim.js `tryWormholeOrDie`.

## 3. The registry

`powerups/index.js` maps type name -> module. One line per powerup; the
name used there is THE type string everywhere (config key, wire value,
renderer color key). `server/config.js` `POWERUP_TYPES` lists the same
names in their load-bearing render-index order (section 9) -- new types are
always APPENDED.

## 4. Config integration

Every type gets a block in config.json AND a shallow-merged default in
`server/config.js` (`POWERUPS.<type> = Object.assign({defaults},
POWERUPS.<type> || {})`) so an older config.json missing the block still
boots. `enabled` gates spawning; the rest is per-type tuning
(`durationMs`, etc). Tests override any of it per-server through
`startServer(configOverrides)` (tests/helpers.js), which deep-merges the
`powerups` sub-object.

## 5. Self-describing UI (POWERUP_INFO)

`server/config.js` builds `POWERUP_INFO` from each module's
title/description and serves it via `/api/config`. The join-screen "What do
the powerups do?" popup and the color legend render from it (ui.js
`setPowerupInfo`), and the legend filters on `enabled` -- so the in-game
help can never drift from the modules, and a disabled type never teaches a
color that can't appear.

## 6. Pickup flow

`maybeSpawnPowerupPickup` (server/sim.js) spawns one random enabled type on
an interval (blue shell is additionally presence-gated to >=2 people, and
the rubberband shell pressure can weight/hasten it). On head contact
(`applyMovementAndFood`):

- **wormhole**: arms the independent `s.wormholeCharge` (never the held
  slot); it auto-triggers later on a fatal move.
- **requiresActivation types** (speedBoost): stored in `s.heldPowerup`, one
  slot per snake; the `activatePowerup` message fires it via `firePowerup`.
- **everything else**: `firePowerup` immediately (auto-fire on pickup).

`firePowerup` either launches a one-shot (blueShell projectile) or sets the
timed `s.activePowerup = { type, startTick, expiresAtTick }`; expiry is
sim-clock based (`expirePowerupsAndTrails`). A pickup that would be wasted
(slot full / same effect running / blue shell while alone) grants the +1
segment food fallback instead.

## 7. Button-fired vs fire-on-pickup

`requiresActivation: true` opts a type into the held slot + activate key
(built into `HELD_TYPES`, data-driven -- no handler edits). Default is
fire-on-pickup. The design rule of thumb: hold-to-time has to be worth a
button (speed is; a trail isn't).

## 8. Trails

Trail-laying types (`TRAIL_TYPES` in server/config.js: ice, poison, banana)
lay one tile per movement step at the vacated cell while their
`activePowerup` runs; tiles expire on the sim clock
(`<type>.tileDurationMs`), one tile per (x,y). Crossing dispatches by
`trail.type` in `applyMovementAndFood` -- add your branch there, stamp any
per-snake status next to it, and remember the layer is NOT immune to their
own trail (confirmed design, all three trails).

## 9. Rendering: the CRITICAL 3-place color sync

A pickup/trail color lives in THREE places whose **index order must
match**, keyed by the position in `POWERUP_TYPES`:

1. `public/js/render2d.js` -- `POWERUP_STYLE` (hex) and, for trails,
   `TRAIL_STYLE` (rgba).
2. `public/js/render.js` -- `POWERUP_TYPE_INDEX` (name -> index written
   into wasm memory).
3. `wasm/renderer.ts` -- `pickupColor()` / `trailColor()` cases (ABGR:
   r low byte).

After ANY `wasm/renderer.ts` edit: `deno run -A tools/build-wasm.mjs`
(rebuilds the gitignored `public/js/render-wasm.js`; without it the client
silently uses the 2D fallback). Then extend `tools/bench/scene.js` so the
frozen-clock pixel diff actually exercises the new visual, and run the
parity check (`tools/bench/run-bench.js /tools/bench/parity.html
window.__PARITY__`, pass bar <1% differing pixels, currently <=0.001%).

## 10. The e2e test pattern

One `tests/pw_<type>.js` per powerup, run against a REAL server (no
mocks): `startServer` with only what you need enabled and the natural
spawner silenced (`spawnIntervalMs: 3600000`), deterministic staging via
`SNAKE_TEST_SPAWNS` (env: array indexed by slot, `{x,y,dir,len?}`) and the
`SNAKE_TEST_HOOKS=1` `testHook` message (`spawnPickup` places a pickup in a
snake's path -- snakes auto-move, so "collect it" means send nothing;
`grantPowerup` arms/fires/holds directly; `placeFood` re-rolls food). Wrap
in `runTest(main, { attempts })`. Read the "Test harness gotchas" list in
the maintainer notes before writing one; tests/pw_helloworld.js is the
minimal example, tests/pw_bananatrail.js the trail-type example.

## Checklist for a new powerup

1. `powerups/<name>.js` (copy helloWorld.js).
2. `powerups/index.js`: +1 line.
3. `server/config.js`: POWERUPS defaults + APPEND to `POWERUP_TYPES`
   (+ `TRAIL_TYPES` if it lays tiles).
4. `config.json`: the tuning block.
5. Colors in render2d.js / render.js / renderer.ts at the SAME new index,
   wasm rebuild, scene.js + parity.
6. `tests/pw_<name>.js`, then the full suite.
7. Check the join screen: legend + info popup picked it up by themselves.
