const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Pasta temporária ANTES de carregar a config: os testes nunca tocam nos dados reais.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-us-'));
process.env.IDLEHUB_DATA = dir;
const config = require('../src/main/config');
const { UserScriptStore, resolveScriptUrl, VALUE_LIMITS } = require('../src/main/userscript-store');
const us = require('../src/main/userscripts');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const PAGE = 'https://pokeidle.io/app';
const header = (lines) => `// ==UserScript==\n${lines.map((l) => `// ${l}`).join('\n')}\n// ==/UserScript==\n`;
const SIMPLE = (extra = [], body = 'window.__x = 1;') => header(['@name Simples', '@namespace https://t.exemplo', '@version 1.0.0', '@match https://pokeidle.io/*', '@grant none', ...extra]) + body;
const GM = (extra = [], body = 'GM_setValue("a", 1);') =>
  header(['@name Com GM', '@namespace https://t.exemplo', '@version 1.0.0', '@match https://pokeidle.io/*', '@grant GM_setValue', '@grant GM_getValue', '@grant GM_notification', '@grant GM_xmlhttpRequest', '@connect api.exemplo.com', '@connect self', ...extra]) + body;

function setup(opts = {}) {
  const root = fs.mkdtempSync(path.join(dir, 'root-'));
  const cfg = { games: [{ id: 'g1', url: PAGE, accounts: [{ id: 'a1' }, { id: 'a2' }] }] };
  const calls = { notify: [], problems: [], fetches: [] };
  const store = new UserScriptStore({
    root, getConfig: () => cfg, saveConfig: () => config.save(cfg), appVersion: '9.9.9',
    notify: (...a) => calls.notify.push(a), onProblem: (...a) => calls.problems.push(a),
    fetch: opts.fetch && ((url, init) => (calls.fetches.push({ url, init }), opts.fetch(url, init))),
  });
  return { root, cfg, store, calls };
}

