// ============================================================
// Shared mutable game state + board/snake primitives. Port of
// server/state.js: the JS single `S` object became the `Game` struct; the
// module functions became methods. Everything that mutates the game locks
// the one Mutex<Game> in main.rs, which preserves the JS single-threaded
// semantics exactly.
//
// Split across submodules by responsibility: types.rs (plain data structs),
// snake.rs / conn.rs (per-entity structs+impls), game/ (the Game struct,
// itself split by what its methods do -- spawn, food, queries, food-rate).
// ============================================================
// `mod name;` declares a submodule backed by name.rs (or name/mod.rs) --
// see "Modules" in docs/RUST-CHEATSHEET.md. These are private by default;
// nothing outside this file can see `conn`/`game`/etc. directly.
mod conn;
mod game;
mod snake;
mod types;

// `pub use` re-exports an item from a submodule at this module's own path,
// so callers write `crate::state::Conn` instead of `crate::state::conn::Conn`.
pub use conn::Conn;
pub use game::Game;
pub use snake::Snake;
pub use types::{
    dir_vector, hits_body, ActivePowerup, BlueShell, Cell, Explosion, Food, FoodKind, Input,
    JoinOffer, KillEvent, LocalSeat, PerfCounters, Pickup, PortalFx, QueueEntry, Role, Trail, Wall,
    WallShatterFx, WsOut,
};
// pub(crate): visible anywhere in this crate, but not to external users of
// this crate as a library.
pub(crate) use types::rand_below;
