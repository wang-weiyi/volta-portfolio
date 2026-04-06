// fractal-worker.js — runs entirely off the main thread via OffscreenCanvas

// ── Vertex shader (fullscreen triangle) ───────────────────────────────────
const VERT_SRC = `#version 300 es
precision highp float;
out vec2 vUv;
void main(){
  vec2 pos[3] = vec2[](vec2(-1,-1),vec2(3,-1),vec2(-1,3));
  gl_Position = vec4(pos[gl_VertexID], 0.0, 1.0);
  vUv = (pos[gl_VertexID] + 1.0) * 0.5;
}`;

// ── Fractal fragment shader ────────────────────────────────────────────────
const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform float u_time;
uniform vec2  u_resolution;

uniform vec3  u_juliaC;
uniform vec2  u_juliaCOffset;
uniform vec3  u_rotAxis;
uniform float u_rotAngle;
uniform float u_scale;
uniform float u_bailout;
uniform int   u_iter;
uniform int   u_inversion;
uniform int   u_rotateC;
uniform float u_uvScale;
uniform float u_zPower;
uniform float u_zOffset;
uniform float u_zOffset2;
uniform float u_proj;

uniform vec3  u_lightDir;
uniform vec3  u_lightColor;
uniform vec3  u_ambientColor;
uniform vec3  u_materialColor;
uniform float u_shininess;
uniform float u_ambientStrength;
uniform float u_specularStrength;

uniform vec3  u_camPos;
uniform float u_fov;

mat3 rotAxisAngle(float angle, vec3 axis) {
  axis = normalize(axis);
  float c = cos(angle), s = sin(angle), t = 1.0 - c;
  float x = axis.x, y = axis.y, z = axis.z;
  return mat3(
    t*x*x+c,   t*x*y-s*z, t*x*z+s*y,
    t*y*x+s*z, t*y*y+c,   t*y*z-s*x,
    t*z*x-s*y, t*z*y+s*x, t*z*z+c
  );
}

float frobeniusNorm(mat3 M) {
  return sqrt(dot(M[0],M[0]) + dot(M[1],M[1]) + dot(M[2],M[2]));
}

vec3 equirectangularInverse(vec3 planarPos, float scale, float radius) {
  float useR = (radius != 0.0) ? radius : planarPos.z;
  float lon = planarPos.x / scale;
  float lat = planarPos.y / scale;
  float xzLen = useR * cos(lat);
  return vec3(xzLen * sin(lon), useR * sin(lat), xzLen * cos(lon));
}

vec3 applyTransform(vec3 pos) {
  float r = sign(pos.z) * pow(abs(pos.z), u_zPower);
  r += sign(pos.z) * u_zOffset;
  r += u_zOffset2;
  vec3 npos = equirectangularInverse(pos, u_uvScale, r);
  return pos + u_proj * (npos - pos);
}

mat3 computeTransformJacobian(vec3 pos) {
  float absZ = abs(pos.z);
  float signZ = sign(pos.z);
  float r = (absZ > 1e-6 ? signZ * pow(absZ, u_zPower) : 0.0)
            + signZ * u_zOffset + u_zOffset2;
  float useR, dr_dz;
  if (r != 0.0) {
    useR  = r;
    dr_dz = (absZ > 1e-6) ? u_zPower * pow(absZ, u_zPower - 1.0) : 0.0;
  } else {
    useR  = pos.z;
    dr_dz = 1.0;
  }
  float lon    = pos.x / u_uvScale;
  float lat    = pos.y / u_uvScale;
  float cosLat = cos(lat), sinLat = sin(lat);
  float cosLon = cos(lon), sinLon = sin(lon);
  float invS   = 1.0 / u_uvScale;
  mat3 JF = mat3(
    vec3( useR * cosLat * cosLon * invS,  0.0, -useR * cosLat * sinLon * invS),
    vec3(-useR * sinLat * sinLon * invS,  useR * cosLat * invS, -useR * sinLat * cosLon * invS),
    vec3( cosLat * sinLon * dr_dz,        sinLat * dr_dz,        cosLat * cosLon * dr_dz)
  );
  return mat3(1.0) + u_proj * (JF - mat3(1.0));
}

