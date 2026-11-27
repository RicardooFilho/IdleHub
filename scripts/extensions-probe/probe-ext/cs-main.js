// Content script em world MAIN: roda no mesmo mundo do jogo (como a /hunt faz).
window.__probeMain = true;
console.log('PROBE ' + JSON.stringify({ where: 'cs-main', k: 'rodou', v: { chrome: typeof chrome, hidden: document.hidden, readyState: document.readyState } }));