// Resposta falsa de fetch.
const reply = (body, { status = 200, headers = {} } = {}) => {
  const buf = Buffer.from(body);
  const h = new Map(Object.entries({ ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300, status, statusText: 'OK',
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null, forEach: (fn) => h.forEach((v, k) => fn(v, k)) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  };
};

const install = (store, code, accounts) => {
  const r = store.prepareCode(code);
  assert.equal(r.ok, true, r.error);
  const done = store.confirmInstall(r.token, accounts);
  assert.equal(done.ok, true, done.error);
  return done.id;
};

// ---------- links ----------
test('links do Greasy Fork, OpenUserJS e GitHub viram o arquivo .user.js; o resto é recusado', () => {
  assert.equal(resolveScriptUrl('https://greasyfork.org/pt-BR/scripts/12345-meu-script'), 'https://update.greasyfork.org/scripts/12345/script.user.js');
  assert.equal(resolveScriptUrl('https://greasyfork.org/en/scripts/12345-meu-script/code'), 'https://update.greasyfork.org/scripts/12345/script.user.js');
  assert.equal(resolveScriptUrl('https://greasyfork.org/scripts/12345/code/x.user.js'), 'https://greasyfork.org/scripts/12345/code/x.user.js');
  assert.equal(resolveScriptUrl('https://update.greasyfork.org/scripts/1/x.user.js'), 'https://update.greasyfork.org/scripts/1/x.user.js');
  assert.equal(resolveScriptUrl('https://openuserjs.org/scripts/autor/Meu_Script'), 'https://openuserjs.org/install/autor/Meu_Script.user.js');
  assert.equal(resolveScriptUrl('https://openuserjs.org/install/autor/Meu_Script.user.js'), 'https://openuserjs.org/install/autor/Meu_Script.user.js');
  assert.equal(resolveScriptUrl('https://raw.githubusercontent.com/u/r/main/x.user.js'), 'https://raw.githubusercontent.com/u/r/main/x.user.js');
  assert.equal(resolveScriptUrl('https://github.com/u/r/blob/main/dir/x.user.js'), 'https://raw.githubusercontent.com/u/r/main/dir/x.user.js');
  assert.equal(resolveScriptUrl('https://github.com/u/r/raw/main/x.user.js'), 'https://github.com/u/r/raw/main/x.user.js');
  for (const bad of ['http://greasyfork.org/scripts/1-x', 'https://evil.com/x.user.js', 'https://greasyfork.org.evil.com/scripts/1-x', 'https://github.com/u/r', 'https://raw.githubusercontent.com/u/r/main/x.js', 'https://u:p@greasyfork.org/scripts/1-x', 'lixo', '', 'https://greasyfork.org/pt-BR/users/1']) {
    assert.equal(resolveScriptUrl(bad), null, bad);
  }
});

// ---------- instalar ----------
test('instala colando o código: nada entra antes do "sim" e nasce desligado em todas as contas', () => {
  const { root, cfg, store } = setup();
  const r = store.prepareCode(SIMPLE());
  assert.equal(r.ok, true);
  assert.equal(r.summary.kind, 'script');
  assert.equal(r.summary.name, 'Simples');
  assert.equal(r.summary.blocked, false);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(cfg.userscripts?.items ?? {}, {});
  assert.ok(!fs.existsSync(path.join(root, us.scriptId(us.parseMetadata(SIMPLE())))));

  const done = store.confirmInstall(r.token);
  assert.equal(done.ok, true);
  assert.deepEqual(done.accounts, []);
  assert.deepEqual(store.plan('g1:a1', PAGE), []);
  const item = store.list()[0];
  assert.equal(item.version, '1.0.0');
  assert.deepEqual(item.accounts, []);
  assert.equal(item.mode, 'main');
  assert.ok(config.load().userscripts.items[done.id]);
});

test('instalar duas vezes o mesmo código dá o mesmo hash; já instalado não instala de novo', () => {
  const a = setup();
  const b = setup();
  install(a.store, SIMPLE());
  install(b.store, SIMPLE().replace(/\n/g, '\r\n'));
  assert.equal(a.store.list()[0].hash, b.store.list()[0].hash);
  assert.match(a.store.list()[0].hash, /^[0-9a-f]{64}$/);
  assert.equal(a.store.prepareCode(SIMPLE()).ok, false);
});

test('recusa o script que pede o que não pode, e nada é instalado', () => {
  const { store } = setup();
  for (const [lines, re] of [
    [['@require https://cdn.exemplo.com/lib.js'], /@require/],
    [['@match *://*/*'], /não são dos seus jogos/],
    [['@grant GM_cookie'], /cookies/],
  ]) {
    const r = store.prepareCode(SIMPLE(lines));
    assert.equal(r.ok, true);
    assert.equal(r.summary.blocked, true);
    assert.match(r.summary.errors.join(' '), re);
    assert.equal(store.confirmInstall(r.token).ok, false);
  }
  assert.deepEqual(store.list(), []);
  assert.equal(store.prepareCode('console.log(1)').ok, false);
  assert.equal(store.prepareCode('   ').ok, false);
});

test('liga e desliga por conta, e guarda no config.json', () => {
  const { cfg, store } = setup();
  const id = install(store, SIMPLE(), ['g1:a1', 'g1:nao-existe']);
  assert.deepEqual(store.list()[0].accounts, ['g1:a1']);
  assert.equal(store.plan('g1:a1', PAGE).length, 1);
  assert.equal(store.plan('g1:a2', PAGE).length, 0);
  assert.equal(store.setAccount(id, 'g1:a2', true).ok, true);
  assert.equal(store.plan('g1:a2', PAGE).length, 1);
  assert.equal(store.setAccount(id, 'g1:a1', false).ok, true);
  assert.equal(store.plan('g1:a1', PAGE).length, 0);
  assert.equal(store.setAccount(id, 'g9:zz', true).ok, false);
  assert.equal(store.setAccount('x'.repeat(16), 'g1:a1', true).ok, false);
  assert.deepEqual(config.load().userscripts.items[id].accounts, ['g1:a2']);
  cfg.games[0].accounts = [{ id: 'a1' }]; // conta removida do jogo
  store.pruneAccounts();
  assert.deepEqual(store.list()[0].accounts, []);
});

test('limite de scripts instalados', () => {
  const { store } = setup();
  for (let i = 0; i < 30; i++) install(store, SIMPLE().replace('@name Simples', `@name S${i}`));
  assert.match(store.prepareCode(SIMPLE().replace('@name Simples', '@name S31')).error, /limite/);
});

// ---------- por link ----------
test('instala por link, seguindo só redirecionamentos para sites permitidos', async () => {
  const code = SIMPLE();
  const { store, calls } = setup({
    fetch: (url) => {
      if (url === 'https://update.greasyfork.org/scripts/5/script.user.js') return reply('', { status: 302, headers: { location: 'https://greasyfork.org/scripts/5/code/x.user.js' } });
      if (url === 'https://greasyfork.org/scripts/5/code/x.user.js') return reply(code);
      throw new Error('endereço inesperado ' + url);
    },
  });
  const r = await store.prepareUrl('https://greasyfork.org/pt-BR/scripts/5-simples');
  assert.equal(r.ok, true, r.error);
  assert.equal(calls.fetches[0].init.redirect, 'manual');
  assert.equal(calls.fetches[0].init.credentials, 'omit');
  const id = store.confirmInstall(r.token).id;
  assert.equal(store.list()[0].canUpdateByUrl, true);
  assert.ok(id);
});

test('link que redireciona para site de fora não é baixado', async () => {
  const { store } = setup({ fetch: () => reply('', { status: 302, headers: { location: 'https://evil.com/x.user.js' } }) });
  const r = await store.prepareUrl('https://greasyfork.org/pt-BR/scripts/5-x');
  assert.equal(r.ok, false);
  assert.match(r.error, /não usa/);
  assert.equal((await store.prepareUrl('https://evil.com/x.user.js')).ok, false);
});

test('erro de rede, resposta com erro e arquivo grande demais dão mensagens simples', async () => {
  let mode = 'rede';
  const { store } = setup({
    fetch: () => {
      if (mode === 'rede') throw new Error('x');
      if (mode === 'erro') return reply('x', { status: 404 });
      return reply('x', { headers: { 'content-length': String(us.LIMITS.code + 1) } });
    },
  });
  const url = 'https://raw.githubusercontent.com/u/r/main/x.user.js';
  assert.match((await store.prepareUrl(url)).error, /internet/);
  mode = 'erro';
  assert.match((await store.prepareUrl(url)).error, /404/);
  mode = 'grande';
  assert.match((await store.prepareUrl(url)).error, /grande demais/);
});

// ---------- conferência do arquivo e plano ----------
test('plan: só scripts ligados na conta, que casam com a página; modo, hora e valores certos', () => {
  const { store } = setup();
  install(store, SIMPLE(['@run-at document-start']), ['g1:a1']);
  install(store, GM(), ['g1:a1', 'g1:a2']);
  const p = store.plan('g1:a1', 'https://pokeidle.io/app/x');
  assert.equal(p.length, 2);
  const simple = p.find((x) => x.name === 'Simples');
  const withGm = p.find((x) => x.name === 'Com GM');
  assert.equal(simple.mode, 'main');
  assert.equal(simple.runAt, 'document-start');
  assert.equal(withGm.mode, 'isolated');
  assert.equal(withGm.runAt, 'document-idle');
  assert.deepEqual(p.map((x) => x.world), [1000, 1001], 'um mundo isolado por script');
  assert.ok(withGm.code.includes('idleHubGM'));
  assert.ok(!simple.code.includes('idleHubGM'));
  assert.equal(store.plan('g1:a2', PAGE).length, 1, 'só o que está ligado na conta');
  assert.equal(store.plan('g1:a3', PAGE).length, 0);

  assert.equal(store.plan('g1:a1', 'https://outro.com/').length, 0);
  assert.equal(store.plan('g1:a1', 'https://accounts.google.com/signin').length, 0);
  assert.equal(store.plan('g1:a1', 'https://pokeidle.io.evil.com/').length, 0);
});

test('plan: se o site do jogo deixa de estar nos jogos, o script não roda mais', () => {
  const { cfg, store } = setup();
  install(store, SIMPLE(), ['g1:a1']);
  assert.equal(store.plan('g1:a1', PAGE).length, 1);
  cfg.games[0].url = 'https://outrojogo.com/';
  assert.equal(store.plan('g1:a1', PAGE).length, 0);
});

test('mexeram no arquivo depois de instalar: o script não roda e a Atividade é avisada', () => {
  const { root, store, calls } = setup();
  const id = install(store, SIMPLE(), ['g1:a1']);
  assert.equal(store.plan('g1:a1', PAGE).length, 1);
  const file = path.join(root, id, store.items()[id].current.file);
  fs.appendFileSync(file, '\nfetch("https://coleta.exemplo.com")');
  assert.deepEqual(store.plan('g1:a1', PAGE), []);
  assert.equal(calls.problems.length, 1);
  assert.match(calls.problems[0][1], /alterados depois de instalado/);
  store.plan('g1:a1', PAGE); // não repete o aviso a cada página
  assert.equal(calls.problems.length, 1);
  assert.equal(store.authorize('g1:a1', id, PAGE), null, 'também não autoriza pedidos');
});

test('no máximo 12 scripts na mesma página', () => {
  const { store } = setup();
  for (let i = 0; i < 15; i++) install(store, SIMPLE().replace('@name Simples', `@name S${i}`), ['g1:a1']);
  assert.equal(store.plan('g1:a1', PAGE).length, 12);
});

// ---------- permissão dos pedidos da página ----------
test('authorize: conta ligada, página que casa e permissão do @grant', () => {
  const { store } = setup();
  const gm = install(store, GM(), ['g1:a1']);
  const plain = install(store, SIMPLE(), ['g1:a1']);
  assert.ok(store.authorize('g1:a1', gm, PAGE, 'setvalue'));
  assert.ok(store.authorize('g1:a1', gm, PAGE, 'xmlhttprequest'));
  assert.equal(store.authorize('g1:a1', gm, PAGE, 'deletevalue'), null, 'não pediu GM_deleteValue');
  assert.equal(store.authorize('g1:a1', plain, PAGE, 'setvalue'), null, '@grant none não tem ponte');
  assert.equal(store.authorize('g1:a2', gm, PAGE, 'setvalue'), null, 'conta em que não está ligado');
  assert.equal(store.authorize('g1:a1', gm, 'https://outro.com/', 'setvalue'), null, 'página que não casa');
  assert.equal(store.authorize('g1:a1', gm, 'https://accounts.google.com/', 'setvalue'), null);
  assert.equal(store.authorize(null, gm, PAGE, 'setvalue'), null, 'janela que não é de conta');
  assert.equal(store.authorize('g1:a1', 'naoexiste', PAGE), null);
});

// ---------- valores (GM_setValue) ----------
test('valores: por script e por conta, gravados no disco e relidos', () => {
  const { root, store, cfg, calls } = setup();
  const id = install(store, GM(), ['g1:a1', 'g1:a2']);
  assert.equal(store.setValue('g1:a1', id, 'n', '5'), true);
  assert.equal(store.setValue('g1:a2', id, 'n', '"outra"'), true);
  store.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, id, 'values', 'g1_a1.json'), 'utf8')), { n: '5' });

  // outra execução do app: relê do disco
  const again = new UserScriptStore({ root, getConfig: () => cfg, saveConfig() {}, notify() {}, onProblem() {} });
  assert.deepEqual(again.valuesOf(id, 'g1:a1'), { n: '5' });
  assert.deepEqual(again.valuesOf(id, 'g1:a2'), { n: '"outra"' });
  // o plano já leva os valores (GM_getValue é síncrono na página)
  assert.ok(again.plan('g1:a1', PAGE)[0].code.includes('"n":"5"'));

  store.deleteValue('g1:a1', id, 'n');
  store.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, id, 'values', 'g1_a1.json'), 'utf8')), {});
  assert.equal(calls.problems.length, 0);
});

