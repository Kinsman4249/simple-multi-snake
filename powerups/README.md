# The powerup framework

How powerups work in this codebase and, more importantly, how to add one.

**The live server is the Rust rewrite (`server-rust/`, shipped v4.0.0).**
Everything below describes the Rust implementation. The JS files in this
`powerups/` directory (and `server/`) are RETAINED REFERENCE ONLY -- not
executed by the running server -- kept because the Rust port mirrors their
structure closely (same type names, same comments, same hook shapes) and
the maintainer hasn't yet decided whether to delete them. If you're reading
`powerups/helloWorld.js` for the worked example, treat it as prose
documentation of the design, not code to edit; the actual worked example to
copy is `PowerupType::HelloWorld` in `server-rust/src/powerups.rs`.

## 1. Philosophy: one type, one match arm

Where the JS version was one CommonJS module per powerup, the Rust port is
one `enum PowerupType` (`server-rust/src/powerups.rs`) with one match arm
per type in each hook function -- there's no per-file module boundary, but
the same rule applies: a hook only answers questions ("what's your speed
multiplier for this snake?") or reacts at well-defined moments ("you were
just activated"). The sim core (`server-rust/src/sim.rs`) owns all state
and timing; per-snake effect state lives on `Snake`
(`server-rust/src/state.rs`: `active_powerup`, `ice_stacks`,
`invert_until_tick`, `wormhole_charge`, ...), reset by `spawn_snake` on
every (re)spawn so effects can't be banked across runs.

## 2. Hook anatomy

`PowerupType` (`server-rust/src/powerups.rs`) carries the per-type data as
methods matched on the enum variant:

```rust
impl PowerupType {
    pub fn as_str(self) -> &'static str { /* wire value */ }
    pub fn requires_activation(self) -> bool { /* held + button-fired, section 7 */ }
    pub fn is_trail(self) -> bool { /* lays tiles, section 8 */ }
    pub fn has_speed_multiplier(self) -> bool { /* opts into speed_multiplier() below */ }
    pub fn title(self) -> &'static str { /* legend + info popup */ }
    pub fn description(self) -> &'static str { /* one or two ESL-friendly sentences */ }
}
// Free functions, matched on PowerupType, called from sim.rs at the
// relevant moment:
pub fn speed_multiplier(t: PowerupType, s: &Snake, pw: &PowerupsCfg) -> f64 { .. }
pub fn food_growth_multiplier(s: &Snake, pw: &PowerupsCfg) -> i64 { .. }
pub fn kill_bonus_growth_bonus(s: &Snake, pw: &PowerupsCfg) -> i64 { .. }
```

Hook notes:
- `speed_multiplier` types are discovered via `has_speed_multiplier()` and
  multiplied into BOTH the movement accumulator (`sim.rs` `sim_tick`) and
  the broadcast `moveMs` (`net.rs` `move_ms`) -- write the match arm, touch
  neither call site. They stack multiplicatively with each other and with
  hold-to-boost.
- Activation (`fire_powerup` in `sim.rs`) fires once for both the auto-fire
  and the button path; it's the place to add a one-shot effect (like
  `BlueShell`'s projectile launch) versus the default timed
  `active_powerup` buff.
- Trail crossing is dispatched by `match tt` in `apply_movement_and_food`
  (`sim.rs`) when a head lands on a laid tile; the match arm stamps any
  sim-clock expiry itself (ice stamps `ice_expires_at_tick`, banana stamps
  `invert_until_tick`) since tick math belongs to the core.
- Wormhole is special: its landing-search algorithm is the free function
  `attempt_wormhole` in `powerups.rs`, driven from the collision resolvers
  (`sim.rs` `try_wormhole_or_die`), not from the per-tick hooks above. As
  of the 2026-07-20 rework it does directional phasing (keep the movement
  vector, phase through whatever was hit -- board edge wrap, dynamic
  walls, own body, other snakes -- to the first realistically-escapable
  cell beyond) with purple portal FX (`state.rs` `PortalFx`,
  broadcast as `portalFx`); see the "Rework wormhole behavior" entry in
  handoff.md for the full spec.

## 3. The registry

`POWERUP_TYPES: [PowerupType; N]` (`server-rust/src/powerups.rs`) is the
one array listing every type in load-bearing render-index order (section
9) -- new types are always APPENDED. `PowerupType::as_str()` /
`from_str()` are the type-string <-> enum conversion used everywhere (wire
value, config key, renderer color key).

## 4. Config integration

Every type gets a `#[derive(Deserialize, Serialize, Clone)] ...Cfg` struct
in `server-rust/src/config.rs` (e.g. `WormholeCfg`, `IceTrailCfg`) with a
`Default` impl matching `config.json`'s defaults, held in `PowerupsCfg`.
Serde's `#[serde(default)]` on each field means an older `config.json`
missing the block still boots, mirroring the JS shallow-merge behavior.
`enabled` gates spawning; the rest is per-type tuning (`duration_ms`,
etc). Tests override any of it per-server through `startServer(cfg)`
(`tests/helpers.js` launches the Rust binary with a JSON config file), same
deep-merge semantics as before.

## 5. Self-describing UI (powerupInfo)

`api_config` (`server-rust/src/main.rs`) builds a `powerupInfo` map from
each type's `title()`/`description()` and serves it via `/api/config` --
same shape and same consumer (`ui.js` `setPowerupInfo`) as the JS server.
The join-screen "What do the powerups do?" popup and the color legend
render from it, filtered on `enabled`, so the in-game help can never drift
from the server and a disabled type never teaches a color that can't
appear.

## 6. Pickup flow

`maybe_spawn_powerup_pickup` (`server-rust/src/sim.rs`) spawns one random
enabled type on an interval (blue shell is additionally presence-gated to
>=2 people, and the rubberband shell pressure can weight/hasten it). On
head contact (`apply_movement_and_food`):

- **wormhole**: arms the independent `s.wormhole_charge` (never the held
  slot); it auto-triggers later on a fatal move.
- **requiresActivation types** (speedBoost): stored in `s.held_powerup`,
  one slot per snake; the `activate` message fires it via `fire_powerup`.
- **everything else**: `fire_powerup` immediately (auto-fire on pickup).

`fire_powerup` either launches a one-shot (blueShell projectile) or sets
the timed `s.active_powerup = ActivePowerup { ptype, start_tick,
expires_at_tick }`; expiry is sim-clock based
(`expire_powerups_and_trails`). A pickup that would be wasted (slot full /
same effect running / blue shell while alone) grants the +1 segment food
fallback instead (`grow_segment` without `grew = true`).

## 7. Button-fired vs fire-on-pickup

`requires_activation()` returning `true` opts a type into the held slot +
activate key (only `SpeedBoost`, by maintainer decision 2026-07-16).
Default is fire-on-pickup. The design rule of thumb: hold-to-time has to be
worth a button (speed is; a trail isn't).

## 8. Trails

Trail-laying types (`is_trail()`: ice, poison, banana) lay one tile per
movement step at the vacated cell while their `active_powerup` runs; tiles
expire on the sim clock (`PowerupsCfg::tile_duration_ms(t)`), one tile per
(x,y). Crossing dispatches by `match tt` in `apply_movement_and_food` --
add your arm there, stamp any per-snake status next to it, and remember
the layer is NOT immune to their own trail (confirmed design, all three
trails).

## 9. Rendering: the CRITICAL 3-place color sync (client, unchanged)

The client is untouched by the server rewrite. A pickup/trail color still
lives in THREE places whose **index order must match**, keyed by the
position in `POWERUP_TYPES`:

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
window.__PARITY__`, pass bar <1% differing pixels, currently <=0.013%).

## 10. The e2e test pattern (unchanged, now against the Rust binary)

One `tests/pw_<type>.js` per powerup, run against a REAL server (no
mocks): `startServer` launches `server-rust/target/release/multisnake-server`
(build with `cd server-rust && cargo build --release`) with only what you
need enabled and the natural spawner silenced (`spawnIntervalMs:
3600000`), deterministic staging via `SNAKE_TEST_SPAWNS` (env: array
indexed by slot, `{x,y,dir,len?}`) and the `SNAKE_TEST_HOOKS=1` `testHook`
message (`spawnPickup` places a pickup in a snake's path -- snakes
auto-move, so "collect it" means send nothing; `grantPowerup`
arms/fires/holds directly; `placeFood` re-rolls food; `spawnWall` places a
dynamic wall for deterministic wormhole/obstacle staging). Wrap in
`runTest(main, { attempts })`. Read the "Test harness gotchas" list in the
maintainer notes before writing one; `tests/pw_helloworld.js` is the
minimal example, `tests/pw_bananatrail.js` the trail-type example.

## Checklist for a new powerup

1. `server-rust/src/powerups.rs`: add the `PowerupType` variant, append to
   `POWERUP_TYPES`, add match arms in `as_str`/`from_str`/`title`/
   `description`/`requires_activation`/`is_trail`/`has_speed_multiplier`
   (as applicable) and any per-tick hook it needs.
2. `server-rust/src/config.rs`: a `<Name>Cfg` struct + `Default` impl,
   wired into `PowerupsCfg`.
3. `config.json`: the tuning block.
4. `server-rust/src/sim.rs`: any collection/activation/crossing logic the
   hooks above don't already cover generically (a new one-shot effect
   like blueShell, a new trail crossing arm, etc).
5. Colors in render2d.js / render.js / renderer.ts at the SAME new index,
   wasm rebuild, scene.js + parity.
6. `tests/pw_<name>.js`, then the full suite (`cargo build --release` +
   the relevant `tests/pw_*.js`).
7. Check the join screen: legend + info popup picked it up by themselves
   via `/api/config`.