float sdf(vec3 pos) {
  vec3 tp = applyTransform(pos);
  mat3 Jt = computeTransformJacobian(pos);
  vec3 z; mat3 D;
  if (u_inversion == 1) {
    float r2 = dot(tp, tp);
    z = tp / r2;
    mat3 outer = outerProduct(tp, tp);
    mat3 Jinv = (mat3(1.0) - 2.0/r2 * outer) / r2;
    D = Jinv * Jt;
  } else { z = tp; D = Jt; }

  mat3 rot = rotAxisAngle(u_rotAngle, u_rotAxis);
  vec3 j = u_juliaC + vec3(u_juliaCOffset, 0.0);

  for (int i = 0; i < 64; i++) {
    if (i >= u_iter) break;
    float a = z.x, b = z.y;
    vec3 zn = vec3(a*a - b*b, 2.0*a*b, z.z);
    mat3 Jj = mat3(
       2.0*a,  2.0*b, 0.0,
      -2.0*b,  2.0*a, 0.0,
       0.0,    0.0,   1.0
    );
    D = rot * Jj * D;
    z = rot * zn;
    if (u_rotateC == 1) j = rot * j;
    z = z * u_scale + j;
    float r = length(z);
    if (r > u_bailout) {
      float normD = frobeniusNorm(D);
      float distScale = clamp(float(i+1) / 50.0, 0.0, 1.0);
      float de = (0.5 + 0.25*distScale) * r * log(r) / normD;
      return max(de, length(pos) - 30.0);
    }
  }
  return 0.0;
}

vec3 calcNormal(vec3 p) {
  float eps = 0.0005;
  float d = sdf(p);
  return normalize(vec3(
    sdf(p + vec3(eps,0,0)) - d,
    sdf(p + vec3(0,eps,0)) - d,
    sdf(p + vec3(0,0,eps)) - d
  ));
}

float calcAO(vec3 p, vec3 n) {
  float dist = 0.002, occ = 1.0;
  for (int i = 0; i < 8; i++) {
    occ = min(occ, sdf(p + dist*n) / dist);
    dist *= 2.0;
  }
  return max(occ, 0.0);
}

float softShadow(vec3 ro, vec3 rd, float mint, float maxt, float w) {
  float res = 1.0, ph = 1e20, t = mint;
  for (int i = 0; i < 64 && t < maxt; i++) {
    float h = sdf(ro + rd*t);
    if (h < 0.001) return 0.0;
    float y = h*h / (2.0*ph);
    float d = sqrt(h*h - y*y);
    res = min(res, clamp(d / (w * max(0.01, t-y)), 0.0, 10.0));
    ph = h; t += h;
  }
  return res;
}

vec3 phongLighting(vec3 p, vec3 normal, vec3 viewDir) {
  vec3 ld     = normalize(-u_lightDir);
  vec3 ambient = u_ambientStrength * u_ambientColor;
  float diff  = max(dot(normal, ld), 0.0);
  vec3 reflDir = reflect(ld, normal);
  float spec  = pow(max(dot(viewDir, reflDir), 0.0), u_shininess);
  return (ambient + diff * u_lightColor + u_specularStrength * spec * u_lightColor) * u_materialColor;
}