test('valores: limites de nome, tamanho e quantidade', () => {
  const { store } = setup();
  const id = install(store, GM(), ['g1:a1']);
  assert.equal(store.setValue('g1:a1', id, '', '1'), false);
  assert.equal(store.setValue('g1:a1', id, 'x'.repeat(VALUE_LIMITS.name + 1), '1'), false);
  assert.equal(store.setValue('g1:a1', id, 'g', 'x'.repeat(VALUE_LIMITS.value + 1)), false);
  for (let i = 0; i < VALUE_LIMITS.count; i++) assert.equal(store.setValue('g1:a1', id, `k${i}`, '1'), true);
  assert.equal(store.setValue('g1:a1', id, 'extra', '1'), false);
  assert.equal(store.setValue('g1:a1', id, 'k0', '2'), true, 'trocar um que já existe pode');
});

test('valores de conta removida são apagados; remover o script apaga tudo', () => {
  const { root, store, cfg } = setup();
  const id = install(store, GM(), ['g1:a1', 'g1:a2']);
  store.setValue('g1:a1', id, 'n', '1');
  store.setValue('g1:a2', id, 'n', '1');
  store.flush();
  cfg.games[0].accounts = [{ id: 'a1' }];
  store.pruneAccounts();
  assert.deepEqual(fs.readdirSync(path.join(root, id, 'values')), ['g1_a1.json']);
  assert.equal(store.remove(id).ok, true);
  assert.ok(!fs.existsSync(path.join(root, id)));
  assert.deepEqual(store.list(), []);
});

