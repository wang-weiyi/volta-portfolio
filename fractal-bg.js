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

      // 把 canvas 控制权完整转移给 worker
      const offscreen = canvas.transferControlToOffscreen();
      const [w, h] = getDrawSize();

      // CSS 尺寸仍由主线程管理
      canvas.style.width  = window.innerWidth  + 'px';
      canvas.style.height = window.innerHeight + 'px';

      worker = new Worker('fractal-worker.js');
      worker.postMessage({ type: 'init', canvas: offscreen, w, h }, [offscreen]);

      // ── 窗口尺寸变化 ─────────────────────────────────────────
      window.addEventListener('resize', () => {
        const [nw, nh] = getDrawSize();
        canvas.style.width  = window.innerWidth  + 'px';
        canvas.style.height = window.innerHeight + 'px';
        worker.postMessage({ type: 'resize', w: nw, h: nh });
      });

      // ── 鼠标事件：加一个简单的节流，避免高频消息 ──
      let pendingMove = false;
      canvas.addEventListener('mouseenter', () => {
        worker.postMessage({ type: 'mouseenter' });
      });

      canvas.addEventListener('mousemove', (e) => {
        if (pendingMove) return;
        pendingMove = true;
        requestAnimationFrame(() => {
          const rect = canvas.getBoundingClientRect();
          worker.postMessage({
            type: 'mousemove',
            nx: (e.clientX - rect.left) / rect.width,
            ny: (e.clientY - rect.top)  / rect.height,
          });
          pendingMove = false;
        });
      });

      canvas.addEventListener('mouseleave', () => {
        worker.postMessage({ type: 'mouseleave' });
        pendingMove = false;
      });

      return true;
    },

    stop() {
      if (worker) { worker.terminate(); worker = null; }
    },
  };
})();