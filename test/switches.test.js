const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// As chaves do Chromium ficam no main.js (precisam vir antes do app abrir), então o teste lê o arquivo.
const src = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');

test('os jogos continuam rodando com a janela escondida, minimizada ou coberta', () => {
  for (const k of ['disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) {
    assert.ok(src.includes(`appendSwitch('${k}')`), k);
  }
});

test('a bandeja minimiza a janela em vez de esconder (escondida, o Chromium segue desenhando as contas)', () => {
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/\bwin\.hide\(\)/.test(code), 'win.hide() voltou');
  const fn = src.match(/function hideToTray\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'hideToTray');
  assert.ok(fn[0].includes('setSkipTaskbar(true)') && fn[0].includes('win.minimize()'));
  assert.ok(/function showWindow\(\) \{[\s\S]*?setSkipTaskbar\(false\)/.test(src), 'showWindow devolve o botão da barra de tarefas');
});

test('o app desenha a no máximo ~60 quadros/s, mesmo em monitor de 240 Hz', () => {
  const m = src.match(/appendSwitch\('fake-vsync-rate', '(\d+)'\)/);
  assert.ok(m, 'fake-vsync-rate');
  // Abaixo de ~64 o mosaico não chega aos 30 quadros/s (o Chromium entrega ~6% menos que o pedido).
  assert.ok(Number(m[1]) >= 64 && Number(m[1]) <= 75, m[1]);
});