// ---------- pedidos de rede ----------
const okFetch = (body = '{"a":1}') => () => reply(body, { headers: { 'content-type': 'application/json', 'set-cookie': 'x=1' } });
const GMX = (connects, grants = ['@grant GM_xmlhttpRequest']) =>
  header(['@name Rede', '@namespace n', '@match https://pokeidle.io/*', ...grants, ...connects.map((c) => `@connect ${c}`)]) + 'x();';

test('xmlhttpRequest só vai para o que está no @connect (e subdomínios), sem cookies', async () => {
  const { store, calls } = setup({ fetch: okFetch() });
  const id = install(store, GMX(['api.exemplo.com', 'self']), ['g1:a1']);
  const ask = (url, over = {}) => store.request('g1:a1', id, PAGE, 'r1', { url, ...over });

  const r = await ask('https://api.exemplo.com/dados', { headers: { Cookie: 'sessao=1', 'X-Chave': 'abc', Host: 'x', 'Sec-Fetch-Mode': 'x', Origin: 'https://x' } });
  assert.equal(r.status, 200);
  assert.equal(r.text, '{"a":1}');
  assert.ok(r.headers.includes('content-type: application/json'));
  assert.ok(!/set-cookie/i.test(r.headers), 'não devolve cookies para o script');
  const init = calls.fetches[0].init;
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'manual');
  assert.deepEqual(init.headers, { 'X-Chave': 'abc' }, 'sem Cookie, Host, Origin nem Sec-*');

  assert.equal((await ask('https://v2.api.exemplo.com/x')).status, 200, 'subdomínio');
  assert.equal((await ask('https://pokeidle.io/api')).status, 200, '"self" é o site da página');

  for (const bad of ['https://outro.com/', 'https://exemplo.com/', 'https://api.exemplo.com.evil.com/', 'https://evilapi.exemplo.com.br/', 'http://127.0.0.1:3000/x', 'https://api.pokeidle.io/x']) {
    const x = await ask(bad);
    assert.match(x.error, /@connect/, bad);
  }
  assert.equal(calls.fetches.length, 3, 'o que foi recusado nem chegou na rede');
  assert.ok(calls.problems.some((p) => /@connect/.test(p[1])));
});

