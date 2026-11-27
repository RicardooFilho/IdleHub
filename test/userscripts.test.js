const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const us = require('../src/main/userscripts');

const HOSTS = ['pokeidle.io'];
const header = (lines) => `// ==UserScript==\n${lines.map((l) => `// ${l}`).join('\n')}\n// ==/UserScript==\n`;
const script = (lines, body = 'console.log("oi");') => header(lines) + body;
const GOOD = ['@name Meu script', '@namespace https://exemplo.com', '@version 1.2.3', '@match https://pokeidle.io/*', '@grant none'];

// ---------- cabeçalho ----------
test('lê o cabeçalho: nome, versão, padrões, grants, connect e run-at', () => {
  const m = us.parseMetadata(
    script([
      '@name Meu script', '@name:pt-BR Meu roteiro', '@namespace https://exemplo.com', '@version 1.2.3', '@description faz coisas', '@author eu',
      '@match https://pokeidle.io/*', '@match *://*.pokeidle.io/app/*', '@include https://pokeidle.io/play*', '@exclude https://pokeidle.io/play/admin*',
      '@exclude-match https://pokeidle.io/tos', '@grant GM_setValue', '@grant GM.getValue', '@connect api.exemplo.com', '@connect localhost',
      '@run-at document-start', '@noframes', '@updateURL https://greasyfork.org/scripts/1/code/x.meta.js', '@downloadURL https://update.greasyfork.org/scripts/1/x.user.js',
    ])
  );
  assert.equal(m.name, 'Meu script'); // @name:pt-BR é outra coisa
  assert.equal(m.version, '1.2.3');
  assert.deepEqual(m.matches, ['https://pokeidle.io/*', '*://*.pokeidle.io/app/*']);
  assert.deepEqual(m.includes, ['https://pokeidle.io/play*']);
  assert.deepEqual(m.excludes, ['https://pokeidle.io/play/admin*']);
  assert.deepEqual(m.excludeMatches, ['https://pokeidle.io/tos']);
  assert.deepEqual(m.grants, ['GM_setValue', 'GM.getValue']);
  assert.deepEqual(m.connects, ['api.exemplo.com', 'localhost']);
  assert.equal(m.runAt, 'document-start');
  assert.equal(m.noframes, true);
  assert.equal(m.downloadURL, 'https://update.greasyfork.org/scripts/1/x.user.js');
});

test('aceita BOM, quebra de linha do Windows e valores padrão', () => {
  const m = us.parseMetadata('﻿' + script(['@name Teste', '@match https://pokeidle.io/*']).replace(/\n/g, '\r\n'));
  assert.equal(m.name, 'Teste');
  assert.equal(m.runAt, 'document-idle');
  assert.deepEqual(m.grants, []);
  assert.equal(us.parseMetadata(script(['@name X', '@run-at qualquer-coisa'])).runAt, 'document-idle');
});

test('recusa o que não é script de usuário', () => {
  assert.throws(() => us.parseMetadata('console.log(1)'), /UserScript/);
  assert.throws(() => us.parseMetadata(script(['@match https://pokeidle.io/*'])), /@name/);
  assert.throws(() => us.parseMetadata('// ==UserScript==\n// @name X'), /UserScript/); // sem fechar o bloco
});

test('o mesmo script tem o mesmo ID; outro nome ou namespace, outro ID', () => {
  const a = us.scriptId(us.parseMetadata(script(['@name A', '@namespace n'])));
  assert.equal(a, us.scriptId(us.parseMetadata(script(['@name A', '@namespace n', '@version 9']))));
  assert.notEqual(a, us.scriptId(us.parseMetadata(script(['@name B', '@namespace n']))));
  assert.notEqual(a, us.scriptId(us.parseMetadata(script(['@name A', '@namespace outro']))));
  assert.match(a, /^[0-9a-f]{16}$/);
});

test('o hash não muda com BOM nem com quebra de linha', () => {
  const a = script(GOOD);
  assert.equal(us.sha256(us.normalizeCode(a)), us.sha256(us.normalizeCode('﻿' + a.replace(/\n/g, '\r\n'))));
});

