// ============================================================
// Networking: owns the WebSocket connection and keeps the last two
// authoritative "state" snapshots, each stamped with browser receive time.
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).net = "net 2026-07-17.1";
// IIFE module pattern: runs immediately, `ws`/`handlers`/etc below stay
// private, and only the returned { connect, send, snapshots } object is
// public as `Net.xxx` -- see docs/JS-CHEATSHEET.md.
const Net = (() => {
  let ws = null;
  let handlers = {};
  let prevSnap = null;
  let currSnap = null;
  function connect(token, cbHandlers) {
    handlers = cbHandlers;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    // `new WebSocket(url)` opens the connection; assigning its onopen/
    // onclose/onmessage properties (rather than passing callbacks to the
    // constructor) is how you attach behavior -- see JS-CHEATSHEET.md.
    ws = new WebSocket(proto + "//" + location.host + "/ws?token=" + token);
    // `x => y` is an arrow function (shorthand for `function(x) { return y; }`).
    // `a && a()` calls `a` only if it's truthy -- avoids crashing when no
    // callback was registered for this event. See JS-CHEATSHEET.md.
    ws.onopen = () => handlers.onOpen && handlers.onOpen();
    ws.onclose = () => handlers.onClose && handlers.onClose();
    // Incoming WebSocket frames are JSON text; JSON.parse turns them back
    // into a JS object before we hand them to dispatch().
    ws.onmessage = ev => dispatch(JSON.parse(ev.data));
    return ws;
  }
  function dispatch(msg) {
    if (msg.type === "state") {
      prevSnap = currSnap;
      // Object.assign(target, source) copies source's fields onto target and
      // returns target. Target here is a fresh {recvTime: ...} object, so
      // this builds a NEW object with recvTime plus everything in msg --
      // see JS-CHEATSHEET.md.
      currSnap = Object.assign({ recvTime: performance.now() }, msg);
      handlers.onState && handlers.onState(currSnap, prevSnap);
    } else if (msg.type === "spectator") {
      handlers.onSpectator && handlers.onSpectator(msg);
    } else if (msg.type === "offerJoin") {
      handlers.onOfferJoin && handlers.onOfferJoin(msg);
    } else if (msg.type === "joinLocalDenied") {
      handlers.onJoinLocalDenied && handlers.onJoinLocalDenied(msg);
    } else if (msg.type === "systemNotice") {
      handlers.onSystemNotice && handlers.onSystemNotice(msg);
    }
  }
  function send(obj) {
    // JSON.stringify turns the JS object into JSON text for the wire; the
    // server's Rust side parses it back with serde_json.
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  function snapshots() {
    return { prev: prevSnap, curr: currSnap };
  }
  return { connect, send, snapshots };
})();