test('xmlhttpRequest: endereço local só se o @connect disser (e IP não vale para "subdomínio")', async () => {
  const { store } = setup({ fetch: okFetch('ok') });
  const id = install(store, GMX(['localhost', '127.0.0.1']), ['g1:a1']);
  const ask = (url) => store.request('g1:a1', id, PAGE, 'r', { url });
  assert.equal((await ask('http://localhost:3107/x')).status, 200);
  assert.equal((await ask('http://127.0.0.1:3107/x')).status, 200);
  assert.match((await ask('http://sub.localhost/x')).error, /@connect/);
  assert.match((await ask('http://192.168.0.1/x')).error, /@connect/);
});

test('xmlhttpRequest: recusa sem @grant, em conta desligada, método ruim e protocolo ruim', async () => {
  const { store } = setup({ fetch: okFetch() });
  const id = install(store, GMX(['api.exemplo.com']), ['g1:a1']);
  const none = install(store, GMX(['api.exemplo.com'], ['@grant none']).replace('@name Rede', '@name Sem grant'), ['g1:a1']);
  const ask = (key, sid, req, page = PAGE) => store.request(key, sid, page, 'r', req);
  assert.match((await ask('g1:a1', none, { url: 'https://api.exemplo.com/' })).error, /não pode/);
  assert.match((await ask('g1:a2', id, { url: 'https://api.exemplo.com/' })).error, /não pode/);
  assert.match((await ask('g1:a1', id, { url: 'https://api.exemplo.com/' }, 'https://outro.com/')).error, /não pode/);
  assert.match((await ask('g1:a1', id, { url: 'https://api.exemplo.com/', method: 'TRACE' })).error, /Método/);
  assert.match((await ask('g1:a1', id, { url: 'ftp://api.exemplo.com/' })).error, /http/);
  assert.match((await ask('g1:a1', id, { url: 'file:///c:/x' })).error, /http/);
  assert.match((await ask('g1:a1', id, { url: 'lixo://' })).error, /http|inválido/);
  assert.match((await ask('g1:a1', id, { url: 'https://api.exemplo.com/' + 'x'.repeat(3000) })).error, /inválido/);
});

