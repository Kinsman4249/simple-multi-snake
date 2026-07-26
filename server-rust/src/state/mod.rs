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
mod conn;
mod game;
mod snake;
mod types;

pub use conn::Conn;
pub use game::Game;
pub use snake::Snake;
pub use types::{
    dir_vector, hits_body, ActivePowerup, BlueShell, Cell, Explosion, Food, Input, JoinOffer,
    KillEvent, LocalSeat, PerfCounters, Pickup, PortalFx, QueueEntry, Role, Trail, Wall,
    WallShatterFx, WsOut,
};
pub(crate) use types::rand_below;
