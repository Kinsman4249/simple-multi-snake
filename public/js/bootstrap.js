// ============================================================
// Bootstrap: /api/config fetch, the captcha-gated startGame entry point,
// the server-state broadcast handler, and the requestAnimationFrame render
// loop. Depends on state.js/keymap.js/seats.js/input.js all being loaded
// first (this is the true main.js entry -- it's what kicks the app off).
//
// Client leads on movement + food prediction; server reconciles.
//
// Phase 4 additions:
//   - Seat lifecycle: any seat can LEAVE (button) and later REJOIN by
//     pressing its own movement keys or the Play/Add button. Leaving the
//     last seat closes the connection entirely; the server said goodbye, so
//     the client shows a rejoin/menu screen instead of idling.
//   - Boost & slide: holding the key of the CURRENT travel direction sends
//     boost on/off transitions to the server. Turns entered while boosting
//     are still sent (and acked) immediately, but flagged `delayed` so the
//     predictor does not pre-play a turn the server will drift through for
//     config.boost.slideDistance cells.
//   - Lock-step render smoothing: each state message carries every player's
//     effective ms-per-cell (moveMs, boost included); render.js interpolates
//     between the last two snapshots at exactly that cadence. Cosmetic only.
//   - Zero-resource debug: when the operator sets enableDebug=false, the
//     debug button/panel/recording are never created at all -- the only
//     residue is one boolean test at startup.
// ============================================================
(window.__BUILDS__ = window.__BUILDS__ || {}).main = "main 2026-07-22.1";
Loading.begin(1); // boot task: config must be in before the UI is revealed
fetch("/api/config").then(r => r.json()).then(cfg => {
  if (cfg && cfg.clientFx) CLIENT_FX = Object.assign({}, CLIENT_FX, cfg.clientFx);
  if (cfg && cfg.clientRender) CLIENT_RENDER = Object.assign({}, CLIENT_RENDER, cfg.clientRender);
  if (cfg && cfg.boost) BOOST_CFG = Object.assign({}, BOOST_CFG, cfg.boost);
  if (cfg && cfg.powerups) POWERUPS_CFG = cfg.powerups;
  UI.setPowerupInfo((cfg && cfg.powerupInfo) || {}, POWERUPS_CFG);
  // The join-screen boost tip (index.html #boostTip) is irrelevant if the
  // operator disabled the mechanic entirely -- don't show players a tip for
  // something that will never boost them.
  if (!BOOST_CFG.enabled) {
    const tip = document.getElementById("boostTip");
    if (tip) tip.style.display = "none";
  }
  // Zero-resource debug gate: nothing debug-related is even constructed
  // when the operator disabled it -- no button, no panel, no recording
  // hooks, no per-frame branches beyond this single startup check.
  if (!cfg || cfg.enableDebug !== false) {
    UI.initDebug(window.__DEBUG_SOURCE__, on => myPlayers.forEach(p => p.setDebug(on)));
    UI.showVersionStamp(true, cfg && cfg.build);
  }
  Loading.step();
}).catch(() => {
  UI.initDebug(window.__DEBUG_SOURCE__, on => myPlayers.forEach(p => p.setDebug(on)));
  UI.showVersionStamp(true, null);
  Loading.step();
});

