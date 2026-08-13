// fractal-worker.js — runs entirely off the main thread via OffscreenCanvas
// Shader sources & GL helpers are in fractal-core.js

importScripts('fractal-core.js?v=' + Date.now());

const FC = FractalCore;

// ── Worker state ───────────────────────────────────────────────────────────
let gl, progressiveProg, accumulateProg, activeRayProg, resolveProg, displayProg;
let progressiveUniforms = {}, accumulateUniforms = {}, activeRayUniforms = {}, resolveUniforms = {}, displayUniforms = {};
let fboA = null, fboB = null;
let stateA = null, stateB = null;
let accumulationFBO = null;
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

function drawResolved(currentState, includeCurrent, targetFBO) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO || null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(resolveProg);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, accumulationFBO.tex);
  gl.uniform1i(resolveUniforms.u_accum, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, currentState.tex);
  gl.uniform1i(resolveUniforms.u_currentState, 1);
  gl.uniform1f(resolveUniforms.u_includeCurrent, includeCurrent ? 1.0 : 0.0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function accumulateSample(sampleState) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, accumulationFBO.fbo);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(accumulateProg);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, sampleState.tex);
  gl.uniform1i(accumulateUniforms.u_sampleState, 0);
  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.disable(gl.BLEND);
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

let progressiveRendering = false;
let pendingOffset = null;

const AA_SAMPLES = 4;
const STEPS_PER_SAMPLE = 512;
const ACTIVE_CHECK_INTERVAL = 16;
const SAMPLE_JITTERS = [
  [-0.25, -0.25],
  [ 0.25, -0.25],
  [-0.25,  0.25],
  [ 0.25,  0.25],
];

