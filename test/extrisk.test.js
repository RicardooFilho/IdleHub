const test = require('node:test');
const assert = require('node:assert');
const risk = require('../src/main/extrisk');
const { manifest } = require('./helpers/crx-builder');

const HOSTS = ['pokeidle.io'];
const analyze = (over, opts = {}) => risk.analyzeManifest(manifest(over), { gameHosts: HOSTS, ...opts });

test('extensão que só mexe no site do jogo passa', () => {
  const a = analyze({ permissions: ['storage'], host_permissions: ['https://pokeidle.io/*', 'https://*.pokeidle.io/*'] });
  assert.deepEqual(a.errors, []);
  assert.deepEqual(a.permissions.map((p) => p.name), ['storage']);
});

test('recusa Manifest V2', () => {
  assert.match(analyze({ manifest_version: 2 }).errors.join(' '), /Manifest V3/);
});

test('recusa as permissões que enxergam a sessão da conta', () => {
  for (const p of ['cookies', 'webRequest', 'webRequestBlocking', 'debugger', 'nativeMessaging', 'proxy']) {
    const a = analyze({ permissions: [p] });
    assert.ok(a.errors.some((e) => e.includes(`"${p}"`)), p);
  }
  // pedir "depois" também conta: ela poderia pedir no meio do jogo
  assert.ok(analyze({ optional_permissions: ['cookies'] }).errors.length);
});

test('recusa endereços fora dos jogos e curingas', () => {
  for (const pat of ['<all_urls>', '*://*/*', 'https://*.com/*', 'https://*.io/*', 'https://accounts.google.com/*', 'https://pokeidle.io.evil.com/*', 'http://127.0.0.1/*', 'ftp://pokeidle.io/*']) {
    assert.ok(analyze({ host_permissions: [pat] }).errors.length, `host_permissions ${pat}`);
    assert.ok(analyze({ content_scripts: [{ matches: [pat], js: ['content.js'] }] }).errors.length, `matches ${pat}`);
  }
});

test('aceita subdomínio e o site do jogo com ou sem porta e caminho', () => {
  for (const pat of ['https://pokeidle.io/*', '*://pokeidle.io/app/*', 'https://api.pokeidle.io/*', 'https://*.pokeidle.io/*', 'http://pokeidle.io:8080/*']) {
    assert.deepEqual(analyze({ host_permissions: [pat] }).errors, [], pat);
  }
});

test('sem nenhum jogo configurado, pede para adicionar o jogo antes', () => {
  assert.match(risk.analyzeManifest(manifest(), { gameHosts: [] }).errors.join(' '), /Adicione primeiro o jogo/);
});

test('endereços nas permissões (formato antigo) contam como endereços', () => {
  assert.ok(analyze({ permissions: ['<all_urls>'] }).errors.length);
  assert.deepEqual(analyze({ permissions: ['https://pokeidle.io/*'] }).errors, []);
});

test('acesso opcional a outros sites vira aviso, não bloqueio', () => {
  const a = analyze({ optional_host_permissions: ['https://*/*'] });
  assert.deepEqual(a.errors, []);
  assert.ok(a.warnings.length);
});

test('recusa caminhos com .. e arquivos que não existem', () => {
  assert.ok(analyze({ content_scripts: [{ matches: ['https://pokeidle.io/*'], js: ['../fora.js'] }] }).errors.length);
  assert.ok(analyze({ content_scripts: [{ matches: ['https://pokeidle.io/*'], js: ['/abs.js'] }] }).errors.length);
  assert.ok(analyze({}, { files: ['manifest.json'] }).errors.some((e) => e.includes('content.js')));
  assert.deepEqual(analyze({}, { files: ['manifest.json', 'content.js'] }).errors, []);
});

test('service worker aparece como permissão de segundo plano', () => {
  const a = analyze({ background: { service_worker: 'sw.js' } });
  assert.equal(a.permissions[0].name, 'service_worker');
  assert.equal(a.usesServiceWorker, true);
});

test('permissão desconhecida aparece com nível baixo', () => {
  const a = analyze({ permissions: ['algumaCoisaNova', 'history'] });
  assert.equal(a.permissions.find((p) => p.name === 'algumaCoisaNova').level, 'low');
  assert.equal(a.permissions.find((p) => p.name === 'history').level, 'high');
});