vec3 aces(vec3 x) {
  float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;
  vec3 ro  = u_camPos;
  vec3 target = vec3(7.9, 0.0, 1.55);
  vec3 fwd = normalize(target - ro);
  vec3 worldUp = abs(fwd.y) < 0.99 ? vec3(0,1,0) : vec3(0,0,1);
  vec3 right = normalize(cross(worldUp, fwd));
  vec3 up    = cross(fwd, right);

  float aspect    = u_resolution.x / u_resolution.y;
  vec2 ndc        = (uv - 0.5) * 2.0;
  ndc.x          *= aspect;
  float fovFactor = tan(u_fov * 0.5);
  vec3 rd = normalize(fwd + ndc.x * fovFactor * right + ndc.y * fovFactor * up);

  vec3 raypos = ro;
  bool hit = false;
  for (int i = 0; i < 600; i++) {
    float dist = sdf(raypos);
    if (dist < 0.000001) { hit = true; break; }
    if (length(raypos - ro) > 60.0) break;
    raypos += dist * rd;
  }

  vec3 col;
  if (hit) {
    vec3  normal  = calcNormal(raypos);
    float ao      = calcAO(raypos, normal);
    vec3  viewDir = normalize(ro - raypos);
    vec3  ldir    = normalize(u_lightDir);
    float shadow  = softShadow(raypos + 0.0001*normal, -ldir, 0.06, 5.0, 0.08);
    col  = phongLighting(raypos, normal, viewDir);
    col *= ao * (0.4 + 0.6 * shadow);
  } else {
    col = vec3(0.0);
  }

  col  = aces(col * 1.2);
  col  = pow(col, vec3(1.0/2.2));
  col *= 1.0 - 0.4 * pow(length(uv*2.0-1.0), 2.0);
  fragColor = vec4(col, 1.0);
}`;

// ── Pixel-sort transition shader ───────────────────────────────────────────
const DISPLAY_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D u_texA;
uniform sampler2D u_texB;
uniform float     u_transition;
uniform vec2      u_resolution;

float hash1(float n) {
  return fract(sin(n * 127.1) * 43758.5453);
}

void main() {
  vec2 uv = vUv;
  if (u_transition <= 0.0) { fragColor = texture(u_texA, uv); return; }
  if (u_transition >= 1.0) { fragColor = texture(u_texB, uv); return; }

  float colId    = floor(gl_FragCoord.x / 3.0);
  float colRand  = hash1(colId);
  float colDelay = colRand * 0.38;
  float colT     = clamp((u_transition - colDelay) / (1.0 - colDelay), 0.0, 1.0);

  float luma     = dot(texture(u_texA, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
  float sortDir  = (colRand > 0.5) ? 1.0 : -1.0;
  float envelope = sin(colT * 3.14159);
  float shift    = (luma - 0.45) * sortDir * envelope * 0.52;

  vec2  sortedUV  = vec2(uv.x, clamp(uv.y + shift, 0.001, 0.999));
  vec4  colA_sort = texture(u_texA, sortedUV);

  float scanFlash = exp(-pow((colT - 0.5) * 9.0, 2.0)) * 0.22;
  colA_sort.rgb  += scanFlash * vec3(0.5, 0.72, 1.0);

  float revealT = smoothstep(0.50, 0.90, colT);
  fragColor = clamp(mix(colA_sort, texture(u_texB, uv), revealT), 0.0, 1.0);
}`;

// ── Worker state ───────────────────────────────────────────────────────────
let gl, fractalProg, displayProg;
let fractalUniforms = {}, displayUniforms = {};
let fboA = null, fboB = null;
let fboAValid = false;
let pendingOffset = [0, 0];
let transitionStart = 0;
let isTransitioning = false;
let transitionTimer = null;
let debounceTimer = null;
let canvas = null;
let renderGen = 0; // Cancellation token: incremented on each new render request

const MOUSE_STRENGTH = 0.285;
const DEBOUNCE_MS    = 350;
const TRANSITION_MS  = 900;

// GPU budget per tile: once drawArrays starts, GPU is non-preemptible.
// This is the max compositor stall per tile. Must be < 1 vsync (16ms).
const TARGET_GPU_MS = 4;

// ── GL helpers ─────────────────────────────────────────────────────────────
function compileShader(g, type, src) {
  const s = g.createShader(type);
  g.shaderSource(s, src);
  g.compileShader(s);
  if (!g.getShaderParameter(s, g.COMPILE_STATUS)) {
    console.error('[fractal-worker] Shader error:', g.getShaderInfoLog(s));
    return null;
  }
  return s;
}

function buildProgram(g, fSrc) {
  const vs = compileShader(g, g.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(g, g.FRAGMENT_SHADER, fSrc);
  if (!vs || !fs) return null;
  const p = g.createProgram();
  g.attachShader(p, vs); g.attachShader(p, fs);
  g.linkProgram(p);
  if (!g.getProgramParameter(p, g.LINK_STATUS)) {
    console.error('[fractal-worker] Link error:', g.getProgramInfoLog(p));
    return null;
  }
  return p;
}

function makeFBO(g, w, h) {
  const tex = g.createTexture();
  g.bindTexture(g.TEXTURE_2D, tex);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, null);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  const fbo = g.createFramebuffer();
  g.bindFramebuffer(g.FRAMEBUFFER, fbo);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
  g.bindFramebuffer(g.FRAMEBUFFER, null);
  g.bindTexture(g.TEXTURE_2D, null);
  return { fbo, tex, w, h };
}