function renderFractalToFBO() {
  const w = canvas.width, h = canvas.height;

  if (progressiveRendering) {
    renderGen++;
    pendingOffset = [...currentOffset];
    return;
  }

  const myGen = ++renderGen;
  const renderOffset = [...currentOffset];
  const wasInitialRender = !fboAValid;
  progressiveRendering = true;

  if (!fboA || fboA.w !== w || fboA.h !== h) {
    fboA = FC.makeFBO(gl, w, h);
    fboB = FC.makeFBO(gl, w, h);
    fboAValid = false;
  }

  if (!stateA || stateA.w !== w || stateA.h !== h) {
    stateA = FC.makeStateFBO(gl, w, h);
    stateB = FC.makeStateFBO(gl, w, h);
    accumulationFBO = FC.makeAccumFBO(gl, w, h);
    if (!stateA.complete || !stateB.complete || !accumulationFBO.complete) {
      progressiveRendering = false;
      self.postMessage({ type: 'initError', reason: 'Floating-point render targets are unavailable' });
      return;
    }
  }

  if (isTransitioning) {
    isTransitioning = false;
    clearTimeout(transitionTimer);
    transitionTimer = null;
  }

  let readState = stateA;
  let writeState = stateB;
  let pass = 0;
  let sampleIndex = 0;

  gl.bindFramebuffer(gl.FRAMEBUFFER, accumulationFBO.fbo);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  function submitNextStep() {
    if (myGen !== renderGen) { finishCancelled(); return; }

    gl.bindFramebuffer(gl.FRAMEBUFFER, writeState.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(progressiveProg);
    FC.setFractalUniforms(gl, progressiveUniforms, renderOffset, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, readState.tex);
    gl.uniform1i(progressiveUniforms.u_state, 0);
    gl.uniform1i(progressiveUniforms.u_resetState, pass === 0 ? 1 : 0);
    gl.uniform2f(
      progressiveUniforms.u_subpixelJitter,
      SAMPLE_JITTERS[sampleIndex][0],
      SAMPLE_JITTERS[sampleIndex][1],
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();

    function pollStep() {
      if (myGen !== renderGen) {
        gl.deleteSync(sync);
        finishCancelled();
        return;
      }
      const status = gl.clientWaitSync(sync, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) {
        setTimeout(pollStep, 4);
        return;
      }
      gl.deleteSync(sync);
      const tmp = readState; readState = writeState; writeState = tmp;
      pass++;
      drawResolved(readState, true, null);
      gl.flush();
      const totalStep = sampleIndex * STEPS_PER_SAMPLE + pass;
      self.postMessage({
        type: 'renderProgress',
        progress: totalStep / (AA_SAMPLES * STEPS_PER_SAMPLE),
        step: pass,
        sample: sampleIndex + 1,
        samples: AA_SAMPLES,
      });

      if (pass >= STEPS_PER_SAMPLE) {
        finishCurrentSample();
      } else if (pass % ACTIVE_CHECK_INTERVAL === 0) {
        checkForActiveRays((hasActiveRays) => {
          if (hasActiveRays) setTimeout(submitNextStep, 0);
          else finishCurrentSample();
        });
      } else {
        setTimeout(submitNextStep, 0);
      }
    }
    setTimeout(pollStep, 4);
  }

  function checkForActiveRays(onResult) {
    const query = gl.createQuery();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(activeRayProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, readState.tex);
    gl.uniform1i(activeRayUniforms.u_state, 0);
    gl.colorMask(false, false, false, false);
    gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, query);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
    gl.colorMask(true, true, true, true);
    gl.flush();

    function pollQuery() {
      if (myGen !== renderGen) {
        gl.deleteQuery(query);
        finishCancelled();
        return;
      }
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
        setTimeout(pollQuery, 4);
        return;
      }
      const hasActiveRays = !!gl.getQueryParameter(query, gl.QUERY_RESULT);
      gl.deleteQuery(query);
      onResult(hasActiveRays);
    }
    setTimeout(pollQuery, 4);
  }

  function finishCurrentSample() {
    accumulateSample(readState);
    sampleIndex++;
    if (sampleIndex >= AA_SAMPLES) {
      finishSuccess();
      return;
    }
    pass = 0;
    setTimeout(submitNextStep, 0);
  }

  function finishCancelled() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    progressiveRendering = false;
    if (pendingOffset) {
      currentOffset = pendingOffset;
      pendingOffset = null;
      renderFractalToFBO();
    }
  }

  function finishSuccess() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    progressiveRendering = false;
    if (myGen !== renderGen) { finishCancelled(); return; }

    // Convert the float state texture into the regular display/cache FBO.
    drawResolved(readState, false, fboB.fbo);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const tmp = fboA; fboA = fboB; fboB = tmp;
    fboAValid = true;
    drawDisplay(0.0, 0.0);
    gl.flush();
    self.postMessage({ type: 'renderDone' });

    if (wasInitialRender) {
      setTimeout(() => {
        if (myGen !== renderGen || !fboAValid) return;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboA.fbo);
        const pixels = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        self.postMessage({ type: 'cacheFBO', pixels: pixels.buffer, w, h }, [pixels.buffer]);
      }, 0);
    }

    if (pendingOffset) {
      currentOffset = pendingOffset;
      pendingOffset = null;
      renderFractalToFBO();
    }
  }

  submitNextStep();
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

    if (!gl.getExtension('EXT_color_buffer_float')) {
      self.postMessage({ type: 'initError', reason: 'Floating-point render targets are unavailable' });
      return;
    }

    progressiveProg = FC.buildProgram(gl, FC.VERT_SRC, FC.FRAG_SRC_PROGRESSIVE);
    accumulateProg = FC.buildProgram(gl, FC.VERT_SRC, FC.ACCUMULATE_FRAG_SRC);
    activeRayProg = FC.buildProgram(gl, FC.VERT_SRC, FC.ACTIVE_RAY_FRAG_SRC);
    resolveProg = FC.buildProgram(gl, FC.VERT_SRC, FC.PROGRESSIVE_RESOLVE_FRAG_SRC);
    displayProg = FC.buildProgram(gl, FC.VERT_SRC, FC.DISPLAY_FRAG_SRC);
    if (!progressiveProg || !accumulateProg || !activeRayProg || !resolveProg || !displayProg) {
      self.postMessage({ type: 'initError', reason: 'Shader compilation failed' });
      return;
    }

    progressiveUniforms = FC.cacheFractalUniforms(gl, progressiveProg);
    progressiveUniforms.u_state = gl.getUniformLocation(progressiveProg, 'u_state');
    progressiveUniforms.u_resetState = gl.getUniformLocation(progressiveProg, 'u_resetState');
    progressiveUniforms.u_subpixelJitter = gl.getUniformLocation(progressiveProg, 'u_subpixelJitter');
    accumulateUniforms.u_sampleState = gl.getUniformLocation(accumulateProg, 'u_sampleState');
    activeRayUniforms.u_state = gl.getUniformLocation(activeRayProg, 'u_state');
    resolveUniforms.u_accum = gl.getUniformLocation(resolveProg, 'u_accum');
    resolveUniforms.u_currentState = gl.getUniformLocation(resolveProg, 'u_currentState');
    resolveUniforms.u_includeCurrent = gl.getUniformLocation(resolveProg, 'u_includeCurrent');
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
    renderFractalToFBO();

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
