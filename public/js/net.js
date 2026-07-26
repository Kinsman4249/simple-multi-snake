// ============================================================
// Networking: owns the WebSocket connection and keeps the last two
// authoritative "state" snapshots, each stamped with browser receive time.
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).net = "net 2026-07-17.1";
const Net = (() => {
  let ws = null;
  let handlers = {};
  let prevSnap = null;
  let currSnap = null;
  function connect(token, cbHandlers) {
    handlers = cbHandlers;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/ws?token=" + token);
    ws.onopen = () => handlers.onOpen && handlers.onOpen();
    ws.onclose = () => handlers.onClose && handlers.onClose();
    ws.onmessage = ev => dispatch(JSON.parse(ev.data));
    return ws;
  }
  function dispatch(msg) {
    if (msg.type === "state") {
      prevSnap = currSnap;
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
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  function snapshots() {
    return { prev: prevSnap, curr: currSnap };
  }
  return { connect, send, snapshots };
})();