function cacheFractalUniforms(g, p) {
  const names = [
    'u_time','u_resolution',
    'u_juliaC','u_juliaCOffset','u_rotAxis','u_rotAngle','u_scale','u_bailout',
    'u_iter','u_inversion','u_rotateC',
    'u_uvScale','u_zPower','u_zOffset','u_zOffset2','u_proj',
    'u_lightDir','u_lightColor','u_ambientColor','u_materialColor',
    'u_shininess','u_ambientStrength','u_specularStrength',
    'u_camPos','u_fov',
  ];
  const out = {};
  for (const n of names) out[n] = g.getUniformLocation(p, n);
  return out;
}

function setFractalUniforms(g, u, offset, rw, rh) {
  g.uniform1f(u.u_time, 0.0);
  g.uniform2f(u.u_resolution, rw, rh);
  g.uniform3f(u.u_juliaC,           0.345, 0.557, 0.0);
  g.uniform2f(u.u_juliaCOffset,     offset[0], offset[1]);
  g.uniform3f(u.u_rotAxis,          1.0, 0.0, 0.0);
  g.uniform1f(u.u_rotAngle,         45.0 * Math.PI / 180.0);
  g.uniform1f(u.u_scale,            0.957);
  g.uniform1f(u.u_bailout,          3000.0);
  g.uniform1i(u.u_iter,             24);
  g.uniform1i(u.u_inversion,        0);
  g.uniform1i(u.u_rotateC,          0);
  g.uniform1f(u.u_uvScale,          2.5);
  g.uniform1f(u.u_zPower,           1.0);
  g.uniform1f(u.u_zOffset,          0.0);
  g.uniform1f(u.u_zOffset2,         0.0);
  g.uniform1f(u.u_proj,             1.0);
  g.uniform3f(u.u_lightDir,        -0.69, -0.23, -0.2);
  g.uniform3f(u.u_lightColor,       1.0,   1.0,   1.0);
  g.uniform3f(u.u_ambientColor,     0.3,   0.3,   0.3);
  g.uniform3f(u.u_materialColor,    0.9,   0.9,   0.9);
  g.uniform1f(u.u_shininess,        93.0);
  g.uniform1f(u.u_ambientStrength,  0.39);
  g.uniform1f(u.u_specularStrength, 2.76);
  g.uniform3f(u.u_camPos,           6.1788, 1.4962, 5.7053);
  g.uniform1f(u.u_fov,              60.0 * Math.PI / 180.0);
}

