// WebGL2 instanced-quad executor prototype for the Phase 7 benchmark.
// One vertex buffer-less instanced TRIANGLE_STRIP draw per frame: every
// visual (cell, trail tile, pickup, shell, ring, particle, flash strip) is
// one instance {rect px, color, shape kind, rotation, param}, drawn in
// painter's order with premultiplied-alpha blending. The instance stream is
// built in JS here purely for the benchmark -- in the shipped renderer the
// wasm module produces it.
(function () {
  const VS = `#version 300 es
layout(location=0) in vec4 i_rect;   // x,y (top-left px), w,h
layout(location=1) in vec4 i_color;  // straight alpha
layout(location=2) in vec4 i_misc;   // kind, rot, p1, unused
out vec2 v_uv;
flat out vec4 v_color;
flat out vec2 v_kp;
uniform vec2 u_res;
void main(){
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 local = (corner - 0.5) * i_rect.zw;
  float c = cos(i_misc.y), s = sin(i_misc.y);
  vec2 r = vec2(local.x*c - local.y*s, local.x*s + local.y*c);
  vec2 px = i_rect.xy + i_rect.zw*0.5 + r;
  vec2 clip = (px / u_res) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = corner * 2.0 - 1.0;
  v_color = i_color;
  v_kp = vec2(i_misc.x, i_misc.z);
}`;
  const FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
flat in vec4 v_color;
flat in vec2 v_kp;
out vec4 o;
void main(){
  if (v_kp.x > 0.5 && v_kp.x < 1.5) {        // ellipse
    if (dot(v_uv, v_uv) > 1.0) discard;
  } else if (v_kp.x > 1.5) {                 // ring, p1 = inner radius 0..1
    float r = length(v_uv);
    if (r > 1.0 || r < v_kp.y) discard;
  }
  o = vec4(v_color.rgb * v_color.a, v_color.a);
}`;
  const KIND_RECT = 0, KIND_ELLIPSE = 1, KIND_RING = 2;
  const STRIDE = 12; // floats per instance
  const CAPACITY = 65536;

  const colorCache = new Map();
  function parseColor(str) {
    let c = colorCache.get(str);
    if (c) return c;
    if (str[0] === "#") {
      const hex = str.length === 4
        ? str.slice(1).split("").map(h => h + h).join("")
        : str.slice(1);
      c = [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255, 1];
    } else {
      const m = str.match(/rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+))?\)/);
      c = m ? [m[1] / 255, m[2] / 255, m[3] / 255, m[4] == null ? 1 : +m[4]] : [1, 1, 1, 1];
    }
    colorCache.set(str, c);
    return c;
  }

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }

  function init(canvas) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const uRes = gl.getUniformLocation(prog, "u_res");
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, CAPACITY * STRIDE * 4, gl.DYNAMIC_DRAW);
    for (let loc = 0; loc < 3; loc++) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, STRIDE * 4, loc * 16);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 1);
    const buf = new Float32Array(CAPACITY * STRIDE);
    const state = {
      gl, uRes, buf, n: 0, canvas,
      rendererInfo: gl.getParameter(gl.RENDERER)
    };
    return state;
  }

  function push(st, x, y, w, h, color, alpha, kind, rot, p1) {
    const o = st.n * STRIDE;
    const b = st.buf;
    const c = parseColor(color);
    b[o] = x; b[o + 1] = y; b[o + 2] = w; b[o + 3] = h;
    b[o + 4] = c[0]; b[o + 5] = c[1]; b[o + 6] = c[2]; b[o + 7] = c[3] * alpha;
    b[o + 8] = kind; b[o + 9] = rot; b[o + 10] = p1; b[o + 11] = 0;
    st.n++;
  }

  const TRAIL_STYLE = { iceTrail: "rgba(150,225,255,0.65)", poisonTrail: "rgba(110,210,70,0.6)" };
  const POWERUP_STYLE = {
    wormhole: "#a3f", growthSpurt: "#fd6", iceTrail: "#9df",
    poisonTrail: "#4a2", speedBoost: "#f93", blueShell: "#39f"
  };
  const FLASH_DIR_VECTORS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  // Mirrors render.js draw() 1:1, emitting instances instead of 2D calls.
  function drawScene(st, scene, now) {
    const { curr, prev, localBodies, eatenKeys, fx, opts } = scene;
    const grid = curr.grid, cs = grid.cellSize;
    const cellGap = Math.max(1, Math.round(cs * 0.08));
    st.n = 0;
    for (const t of curr.trails) push(st, t.x * cs, t.y * cs, cs - cellGap, cs - cellGap, TRAIL_STYLE[t.type] || "#fff", 1, KIND_RECT, 0, 0);
    if (curr.food) {
      const key = curr.food.x + "," + curr.food.y;
      if (!eatenKeys || eatenKeys.indexOf(key) === -1) {
        push(st, curr.food.x * cs, curr.food.y * cs, cs - cellGap, cs - cellGap, "#e33", 1, KIND_RECT, 0, 0);
      }
    }
    for (const p of curr.powerupPickups) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 220 + p.id);
      const size = (cs - 2) * (0.7 + 0.3 * pulse);
      const off = (cs - size) / 2;
      push(st, p.x * cs + off, p.y * cs + off, size, size, POWERUP_STYLE[p.type] || "#fff", 0.6 + 0.4 * pulse, KIND_RECT, 0, 0);
    }
    for (const sh of curr.blueShells) {
      const cx = sh.x * cs + cs / 2, cy = sh.y * cs + cs / 2;
      const spin = (now / 300) % (Math.PI * 2);
      push(st, cx - cs * 0.42, cy - cs * 0.32, cs * 0.84, cs * 0.64, "#39f", 1, KIND_ELLIPSE, spin, 0);
      const hx = cx + Math.sin(spin) * cs * 0.05, hy = cy - Math.cos(spin) * cs * 0.05;
      push(st, hx - cs * 0.12, hy - cs * 0.12, cs * 0.24, cs * 0.24, "#dff", 1, KIND_ELLIPSE, 0, 0);
    }
    for (const e of fx.explosions) {
      const r = e.radius * cs * e.age, lw = Math.max(2, cs * 0.15);
      const outer = r + lw / 2;
      push(st, e.x * cs + cs / 2 - outer, e.y * cs + cs / 2 - outer, outer * 2, outer * 2, "#39f", Math.max(0, 1 - e.age), KIND_RING, 0, Math.max(0, (r - lw / 2) / outer), 0);
    }
    curr.players.forEach((p, i) => {
      if (!p) return;
      const isLocal = localBodies && localBodies.has(i);
      const body = isLocal ? localBodies.get(i) : p.body;
      if (!body || !body.length) return;
      const glide = fx.glides.find(g => g.slot === i);
      const smooth = opts.interpolate && !isLocal && p.alive &&
        prev && prev.players && prev.players[i] && prev.players[i].body;
      const t = smooth ? Math.min(1, Math.max(0, (now - curr.recvTime) / (p.moveMs || curr.tickMs || 100))) : 1;
      const prevBody = smooth ? prev.players[i].body : null;
      let headPx = body[0].x * cs, headPy = body[0].y * cs;
      if (glide) {
        const gt = Math.min(1, (now - glide.startTime) / glide.durationMs);
        const et = easeOutCubic(gt);
        headPx = lerp(glide.from.x * cs, glide.to.x * cs, et);
        headPy = lerp(glide.from.y * cs, glide.to.y * cs, et);
        push(st, headPx, headPy, cs - cellGap, cs - cellGap, p.color.head, 1, KIND_RECT, 0, 0);
        for (let si = 1; si < body.length; si++) push(st, body[si].x * cs, body[si].y * cs, cs - cellGap, cs - cellGap, p.color.body, 1, KIND_RECT, 0, 0);
      } else if (smooth) {
        for (let si = 0; si < body.length; si++) {
          let x = body[si].x * cs, y = body[si].y * cs;
          if (t < 1 && prevBody[si]) {
            const dist = Math.abs(prevBody[si].x - body[si].x) + Math.abs(prevBody[si].y - body[si].y);
            if (dist >= 1 && dist <= 2) {
              x = lerp(prevBody[si].x, body[si].x, t) * cs;
              y = lerp(prevBody[si].y, body[si].y, t) * cs;
            }
          }
          if (si === 0) { headPx = x; headPy = y; }
          push(st, x, y, cs - cellGap, cs - cellGap, si === 0 ? p.color.head : p.color.body, 1, KIND_RECT, 0, 0);
        }
      } else {
        for (let si = 0; si < body.length; si++) {
          push(st, body[si].x * cs, body[si].y * cs, cs - cellGap, cs - cellGap, si === 0 ? p.color.head : p.color.body, 1, KIND_RECT, 0, 0);
        }
      }
      if (!p.alive) {
        for (const seg of body) push(st, seg.x * cs, seg.y * cs, cs - cellGap, cs - cellGap, "#000", 0.5, KIND_RECT, 0, 0);
      }
      if (p.alive && p.boost && opts.boostTrail && p.dir) {
        for (let n = 0; n < 3; n++) {
          const phase = (now / 90 + n * 0.33) % 1;
          const dist = phase * cs * 1.5;
          push(st, headPx + cs / 2 - p.dir.x * dist - cs * 0.15, headPy + cs / 2 - p.dir.y * dist - cs * 0.15, cs * 0.3, cs * 0.3, "#9df", 0.5 * (1 - phase), KIND_RECT, 0, 0);
        }
      }
      if (p.alive && p.sliding && opts.slideDust) {
        for (let n = 0; n < 4; n++) {
          const phase = (now / 140 + n * 0.25) % 1;
          const angle = (n / 4) * Math.PI * 2;
          const dist = phase * cs * 0.6;
          push(st, headPx + cs / 2 + Math.cos(angle) * dist - cs * 0.08, headPy + cs / 2 + Math.sin(angle) * dist - cs * 0.08, cs * 0.16, cs * 0.16, "#ccc", 0.35 * (1 - phase), KIND_RECT, 0, 0);
        }
      }
      const flash = fx.flashes.find(f => f.slot === i);
      if (flash) {
        const alpha = Math.max(0, 1 - (now - flash.t) / flash.durationMs);
        const v = FLASH_DIR_VECTORS[flash.dir];
        if (v && alpha > 0) {
          const stripW = Math.max(3, Math.round(cs * 0.28));
          if (v.x === 1) push(st, headPx + cs - stripW, headPy, stripW, cs - cellGap, "#fff", alpha, KIND_RECT, 0, 0);
          else if (v.x === -1) push(st, headPx, headPy, stripW, cs - cellGap, "#fff", alpha, KIND_RECT, 0, 0);
          else if (v.y === 1) push(st, headPx, headPy + cs - stripW, cs - cellGap, stripW, "#fff", alpha, KIND_RECT, 0, 0);
          else push(st, headPx, headPy, cs - cellGap, stripW, "#fff", alpha, KIND_RECT, 0, 0);
        }
      }
    });
    const gl = st.gl;
    gl.viewport(0, 0, st.canvas.width, st.canvas.height);
    gl.uniform2f(st.uRes, st.canvas.width, st.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, st.buf.subarray(0, st.n * STRIDE));
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, st.n);
  }

  window.GLProto = { init, drawScene };
})();