test('compatibilidade: testada, comum, só popup e sem os recursos do Electron', () => {
  const id = 'mhnplloljgchpfpcpbhmcokmnefodjnh';
  assert.equal(risk.compatibility(manifest(), id).level, 'tested');
  assert.equal(risk.compatibility(manifest(), 'a'.repeat(32)).level, 'ok');
  const popup = risk.compatibility({ manifest_version: 3, action: { default_popup: 'p.html' } }, 'x');
  assert.equal(popup.level, 'limited');
  assert.ok(popup.notes.some((n) => n.includes('Só funciona pelo popup')));
  const notif = risk.compatibility(manifest({ permissions: ['notifications', 'storage'], background: { service_worker: 'sw.js' } }), id);
  assert.equal(notif.level, 'incompatible');
  assert.equal(risk.compatibility(manifest({ commands: { a: {} } }), 'x').level, 'incompatible');
});

test('scanCode acha rede, endereços e sinais de automação', () => {
  const code = risk.scanCode([
    { name: 'a.js', text: 'fetch("https://api.exemplo.com/x"); new WebSocket("wss://ws.exemplo.com:9/a"); btn.click(); el.dispatchEvent(new Event("x")); eval("1")' },
    { name: 'b.js', text: '// http://www.w3.org/2000/svg  http://127.0.0.1:8080/dados  new Function("return 1")' },
  ]);
  assert.deepEqual(code.hosts, ['127.0.0.1', 'api.exemplo.com', 'ws.exemplo.com']);
  assert.deepEqual(code.net, { fetch: 1, xhr: 0, websocket: 1, beacon: 0 });
  assert.deepEqual(code.auto, { click: 1, dispatch: 1, eval: 1, newFunction: 1 });
});

const summary = (over = {}, code = { hosts: [], net: {}, auto: {} }) => {
  const m = manifest(over);
  const analysis = risk.analyzeManifest(m, { gameHosts: HOSTS });
  return risk.buildSummary({ manifest: m, id: 'x'.repeat(32), analysis, code, gameHosts: HOSTS });
};

test('resumo: nível de risco', () => {
  assert.equal(summary().risk, 'low');
  assert.equal(summary({ permissions: ['scripting'] }).risk, 'medium');
  assert.equal(summary({}, { hosts: [], net: {}, auto: { click: 3, dispatch: 0, eval: 0, newFunction: 0 } }).risk, 'medium');
  assert.equal(summary({}, { hosts: ['coleta.exemplo.com'], net: {}, auto: {} }).risk, 'high');
  assert.equal(summary({}, { hosts: [], net: {}, auto: { eval: 1 } }).risk, 'high');
  // o próprio site do jogo no código não é "destino de fora"
  assert.equal(summary({}, { hosts: ['api.pokeidle.io'], net: {}, auto: {} }).codeSites.length, 0);
});

test('resumo: extensão com erro vem marcada como bloqueada', () => {
  const s = summary({ permissions: ['cookies'] });
  assert.equal(s.blocked, true);
  assert.equal(summary().blocked, false);
});

test('diferença entre versões: permissão ou site novo pede confirmação', () => {
  const v1 = summary({ permissions: ['storage'] });
  const files1 = new Map([['manifest.json', 'a'], ['content.js', 'b']]);
  const same = risk.diffVersions(v1, summary({ permissions: ['storage'], version: '1.0.1' }), files1, new Map([...files1, ['content.js', 'c']]));
  assert.equal(same.needsConfirm, false);
  assert.deepEqual(same.files.changed, ['content.js']);

  const v2 = summary({ permissions: ['storage', 'scripting'], version: '2.0.0', host_permissions: ['https://api.pokeidle.io/*'] }, { hosts: ['coleta.exemplo.com'], net: {}, auto: { click: 1 } });
  const d = risk.diffVersions(v1, v2, files1, new Map([['manifest.json', 'a'], ['novo.js', 'z']]));
  assert.equal(d.needsConfirm, true);
  assert.deepEqual(d.newPermissions, ['scripting']);
  assert.deepEqual(d.newSites, ['https://api.pokeidle.io/*']);
  assert.deepEqual(d.newCodeSites, ['coleta.exemplo.com']);
  assert.deepEqual(d.newAutomation, ['click']);
  assert.deepEqual(d.files, { added: ['novo.js'], removed: ['content.js'], changed: [] });
  assert.equal(d.from, '1.0.0');
  assert.equal(d.to, '2.0.0');
});