test('xmlhttpRequest: redirecionamento para fora do @connect é recusado sem ler a resposta', async () => {
  const hops = [];
  const { store } = setup({
    fetch: (url) => {
      hops.push(url);
      if (url === 'https://api.exemplo.com/a') return reply('', { status: 302, headers: { location: 'https://api.exemplo.com/b' } });
      if (url === 'https://api.exemplo.com/b') return reply('fim');
      if (url === 'https://api.exemplo.com/mau') return reply('', { status: 302, headers: { location: 'https://evil.com/roubo' } });
      return reply('nao deveria', { status: 200 });
    },
  });
  const id = install(store, GMX(['api.exemplo.com']), ['g1:a1']);
  const ask = (url, over) => store.request('g1:a1', id, PAGE, 'r', { url, ...over });
  const ok = await ask('https://api.exemplo.com/a');
  assert.equal(ok.text, 'fim');
  assert.equal(ok.finalUrl, 'https://api.exemplo.com/b');
  const bad = await ask('https://api.exemplo.com/mau');
  assert.match(bad.error, /evil\.com/);
  assert.ok(!hops.includes('https://evil.com/roubo'), 'não chamou o destino de fora');
});

test('xmlhttpRequest: POST leva o corpo; GET não; redirecionamento 303 vira GET', async () => {
  const seen = [];
  const { store } = setup({
    fetch: (url, init) => {
      seen.push([url, init.method, init.body]);
      return url.endsWith('/post') ? reply('', { status: 303, headers: { location: 'https://api.exemplo.com/destino' } }) : reply('ok');
    },
  });
  const id = install(store, GMX(['api.exemplo.com']), ['g1:a1']);
  const ask = (url, over) => store.request('g1:a1', id, PAGE, 'r', { url, ...over });
  await ask('https://api.exemplo.com/get', { data: 'a=1' });
  await ask('https://api.exemplo.com/post', { method: 'POST', data: 'a=1' });
  assert.deepEqual(seen, [
    ['https://api.exemplo.com/get', 'GET', undefined],
    ['https://api.exemplo.com/post', 'POST', 'a=1'],
    ['https://api.exemplo.com/destino', 'GET', undefined],
  ]);
});

test('xmlhttpRequest: tempo esgotado, cancelar, falha de rede e muitos pedidos juntos', async () => {
  const pending = [];
  const { store } = setup({
    fetch: (url, init) =>
      url.includes('/falha')
        ? Promise.reject(new Error('rede'))
        : new Promise((_, rej) => {
            pending.push(init.signal);
            init.signal.addEventListener('abort', () => rej(new Error('abort')));
          }),
  });
  const id = install(store, GMX(['api.exemplo.com']), ['g1:a1']);
  const ask = (url, rid, over) => store.request('g1:a1', id, PAGE, rid, { url, ...over });

  const t = await ask('https://api.exemplo.com/lento', 't', { timeout: 1000 });
  assert.equal(t.timeout, true);
  assert.match(t.error, /Tempo/);

  const a = ask('https://api.exemplo.com/x', 'a');
  await new Promise((r) => setTimeout(r, 5));
  store.abort('g1:a1', id, 'a');
  assert.match((await a).error, /cancelado/);

  assert.match((await ask('https://api.exemplo.com/falha', 'f')).error, /Não consegui/);

  const four = [1, 2, 3, 4].map((n) => ask('https://api.exemplo.com/x', `p${n}`));
  await new Promise((r) => setTimeout(r, 5));
  assert.match((await ask('https://api.exemplo.com/x', 'p5')).error, /demais/);
  store.stop('g1:a1'); // dormiu: cancela todos
  for (const r of await Promise.all(four)) assert.match(r.error, /cancelado/);
});