// ── Display (transition) rendering ────────────────────────────────────────
function drawDisplay(t) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(displayProg);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, fboA.tex);
  gl.uniform1i(displayUniforms.u_texA, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, fboB.tex);
  gl.uniform1i(displayUniforms.u_texB, 1);
  gl.uniform1f(displayUniforms.u_transition, t);
  gl.uniform2f(displayUniforms.u_resolution, canvas.width, canvas.height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// Transition loop: runs AFTER gl.finish() so GPU is free; each frame is fast.
function startTransitionLoop() {
  if (transitionTimer !== null) return;
  function tick() {
    if (!isTransitioning) { transitionTimer = null; return; }
    const t = Math.min((performance.now() - transitionStart) / TRANSITION_MS, 1.0);
    drawDisplay(t);
    if (t >= 1.0) {
      isTransitioning = false;
      transitionTimer = null;
      const tmp = fboA; fboA = fboB; fboB = tmp;
    } else {
      transitionTimer = setTimeout(tick, 16);
    }
  }
  transitionTimer = setTimeout(tick, 16);
}

// ── Adaptive tiled fractal render ─────────────────────────────────────────
// Key insight: gl.finish() blocks ONLY the worker thread, not the main thread
// or compositor. By measuring actual GPU time per batch and keeping it under
// TARGET_GPU_MS, the compositor always gets GPU access within one batch window.
//
// Flow per batch:
//   drawArrays (submit to GPU) → gl.finish() (worker waits; GPU executes)
//   → setTimeout(0) (yield worker event loop; compositor gets GPU window)
//   → next batch
//
// Batch height adapts: if GPU took too long → fewer rows; too fast → more rows.

async function renderFractalToFBO(offset) {
  const w = canvas.width, h = canvas.height;
  const gen = ++renderGen;

  if (!fboA || fboA.w !== w || fboA.h !== h) {
    fboA = makeFBO(gl, w, h);
    fboB = makeFBO(gl, w, h);
    fboAValid = false;
  }

  if (isTransitioning) {
    isTransitioning = false;
    clearTimeout(transitionTimer);
    transitionTimer = null;
    const tmp = fboA; fboA = fboB; fboB = tmp;
  }

  gl.useProgram(fractalProg);
  setFractalUniforms(gl, fractalUniforms, offset, w, h);

  // ── Adaptive tile-based rendering ──────────────────────────
  // Row-based batching fails when even 1 full-width row exceeds the GPU
  // budget (e.g. 3840px × heavy shader > 16ms). Tiles cut BOTH dimensions,
  // so a 64×64 tile = 4096 fragments — small enough for <4ms on most GPUs.
  //
  // Tile side length adapts: after each tile we measure actual GPU time,
  // compute ms-per-pixel, and resize to hit TARGET_GPU_MS.

  let tileSide = 64; // starting guess; adapts after first measurement

  for (let y = 0; y < h;) {
    for (let x = 0; x < w;) {
      if (gen !== renderGen) return; // newer request — abort

      const tw = Math.min(tileSide, w - x);
      const th = Math.min(tileSide, h - y);

      gl.bindFramebuffer(gl.FRAMEBUFFER, fboB.fbo);
      gl.viewport(0, 0, w, h);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(x, y, tw, th);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      // gl.finish() blocks worker only; measures real GPU time for this tile
      const t0 = performance.now();
      gl.finish();
      const gpuMs = performance.now() - t0;

      // Adapt tile size based on measured cost per pixel
      const pixels = tw * th;
      if (gpuMs > 0.01) {
        const msPerPx    = gpuMs / pixels;
        const wantPixels = TARGET_GPU_MS / msPerPx;
        const wantSide   = Math.sqrt(wantPixels);
        // Smooth adjustment: blend 60% toward target to avoid oscillation
        tileSide = Math.max(16, Math.min(256,
          Math.round(tileSide * 0.4 + wantSide * 0.6)));
      }

      x += tw;

      // Yield after every tile: compositor gets a GPU-free window
      await new Promise(r => setTimeout(r, 0));
    }
    y += tileSide; // use current (adapted) tileSide for next row of tiles
  }

  if (gen !== renderGen) return;

  if (!fboAValid) {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fboB.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fboA.fbo);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    fboAValid = true;
    const tmp = fboA; fboA = fboB; fboB = tmp;
    drawDisplay(0.0);
    return;
  }

  isTransitioning = true;
  transitionStart = performance.now();
  startTransitionLoop();
}

// ── Message handler ────────────────────────────────────────────────────────
self.addEventListener('message', (e) => {
  const { type } = e.data;

  if (type === 'init') {
    canvas = e.data.canvas;
    canvas.width  = e.data.w;
    canvas.height = e.data.h;

    gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) { console.error('[fractal-worker] WebGL2 not supported'); return; }

    fractalProg = buildProgram(gl, FRAG_SRC);
    displayProg = buildProgram(gl, DISPLAY_FRAG_SRC);
    if (!fractalProg || !displayProg) return;

    fractalUniforms = cacheFractalUniforms(gl, fractalProg);
    displayUniforms = {
      u_texA:       gl.getUniformLocation(displayProg, 'u_texA'),
      u_texB:       gl.getUniformLocation(displayProg, 'u_texB'),
      u_transition: gl.getUniformLocation(displayProg, 'u_transition'),
      u_resolution: gl.getUniformLocation(displayProg, 'u_resolution'),
    };

  } else if (type === 'resize') {
    if (!canvas) return;
    canvas.width  = e.data.w;
    canvas.height = e.data.h;
    if (gl) gl.viewport(0, 0, e.data.w, e.data.h);
    fboAValid = false;
    renderGen++; // Cancel any in-progress tiled render

  } else if (type === 'mouseenter') {
    if (!fboAValid) renderFractalToFBO([0, 0]);

  } else if (type === 'mousemove') {
    pendingOffset[0] = (e.data.nx - 0.5) * MOUSE_STRENGTH;
    pendingOffset[1] = (e.data.ny - 0.5) * MOUSE_STRENGTH;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      renderFractalToFBO([pendingOffset[0], pendingOffset[1]]);
    }, DEBOUNCE_MS);

  } else if (type === 'mouseleave') {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
});
