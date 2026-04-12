// fractal-worker.js — runs entirely off the main thread via OffscreenCanvas
// Shader sources & GL helpers are in fractal-core.js

importScripts('fractal-core.js?v=' + Date.now());

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
const INTRO_MS       = 3600;   // sorted → normal (unsort)
const TRANSITION_MS  = 7200;
const SORT_THRESH_LO = 8;
const SORT_THRESH_HI = 250;

let currentOffset = [0, 0];
let dispTexA = null, dispTexB = null;

// ── Displacement texture helpers ─────────────────────────────────────────
function uploadDispTex(tex, dispData, w, h) {
  if (!tex) {
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  } else {
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, dispData);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function buildDispFromFBO(fbo, w, h) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
  const pixels = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return FC.pixelSortBuildDisp(pixels, w, h, SORT_THRESH_LO, SORT_THRESH_HI);
}

// ── Display (transition) rendering ────────────────────────────────────────
function drawDisplay(t, intro) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(displayProg);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, fboA.tex);
  gl.uniform1i(displayUniforms.u_texA, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, fboB.tex);
  gl.uniform1i(displayUniforms.u_texB, 1);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, dispTexA);
  gl.uniform1i(displayUniforms.u_dispA, 2);
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, dispTexB);
  gl.uniform1i(displayUniforms.u_dispB, 3);
  gl.uniform1f(displayUniforms.u_transition, t);
  gl.uniform1f(displayUniforms.u_intro, intro || 0.0);
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
      const dtmp = dispTexA; dispTexA = dispTexB; dispTexB = dtmp;
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
    const dtmp = dispTexA; dispTexA = dispTexB; dispTexB = dtmp;
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
      const dispA = buildDispFromFBO(fboA, w, h);
      dispTexA = uploadDispTex(dispTexA, dispA, w, h);
      if (!dispTexB) dispTexB = uploadDispTex(dispTexB, dispA, w, h);

      function saveFBOToMain() {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboA.fbo);
        const pixels = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        self.postMessage({ type: 'cacheFBO', pixels: pixels.buffer, w, h }, [pixels.buffer]);
      }

      // 播放入场动画（sorted → normal）
      const introStart = performance.now();
      function introTick() {
        const p = Math.min((performance.now() - introStart) / INTRO_MS, 1.0);
        drawDisplay(0.0, 1.0 - p);
        gl.flush();
        if (p < 1.0) {
          setTimeout(introTick, 16);
        } else {
          saveFBOToMain();
        }
      }
      setTimeout(introTick, 16);
      self.postMessage({ type: 'renderDone' });
    } else {
      // create displacement map for transition target
      const dispB = buildDispFromFBO(fboB, w, h);
      dispTexB = uploadDispTex(dispTexB, dispB, w, h);
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
    if (!gl) {
      console.error('[fractal-worker] WebGL2 not supported');
      self.postMessage({ type: 'initError', reason: 'WebGL2 not supported on OffscreenCanvas' });
      return;
    }

    fractalProg = FC.buildProgram(gl, FC.VERT_SRC, FC.FRAG_SRC_HQ);
    displayProg = FC.buildProgram(gl, FC.VERT_SRC, FC.DISPLAY_FRAG_SRC);
    if (!fractalProg || !displayProg) {
      self.postMessage({ type: 'initError', reason: 'Shader compilation failed' });
      return;
    }

    fractalUniforms = FC.cacheFractalUniforms(gl, fractalProg);
    displayUniforms = {
      u_texA:       gl.getUniformLocation(displayProg, 'u_texA'),
      u_texB:       gl.getUniformLocation(displayProg, 'u_texB'),
      u_dispA:      gl.getUniformLocation(displayProg, 'u_dispA'),
      u_dispB:      gl.getUniformLocation(displayProg, 'u_dispB'),
      u_transition: gl.getUniformLocation(displayProg, 'u_transition'),
      u_intro:      gl.getUniformLocation(displayProg, 'u_intro'),
      u_resolution: gl.getUniformLocation(displayProg, 'u_resolution'),
    };

    self.postMessage({ type: 'initOK' });

  } else if (type === 'resize') {
    if (!canvas) return;
    canvas.width  = e.data.w;
    canvas.height = e.data.h;
    if (gl) gl.viewport(0, 0, e.data.w, e.data.h);
    fboAValid = false;
    renderGen++;

  } else if (type === 'mouseenter') {
    if (!fboAValid) renderFractalToFBO();

  } else if (type === 'loadCache') {
    // 从主线程接收缓存像素，上传到 FBO，跳过 GPU 分形计算，直接播放 intro
    const { pixels, w, h } = e.data;
    if (!fboA || fboA.w !== w || fboA.h !== h) {
      fboA = FC.makeFBO(gl, w, h);
      fboB = FC.makeFBO(gl, w, h);
    }
    gl.bindTexture(gl.TEXTURE_2D, fboA.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(pixels));
    gl.bindTexture(gl.TEXTURE_2D, null);
    fboAValid = true;

    // 构建 displacement map + 播放 intro 动画
    const dispA = buildDispFromFBO(fboA, w, h);
    dispTexA = uploadDispTex(dispTexA, dispA, w, h);
    if (!dispTexB) dispTexB = uploadDispTex(dispTexB, dispA, w, h);

    const introStart = performance.now();
    function introTick() {
      const p = Math.min((performance.now() - introStart) / INTRO_MS, 1.0);
      drawDisplay(0.0, 1.0 - p);
      gl.flush();
      if (p < 1.0) setTimeout(introTick, 16);
    }
    setTimeout(introTick, 16);
    self.postMessage({ type: 'renderDone' });

  } else if (type === 'click') {
    currentOffset[0] = (e.data.nx - 0.5) * MOUSE_STRENGTH;
    currentOffset[1] = (e.data.ny - 0.5) * MOUSE_STRENGTH;
    renderFractalToFBO();
  }
});