function startGame(token, initials) {
  if (!myPlayers.has(0)) myPlayers.set(0, new LocalPlayerPredictor("p1"));
  wireLocalPlayer(0);
  // P1's initials came from the captcha gate; bind them for the session and
  // arm the grace so residual keypresses from typing them can't spawn P2.
  // (The setInitials send inside storeInitials is dropped -- no socket yet --
  // and onOpen below re-sends every bound seat's initials once connected.)
  if (initials) storeInitials(0, initials);
  armSeatRequestGrace();
  UI.setConnectionStatus("connecting...");
  Net.connect(token, {
    onOpen: () => {
      UI.setConnectionStatus("connected");
      // The socket is up now: (re)send every seat's session initials.
      sessionInitials.forEach((v, idx) => { if (v) Net.send({ type: "setInitials", local: idx, value: v }); });
    },
    onClose: () => {
      // Connection is gone (we left, were idle-kicked, or the server went
      // away). Never idle on a dead board: show the menu/rejoin screen.
      UI.setConnectionStatus("disconnected");
      UI.showRejoin();
    },
    onState: handleState,
    onSpectator: msg => UI.showSpectator(msg, myPlayers.size > 1),
    onOfferJoin: msg => UI.offerJoin(msg, () => Net.send({ type: "acceptJoin", local: msg.local }), myPlayers.size > 1),
    onJoinLocalDenied: () => { seatPending[1] = false; UI.notifyJoinLocalDenied({ reason: "max local players reached" }); },
    onSystemNotice: msg => UI.showSystemNotice(msg)
  });
  // Mobile is single-seat only (maintainer decision, Phase 6): no co-op
  // button on coarse-pointer devices -- swipe + PWR + BOOST replace the
  // keyboard surfaces instead.
  if (IS_TOUCH) {
    UI.initTouchControls({
      onActivate: () => {
        const entry = myLocals && myLocals[0];
        if (entry && entry.role === "player") Net.send({ type: "activatePowerup", local: 0 });
      },
      onBoost: on => { touchBoost = on; refreshBoost(); }
    });
    initSwipeSteering();
    // Mobile: hide the INFO overlays by default behind a small toggle so they
    // never cover the board (swipe-to-steer keeps working while hidden). The
    // PWR/BOOST play buttons stay on screen at all times -- see initMobileUiToggle.
    UI.initMobileUiToggle();
  } else {
    UI.initCoOp(() => requestSeat(1));
  }
  UI.initLeaveButtons(leaveSeat);
  UI.initKeymapPanel(() => KEY_MAPS, saveKeyMap, swapKeyMaps);
  UI.initPowerupRefButton();
  // Persistent "Change Initials" (v3.4.0): overwrite either seat's session
  // initials any time, no refresh needed. Saving re-arms the grace window.
  UI.initInitialsPanel(
    idx => sessionInitials[idx] || storedInitials(idx),
    (idx, value) => { storeInitials(idx, value); armSeatRequestGrace(); }
  );
}
function handleState(curr, prev) {
  myLocals = curr.you.locals;
  spawnDriftDust(curr, prev);
  if (myPlayers.has(1) && myLocals[1] && myLocals[1].role === "player") UI.coOpJoined();
  for (let idx = 0; idx < KEY_MAPS.length; idx++) {
    const entry = myLocals[idx];
    if (!entry) {
      // Seat left (or never existed). Clean up so its keys can re-request
      // it -- but NOT while a join request is still in flight: a state
      // broadcast can arrive before the server processed our joinLocal, and
      // tearing the predictor down then would cancel the join.
      if (!seatPending[idx]) {
        dropSeat(idx);
        if (idx === 1) UI.coOpLeft();
      }
      continue;
    }
    seatPending[idx] = false; // server now knows this seat, in whatever role
    const p = myPlayers.get(idx);
    if (!p) continue;
    if (entry.role !== "player") {
      // Spectating or held: nothing to reconcile against, and any
      // previously predicted body must not keep rendering stale.
      p.simBody = null; p.authBody = null;
      continue;
    }
    p.reconcile(entry.slot, curr.players, curr.tickMs, curr.grid, curr.seq, entry.ack, curr.foods);
    p.retryUnacked();
    // Capture a fresh correction event for the glide effect (cosmetic only;
    // guarded by id so a still-active glide isn't restarted every frame).
    const ev = p.lastCorrectionEvent;
    if (CLIENT_FX.correctionGlide && ev && ev.id !== lastSeenCorrectionEventId[idx]) {
      lastSeenCorrectionEventId[idx] = ev.id;
      activeGlide[idx] = { from: ev.fromHead, to: ev.toHead, slot: entry.slot, startTime: performance.now() };
    }
  }
  if (curr.explosions && curr.explosions.length) {
    const now = performance.now();
    curr.explosions.forEach(e => activeExplosions.push(Object.assign({ startTime: now }, e)));
  }
  if (curr.wallShatters && curr.wallShatters.length) {
    const now = performance.now();
    curr.wallShatters.forEach(w => activeWallShatters.push(Object.assign({ startTime: now }, w)));
  }
  // Powerup activation flashes: one per player whose `activated` one-shot is
  // set this broadcast (any seat, local or remote -- everyone sees the pop).
  if (curr.players) {
    const now = performance.now();
    curr.players.forEach((p, slot) => {
      if (p && p.activated) activePowerFlashes.push({ slot, type: p.activated, startTime: now });
    });
  }
  // Kill feed (v3.6.8): one-shot events queued server-side since the last
  // broadcast (same pattern as explosions above) -- hand straight to ui.js,
  // which owns the fading-line DOM lifecycle.
  if (curr.kills && curr.kills.length) UI.pushKillFeed(curr.kills);
  refreshBoost(); // direction may have changed under a held key
  UI.updateStatus(curr);
  UI.updateLeaveButtons(myLocals);
  UI.updateLeaderboards(curr.highScores, curr.mode);
}
function frame() {
  const { prev, curr } = Net.snapshots();
  if (curr) {
    const localBodies = new Map();
    const eatenKeys = [];
    const flashes = [];
    const glides = [];
    const now = performance.now();
    if (myLocals) {
      myLocals.forEach(entry => {
        if (!entry || entry.role !== "player") return;
        const p = myPlayers.get(entry.local);
        if (!p) return;
        const body = p.renderBody(now);
        if (body) localBodies.set(entry.slot, body);
        const k = p.eatenFoodKey();
        if (k) eatenKeys.push(k);
        const lif = lastInputFlash[entry.local];
        if (CLIENT_FX.inputFlash && lif && (now - lif.t) < CLIENT_FX.inputFlashMs) {
          flashes.push({ slot: entry.slot, dir: lif.dir, t: lif.t, durationMs: CLIENT_FX.inputFlashMs });
        }
        const g = activeGlide[entry.local];
        if (g && (now - g.startTime) < CLIENT_FX.correctionGlideMs) {
          glides.push(Object.assign({ durationMs: CLIENT_FX.correctionGlideMs }, g));
        } else if (g) {
          activeGlide[entry.local] = null; // expired, stop carrying it forward
        }
      });
    }
    const now2 = performance.now();
    activeExplosions = activeExplosions.filter(e => now2 - e.startTime < EXPLOSION_DURATION_MS);
    const explosions = activeExplosions.map(e => Object.assign({}, e, { age: (now2 - e.startTime) / EXPLOSION_DURATION_MS }));
    activePowerFlashes = activePowerFlashes.filter(f => now2 - f.startTime < POWERUP_FLASH_MS);
    const powerFlashes = CLIENT_FX.powerupFx
      ? activePowerFlashes.map(f => ({ slot: f.slot, type: f.type, age: (now2 - f.startTime) / POWERUP_FLASH_MS }))
      : [];
    activeDust = activeDust.filter(d => now2 - d.startTime < DUST_MS);
    const dust = activeDust.map(d => ({ x: d.x, y: d.y, age: (now2 - d.startTime) / DUST_MS }));
    activeWallShatters = activeWallShatters.filter(w => now2 - w.startTime < WALLSHATTER_DURATION_MS);
    const wallShatters = activeWallShatters.map(w => Object.assign({}, w, { age: (now2 - w.startTime) / WALLSHATTER_DURATION_MS }));
    Render.draw(prev, curr, localBodies, eatenKeys, { flashes, glides, explosions, powerFlashes, dust, wallShatters }, {
      interpolate: CLIENT_RENDER.interpolate,
      renderer: CLIENT_RENDER.renderer,
      boostTrail: CLIENT_FX.boostTrail,
      slideDust: CLIENT_FX.slideDust,
      heldGlow: CLIENT_FX.heldGlow,
      powerupFx: CLIENT_FX.powerupFx
    });
  }
  requestAnimationFrame(frame);
}
window.__DEBUG_SOURCE__ = function () {
  const { curr } = Net.snapshots();
  const locals = [];
  myPlayers.forEach((p, localIdx) => {
    const entry = myLocals ? myLocals[localIdx] : null;
    let playerState = null;
    if (entry && entry.role === "player" && curr && curr.players) {
      playerState = curr.players[entry.slot];
    }
    const activationKey = KEY_MAPS[localIdx].activate;
    const isPressingActivation = heldKeys.has(activationKey.toLowerCase()) || heldKeys.has(activationKey);
    locals.push({
      label: localIdx === 0 ? "p1" : "p2",
      role: entry ? entry.role : null,
      slot: (entry && entry.role === "player") ? entry.slot : null,
      boost: boostOn[localIdx],
      heldPowerup: playerState ? playerState.heldPowerup : null,
      activePowerup: playerState ? playerState.activePowerup : null,
      isDrifting: playerState ? !!playerState.activePowerup && (playerState.activePowerup.type === "iceTrail" || playerState.activePowerup.type === "poisonTrail") : false,
      isPressingActivation: isPressingActivation,
      pending: p.inputBuffer.map(x => ({ seq: x.seq, dir: x.dirName, retries: x.retries })),
      corrections: p.corrections.slice(-12),
      correctionCount: p.correctionCount
    });
  });
  return {
    builds: window.__BUILDS__ || {},
    serverBuild: curr ? curr.build : null,
    seq: curr ? curr.seq : null,
    tickMs: curr ? curr.tickMs : null,
    boostSpeed: BOOST_CFG.boostSpeed,
    driftMs: BOOST_CFG.driftMs,
    rampMs: BOOST_CFG.rampMs,
    holdGraceMs: BOOST_CFG.holdGraceMs,
    locals
  };
};
UI.initCaptchaGate(startGame);
requestAnimationFrame(frame);
