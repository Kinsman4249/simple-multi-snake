# JavaScript / TypeScript syntax cheatsheet (this codebase)

Reusable reference for patterns repeated across `public/js/`,
`wasm/`, and `tools/bench/`. Code comments point here ("see
JS-CHEATSHEET.md") instead of re-explaining the same syntax in every
file.

## IIFE module pattern: `const X = (() => { ... })();`
An "Immediately Invoked Function Expression." The arrow function is
defined and called on the spot, and only what it `return`s becomes
the public API. Everything else declared inside (like `let ws` below)
is a private variable no other file can reach -- this is how the
codebase fakes "modules" without a bundler.

```js
const Net = (() => {
  let ws = null;              // private -- not visible outside
  function connect() { ... }  // private helper
  return { connect };         // only `connect` is exposed as Net.connect
})();
```

## Arrow functions `(args) => expr`
Shorthand function syntax. `() => x` returns `x`. `(a, b) => { ... }`
needs braces + `return` for a multi-line body. Unlike `function`,
arrow functions don't rebind `this`, which is why they're preferred
for callbacks.

## Template literals `` `text ${expr}` ``
Backtick strings that can embed expressions inside `${...}` and span
multiple lines, instead of `"text" + expr`.

## Optional chaining `?.` and short-circuit calls
`handlers.onOpen && handlers.onOpen()` is an older idiom for "call
this function only if it exists" (avoids a crash if the callback
wasn't provided). `handlers.onOpen?.()` is the modern equivalent.
Both appear in this codebase.

## Nullish coalescing / defaults `a || b`
`x || fallback` evaluates to `fallback` when `x` is falsy (`null`,
`undefined`, `0`, `""`). Used constantly for default values, e.g.
`window.__BUILDS__ = window.__BUILDS__ || {}` ("use the existing
object, or create one if this is the first script to run").

## Destructuring
Pulling fields out of an object/array into named variables in one
step.

```js
const { prev, curr } = Net.snapshots();       // object destructuring
function connect(token, { onOpen, onClose }) {} // in a parameter list
```

## Spread / rest `...`
`...` expands an array/object into individual items (spread) or
gathers extra items into one (rest), depending on context.

```js
const merged = { ...defaults, ...overrides }; // spread: shallow-merge objects
function f(...args) {}                        // rest: collect all args into an array
```

## `Object.assign(target, ...sources)`
Copies properties from source objects onto `target` (mutates and
returns `target`). Used here to stamp an extra field onto an incoming
message: `Object.assign({ recvTime: performance.now() }, msg)` builds
a *new* object (since the target is a fresh `{}`) that has `recvTime`
plus everything from `msg`.

## Classes and `WebSocket`/DOM built-ins
`new WebSocket(url)` opens a connection; you attach behavior by
assigning its event-handler properties (`ws.onopen = fn`,
`ws.onmessage = fn`) rather than a constructor argument. This
event-handler-property style (`el.onclick = fn`) shows up throughout
the UI code as a simpler alternative to `addEventListener`.

## `JSON.stringify` / `JSON.parse`
Convert a JS object to a JSON text string (to send over the
WebSocket) and back. The server's Rust `serde_json` does the same
job on the other end.

## Async / Promises / `await`
A `Promise` represents a value that will resolve later (e.g. after a
network round trip). `async function` lets you write `await somePromise`
to pause until it resolves, reading top-to-bottom instead of nesting
`.then()` callbacks.

## `Map` / `Set` / `WeakMap`
`Map` is a key-value dictionary that (unlike a plain `{}` object) can
use any value as a key and preserves insertion order. `Set` stores
unique values. `WeakMap` is like `Map` but lets its keys be
garbage-collected when nothing else references them -- used for
metadata attached to DOM nodes/objects without leaking memory.

## TypeScript-only bits (files under `wasm/*.ts`)
- `type Foo = { x: number }` / `interface Foo { x: number }` declare a
  *shape* checked at compile time only -- erased at runtime, pure
  documentation-with-enforcement.
- `foo: number`, `foo?: number` (optional), `foo: number | null`
  (union type) annotate what a variable/parameter is allowed to hold.
- `as Type` force-casts a value's type when TS can't infer it itself
  (e.g. reading out of a raw WASM memory buffer).
- Typed arrays (`Float32Array`, `Uint8Array`, ...) are fixed-size,
  fixed-type array views over raw binary memory -- used here to read
  the WASM module's linear memory directly instead of copying data
  through JSON.

## `??`, `!`, `!!`
`a ?? b` = "b only if a is null/undefined" (stricter than `||`).
`!x` negates a boolean. `!!x` converts any value to a strict boolean
(common idiom, not a typo).

## Object literal shorthand `{ x }`
`{ x }` inside `{ }` is shorthand for `{ x: x }` -- reuses a variable's own
name as the property name. Shows up constantly at the bottom of every
`ui-*.js` file:

```js
Object.assign(UI, { initCaptchaGate, setPowerupInfo });
// same as: Object.assign(UI, { initCaptchaGate: initCaptchaGate, setPowerupInfo: setPowerupInfo });
```

## AssemblyScript low-level memory access (`wasm/*.ts` only)
AssemblyScript compiles to raw WASM linear memory, so it adds syntax
JS/TS don't have, all used heavily in `wasm/layout.ts`, `colors.ts`,
`art.ts`, `instbuf.ts`, `draw-players.ts`, `renderer.ts`:
- `<i32>expr`, `<f32>expr`, `<u32>expr` -- an angle-bracket cast,
  AssemblyScript's version of `as Type`. Converts between numeric
  types (e.g. truncate a float to an int).
- `usize` -- an unsigned integer type sized to hold a raw memory
  address (a "pointer"). Treated like a number you can add byte
  offsets to.
- `load<T>(ptr, offset)` / `store<T>(ptr, value, offset)` -- generic
  functions that read/write a value of type `T` at `ptr + offset`
  bytes into linear memory. This is how these files read/write the
  shared WASM memory buffer directly instead of using JS objects.
- `heap.alloc(bytes)` -- reserves a fixed block of linear memory once
  and returns its address; there's no garbage collector in this
  runtime, so memory is bump-allocated up front and reused forever,
  never freed.
- `@inline` above a function, preceded by `// @ts-ignore` -- a
  compiler decorator (not valid plain TS, hence the ts-ignore) that
  asks the AssemblyScript compiler to inline the function's body at
  each call site instead of a real function call, for speed.
- Bit-shift used as fast multiply/divide (`i << 5` == `i * 32`,
  `i << 2` == `i * 4`) -- a common low-level idiom for computing a
  byte offset from a fixed record "stride" (size per entry).

## Playwright basics (test files under `tests/pw_*.js`)
[Playwright](https://playwright.dev/) is a browser-automation library
used here for end-to-end tests: it launches a real browser, drives
the page, and checks the results.
- `test('name', async ({ page }) => { ... })` declares one test case.
  `page` is Playwright's handle to a browser tab.
- `expect(actual).toBe(expected)` (and similar `expect(...).toXxx()`
  matchers) asserts a value is what the test expects; the test fails
  if it isn't.
- `page.goto(url)` navigates the tab to a URL; `page.click(selector)`
  clicks a matching element; a "locator" (`page.locator(selector)`)
  is a reusable reference to element(s) on the page.
- `page.evaluate(fn)` runs `fn` *inside* the browser page (not in the
  Node test process) and returns its result -- used here to read the
  live game state out of the page's JS.
