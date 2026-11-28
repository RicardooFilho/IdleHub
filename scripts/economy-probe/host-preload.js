// Preload da janela da sonda no modo "textura": recebe os quadros das contas (desenhadas fora da tela)
// e pinta cada um no seu canvas, como a interface do app faria. O mundo isolado enxerga o DOM da página.
const { sharedTexture } = require('electron');

const canvases = new Map();
const canvasFor = (i) => {
  if (!canvases.has(i)) {
    const c = document.createElement('canvas');
    c.style.cssText = 'position:absolute;outline:1px solid #222';
    document.body.appendChild(c);
    canvases.set(i, c);
  }
  return canvases.get(i);
};

window.addEventListener('message', (e) => {
  // Posição de cada conta, mandada pelo main.js (executeJavaScript -> postMessage).
  if (!e.data || e.data.type !== 'tiles') return;
  for (const t of e.data.tiles) {
    const c = canvasFor(t.i);
    Object.assign(c.style, { left: `${t.x}px`, top: `${t.y}px`, width: `${t.width}px`, height: `${t.height}px` });
  }
});

let drawn = 0;
sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture: tex }, i) => {
  try {
    const frame = tex.getVideoFrame();
    const c = canvasFor(i);
    if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
      c.width = frame.displayWidth;
      c.height = frame.displayHeight;
    }
    c.getContext('2d').drawImage(frame, 0, 0);
    frame.close();
    drawn++;
  } finally {
    tex.release();
  }
});
window.addEventListener('DOMContentLoaded', () => {
  document.body.dataset.ready = '1';
});
// Contador de quadros pintados, lido pelo main.js no fim.
setInterval(() => {
  document.documentElement.dataset.drawn = String(drawn);
}, 500);
