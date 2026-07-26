# Rust syntax cheatsheet (this codebase)

Reusable reference for patterns that show up over and over in
`server-rust/`. Code comments point here ("see RUST-CHEATSHEET.md")
instead of re-explaining the same syntax in every file. If you're new
to Rust, read this once, then skim the files.

## `struct` and `enum`
A `struct` bundles named fields (like a plain object). An `enum` is a
value that can be exactly one of several named "variants" -- Rust's
enums can also carry data per-variant (see `Role` vs `WsOut` below).

```rust
pub struct Cell { pub x: i32, pub y: i32 }   // a 2D grid point

pub enum WsOut {       // a message to the outbound-writer task
    Text(String),       // variant carrying a String
    Ping,                // variant carrying nothing
    Close,
}
```

## `#[derive(...)]`
An "attribute" above a type that auto-generates boilerplate code.
Common ones here:
- `Clone` -- adds a `.clone()` method (deep-ish copy).
- `Copy` -- makes the type copy-by-value instead of move-by-value
  (only legal for small, plain-data types with no heap pointers).
- `PartialEq, Eq` -- adds `==` / `!=` comparison.
- `Debug` -- adds `{:?}` printf-style formatting for debugging.
- `Default` -- adds a `Type::default()` constructor (zeroed/empty).
- `Serialize` (from `serde`) -- adds the ability to turn the struct
  into JSON via `serde_json::to_string`.

## `Option<T>`
Rust has no `null`. A value that might be missing is wrapped in
`Option<T>`, which is either `Some(value)` or `None`. You must handle
both cases before using the inner value -- the compiler enforces it.

```rust
pub seq: Option<i64>,   // "maybe a sequence number, maybe absent"

match some_option {
    Some(v) => println!("{v}"),
    None => println!("nothing"),
}

// Common shortcuts:
some_option.unwrap_or(0);        // use 0 if None
some_option.map(|v| v * 2);      // transform the value if present
if let Some(v) = some_option { } // handle only the Some case
```

## `Result<T, E>`
Like `Option`, but the "missing" case carries an error value:
`Ok(value)` or `Err(error)`. Used for operations that can fail
(parsing, I/O). `?` at the end of a call means "if this is `Err`,
return it from the current function immediately; otherwise unwrap the
`Ok` value and keep going."

## `match`
A pattern-matching switch statement. Every possible case must be
covered (or you add a `_ => ...` catch-all wildcard arm).

```rust
match name {
    "up" => Some(Cell { x: 0, y: -1 }),
    "down" => Some(Cell { x: 0, y: 1 }),
    _ => None,   // anything else
}
```

## References (`&`) and borrowing
`&x` is a reference -- "look at this value without taking ownership
of it." `&mut x` is a mutable reference -- "look at and modify this
value, and while you hold this, nobody else may." The compiler
enforces that you can have many `&` readers OR one `&mut` writer at a
time, never both, which is how Rust guarantees no data races without
a garbage collector.

```rust
pub fn hits_body(body: &[Cell], h: Cell, skip_tail: bool) -> bool
//                     ^ borrow a slice of Cells, don't take ownership
```

## Slices `&[T]`
A "view" into part of an array/vector: a pointer + length, no
ownership. `&my_vec[..]` or just passing `&my_vec` (auto-converts)
gives you a slice.

## Closures
Anonymous inline functions, written `|args| expression`. Used a lot
with iterator methods like `.map()`, `.filter()`, `.any()`.

```rust
body[..end].iter().any(|c| c.x == h.x && c.y == h.y)
// "does any cell c in this slice match h's coordinates?"
```

## `Arc<Mutex<T>>` / `RwLock<T>`
`Arc` = "Atomically Reference Counted" pointer -- lets multiple owners
(e.g. multiple async tasks) share the same heap data safely. `Mutex`
(mutual exclusion lock) / `RwLock` (read-write lock) guard the data
inside so only one task can mutate it at a time. Pattern:
`arc.lock().await` (async mutex) or `arc.lock().unwrap()` (sync
mutex) to get temporary exclusive access.

