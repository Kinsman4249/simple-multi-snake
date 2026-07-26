// Memory-layout constants for the wasm renderer: snapshot region, frame-
// input region, and instance-buffer offsets/strides, plus the entity-count
// caps that size them. See renderer.ts's module doc comment for the full
// byte-for-byte protocol description shared with public/js/render.js.
//
// Snapshot region (x2: which=0 curr-candidate A, which=1 candidate B; JS
// alternates and tells render() which one is CURRENT):
//   0  seq        u32
//   4  tickMs     f32
//   8  foodX      i32   (-1 = no food)
//   12 foodY      i32
//   16 nPlayers   i32
//   20 nTrails    i32
//   24 nPickups   i32
//   28 nShells    i32
//   32 nWalls     i32   (grid decay / anti-turtling obstacles, v3.8.0)
//   36 nPortals   i32   (wormhole portal markers, 2026-07-20 -- was pad)
//   40 players[MAX_PLAYERS] stride 64:
//        0 present i32, 4 alive i32, 8 colorHead u32 (ABGR byte order:
//        r=low byte), 12 colorBody u32, 16 dirX i32, 20 dirY i32,
//        24 moveMs f32, 28 boost i32, 32 sliding i32, 36 bodyLen i32,
//        40 bodyOff i32 (segment index into body pool), 44 heldIdx i32
//        (HELD-powerup type index for the glow, -1 = none), 48 activeIdx i32
//        (active-powerup type index for the tail-drain/speed jetstream,
//        -1 = none), 52 activePct f32 (fraction of the active powerup
//        remaining, 1..0), 56 wormholeCharge i32 (glow alternates between
//        the held color and the wormhole color when both are ready),
//        60 scissorsCharge i32 (v4.5.0 -- a SEPARATE head-only rotated
//        icon, NOT part of the heldIdx/wormholeCharge glow-alternation)
//   +players: body pool, MAX_SEGS x {x:i16, y:i16}
//   +pool: trails, MAX_TRAILS stride 8: {x:i16, y:i16, type:i16, pad}
//   +trails: pickups, MAX_PICKUPS stride 16: {x:i32, y:i32, type:i32, id:i32}
//   +pickups: shells, MAX_SHELLS stride 8: {x:i32, y:i32}
//   +shells: walls, MAX_WALLS stride 16: {x:i32, y:i32, state:i32 (0 warn/
//        1 solid/2 fading), id:i32 (seeds the pulse phase, like pickups)}
//   +walls: portals, MAX_PORTALS stride 12: {x:i32, y:i32, id:i32} --
//        wormhole entry/exit markers (2026-07-20 rework)
//
// Frame-input region (written every frame BEFORE render()):
//   0  interpolate i32, 4 boostTrail i32, 8 slideDust i32, 12 foodHidden i32
//   16 recvElapsedMs f32   (now - currSnap.recvTime; relative so f32 is safe)
//   20 nFlashes i32
//   24 flashes[MAX_FLASHES] stride 16: {slot i32, dirIdx i32 (0 up/1 down/
//        2 left/3 right), elapsedMs f32, durMs f32}
//   152 nGlides i32
//   156 glides[MAX_GLIDES] stride 32: {slot, fromX, fromY, toX, toY (i32),
//        elapsedMs f32, durMs f32, pad}
//   412 nExplosions i32
//   416 explosions[MAX_EXPLOSIONS] stride 16: {x i32, y i32, radius f32, age f32}
//   672 nLocals i32
//   676 locals[MAX_LOCALS] stride 12: {slot i32, len i32, off i32 (into the
//        local body pool)}
//   724 heldGlow i32 (clientFx.heldGlow toggle)
//   728 powerupFx i32 (clientFx.powerupFx toggle)
//   732 nPflash i32
//   736 pflashes[MAX_PFLASHES] stride 16: {slot i32, colorIdx i32, age f32, pad}
//   864 nDust i32   (drift dust particles, v3.4.0 -- one per slid-through cell)
//   868 dust[MAX_DUST] stride 12: {x i32, y i32, age f32}
//   3940 local body pool, MAX_LOCAL_SEGS x {x:i16, y:i16}
//   FR_NFOODS/FR_FOODS (computed, after the local body pool): foods
//   FR_NWALLSHATTER/FR_WALLSHATTER (computed, after foods): scissors
//        wall-shatter fx (v4.5.0), stride 12: {x i32, y i32, age f32}
//
// Instance buffer (output) stride 32:
//   0 x f32, 4 y f32, 8 w f32, 12 h f32, 16 color u32 (ABGR: r low byte,
//   alpha high byte), 20 kind f32 (0 rect / 1 ellipse / 2 ring), 24 rot f32,
//   28 param f32 (ring: inner radius as fraction of outer)

