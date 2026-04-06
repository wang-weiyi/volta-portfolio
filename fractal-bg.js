// fractal-bg.js
// Main thread bridge: transfers canvas to worker, forwards mouse events with throttling
// All WebGL / fractal computation runs in worker thread.

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

      const offscreen = canvas.transferControlToOffscreen();
      const [w, h] = getDrawSize();

      canvas.style.width  = window.innerWidth  + 'px';
      canvas.style.height = window.innerHeight + 'px';

      worker = new Worker('fractal-worker.js');
      worker.postMessage({ type: 'init', canvas: offscreen, w, h }, [offscreen]);

      // ── Resize ─────────────────────────────────────────────────────────
      window.addEventListener('resize', () => {
        const [nw, nh] = getDrawSize();
        canvas.style.width  = window.innerWidth  + 'px';
        canvas.style.height = window.innerHeight + 'px';
        worker.postMessage({ type: 'resize', w: nw, h: nh });
      });

      // ── Mouse events with throttling (avoid flooding worker) ───────────
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
        pendingMove = false; // reset just in case
      });

      return true;
    },

    stop() {
      if (worker) { worker.terminate(); worker = null; }
    },
  };
})();