// fractal-bg.js
// 主线程桥接层：优先使用 OffscreenCanvas + Worker，不支持时回退到主线程 WebGL2 渲染
// 着色器 & GL 工具函数来自 fractal-core.js

const FractalBG = (() => {

  let worker = null;
  let _replayIntro = null;

  function getDrawSize(scale) {
    const dpr = (window.devicePixelRatio || 1) * (scale || 1);
    return [
      Math.floor(window.innerWidth  * dpr),
      Math.floor(window.innerHeight * dpr),
    ];
  }

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
    computing: null,

    init(canvas) {
      this.el        = document.getElementById('fractalHUD');
      this.coords    = document.getElementById('fractalCoords');
      this.xEl       = document.getElementById('fractalX');
      this.yEl       = document.getElementById('fractalY');
      this.hint      = document.getElementById('fractalHint');
      this.computing = document.getElementById('fractalComputing');

      if (this.el && typeof IntersectionObserver !== 'undefined') {
        new IntersectionObserver(([entry]) => {
          this.el.style.display = entry.isIntersecting ? '' : 'none';
        }, { threshold: 0 }).observe(canvas);
      }
    },

    showCoords(nx, ny) {
      if (!this.coords) return;
      this.xEl.textContent = 'x: ' + nx.toFixed(3);
      this.yEl.textContent = 'y: ' + ny.toFixed(3);
      this.coords.style.opacity = '1';
    },

    hideCoords() {
      if (this.coords) this.coords.style.opacity = '0';
    },

    setComputing(active) {
      if (!this.computing || !this.hint) return;
      if (active) {
        this.hint.style.opacity = '0';
        this.computing.style.display = 'flex';
      } else {
        this.hint.style.opacity = '1';
        this.computing.style.display = 'none';
      }
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
      hud.showCoords(nx, ny);
    });
    heroSection.addEventListener('mouseleave', () => hud.hideCoords());

    heroSection.addEventListener('touchmove', (e) => {
      const touch = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      const nx = (touch.clientX - rect.left) / rect.width;
      const ny = (touch.clientY - rect.top)  / rect.height;
      hud.showCoords(nx, ny);
    }, { passive: true });
    heroSection.addEventListener('touchend', () => hud.hideCoords());

    document.addEventListener('click', onClick);
  }

  function makeClickHandler(canvas, onClickAction) {
    return (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX, y = e.clientY;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
      hud.setComputing(true);
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
  function initWorkerPath(canvas) {
    const offscreen = canvas.transferControlToOffscreen();
    const [w, h] = getDrawSize();

    canvas.style.width  = window.innerWidth  + 'px';
    canvas.style.height = window.innerHeight + 'px';

    worker = new Worker('fractal-worker.js');
    worker.postMessage({ type: 'init', canvas: offscreen, w, h }, [offscreen]);

    let initResolved = false;
    let eventsWired = false;

    // 超时：Worker 3 秒内没回报 → 降级
    const timeout = setTimeout(() => {
      if (!initResolved) {
        initResolved = true;
        console.warn('FractalBG: Worker init timeout, falling back to main thread');
        worker.terminate(); worker = null;
        fallbackToMainThread(canvas);
      }
    }, 3000);

    worker.onmessage = (e) => {
      if (e.data.type === 'initOK' && !initResolved) {
        initResolved = true;
        clearTimeout(timeout);
        // Worker 初始化成功，触发首次渲染并绑定事件
        worker.postMessage({ type: 'mouseenter' });
        if (!eventsWired) {
          eventsWired = true;
          wireEvents(canvas,
            () => {
              const [nw, nh] = getDrawSize();
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
        fallbackToMainThread(canvas);
      } else if (e.data.type === 'renderDone') {
        hud.setComputing(false);
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

  function fallbackToMainThread(oldCanvas) {
    console.info('FractalBG: using main-thread WebGL2 fallback');
    // canvas 的控制权已转移给 Worker，需要创建新 canvas
    const newCanvas = replaceCanvas(oldCanvas);
    hud.init(newCanvas);
    initMainThreadPath(newCanvas);
  }

  // ================================================================
  // PATH B — Main-thread WebGL2 fallback (mobile / old browsers)
  // ================================================================
  function initMainThreadPath(canvas) {
    const FC = FractalCore;

    // 移动端大幅降低渲染分辨率，配合 LITE 着色器避免 GPU 超时
    const RES_SCALE = 0.35;
    const MOUSE_STRENGTH = 0.285;
    const TRANSITION_MS  = 1800;

    let gl, fractalProg, displayProg;
    let fractalUniforms = {}, displayUniforms = {};
    let fboA = null, fboB = null;
    let fboAValid = false;
    let currentOffset = [0, 0];
    let isTransitioning = false;
    let transitionStart = 0;
    let transitionRAF = null;

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
      gl.uniform1f(displayUniforms.u_transition, t);
      gl.uniform1f(displayUniforms.u_intro, intro || 0.0);
      gl.uniform2f(displayUniforms.u_resolution, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function playIntroAnim() {
      const introStart = performance.now();
      function introTick() {
        const p = Math.min((performance.now() - introStart) / TRANSITION_MS, 1.0);
        drawDisplay(0.0, 1.0 - p);
        if (p < 1.0) requestAnimationFrame(introTick);
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
        playIntroAnim();
      } else {
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
          } else {
            transitionRAF = requestAnimationFrame(tick);
          }
        }
        transitionRAF = requestAnimationFrame(tick);
      }

      hud.setComputing(false);
    }

    renderFractal();

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

    _replayIntro = playIntroAnim;
    return true;
  }

  // ================================================================
  // Public API
  // ================================================================
  return {
    init(targetId = 'fractalCanvas') {
      const canvas = document.getElementById(targetId);
      if (!canvas) {
        console.warn('FractalBG: canvas not found, id =', targetId);
        return false;
      }

      hud.init(canvas);

      // debug replay button
      const btn = document.createElement('button');
      btn.textContent = 'Replay Intro';
      btn.style.cssText = 'position:absolute;top:12px;right:12px;z-index:10;padding:6px 14px;font-size:12px;background:rgba(0,0,0,.55);color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:6px;cursor:pointer;backdrop-filter:blur(6px)';
      btn.addEventListener('click', () => this.replayIntro());
      canvas.parentElement.appendChild(btn);

      // 移动端 / 触屏设备：跳过 Worker，直接主线程渲染
      // Worker + OffscreenCanvas WebGL2 在移动端即使初始化成功，实际渲染也可能静默失败
      const isMobile = navigator.maxTouchPoints > 1;

      if (!isMobile && canvas.transferControlToOffscreen && canWorkerRender()) {
        try {
          initWorkerPath(canvas);
          return true;
        } catch (err) {
          console.warn('FractalBG: Worker path threw:', err);
        }
      }

      if (isMobile) console.info('FractalBG: mobile detected, using main-thread rendering');
      else console.info('FractalBG: using main-thread WebGL2 fallback');
      return initMainThreadPath(canvas);
    },

    replayIntro() {
      if (worker) worker.postMessage({ type: 'replayIntro' });
      else if (_replayIntro) _replayIntro();
    },

    stop() {
      if (worker) { worker.terminate(); worker = null; }
    },
  };
})();