test('xmlhttpRequest: resposta e corpo grandes demais', async () => {
  const { store } = setup({ fetch: () => reply('x'.repeat(10 * 1024 * 1024 + 1)) });
  const id = install(store, GMX(['api.exemplo.com']), ['g1:a1']);
  assert.match((await store.request('g1:a1', id, PAGE, 'r', { url: 'https://api.exemplo.com/' })).error, /grande demais/);
  assert.match((await store.request('g1:a1', id, PAGE, 'r', { url: 'https://api.exemplo.com/', method: 'POST', data: 'x'.repeat(2 * 1024 * 1024 + 1) })).error, /corpo/);
});

// ---------- notificações e erros ----------
test('GM_notification: precisa do @grant e não enche a tela', () => {
  const { store, calls } = setup();
  const id = install(store, GM(), ['g1:a1']);
  const none = install(store, SIMPLE(), ['g1:a1']);
  assert.equal(store.notify('g1:a1', id, PAGE, { title: 'Oi', text: 'Texto' }), true);
  assert.deepEqual(calls.notify[0], ['g1:a1', 'Com GM', 'Oi', 'Texto']);
  assert.equal(store.notify('g1:a1', id, PAGE, { title: 'Oi', text: 'de novo' }), false, 'segundo aviso seguido é descartado');
  assert.equal(store.notify('g1:a1', none, PAGE, { text: 'x' }), false);
  assert.equal(store.notify('g1:a2', id, PAGE, { text: 'x' }), false);
  assert.equal(calls.notify.length, 1);
});

test('erro do script vai para a Atividade, sem repetir', () => {
  const { store, calls } = setup();
  const id = install(store, SIMPLE(), ['g1:a1']);
  store.reportError('g1:a1', id, 'x is not defined');
  store.reportError('g1:a1', id, 'x is not defined');
  assert.equal(calls.problems.length, 1);
  assert.match(calls.problems[0][1], /Simples.*x is not defined/);
  store.reportError('g1:a2', id, 'de outra conta');
  assert.equal(calls.problems.length, 1);
});

// ---------- atualizar, voltar ----------
const V = (version, extra = [], body = 'window.__v = 1;') => SIMPLE([...extra], body).replace('@version 1.0.0', `@version ${version}`);

test('procurar atualização: baixa, compara e só troca com o "sim"; dá para voltar', async () => {
  let serve = V('1.0.0');
  const { store, root } = setup({ fetch: () => reply(serve) });
  const r0 = await store.prepareUrl('https://raw.githubusercontent.com/u/r/main/x.user.js');
  const id = store.confirmInstall(r0.token, ['g1:a1']).id;

  assert.equal((await store.prepareUpdate(id)).upToDate, true, 'mesma versão: nada a fazer');

  serve = V('1.1.0', [], 'window.__v = 2;\nwindow.__w = 3;');
  const up = await store.prepareUpdate(id);
  assert.equal(up.ok, true);
  assert.equal(up.diff.from, '1.0.0');
  assert.equal(up.diff.to, '1.1.0');
  assert.deepEqual(up.diff.code, { added: 3, removed: 2 });
  assert.equal(up.diff.needsConfirm, false);
  assert.equal(store.list()[0].version, '1.0.0', 'ainda na versão antiga');
  assert.equal(store.plan('g1:a1', PAGE)[0].code.includes('__v = 2'), false);

  assert.equal(store.confirmUpdate(up.token).ok, true);
  assert.equal(store.list()[0].version, '1.1.0');
  assert.equal(store.list()[0].previousVersion, '1.0.0');
  assert.ok(store.plan('g1:a1', PAGE)[0].code.includes('__v = 2'));

  assert.equal(store.rollback(id).ok, true);
  assert.equal(store.list()[0].version, '1.0.0');
  assert.ok(!store.plan('g1:a1', PAGE)[0].code.includes('__v = 2'));
  assert.equal(fs.readdirSync(path.join(root, id)).filter((f) => f.endsWith('.user.js')).length, 2);
});