// ---------- @match (padrões do Chrome) ----------
test('@match: esquema, site, subdomínio, caminho e consulta', () => {
  const m = us.matchesPattern;
  assert.ok(m('https://pokeidle.io/*', 'https://pokeidle.io/'));
  assert.ok(m('https://pokeidle.io/*', 'https://pokeidle.io/app?x=1#h'));
  assert.ok(!m('https://pokeidle.io/*', 'http://pokeidle.io/'));
  assert.ok(m('*://pokeidle.io/*', 'http://pokeidle.io/a'));
  assert.ok(m('*://pokeidle.io/*', 'https://pokeidle.io/a'));
  assert.ok(!m('*://pokeidle.io/*', 'ftp://pokeidle.io/a'));
  assert.ok(m('https://*.pokeidle.io/*', 'https://api.pokeidle.io/x'));
  assert.ok(m('https://*.pokeidle.io/*', 'https://a.b.pokeidle.io/x'));
  assert.ok(m('https://*.pokeidle.io/*', 'https://pokeidle.io/x'), '*.site também vale para o próprio site');
  assert.ok(!m('https://*.pokeidle.io/*', 'https://pokeidle.io.evil.com/x'));
  assert.ok(!m('https://*.pokeidle.io/*', 'https://evilpokeidle.io/x'));
  assert.ok(!m('https://pokeidle.io/*', 'https://api.pokeidle.io/x'));
  assert.ok(m('https://pokeidle.io/app/*', 'https://pokeidle.io/app/play'));
  assert.ok(!m('https://pokeidle.io/app/*', 'https://pokeidle.io/application'));
  assert.ok(m('https://pokeidle.io/a*b', 'https://pokeidle.io/aXXb'));
  assert.ok(!m('https://pokeidle.io/a*b', 'https://pokeidle.io/aXXc'));
  assert.ok(m('https://pokeidle.io/play?id=*', 'https://pokeidle.io/play?id=7'));
  assert.ok(!m('https://pokeidle.io/play', 'https://pokeidle.io/play?id=7'), 'a consulta conta');
  assert.ok(m('<all_urls>', 'https://qualquer.com/'));
  assert.ok(!m('<all_urls>', 'file:///c:/x'));
  assert.ok(!m('lixo', 'https://pokeidle.io/'));
});

test('@match com porta: sem porta vale qualquer uma, com porta tem de bater', () => {
  assert.ok(us.matchesPattern('http://127.0.0.1/*', 'http://127.0.0.1:3107/x'));
  assert.ok(us.matchesPattern('http://127.0.0.1:3107/*', 'http://127.0.0.1:3107/x'));
  assert.ok(!us.matchesPattern('http://127.0.0.1:3107/*', 'http://127.0.0.1:3108/x'));
  assert.ok(us.matchesPattern('https://pokeidle.io:443/*', 'https://pokeidle.io/x'));
});

test('padrões inválidos não casam com nada', () => {
  for (const p of ['https://*pokeidle.io/*', 'https://pokeidle.*/*', 'pokeidle.io', 'https://pokeidle.io', 'ftp://pokeidle.io/*']) assert.equal(us.parseMatch(p), null, p);
  assert.ok(us.parseMatch('*://*/*'));
});

// ---------- @include / @exclude ----------
test('@include e @exclude: texto com "*" sobre o endereço inteiro', () => {
  assert.ok(us.matchesGlob('https://pokeidle.io/*', 'https://pokeidle.io/a/b?x=1#y'));
  assert.ok(us.matchesGlob('http*://pokeidle.io/*', 'http://pokeidle.io/a'));
  assert.ok(us.matchesGlob('http*://pokeidle.io/*', 'https://pokeidle.io/a'));
  assert.ok(us.matchesGlob('*pokeidle.io*', 'https://pokeidle.io/a'));
  assert.ok(us.matchesGlob('https://pokeidle.io/', 'https://pokeidle.io/'));
  assert.ok(!us.matchesGlob('https://pokeidle.io/', 'https://pokeidle.io/a'), 'sem * no fim, tem de ser igual');
  assert.ok(!us.matchesGlob('https://pokeidle.io/*', 'https://outro.com/'));
  assert.ok(us.matchesGlob('https://pokeidle.io/a.b*', 'https://pokeidle.io/a.bc'));
  assert.ok(!us.matchesGlob('https://pokeidle.io/a.b*', 'https://pokeidle.io/aXbc'), 'o ponto é só um ponto');
  assert.ok(!us.matchesGlob('/pokeidle/', 'https://pokeidle.io/'), 'expressão regular não é aceita');
});