## `async fn` / `.await`
`async fn` marks a function whose body can pause and resume (e.g.
while waiting on network I/O) instead of blocking the whole thread.
Calling an async function returns a "future" that does nothing until
you `.await` it, which runs it to completion (yielding control to
other tasks whenever it's waiting).

## `impl` blocks
Where a type's methods are defined, separate from the `struct`/`enum`
declaration itself.

```rust
impl Cell {
    pub fn new(x: i32, y: i32) -> Self { Cell { x, y } }
}
```

## Modules (`mod`, `pub`, `use`, `crate::`)
Rust files are organized into a module tree. `pub` makes an item
visible outside its module (default is private). `use path::Item;`
brings a name into scope so you don't have to write the full path
every time. `crate::` means "start from the root of this project" (as
opposed to `super::` = parent module, or a bare path = relative).

```rust
use crate::powerups::PowerupType; // import from another file in this crate
```

## `Vec<T>`
A growable array (like a JS array, but single-typed). `vec.push(x)`,
`vec.len()`, `vec[i]`, `vec.iter()`.

## Lifetimes (`&'static str`)
`'static` means "this reference is valid for the entire program" --
typically a string literal baked into the binary, not allocated at
runtime.

```rust
pub cause: &'static str,   // e.g. "collision", never freed/reallocated
```

## `#[serde(...)]` field/struct attributes
Extra options for the `Deserialize`/`Serialize` derives above, controlling
how JSON keys map onto Rust fields.
- `#[serde(rename_all = "camelCase")]` on a struct -- JSON keys are
  `likeThis`, Rust fields stay `snake_case`; serde converts both ways.
- `#[serde(rename = "move")]` on one field -- override just that field's
  JSON key (used when the Rust name would clash with a keyword or differ
  from the pattern above).
- `#[serde(default)]` -- if the JSON key is missing, use `Default::default()`
  instead of erroring. `#[serde(default = "some_fn")]` calls a named
  function for the default instead.
- `#[serde(default)]` on the whole struct (next to `rename_all`) -- every
  field falls back to its default if absent, so a `config.json` that only
  sets a few keys still parses.
- `#[serde(skip_serializing)]` -- leave this field out when converting back
  to JSON.

```rust
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Example {
    pub some_field: bool,   // JSON key: "someField"
}
```

## `Box::leak`
`Box::new(v)` puts `v` on the heap. `Box::leak(b)` intentionally never frees
that heap memory and hands back a `&'static` reference to it. Used here for
one-time startup config: it needs to live for the rest of the program
anyway, so leaking it trades a tiny one-time "waste" for a simple `&'static
Config` everyone can share without `Arc`.

## Glob imports (`use Enum::*`)
`use SomeEnum::*;` brings every variant of an enum into scope unqualified,
so a `match` can write `Wormhole => ...` instead of
`PowerupType::Wormhole => ...`. Usually written right before the `match`
that needs it, and only valid inside that small scope.

## `let ... else`
`let Some(x) = opt else { return ... };` -- unwrap `x` on the happy path, or
run the `else` block (which must diverge: `return`, `continue`, `panic!`,
etc.) on the unhappy path. A flatter alternative to `match`/`if let` when
there's only one "bad" case to bail out on early.

## `Vec<Option<T>>` "slots" + `.as_ref()` / `.as_mut()` / `.unwrap()`
This codebase stores players in `game.slots: Vec<Option<Snake>>` -- a fixed
number of seats, each either empty (`None`) or occupied (`Some(snake)`).
To read or modify the snake in an occupied seat you first have to "look
inside" the `Option`:
- `.as_ref()` -- borrow the `Option<Snake>` as `Option<&Snake>` (read-only
  peek without taking ownership).
- `.as_mut()` -- same, but `Option<&mut Snake>` (allows mutating).
- `.unwrap()` -- assumes it's `Some` and panics if it's actually `None`.
  Safe here only because the surrounding code already checked `.alive` /
  slot occupancy first.

```rust
let s = game.slots[i].as_ref().unwrap();      // read-only borrow
game.slots[i].as_mut().unwrap().score += 1;   // mutate in place
```

## `matches!(value, pattern)`
A macro shorthand for "does this value match this pattern?" that returns
`true`/`false` -- avoids writing out a full `match` just to get a bool. Can
include an `if` guard for extra conditions.

```rust
let alive = matches!(&game.slots[i], Some(s) if s.alive);
// same idea as:
// match &game.slots[i] { Some(s) if s.alive => true, _ => false }
```

## Block expressions `{ ... }`
A `{ }` block is itself an expression -- it evaluates to the value of its
last line (no `;` on that last line) and can be assigned directly. Used a
lot here to scope a short-lived borrow (e.g. of a slot) so it ends before
the next mutable borrow needs the same data.

```rust
let (dir, head) = {
    let s = game.slots[idx].as_ref().unwrap(); // borrow starts
    (s.dir, s.head())
};                                              // borrow ends here
```
