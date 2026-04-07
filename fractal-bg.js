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

      // ── 窗口尺寸变化 ─────────────────────────────────────────
      window.addEventListener('resize', () => {
        const [nw, nh] = getDrawSize();
        canvas.style.width  = window.innerWidth  + 'px';
        canvas.style.height = window.innerHeight + 'px';
        worker.postMessage({ type: 'resize', w: nw, h: nh });
      });

      // ── 全局点击事件：仅当点击位于背景 canvas 内时更新分形 ──
      document.addEventListener('click', (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX, y = e.clientY;
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
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
