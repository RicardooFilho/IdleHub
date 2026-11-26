// Preload das páginas dos jogos. Não expõe nada para a página; só injeta,
// antes dos scripts do jogo:
//  1) "sempre visível": o jogo não pausa quando a conta está escondida;
//  2) limitador de FPS controlado pelo painel (economiza CPU/GPU).
const { webFrame } = require('electron');

function patch() {
  if (window.__idleHub) return;
  window.__idleHub = true;

  try {
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'visible' });
    Document.prototype.hasFocus = function () {
      return true;
    };
  } catch (e) {}
  document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);

  let fps = 0;
  let lastFrame = -1e9;
  let frameT = -1;
  let seq = 0;
  const ids = new Map();
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);

  window.requestAnimationFrame = function (cb) {
    const id = ++seq;
    const tick = (t) => {
      if (!fps || t === frameT || t - lastFrame >= 1000 / fps - 2) {
        if (t !== frameT) {
          frameT = t;
          lastFrame = t;
        }
        ids.delete(id);
        cb(t);
      } else {
        ids.set(id, raf(tick));
      }
    };
    ids.set(id, raf(tick));
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    const real = ids.get(id);
    if (real !== undefined) {
      caf(real);
      ids.delete(id);
    }
  };
  window.__idleHubSetFps = (n) => {
    fps = Math.max(0, Number(n) || 0);
  };
}

webFrame.executeJavaScript(`(${patch.toString()})()`).catch(() => {});