test('scriptMatches: padrões, exclusões e a regra dos sites dos jogos', () => {
  const meta = us.parseMetadata(script(['@name X', '@match https://*.pokeidle.io/*', '@include https://pokeidle.io/app*', '@exclude https://pokeidle.io/app/admin*', '@exclude-match https://*.pokeidle.io/tos']));
  const ok = (url) => us.scriptMatches(meta, url, HOSTS);
  assert.ok(ok('https://pokeidle.io/app'));
  assert.ok(ok('https://api.pokeidle.io/x'));
  assert.ok(!ok('https://pokeidle.io/app/admin/users'), '@exclude');
  assert.ok(!ok('https://api.pokeidle.io/tos'), '@exclude-match');
  assert.ok(!ok('https://outro.com/'));
  assert.ok(!ok('https://pokeidle.io.evil.com/'));
  assert.ok(!ok('ftp://pokeidle.io/'));
  assert.ok(!ok('lixo'));
  assert.ok(!us.scriptMatches(meta, 'https://pokeidle.io/app', []), 'sem jogo configurado não roda em lugar nenhum');
  assert.ok(!us.scriptMatches(meta, 'https://pokeidle.io/app', ['lol.com']), 'o site do jogo tem de ser de um jogo configurado');
});

test('nunca roda no Google, mesmo que o padrão e o "jogo" apontem para lá', () => {
  const meta = us.parseMetadata(script(['@name X', '@match *://*/*', '@include *']));
  for (const url of ['https://accounts.google.com/signin', 'https://www.google.com/', 'https://accounts.google.com.br/x', 'https://www.youtube.com/', 'https://x.gstatic.com/a', 'https://fonts.googleapis.com/css']) {
    assert.ok(!us.scriptMatches(meta, url, ['accounts.google.com', 'google.com', 'youtube.com', 'gstatic.com', 'googleapis.com', 'google.com.br']), url);
  }
  assert.ok(us.isGoogleHost('accounts.google.com'));
  assert.ok(!us.isGoogleHost('pokeidle.io'));
  assert.ok(!us.isGoogleHost('notgoogle.com'));
});

// ---------- análise ----------
const analyze = (lines, hosts = HOSTS) => us.analyze(us.parseMetadata(script(['@name X', ...lines])), { gameHosts: hosts });

test('script que só mexe no site do jogo passa', () => {
  const a = analyze(['@match https://pokeidle.io/*', '@match https://*.pokeidle.io/*', '@include https://pokeidle.io/play*', '@include *pokeidle.io*', '@include http*://pokeidle.io/*']);
  assert.deepEqual(a.errors, []);
  assert.equal(a.mode, 'main');
});

test('recusa sites fora dos jogos, curingas e regex', () => {
  for (const line of [
    '@match <all_urls>', '@match *://*/*', '@match https://*.com/*', '@match https://accounts.google.com/*', '@match https://pokeidle.io.evil.com/*',
    '@include *', '@include https://*/*', '@include https://google.com/*', '@include *google.com*', '@include /pokeidle/', '@include http://*/x',
  ]) {
    assert.ok(analyze([line]).errors.length, line);
  }
  assert.ok(analyze([]).errors.some((e) => /não diz em quais sites/.test(e)));
});

test('sem jogo configurado, nada é aceito', () => {
  assert.ok(analyze(['@match https://pokeidle.io/*'], []).errors.some((e) => /Adicione primeiro o jogo/.test(e)));
});

test('recusa @require, @resource, @connect * e GM_cookie', () => {
  assert.match(analyze(['@match https://pokeidle.io/*', '@require https://cdn.jsdelivr.net/npm/jquery@3/dist/jquery.min.js']).errors.join(' '), /@require/);
  assert.match(analyze(['@match https://pokeidle.io/*', '@resource css https://x.com/a.css']).errors.join(' '), /@resource/);
  assert.match(analyze(['@match https://pokeidle.io/*', '@grant GM_xmlhttpRequest', '@connect *']).errors.join(' '), /@connect \*/);
  assert.match(analyze(['@match https://pokeidle.io/*', '@grant GM_cookie']).errors.join(' '), /cookies/);
  assert.ok(analyze(['@match https://pokeidle.io/*', '@connect nao é host']).errors.length);
});