export const MAX_PLAYERS: i32 = 8;
export const MAX_SEGS: i32 = 16384;
export const MAX_TRAILS: i32 = 8192;
export const MAX_PICKUPS: i32 = 32;
export const MAX_SHELLS: i32 = 16;
export const MAX_WALLS: i32 = 32;
export const MAX_PORTALS: i32 = 16;
export const MAX_FLASHES: i32 = 8;
export const MAX_GLIDES: i32 = 8;
export const MAX_EXPLOSIONS: i32 = 16;
export const MAX_PFLASHES: i32 = 8;
export const MAX_DUST: i32 = 256;
export const MAX_FOODS: i32 = 32;
export const MAX_WALLSHATTERS: i32 = 8;
export const MAX_LOCALS: i32 = 4;
export const MAX_LOCAL_SEGS: i32 = 16384;
export const INSTANCE_CAP: i32 = 40960;

// snapshot-internal offsets. Player stride 64: fields 0..52 as before, plus
// +56 wormholeCharge i32 (and 4 bytes of pad to stay 8-aligned).
export const SNAP_NWALLS: i32 = 32;
export const SNAP_NPORTALS: i32 = 36; // wormhole portals count (was pad)
export const SNAP_PLAYERS: i32 = 40; // was 32; +8 for nWalls + pad (v3.8.0)
export const PLAYER_STRIDE: i32 = 64;
export const SNAP_BODY: i32 = SNAP_PLAYERS + MAX_PLAYERS * PLAYER_STRIDE;
export const SNAP_TRAILS: i32 = SNAP_BODY + MAX_SEGS * 4;
export const SNAP_PICKUPS: i32 = SNAP_TRAILS + MAX_TRAILS * 8;
export const SNAP_SHELLS: i32 = SNAP_PICKUPS + MAX_PICKUPS * 16;
export const SNAP_WALLS: i32 = SNAP_SHELLS + MAX_SHELLS * 8;
export const SNAP_PORTALS: i32 = SNAP_WALLS + MAX_WALLS * 16;
export const SNAP_SIZE: i32 = SNAP_PORTALS + MAX_PORTALS * 12;

// frame-input offsets
export const FR_FLAGS: i32 = 0;
export const FR_RECV_ELAPSED: i32 = 16;
export const FR_NFLASHES: i32 = 20;
export const FR_FLASHES: i32 = 24;
export const FR_NGLIDES: i32 = 152;
export const FR_GLIDES: i32 = 156;
export const FR_NEXPL: i32 = 412;
export const FR_EXPL: i32 = 416;
export const FR_NLOCALS: i32 = 672;
export const FR_LOCALS: i32 = 676;
export const FR_HELDGLOW: i32 = 724;
export const FR_POWERFX: i32 = 728;   // clientFx.powerupFx toggle
export const FR_NPFLASH: i32 = 732;   // powerup activation flashes
export const FR_PFLASH: i32 = 736;    // stride 16: {slot i32, colorIdx i32, age f32, pad}
export const FR_NDUST: i32 = 864;     // 736 + MAX_PFLASHES(8) * 16
export const FR_DUST: i32 = 868;      // stride 12: {x i32, y i32, age f32}
export const FR_LOCAL_BODY: i32 = 3940; // 868 + MAX_DUST(256) * 12
// Foods (v3.5.0) appended after the local body pool: count then {x,y} pairs.
// Re-encoded per frame so predicted-eat hiding is per-frame (an eaten food is
// simply omitted from the array).
export const FR_NFOODS: i32 = FR_LOCAL_BODY + MAX_LOCAL_SEGS * 4;
export const FR_FOODS: i32 = FR_NFOODS + 4;   // stride 12: {x i32, y i32, bounty i32}
// Scissors wall-shatter fx (v4.5.0), appended right after foods (the last
// dynamic-count section). Must match public/js/render.js FR_WALLSHATTER_OFF.
export const FR_NWALLSHATTER: i32 = FR_FOODS + MAX_FOODS * 12;
export const FR_WALLSHATTER: i32 = FR_NWALLSHATTER + 4; // stride 12: {x i32, y i32, age f32}
export const FRAME_SIZE: i32 = FR_WALLSHATTER + MAX_WALLSHATTERS * 12;

export const KIND_RECT: f32 = 0;
export const KIND_ELLIPSE: f32 = 1;
export const KIND_RING: f32 = 2;
