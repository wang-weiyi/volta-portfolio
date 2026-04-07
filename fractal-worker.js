// fractal-worker.js — runs entirely off the main thread via OffscreenCanvas
// Shader sources & GL helpers are in fractal-core.js

importScripts('fractal-core.js');

const FC = FractalCore;

// ── Worker state ───────────────────────────────────────────────────────────
let gl, fractalProg, displayProg;
let fractalUniforms = {}, displayUniforms = {};
let fboA = null, fboB = null;
let fboAValid = false;
let transitionStart = 0;
let isTransitioning = false;
let transitionTimer = null;
let canvas = null;
let renderGen = 0;

const MOUSE_STRENGTH = 0.285;
const TRANSITION_MS  = 1800;

let currentOffset = [0, 0];

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

function startTransitionLoop() {
  if (transitionTimer !== null) return;
  function tick() {
    if (!isTransitioning) { transitionTimer = null; return; }
    const t = Math.min((performance.now() - transitionStart) / TRANSITION_MS, 1.0);
    drawDisplay(t);
    gl.flush();
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

let tileRendering = false;
let pendingOffset = null;

const TILE_COLS = 4;
const TILE_ROWS = 4;
const TILE_BREATHE_MS = 16;

function renderFractalToFBO() {
  const w = canvas.width, h = canvas.height;

  if (tileRendering) {
    pendingOffset = [...currentOffset];
    return;
  }

  ++renderGen;
  tileRendering = true;

  if (!fboA || fboA.w !== w || fboA.h !== h) {
    fboA = FC.makeFBO(gl, w, h);
    fboB = FC.makeFBO(gl, w, h);
    fboAValid = false;
  }

  if (isTransitioning) {
    isTransitioning = false;
    clearTimeout(transitionTimer);
    transitionTimer = null;
    const tmp = fboA; fboA = fboB; fboB = tmp;
  }

  const tileW = Math.ceil(w / TILE_COLS);
  const tileH = Math.ceil(h / TILE_ROWS);
  const tiles = [];
  for (let ty = 0; ty < TILE_ROWS; ty++) {
    for (let tx = 0; tx < TILE_COLS; tx++) {
      tiles.push({
        x: tx * tileW,
        y: ty * tileH,
        w: Math.min(tileW, w - tx * tileW),
        h: Math.min(tileH, h - ty * tileH),
      });
    }
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, fboB.fbo);
  gl.viewport(0, 0, w, h);
  gl.useProgram(fractalProg);
  FC.setFractalUniforms(gl, fractalUniforms, currentOffset, w, h);
  gl.enable(gl.SCISSOR_TEST);

  const myGen = renderGen;
  let tileIdx = 0;

  function submitNextTile() {
    if (myGen !== renderGen) { finish(); return; }
    if (tileIdx >= tiles.length) { finish(); return; }

    const tile = tiles[tileIdx++];
    gl.scissor(tile.x, tile.y, tile.w, tile.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();

    function pollTile() {
      if (myGen !== renderGen) {
        gl.deleteSync(sync);
        finish();
        return;
      }
      const status = gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (status !== gl.SIGNALED) {
        setTimeout(pollTile, 4);
        return;
      }
      gl.deleteSync(sync);
      setTimeout(submitNextTile, TILE_BREATHE_MS);
    }
    setTimeout(pollTile, 4);
  }

  function finish() {
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    tileRendering = false;

    if (myGen !== renderGen) {
      if (pendingOffset) {
        currentOffset = pendingOffset;
        pendingOffset = null;
        renderFractalToFBO();
      }
      return;
    }

    if (!fboAValid) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fboB.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fboA.fbo);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      fboAValid = true;
      const tmp = fboA; fboA = fboB; fboB = tmp;
      drawDisplay(0.0);
      gl.flush();
      self.postMessage({ type: 'renderDone' });
    } else {
      isTransitioning = true;
      transitionStart = performance.now();
      startTransitionLoop();
      self.postMessage({ type: 'renderDone' });
    }

    if (pendingOffset) {
      currentOffset = pendingOffset;
      pendingOffset = null;
      renderFractalToFBO();
    }
  }

  submitNextTile();
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

    fractalProg = FC.buildProgram(gl, FC.VERT_SRC, FC.FRAG_SRC_HQ);
    displayProg = FC.buildProgram(gl, FC.VERT_SRC, FC.DISPLAY_FRAG_SRC);
    if (!fractalProg || !displayProg) return;

    fractalUniforms = FC.cacheFractalUniforms(gl, fractalProg);
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
    renderGen++;

  } else if (type === 'mouseenter') {
    if (!fboAValid) renderFractalToFBO();

  } else if (type === 'click') {
    currentOffset[0] = (e.data.nx - 0.5) * MOUSE_STRENGTH;
    currentOffset[1] = (e.data.ny - 0.5) * MOUSE_STRENGTH;
    renderFractalToFBO();
  }
});