test('@grant: modo, permissões e avisos', () => {
  const none = analyze(['@match https://pokeidle.io/*', '@grant none']);
  assert.equal(none.mode, 'main');
  assert.equal(none.permissions[0].name, 'none');
  assert.equal(none.permissions[0].level, 'medium');
  assert.equal(analyze(['@match https://pokeidle.io/*']).mode, 'main', 'sem @grant = mundo da página');

  const gm = analyze(['@match https://pokeidle.io/*', '@grant GM_setValue', '@grant GM.getValue', '@grant GM_xmlhttpRequest', '@connect api.exemplo.com']);
  assert.equal(gm.mode, 'isolated');
  assert.deepEqual(gm.permissions.map((p) => p.name), ['isolado', 'GM_setValue', 'GM_getValue', 'GM_xmlhttpRequest']);
  assert.deepEqual(gm.connects, ['api.exemplo.com']);

  assert.ok(analyze(['@match https://pokeidle.io/*', '@grant GM_xmlhttpRequest']).warnings.some((w) => /sem @connect/.test(w)));
  assert.ok(analyze(['@match https://pokeidle.io/*', '@grant none', '@grant GM_setValue']).notes.some((n) => /GM_\*/.test(n)));
  assert.ok(analyze(['@match https://pokeidle.io/*', '@grant GM_openInTab']).notes.some((n) => /não tem/.test(n)));
  assert.ok(analyze(['@match https://pokeidle.io/*', '@grant GM_setValue', '@grant unsafeWindow']).notes.some((n) => /unsafeWindow/.test(n)));
  assert.equal(analyze(['@match https://pokeidle.io/*', '@grant unsafeWindow']).mode, 'main', 'só unsafeWindow: roda no mundo da página');
});

const summarize = (lines, code = 'console.log(1)') => {
  const meta = us.parseMetadata(script(['@name X', ...lines], code));
  return us.buildSummary({ meta, id: us.scriptId(meta), analysis: us.analyze(meta, { gameHosts: HOSTS }), code, gameHosts: HOSTS });
};

test('resumo de risco: baixo, médio e alto', () => {
  const low = summarize(['@match https://pokeidle.io/*', '@grant GM_setValue']);
  assert.equal(low.kind, 'script');
  assert.equal(low.risk, 'low');
  assert.equal(low.blocked, false);

  const medium = summarize(['@match https://pokeidle.io/*', '@grant none']);
  assert.equal(medium.risk, 'medium'); // mundo da página

  const auto = summarize(['@match https://pokeidle.io/*', '@grant GM_setValue'], 'document.querySelector("button").click(); el.dispatchEvent(new Event("x"));');
  assert.equal(auto.risk, 'medium');
  assert.deepEqual(auto.automation.map((a) => a.name), ['click', 'dispatch']);

  const evil = summarize(['@match https://pokeidle.io/*', '@grant none'], 'eval(atob("..."))');
  assert.equal(evil.risk, 'high');
  assert.ok(evil.automation.some((a) => a.name === 'eval'));

  const net = summarize(['@match https://pokeidle.io/*', '@grant GM_xmlhttpRequest', '@connect coleta.exemplo.com', '@connect api.pokeidle.io', '@connect self'], 'GM_xmlhttpRequest({url:"https://coleta.exemplo.com/x"})');
  assert.equal(net.risk, 'high');
  assert.deepEqual(net.connectSites, ['coleta.exemplo.com']);
  assert.ok(net.codeSites.includes('coleta.exemplo.com'));
  assert.ok(!net.codeSites.includes('api.pokeidle.io'), 'o próprio site do jogo não é "de fora"');
  assert.equal(net.compat.level, 'ok');

  const blocked = summarize(['@match *://*/*']);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.compat.level, 'incompatible');
});

