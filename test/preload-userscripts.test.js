// A parte do preload que roda os scripts de usuário (src/preload/game.js): hora de cada @run-at, mundo isolado
// só para os que usam GM_*, ponte estreita por script e nada de pedido no login do Google.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../src/preload/game.js'), 'utf8');

function load({ plan, host = 'pokeidle.io', readyState = 'loading', failPlan = false }) {
  const log = { sync: [], send: [], invoke: [], exposed: [], isolated: [], main: [], timers: [] };
  const listeners = [];
  const electron = {
    webFrame: {
      executeJavaScript: (code) => (log.main.push(code), Promise.resolve()),
      executeJavaScriptInIsolatedWorld: (world, scripts) => (log.isolated.push([world, scripts[0].code]), Promise.resolve()),
      setIsolatedWorldInfo() {},
    },
    ipcRenderer: {
      sendSync: (ch, ...a) => {
        log.sync.push([ch, ...a]);
        if (failPlan) throw new Error('sem main');
        return plan;
      },
      send: (...a) => log.send.push(a),
      invoke: (...a) => (log.invoke.push(a), Promise.resolve({ ok: 1 })),
    },
    contextBridge: { exposeInIsolatedWorld: (world, key, api) => log.exposed.push([world, key, api]) },
  };
  const document = { readyState, addEventListener: (type, fn) => listeners.push([type, fn]) };
  const run = new Function('require', 'document', 'location', 'setTimeout', SRC);
  run((n) => (assert.equal(n, 'electron'), electron), document, { hostname: host }, (fn) => log.timers.push(fn));
  const mainBefore = log.main.length; // o patch da página (sempre visível etc.) já foi
  return { log, mainBefore, domReady: () => listeners.filter(([t]) => t === 'DOMContentLoaded').forEach(([, fn]) => fn()), flush: () => log.timers.splice(0).forEach((f) => f()) };
}

const S = (over) => ({ id: 'abc', name: 'Meu script', mode: 'isolated', runAt: 'document-idle', world: 1000, code: 'CODE-ISOLADO', ...over });

test('pede o plano à página principal e não faz nada se vier vazio', () => {
  const p = load({ plan: [] });
  assert.deepEqual(p.log.sync, [['us:plan']]);
  assert.equal(p.log.isolated.length + p.log.exposed.length, 0);
  assert.equal(p.log.main.length, p.mainBefore);
});

test('sem resposta do processo principal, a página segue normalmente', () => {
  const p = load({ plan: [], failPlan: true });
  assert.equal(p.log.main.length, p.mainBefore);
  const q = load({ plan: 'lixo' });
  assert.equal(q.log.isolated.length, 0);
});

test('no login do Google nem o pedido é feito', () => {
  for (const host of ['accounts.google.com', 'accounts.youtube.com']) {
    const p = load({ plan: [S()], host });
    assert.deepEqual(p.log.sync, []);
    assert.equal(p.log.isolated.length, 0);
  }
});

test('script com GM_* roda num mundo isolado, com ponte própria e só lá', () => {
  const p = load({ plan: [S({ id: 'a', world: 1000 }), S({ id: 'b', world: 1001, code: 'OUTRO' })], readyState: 'complete' });
  p.flush();
  assert.deepEqual(p.log.exposed.map(([w, k]) => [w, k]), [[1000, 'idleHubGM'], [1001, 'idleHubGM']]);
  assert.deepEqual(p.log.isolated, [[1000, 'CODE-ISOLADO'], [1001, 'OUTRO']]);
  assert.equal(p.log.main.length, p.mainBefore, 'nada disso vai para o mundo da página');

  // cada ponte fala só em nome do próprio script, e só tem estas funções
  const [, , bridgeA] = p.log.exposed[0];
  const [, , bridgeB] = p.log.exposed[1];
  assert.deepEqual(Object.keys(bridgeA).sort(), ['abort', 'del', 'notify', 'set', 'xhr']);
  bridgeA.set('k', 5);
  bridgeA.del('k');
  bridgeB.notify({ text: 'oi' });
  bridgeB.abort(7);
  bridgeA.xhr('r1', { url: 'https://api.exemplo.com/' });
  assert.deepEqual(p.log.send, [['us:set', 'a', 'k', '5'], ['us:del', 'a', 'k'], ['us:notify', 'b', { text: 'oi' }], ['us:abort', 'b', '7']]);
  assert.deepEqual(p.log.invoke, [['us:xhr', 'a', 'r1', { url: 'https://api.exemplo.com/' }]]);
});

test('script @grant none roda no mundo da página, sem ponte', () => {
  const p = load({ plan: [S({ mode: 'main', code: 'CODE-MAIN' })], readyState: 'complete' });
  p.flush();
  assert.deepEqual(p.log.main.slice(p.mainBefore), ['CODE-MAIN']);
  assert.equal(p.log.exposed.length, 0);
  assert.equal(p.log.isolated.length, 0);
});

test('@run-at: start na hora; end ao terminar de ler; idle um instante depois', () => {
  const p = load({ plan: [S({ id: 's', runAt: 'document-start', code: 'START', world: 1000 }), S({ id: 'e', runAt: 'document-end', code: 'END', world: 1001 }), S({ id: 'b', runAt: 'document-body', code: 'BODY', world: 1002 }), S({ id: 'i', runAt: 'document-idle', code: 'IDLE', world: 1003 })] });
  assert.deepEqual(p.log.isolated.map((x) => x[1]), ['START'], 'document-start roda antes de a página ler o HTML');
  p.domReady();
  assert.deepEqual(p.log.isolated.map((x) => x[1]), ['START', 'END', 'BODY']);
  p.flush();
  assert.deepEqual(p.log.isolated.map((x) => x[1]), ['START', 'END', 'BODY', 'IDLE']);
});

test('os scripts rodam um por vez; o que dá erro avisa o processo principal', async () => {
  const p = load({ plan: [S({ id: 'x', mode: 'main', code: 'RUIM' }), S({ id: 'y', mode: 'main', code: 'BOM' })], readyState: 'complete' });
  p.flush();
  assert.deepEqual(p.log.main.slice(p.mainBefore), ['RUIM', 'BOM']);

  // executeJavaScript que rejeita: vai para 'us:error'
  const log = { send: [] };
  const electron = {
    webFrame: { executeJavaScript: (c) => (c === 'RUIM' ? Promise.reject(new Error('x is not defined')) : Promise.resolve()) },
    ipcRenderer: { sendSync: () => [S({ id: 'x', mode: 'main', code: 'RUIM' })], send: (...a) => log.send.push(a) },
  };
  new Function('require', 'document', 'location', 'setTimeout', SRC)(() => electron, { readyState: 'complete', addEventListener() {} }, { hostname: 'pokeidle.io' }, (fn) => fn());
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(log.send, [['us:error', 'x', 'x is not defined']]);
});
