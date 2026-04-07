// fractal-bg.js
// 主线程桥接层：把 canvas 转移给 Web Worker，自身只转发鼠标事件
// 所有 WebGL / 分形计算均在 fractal-worker.js 中的 Worker 线程完成

const FractalBG = (() => {

  let worker = null;

  function getDrawSize() {
    const dpr = window.devicePixelRatio || 1;
    return [
      Math.floor(window.innerWidth  * dpr),
      Math.floor(window.innerHeight * dpr),
    ];
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

      // 当分形 canvas 离开视口时隐藏 HUD
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

  return {
    init(targetId = 'fractalCanvas') {
      const canvas = document.getElementById(targetId);
      if (!canvas) {
        console.warn('FractalBG: canvas not found, id =', targetId);
        return false;
      }

      if (!canvas.transferControlToOffscreen) {
        console.warn('FractalBG: OffscreenCanvas not supported in this browser');
        canvas.style.display = 'none';
        return false;
      }

      hud.init(canvas);

      // 把 canvas 控制权完整转移给 worker（主线程之后无法再操作其渲染上下文）
      const offscreen = canvas.transferControlToOffscreen();
      const [w, h] = getDrawSize();

      // CSS 尺寸仍由主线程管理
      canvas.style.width  = window.innerWidth  + 'px';
      canvas.style.height = window.innerHeight + 'px';

      worker = new Worker('fractal-worker.js');
      worker.postMessage({ type: 'init', canvas: offscreen, w, h }, [offscreen]);

      // 初始渲染：页面加载后立即触发一次
      worker.postMessage({ type: 'mouseenter' });

      // ── Worker → 主线程消息 ──────────────────────────────────
      worker.onmessage = (e) => {
        if (e.data.type === 'renderDone') hud.setComputing(false);
      };

      // ── 窗口尺寸变化 ─────────────────────────────────────────
      window.addEventListener('resize', () => {
        const [nw, nh] = getDrawSize();
        canvas.style.width  = window.innerWidth  + 'px';
        canvas.style.height = window.innerHeight + 'px';
        worker.postMessage({ type: 'resize', w: nw, h: nh });
      });

      // ── 鼠标移动：在整个 hero 区域内都显示坐标（不被前景文字遮挡）
      const heroSection = canvas.closest('.hero') || canvas.parentElement;
      heroSection.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const nx = (e.clientX - rect.left) / rect.width;
        const ny = (e.clientY - rect.top)  / rect.height;
        hud.showCoords(nx, ny);
      });

      heroSection.addEventListener('mouseleave', () => hud.hideCoords());

      // ── 全局点击事件：仅当点击位于背景 canvas 内时更新分形 ──
      document.addEventListener('click', (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX, y = e.clientY;
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
        hud.setComputing(true);
        worker.postMessage({
          type: 'click',
          nx: (x - rect.left) / rect.width,
          ny: (y - rect.top)  / rect.height,
        });
      });


      return true;
    },

    stop() {
      if (worker) { worker.terminate(); worker = null; }
    },
  };
})();