test('diferença de linhas entre versões', () => {
  assert.deepEqual(us.lineDiff('a\nb\nc', 'a\nb\nc'), { added: 0, removed: 0 });
  assert.deepEqual(us.lineDiff('a\nb\nc', 'a\nX\nc\nd'), { added: 2, removed: 1 });
});

// ---------- o código que vai para a página ----------
const meta = (lines) => us.parseMetadata(script(['@name Teste', '@namespace n', '@match https://pokeidle.io/*', ...lines]));

test('@grant none roda no mundo da página, sem ponte nem GM_*', () => {
  const m = meta(['@grant none']);
  const out = us.buildRun({ meta: m, code: 'window.__r = [typeof GM_setValue, typeof idleHubGM, typeof unsafeWindow, GM_info.script.name];', appVersion: '0.1.0' });
  const win = {};
  win.window = win;
  vm.runInNewContext(out, win);
  assert.deepEqual(win.__r, ['undefined', 'undefined', 'object', 'Teste']);
  assert.ok(!out.includes('createGmRuntime'));
  assert.match(out, /sourceURL=idlehub-userscript\/Teste\.user\.js/);
});

test('código terminando em comentário de linha não quebra o fechamento', () => {
  const out = us.buildRun({ meta: meta(['@grant none']), code: 'window.__ok = 1; // fim sem quebra de linha' });
  const win = {};
  win.window = win;
  vm.runInNewContext(out, win);
  assert.equal(win.__ok, 1);
});

// Página falsa para o runtime das funções GM_*: a ponte registra o que o script pediu.
function gmPage(lines, code, { values = {}, xhr } = {}) {
  const m = meta(lines);
  const calls = [];
  const bridge = {
    set: (n, v) => calls.push(['set', n, v]),
    del: (n) => calls.push(['del', n]),
    xhr: (id, req) => (calls.push(['xhr', id, req]), Promise.resolve(xhr ? xhr(req) : { error: 'sem rede' })),
    abort: (id) => calls.push(['abort', id]),
    notify: (o) => calls.push(['notify', o]),
  };
  const head = { children: [], appendChild(el) { this.children.push(el); el.isConnected = true; el.sheet = {}; } };
  const win = {
    idleHubGM: bridge, console: { log() {}, error() {} }, Promise, JSON, Object, Map, Set, Array, String, Number, Date, setTimeout,
    document: { head, documentElement: head, createElement: () => ({ tagName: 'STYLE' }), addEventListener() {} },
  };
  win.window = win;
  const run = us.buildRun({ meta: m, code, values, appVersion: '0.1.0' });
  vm.runInNewContext(run, win);
  return { win, calls, head };
}

test('GM_setValue / getValue / deleteValue / listValues guardam por ponte e leem o que já existia', () => {
  const { win, calls } = gmPage(
    ['@grant GM_setValue', '@grant GM_getValue', '@grant GM_deleteValue', '@grant GM_listValues'],
    `const antes = GM_getValue('velho'); GM_setValue('n', 5); GM_setValue('o', {a: [1, 2]}); GM_setValue('apaga', 1); GM_deleteValue('apaga');
     window.__r = { antes, n: GM_getValue('n'), o: GM_getValue('o'), padrao: GM_getValue('nada', 'x'), lista: GM_listValues().sort() };`,
    { values: { velho: JSON.stringify('guardado') } }
  );
  assert.deepEqual(JSON.parse(JSON.stringify(win.__r)), { antes: 'guardado', n: 5, o: { a: [1, 2] }, padrao: 'x', lista: ['n', 'o', 'velho'] });
  assert.deepEqual(calls.filter((c) => c[0] === 'set').map((c) => c[1]), ['n', 'o', 'apaga']);
  assert.deepEqual(calls.find((c) => c[0] === 'set' && c[1] === 'n'), ['set', 'n', '5']);
  assert.deepEqual(calls.filter((c) => c[0] === 'del'), [['del', 'apaga']]);
});

test('só existe o que o @grant pediu; o resto fica undefined', () => {
  const { win } = gmPage(['@grant GM_setValue'], 'window.__r = [typeof GM_setValue, typeof GM_getValue, typeof GM_xmlhttpRequest, typeof GM_addStyle, typeof GM.getValue, typeof GM.info, typeof GM_info, typeof unsafeWindow];');
  assert.deepEqual(win.__r, ['function', 'undefined', 'undefined', 'undefined', 'undefined', 'object', 'object', 'undefined']);
});

