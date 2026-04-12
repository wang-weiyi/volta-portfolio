// fractal-bg.js
// 主线程桥接层：优先使用 OffscreenCanvas + Worker，不支持时回退到主线程 WebGL2 渲染
// 着色器 & GL 工具函数来自 fractal-core.js

const FractalBG = (() => {

  let worker = null;

  function getDrawSize(scale) {
    const dpr = (window.devicePixelRatio || 1) * (scale || 1);
    return [
      Math.floor(window.innerWidth  * dpr),
      Math.floor(window.innerHeight * dpr),
    ];
  }

  // ── 分形 FBO 原始像素缓存 (IndexedDB) ──────────────────────
  const fractalCache = {
    DB: 'FractalBGCache',
    STORE: 'fbo',
    KEY: 'initial',

    _open() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(this.DB, 2);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          // 清理旧版 store
          if (db.objectStoreNames.contains('images')) db.deleteObjectStore('images');
          if (!db.objectStoreNames.contains(this.STORE)) db.createObjectStore(this.STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },

    /** 加载缓存的 FBO 像素 → { pixels: ArrayBuffer, w, h } | null */
    async load() {
      try {
        const db = await this._open();
        const data = await new Promise(resolve => {
          const tx = db.transaction(this.STORE, 'readonly');
          const req = tx.objectStore(this.STORE).get(this.KEY);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        });
        if (!data || !data.pixels) return null;
        // 解压（如果需要）
        if (data.compressed && typeof DecompressionStream !== 'undefined') {
          const stream = new Blob([data.pixels]).stream().pipeThrough(new DecompressionStream('gzip'));
          data.pixels = await new Response(stream).arrayBuffer();
        }
        return data;
      } catch { return null; }
    },

    /** 保存 FBO 像素 { pixels: ArrayBuffer, w, h } */
    async save(data) {
      try {
        const db = await this._open();
        let stored = { pixels: data.pixels, w: data.w, h: data.h, compressed: false };
        // 尝试 gzip 压缩（33MB → ~5MB）
        if (typeof CompressionStream !== 'undefined') {
          const stream = new Blob([data.pixels]).stream().pipeThrough(new CompressionStream('gzip'));
          stored.pixels = await new Response(stream).arrayBuffer();
          stored.compressed = true;
        }
        const tx = db.transaction(this.STORE, 'readwrite');
        tx.objectStore(this.STORE).put(stored, this.KEY);
      } catch (e) { console.warn('FractalCache: save failed', e); }
    },
  };

  // 在主线程测试 OffscreenCanvas + WebGL2 是否真正可用
  function canWorkerRender() {
    try {
      if (typeof OffscreenCanvas === 'undefined') return false;
      const c = new OffscreenCanvas(1, 1);
      const gl = c.getContext('webgl2');
      if (!gl) return false;
      // 测试 #version 300 es 着色器能否编译
      const s = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(s, '#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main(){o=vec4(1);}');
      gl.compileShader(s);
      const ok = gl.getShaderParameter(s, gl.COMPILE_STATUS);
      gl.deleteShader(s);
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
      return ok;
    } catch (e) {
      return false;
    }
  }

  // ── HUD helpers ───────────────────────────────────────────
  const hud = {
    el:        null,
    coords:    null,
    xEl:       null,
    yEl:       null,
    hint:      null,
    overlay:   null,

    init() {
      this.el        = document.getElementById('fractalHUD');
      this.xEl       = document.getElementById('fractalX');
      this.yEl       = document.getElementById('fractalY');
      this.hint      = document.getElementById('fractalHint');
      this.overlay   = document.getElementById('fractalLoadingOverlay');
    },

    showCoords(nx, ny, clientX, clientY, canvasRect) {
      if (!this.el) return;
      this.xEl.textContent = 'x: ' + nx.toFixed(3);
      this.yEl.textContent = 'y: ' + ny.toFixed(3);
      this.el.style.left = (clientX - canvasRect.left) + 'px';
      this.el.style.top  = (clientY - canvasRect.top)  + 'px';
      this.el.classList.add('visible');
    },

    hideCoords() {
      if (this.el) this.el.classList.remove('visible');
    },

    startLoading() {
      if (!this.overlay) return;
      this.overlay.innerHTML =
        '<div class="pm-scene"><div class="pm-monster"></div>' +
        '<div class="pm-dots"><i></i><i></i><i></i><i></i></div></div>';
      this.overlay.classList.add('active');
      if (this.hint) this.hint.style.opacity = '0';
    },

    stopLoading() {
      if (!this.overlay) return;
      this.overlay.classList.remove('active');
      setTimeout(() => {
        if (!this.overlay.classList.contains('active')) this.overlay.innerHTML = '';
      }, 350);
      if (this.hint) this.hint.style.opacity = '1';
    },

    setComputing(active) {
      if (active) return;
      this.stopLoading();
    },
  };

  // ── Shared event wiring ─────────────────────────────────────
  function wireEvents(canvas, onResize, onClick) {
    window.addEventListener('resize', onResize);

    const heroSection = canvas.closest('.hero') || canvas.parentElement;
    heroSection.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top)  / rect.height;
      hud.showCoords(nx, ny, e.clientX, e.clientY, rect);
    });
    heroSection.addEventListener('mouseleave', () => hud.hideCoords());

    heroSection.addEventListener('touchmove', (e) => {
      const touch = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      const nx = (touch.clientX - rect.left) / rect.width;
      const ny = (touch.clientY - rect.top)  / rect.height;
      hud.showCoords(nx, ny, touch.clientX, touch.clientY, rect);
    }, { passive: true });
    heroSection.addEventListener('touchend', () => hud.hideCoords());

    document.addEventListener('click', onClick);
  }

  function makeClickHandler(canvas, onClickAction) {
    return (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX, y = e.clientY;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
      hud.startLoading();
      onClickAction(
        (x - rect.left) / rect.width,
        (y - rect.top)  / rect.height,
      );
    };
  }

  // ── 替换已被 transferControlToOffscreen 占用的 canvas ──────
  function replaceCanvas(oldCanvas) {
    const newCanvas = document.createElement('canvas');
    newCanvas.id = oldCanvas.id;
    newCanvas.className = oldCanvas.className;
    newCanvas.style.cssText = oldCanvas.style.cssText;
    oldCanvas.parentNode.replaceChild(newCanvas, oldCanvas);
    return newCanvas;
  }

  // ================================================================
  // PATH A — OffscreenCanvas + Worker (desktop / modern browsers)
  // ================================================================
  function initWorkerPath(canvas, cachedFBO) {
    const RES_SCALE = 1.0;
    const offscreen = canvas.transferControlToOffscreen();
    const [w, h] = getDrawSize(RES_SCALE);

    canvas.style.width  = window.innerWidth  + 'px';
    canvas.style.height = window.innerHeight + 'px';

    worker = new Worker('fractal-worker.js');
    worker.postMessage({ type: 'init', canvas: offscreen, w, h }, [offscreen]);

    let initResolved = false;
    let eventsWired = false;

    const timeout = setTimeout(() => {
      if (!initResolved) {
        initResolved = true;
        console.warn('FractalBG: Worker init timeout, falling back to main thread');
        worker.terminate(); worker = null;
        fallbackToMainThread(canvas, cachedFBO);
      }
    }, 3000);

    worker.onmessage = (e) => {
      if (e.data.type === 'initOK' && !initResolved) {
        initResolved = true;
        clearTimeout(timeout);
        // 有缓存 → 上传像素到 FBO，跳过 GPU 分形计算
        if (cachedFBO && cachedFBO.w === w && cachedFBO.h === h) {
          worker.postMessage(
            { type: 'loadCache', pixels: cachedFBO.pixels, w: cachedFBO.w, h: cachedFBO.h },
            [cachedFBO.pixels],
          );
          cachedFBO = null;
        } else {
          worker.postMessage({ type: 'mouseenter' });
        }
        if (!eventsWired) {
          eventsWired = true;
          wireEvents(canvas,
            () => {
              const [nw, nh] = getDrawSize(RES_SCALE);
              canvas.style.width  = window.innerWidth  + 'px';
              canvas.style.height = window.innerHeight + 'px';
              worker.postMessage({ type: 'resize', w: nw, h: nh });
            },
            makeClickHandler(canvas, (nx, ny) => {
              worker.postMessage({ type: 'click', nx, ny });
            }),
          );
        }
      } else if (e.data.type === 'initError' && !initResolved) {
        initResolved = true;
        clearTimeout(timeout);
        console.warn('FractalBG: Worker init failed:', e.data.reason, '— falling back');
        worker.terminate(); worker = null;
        fallbackToMainThread(canvas, cachedFBO);
      } else if (e.data.type === 'renderDone') {
        hud.setComputing(false);
      } else if (e.data.type === 'cacheFBO') {
        fractalCache.save({ pixels: e.data.pixels, w: e.data.w, h: e.data.h });
      }
    };

    worker.onerror = (err) => {
      if (!initResolved) {
        initResolved = true;
        clearTimeout(timeout);
        console.warn('FractalBG: Worker error:', err.message, '— falling back');
        worker.terminate(); worker = null;
        fallbackToMainThread(canvas);
      }
    };
  }

  function fallbackToMainThread(oldCanvas, cachedFBO) {
    console.info('FractalBG: using main-thread WebGL2 fallback');
    const newCanvas = replaceCanvas(oldCanvas);
    hud.init();
    initMainThreadPath(newCanvas, cachedFBO);
  }

  // ================================================================
  // PATH B — Main-thread WebGL2 fallback (mobile / old browsers)
  // ================================================================
  function initMainThreadPath(canvas, cachedFBO) {
    const FC = FractalCore;

    // 移动端大幅降低渲染分辨率，配合 LITE 着色器避免 GPU 超时
    const RES_SCALE = 0.35;
    const MOUSE_STRENGTH = 0.285;
    const INTRO_MS       = 1800;
    const TRANSITION_MS  = 3600;

    let gl, fractalProg, displayProg;
    let fractalUniforms = {}, displayUniforms = {};
    let fboA = null, fboB = null;
    let fboAValid = false;
    let currentOffset = [0, 0];
    let isTransitioning = false;
    let transitionStart = 0;
    let transitionRAF = null;
    let dispTexA = null, dispTexB = null;

    const SORT_THRESH_LO = 8;
    const SORT_THRESH_HI = 250;

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

    function applySize() {
      const [w, h] = getDrawSize(RES_SCALE);
      canvas.width  = w;
      canvas.height = h;
      canvas.style.width  = window.innerWidth  + 'px';
      canvas.style.height = window.innerHeight + 'px';
      if (gl) gl.viewport(0, 0, w, h);
      fboAValid = false;
    }

    applySize();

    gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'low-power' });
    if (!gl) {
      console.warn('FractalBG: WebGL2 not supported');
      canvas.style.display = 'none';
      return false;
    }

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('FractalBG: WebGL context lost');
      hud.setComputing(false);
    });

    fractalProg = FC.buildProgram(gl, FC.VERT_SRC, FC.FRAG_SRC_LITE);
    displayProg = FC.buildProgram(gl, FC.VERT_SRC, FC.DISPLAY_FRAG_SRC);
    if (!fractalProg || !displayProg) {
      console.warn('FractalBG: shader compilation failed');
      canvas.style.display = 'none';
      return false;
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

    /** 保存 FBO 像素到 IndexedDB */
    function saveFBOCache() {
      const w = canvas.width, h = canvas.height;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboA.fbo);
      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      fractalCache.save({ pixels: pixels.buffer, w, h });
    }

    /** 将缓存像素上传到 FBO texture（跳过 GPU 分形计算） */
    function uploadCacheToFBO(data) {
      const w = data.w, h = data.h;
      if (!fboA || fboA.w !== w || fboA.h !== h) {
        fboA = FC.makeFBO(gl, w, h);
        fboB = FC.makeFBO(gl, w, h);
      }
      // 上传到 fboA
      gl.bindTexture(gl.TEXTURE_2D, fboA.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(data.pixels));
      gl.bindTexture(gl.TEXTURE_2D, null);
      fboAValid = true;
    }

    /** 播放 intro 动画（通用，无论来源是缓存还是 GPU 计算） */
    function playIntro(onDone) {
      const dispA = buildDispFromFBO(fboA, canvas.width, canvas.height);
      dispTexA = uploadDispTex(dispTexA, dispA, canvas.width, canvas.height);
      if (!dispTexB) dispTexB = uploadDispTex(dispTexB, dispA, canvas.width, canvas.height);
      const introStart = performance.now();
      function introTick() {
        const p = Math.min((performance.now() - introStart) / INTRO_MS, 1.0);
        drawDisplay(0.0, 1.0 - p);
        if (p < 1.0) {
          requestAnimationFrame(introTick);
        } else if (onDone) {
          onDone();
        }
      }
      requestAnimationFrame(introTick);
    }

    function renderFractal() {
      const w = canvas.width, h = canvas.height;

      if (!fboA || fboA.w !== w || fboA.h !== h) {
        fboA = FC.makeFBO(gl, w, h);
        fboB = FC.makeFBO(gl, w, h);
        fboAValid = false;
      }

      if (isTransitioning) {
        isTransitioning = false;
        if (transitionRAF) { cancelAnimationFrame(transitionRAF); transitionRAF = null; }
        const tmp = fboA; fboA = fboB; fboB = tmp;
        const dtmp = dispTexA; dispTexA = dispTexB; dispTexB = dtmp;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, fboB.fbo);
      gl.viewport(0, 0, w, h);
      gl.useProgram(fractalProg);
      FC.setFractalUniforms(gl, fractalUniforms, currentOffset, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      if (!fboAValid) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fboB.fbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fboA.fbo);
        gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
        fboAValid = true;
        const tmp = fboA; fboA = fboB; fboB = tmp;
        playIntro(saveFBOCache);
      } else {
        const dispB = buildDispFromFBO(fboB, w, h);
        dispTexB = uploadDispTex(dispTexB, dispB, w, h);
        isTransitioning = true;
        transitionStart = performance.now();
        function tick() {
          if (!isTransitioning) return;
          const t = Math.min((performance.now() - transitionStart) / TRANSITION_MS, 1.0);
          drawDisplay(t);
          if (t >= 1.0) {
            isTransitioning = false;
            transitionRAF = null;
            const tmp = fboA; fboA = fboB; fboB = tmp;
            const dtmp = dispTexA; dispTexA = dispTexB; dispTexB = dtmp;
          } else {
            transitionRAF = requestAnimationFrame(tick);
          }
        }
        transitionRAF = requestAnimationFrame(tick);
      }

      hud.setComputing(false);
    }

    // 有缓存 → 直接上传到 FBO，播放 intro，跳过 GPU 分形计算
    if (cachedFBO && cachedFBO.w === canvas.width && cachedFBO.h === canvas.height) {
      uploadCacheToFBO(cachedFBO);
      playIntro(saveFBOCache);
      cachedFBO = null;
    } else {
      renderFractal();
    }

    wireEvents(canvas,
      () => {
        applySize();
        renderFractal();
      },
      makeClickHandler(canvas, (nx, ny) => {
        currentOffset[0] = (nx - 0.5) * MOUSE_STRENGTH;
        currentOffset[1] = (ny - 0.5) * MOUSE_STRENGTH;
        renderFractal();
      }),
    );

    return true;
  }

  // ================================================================
  // Public API
  // ================================================================
  return {
    async init(targetId = 'fractalCanvas') {
      const canvas = document.getElementById(targetId);
      if (!canvas) {
        console.warn('FractalBG: canvas not found, id =', targetId);
        return false;
      }

      hud.init();

      // 尝试从 IndexedDB 加载缓存的 FBO 像素
      const cachedFBO = await fractalCache.load();
      if (cachedFBO) console.info('FractalBG: cached FBO found (%dx%d)', cachedFBO.w, cachedFBO.h);

      const isMobile = navigator.maxTouchPoints > 1;

      if (!isMobile && canvas.transferControlToOffscreen && canWorkerRender()) {
        try {
          initWorkerPath(canvas, cachedFBO);
          return true;
        } catch (err) {
          console.warn('FractalBG: Worker path threw:', err);
        }
      }

      if (isMobile) console.info('FractalBG: mobile detected, using main-thread rendering');
      else console.info('FractalBG: using main-thread WebGL2 fallback');
      return initMainThreadPath(canvas, cachedFBO);
    },

    stop() {
      if (worker) { worker.terminate(); worker = null; }
    },
  };
})();