test('atualização que ganha acesso exige confirmação e aparece na diferença', async () => {
  let serve = V('1.0.0');
  const { store } = setup({ fetch: () => reply(serve) });
  const id = store.confirmInstall((await store.prepareUrl('https://raw.githubusercontent.com/u/r/main/x.user.js')).token).id;
  serve = header(['@name Simples', '@namespace https://t.exemplo', '@version 2.0.0', '@match https://pokeidle.io/*', '@grant GM_xmlhttpRequest', '@connect coleta.exemplo.com']) + 'eval("1"); GM_xmlhttpRequest({});';
  const up = await store.prepareUpdate(id);
  assert.equal(up.diff.needsConfirm, true);
  assert.ok(up.diff.newCodeSites.includes('coleta.exemplo.com'));
  assert.ok(up.diff.newPermissions.includes('GM_xmlhttpRequest'));
  assert.ok(up.diff.newAutomation.includes('eval'));
  assert.equal(up.summary.risk, 'high');
});

test('atualização que o IdleHub não aceita não troca nada', async () => {
  let serve = V('1.0.0');
  const { store } = setup({ fetch: () => reply(serve) });
  const id = store.confirmInstall((await store.prepareUrl('https://raw.githubusercontent.com/u/r/main/x.user.js')).token).id;
  serve = V('2.0.0', ['@require https://cdn.exemplo.com/x.js']);
  const up = await store.prepareUpdate(id);
  assert.equal(up.summary.blocked, true);
  assert.equal(store.confirmUpdate(up.token).ok, false);
  assert.equal(store.list()[0].version, '1.0.0');
});

test('atualizar colando o código: tem de ser o mesmo script', () => {
  const { store } = setup();
  const id = install(store, V('1.0.0'), ['g1:a1']);
  assert.match(store.prepareUpdateCode(id, V('1.0.0').replace('@name Simples', '@name Outro')).error, /mesmo script/);
  assert.equal(store.prepareUpdateCode(id, V('1.0.0')).upToDate, true);
  const up = store.prepareUpdateCode(id, V('1.2.0'));
  assert.equal(up.ok, true);
  assert.deepEqual(store.confirmUpdate(up.token), { ok: true, id, accounts: ['g1:a1'] });
  assert.equal(store.list()[0].version, '1.2.0');
  assert.equal(store.list()[0].canUpdateByUrl, false, 'colado e sem @updateURL: só colando');
});

test('@updateURL/@downloadURL permitidos viram o endereço de atualização; .meta.js troca por .user.js', async () => {
  const { store } = setup();
  const id = install(store, V('1.0.0', ['@updateURL https://greasyfork.org/scripts/9/code/x.meta.js']));
  assert.equal(store.list()[0].canUpdateByUrl, true);
  assert.equal(store.updateUrlOf(store.items()[id]), 'https://greasyfork.org/scripts/9/code/x.user.js');
  const { store: s2 } = setup();
  const id2 = install(s2, V('1.0.0', ['@downloadURL https://evil.com/x.user.js']));
  assert.equal(s2.updateUrlOf(s2.items()[id2]), null, 'site que não é de scripts conhecidos');
  assert.match((await s2.prepareUpdate(id2)).error, /não diz de onde/);
});

test('versão anterior só guarda uma; a antiga some', async () => {
  const { store, root } = setup();
  const id = install(store, V('1.0.0'));
  for (const v of ['1.1.0', '1.2.0', '1.3.0']) {
    const up = store.prepareUpdateCode(id, V(v));
    assert.equal(store.confirmUpdate(up.token).ok, true);
  }
  assert.equal(store.list()[0].previousVersion, '1.2.0');
  assert.equal(fs.readdirSync(path.join(root, id)).filter((f) => f.endsWith('.user.js')).length, 2);
  assert.equal(setup().store.rollback('x'.repeat(16)).ok, false);
});

test('descartar a análise não instala nada, e a fila de análises é limitada', () => {
  const { store } = setup();
  const r = store.prepareCode(SIMPLE());
  store.discard(r.token);
  assert.equal(store.confirmInstall(r.token).ok, false);
  const tokens = [1, 2, 3, 4, 5, 6].map((i) => store.prepareCode(SIMPLE().replace('@name Simples', `@name P${i}`)).token);
  assert.equal(store.confirmInstall(tokens[0]).ok, false, 'a mais antiga foi descartada');
  assert.equal(store.confirmInstall(tokens[5]).ok, true);
});