test('GM.* devolve promessas', async () => {
  const { win, calls } = gmPage(['@grant GM.setValue', '@grant GM.getValue', '@grant GM.listValues'], `window.__p = GM.setValue('k', 'v').then(() => GM.getValue('k')).then((v) => [v, GM.listValues]);`);
  const [v] = await win.__p;
  assert.equal(v, 'v');
  assert.deepEqual(calls[0], ['set', 'k', '"v"']);
});

test('GM_addStyle põe um <style> na página', () => {
  const { win, head } = gmPage(['@grant GM_addStyle'], 'window.__el = GM_addStyle("body{color:red}");');
  assert.equal(head.children.length, 1);
  assert.equal(win.__el.textContent, 'body{color:red}');
});

test('GM_notification passa só título e texto', () => {
  const { calls } = gmPage(['@grant GM_notification'], 'GM_notification({ text: "oi", title: "T", image: "x", onclick() {} }); GM_notification("só texto");');
  assert.deepEqual(calls.filter((c) => c[0] === 'notify').map((c) => c[1]), [{ title: 'T', text: 'oi' }, { title: '', text: 'só texto' }]);
});

test('GM_xmlhttpRequest: pede à ponte, devolve a resposta e chama onload', async () => {
  const { win, calls } = gmPage(
    ['@grant GM_xmlhttpRequest', '@connect api.exemplo.com'],
    `window.__done = new Promise((res) => GM_xmlhttpRequest({ url: 'https://api.exemplo.com/x', method: 'post', data: 'a=1', headers: { 'X-A': 1 }, responseType: 'json', context: 7, onload: res, onerror: res }));`,
    { xhr: () => ({ status: 200, statusText: 'OK', finalUrl: 'https://api.exemplo.com/x', headers: 'a: b\r\n', text: '{"ok":true}' }) }
  );
  const r = await win.__done;
  assert.equal(r.status, 200);
  assert.equal(r.responseText, '{"ok":true}');
  assert.deepEqual(JSON.parse(JSON.stringify(r.response)), { ok: true });
  assert.equal(r.context, 7);
  const [, , req] = calls.find((c) => c[0] === 'xhr');
  assert.equal(req.method, 'POST');
  assert.deepEqual(req.headers, { 'X-A': '1' });
  assert.equal(req.data, 'a=1');
});

test('GM_xmlhttpRequest recusado vira onerror; GM.xmlHttpRequest devolve a resposta', async () => {
  const refused = () => ({ error: 'O endereço x.com não está no @connect do script. Pedido recusado.' });
  const { win } = gmPage(
    ['@grant GM_xmlhttpRequest', '@grant GM.xmlHttpRequest', '@connect api.exemplo.com'],
    `window.__a = new Promise((res) => GM_xmlhttpRequest({ url: 'https://x.com/', onerror: res }));
     window.__b = GM.xmlHttpRequest({ url: 'https://x.com/' });`,
    { xhr: refused }
  );
  assert.match((await win.__a).error, /@connect/);
  assert.match((await win.__b).error, /@connect/);
});

test('cancelar o pedido avisa a ponte', () => {
  const { win, calls } = gmPage(['@grant GM_xmlhttpRequest'], `window.__h = GM_xmlhttpRequest({ url: 'https://api.exemplo.com/', onabort() { window.__abortou = true; } }); window.__h.abort();`);
  assert.deepEqual(calls.filter((c) => c[0] === 'abort').length, 1);
  assert.equal(win.__abortou, true);
});

test('GM_info tem o nome, a versão do IdleHub e o gerenciador', () => {
  const { win } = gmPage(['@grant GM_setValue', '@version 3'], 'window.__i = [GM_info.scriptHandler, GM_info.script.name, GM_info.script.version, GM_info.version];');
  assert.deepEqual(win.__i, ['IdleHub', 'Teste', '3', '0.1.0']);
});

test('um script não enxerga os valores guardados se não pediu GM_getValue', () => {
  const run = us.buildRun({ meta: meta(['@grant GM_setValue']), code: '', values: { segredo: '"x"' } });
  assert.ok(!run.includes('segredo'));
});
