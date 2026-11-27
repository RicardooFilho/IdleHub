const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Pasta temporária ANTES de carregar a config: os testes nunca tocam nos dados reais.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-ext-'));
process.env.IDLEHUB_DATA = dir;
const config = require('../src/main/config');
const { ExtensionStore, parseStoreInput, parseUpdateXml } = require('../src/main/extensions');
const { sha256 } = require('../src/main/crx');
const { buildZip, buildCrx, newKeyPair, simpleExtension } = require('./helpers/crx-builder');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const KEY = newKeyPair(); // o "dono" da extensão de teste: o ID é o mesmo em todas as versões
const ID = buildCrx(buildZip(simpleExtension()), KEY).id;
const CODEBASE = `https://clients2.googleusercontent.com/crx/blobs/abc/${ID}_1.crx`;

// Servidor de atualização falso: `serve.crx` é o que a "loja" entrega agora.
function fakeStore(serve) {
  const reply = (body) => ({
    ok: true, status: 200,
    headers: { get: () => String(body.length) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
  });
  return async (url) => {
    if (String(url).includes('service/update2/crx')) {
      assert.ok(String(url).includes(encodeURIComponent(`id=${serve.id || ID}`)), 'pede o ID certo');
      const c = serve.crx;
      const xml = `<gupdate><app appid="${serve.id || ID}" status="ok"><updatecheck codebase="${serve.codebase || CODEBASE}" hash_sha256="${serve.sha || sha256(c)}" size="${serve.size || c.length}" status="ok" version="x"/></app></gupdate>`;
      return reply(Buffer.from(xml));
    }
    assert.equal(url, serve.codebase || CODEBASE);
    return reply(serve.crx);
  };
}

const crxOf = (files, kp = KEY, opts) => buildCrx(buildZip(files), kp, opts).crx;
const newConfig = () => ({
  games: [{ id: 'g1', url: 'https://pokeidle.io/app', accounts: [{ id: 'a1' }, { id: 'a2' }] }],
});

// Cada teste tem a própria pasta e a própria config.
function setup(serve) {
  const root = fs.mkdtempSync(path.join(dir, 'root-'));
  const cfg = newConfig();
  const store = new ExtensionStore({ root, getConfig: () => cfg, saveConfig: () => config.save(cfg), fetch: serve && fakeStore(serve) });
  return { root, cfg, store, serve };
}

test('aceita link da loja (novo e antigo) ou só o ID; recusa o resto', () => {
  const id = 'mhnplloljgchpfpcpbhmcokmnefodjnh';
  assert.equal(parseStoreInput(id), id);
  assert.equal(parseStoreInput(`https://chromewebstore.google.com/detail/hunt-for-pokeidle/${id}?hl=pt`), id);
  assert.equal(parseStoreInput(`https://chrome.google.com/webstore/detail/${id}`), id);
  assert.equal(parseStoreInput(`http://chromewebstore.google.com/detail/x/${id}`), null);
  assert.equal(parseStoreInput(`https://evil.com/detail/x/${id}`), null);
  assert.equal(parseStoreInput('qualquer coisa'), null);
  assert.equal(parseStoreInput(''), null);
});

test('resposta do servidor de atualização: confere o endereço de download', () => {
  const ok = (url) => `<gupdate><app appid="${ID}" status="ok"><updatecheck codebase="${url}" hash_sha256="AB" size="12" status="ok" version="1.2"/></app></gupdate>`;
  assert.deepEqual(parseUpdateXml(ok(CODEBASE), ID), { version: '1.2', codebase: CODEBASE, sha256: 'ab', size: 12 });
  assert.throws(() => parseUpdateXml(ok('https://evil.example.com/x.crx'), ID), /estranho/);
  assert.throws(() => parseUpdateXml(ok('http://clients2.googleusercontent.com/x.crx'), ID), /estranho/);
  assert.throws(() => parseUpdateXml('<gupdate/>', ID), /não achou/);
  assert.throws(() => parseUpdateXml(`<gupdate><app appid="${ID}"><updatecheck status="noupdate"/></app></gupdate>`, ID), /não deixou baixar/);
});

test('instala pela loja: nada entra antes do "sim" e nasce desligada em todas as contas', async () => {
  const { root, cfg, store } = setup({ crx: crxOf(simpleExtension()) });
  const r = await store.prepareStore(`https://chromewebstore.google.com/detail/teste/${ID}`);
  assert.equal(r.ok, true);
  assert.equal(r.summary.name, 'Extensão de teste');
  assert.equal(r.summary.blocked, false);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(cfg.extensions?.items ?? {}, {}); // ainda não instalada
  assert.ok(!fs.existsSync(path.join(root, ID)), 'nada na pasta de extensões antes de confirmar');

  const done = store.confirmInstall(r.token);
  assert.equal(done.ok, true);
  assert.deepEqual(done.accounts, []);
  assert.deepEqual(store.forAccount('g1:a1'), { loads: [], problems: [] });
  assert.equal(store.list()[0].version, '1.0.0');
  const man = JSON.parse(fs.readFileSync(path.join(root, ID, '1.0.0', 'manifest.json'), 'utf8'));
  assert.equal(man.key, buildCrx(buildZip(simpleExtension()), KEY).key, 'a chave fixa o ID mesmo trocando de pasta');
  assert.ok(!fs.existsSync(path.join(root, '.staging', r.token)));
});

test('liga e desliga por conta, e guarda no config.json', async () => {
  const { cfg, store } = setup({ crx: crxOf(simpleExtension()) });
  const r = await store.prepareStore(ID);
  store.confirmInstall(r.token, ['g1:a1', 'g1:nao-existe']);
  assert.deepEqual(store.list()[0].accounts, ['g1:a1']);
  assert.equal(store.forAccount('g1:a1').loads.length, 1);
  assert.equal(store.forAccount('g1:a2').loads.length, 0);
  assert.equal(store.setAccount(ID, 'g1:a2', true).ok, true);
  assert.equal(store.forAccount('g1:a2').loads.length, 1);
  assert.equal(store.setAccount(ID, 'g1:a1', false).ok, true);
  assert.equal(store.forAccount('g1:a1').loads.length, 0);
  assert.equal(store.setAccount(ID, 'g9:zz', true).ok, false);
  assert.equal(store.setAccount('x'.repeat(32), 'g1:a1', true).ok, false);
  assert.deepEqual(config.load().extensions.items[ID].accounts, ['g1:a2']);
  // conta removida do jogo: sai da lista
  cfg.games[0].accounts = [{ id: 'a1' }];
  store.pruneAccounts();
  assert.deepEqual(store.list()[0].accounts, []);
});

test('mexeram nos arquivos depois de instalar: a extensão não carrega', async () => {
  const { root, store } = setup({ crx: crxOf(simpleExtension()) });
  store.confirmInstall((await store.prepareStore(ID)).token, ['g1:a1']);
  assert.equal(store.forAccount('g1:a1').loads.length, 1);
  fs.appendFileSync(path.join(root, ID, '1.0.0', 'content.js'), '\nfetch("https://coleta.exemplo.com")');
  const r = store.forAccount('g1:a1');
  assert.equal(r.loads.length, 0);
  assert.equal(r.problems[0].id, ID);
});

test('instalar duas vezes a mesma versão dá o mesmo hash', async () => {
  const a = setup({ crx: crxOf(simpleExtension()) });
  const b = setup({ crx: crxOf(simpleExtension()) }); // outra pasta, outra execução
  const ra = await a.store.prepareStore(ID);
  const rb = await b.store.prepareStore(ID);
  a.store.confirmInstall(ra.token);
  b.store.confirmInstall(rb.token);
  assert.equal(a.store.list()[0].hash, b.store.list()[0].hash);
  assert.match(a.store.list()[0].hash, /^[0-9a-f]{64}$/);
  // já instalada: não instala de novo
  assert.equal((await a.store.prepareStore(ID)).ok, false);
});

test('recusa a extensão com permissão proibida, e nada é instalado', async () => {
  const { root, store } = setup({ crx: crxOf(simpleExtension({ permissions: ['cookies', 'webRequest'] })) });
  const r = await store.prepareStore(ID);
  assert.equal(r.ok, true);
  assert.equal(r.summary.blocked, true);
  assert.match(r.summary.errors.join(' '), /cookies/);
  assert.equal(store.confirmInstall(r.token).ok, false);
  assert.deepEqual(store.list(), []);
  assert.ok(!fs.existsSync(path.join(root, ID)));
});

test('recusa extensão que quer sites fora dos jogos (incluindo o login do Google)', async () => {
  const files = simpleExtension({ content_scripts: [{ matches: ['https://accounts.google.com/*', 'https://pokeidle.io/*'], js: ['content.js'] }] });
  const { store } = setup({ crx: crxOf(files) });
  const r = await store.prepareStore(ID);
  assert.equal(r.summary.blocked, true);
  assert.match(r.summary.errors.join(' '), /accounts\.google\.com/);
});

test('o resumo mostra rede, automação e o aviso de compatibilidade antes de instalar', async () => {
  const code = 'fetch("https://coleta.exemplo.com/x"); document.querySelector("button").click();';
  const { store } = setup({ crx: crxOf(simpleExtension({ permissions: ['scripting', 'notifications'] }, code)) });
  const s = (await store.prepareStore(ID)).summary;
  assert.equal(s.risk, 'high');
  assert.deepEqual(s.codeSites, ['coleta.exemplo.com']);
  assert.equal(s.automation[0].name, 'click');
  assert.equal(s.compat.level, 'incompatible');
  assert.deepEqual(s.permissions.map((p) => p.name).sort(), ['notifications', 'scripting']);
});

test('download adulterado: SHA-256 ou tamanho que não batem, ID de outra extensão', async () => {
  const crx = crxOf(simpleExtension());
  const bad = await setup({ crx, sha: 'a'.repeat(64) }).store.prepareStore(ID);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /SHA-256/);
  const size = await setup({ crx, size: crx.length + 1 }).store.prepareStore(ID);
  assert.match(size.error, /tamanho/);
  // a loja entrega o CRX de OUTRO dono para o ID pedido
  const other = await setup({ crx: crxOf(simpleExtension(), newKeyPair()) }).store.prepareStore(ID);
  assert.equal(other.ok, false);
  assert.match(other.error, /outra extensão/);
  // zip mexido depois de assinado
  const tampered = await setup({ crx: crxOf(simpleExtension(), KEY, { tamper: true }) }).store.prepareStore(ID);
  assert.match(tampered.error, /assinatura/);
  // endereço de download de um servidor que não é do Google
  const evil = await setup({ crx, codebase: 'https://evil.example.com/x.crx' }).store.prepareStore(ID);
  assert.match(evil.error, /estranho/);
  assert.equal((await setup({ crx }).store.prepareStore('link inválido')).ok, false);
});

test('atualização: mostra o que mudou, só troca com o "sim", guarda a anterior e dá para voltar', async () => {
  const serve = { crx: crxOf(simpleExtension()) };
  const { root, store } = setup(serve);
  store.confirmInstall((await store.prepareStore(ID)).token, ['g1:a1']);
  const hash1 = store.list()[0].hash;

  const same = await store.prepareUpdate(ID);
  assert.equal(same.upToDate, true, 'mesma versão: nada a atualizar');

  serve.crx = crxOf(simpleExtension({ version: '2.0.0', permissions: ['scripting'] }, 'document.body.click();'));
  const up = await store.prepareUpdate(ID);
  assert.equal(up.ok, true);
  assert.equal(up.diff.from, '1.0.0');
  assert.equal(up.diff.to, '2.0.0');
  assert.deepEqual(up.diff.newPermissions, ['scripting']);
  assert.deepEqual(up.diff.newAutomation, ['click']);
  assert.equal(up.diff.needsConfirm, true);
  assert.deepEqual(up.diff.files.changed.sort(), ['content.js', 'manifest.json']);
  assert.equal(store.list()[0].version, '1.0.0', 'a versão travada continua até a pessoa confirmar');
  assert.equal(store.list()[0].hash, hash1);

  const done = store.confirmUpdate(up.token);
  assert.deepEqual(done, { ok: true, id: ID, accounts: ['g1:a1'] });
  assert.equal(store.list()[0].version, '2.0.0');
  assert.equal(store.list()[0].previousVersion, '1.0.0');
  assert.ok(fs.existsSync(path.join(root, ID, '1.0.0')) && fs.existsSync(path.join(root, ID, '2.0.0')));
  assert.equal(store.forAccount('g1:a1').loads[0].dir, path.join(root, ID, '2.0.0'));
  assert.deepEqual(store.list()[0].accounts, ['g1:a1'], 'as contas escolhidas continuam');

  assert.equal(store.rollback(ID).ok, true);
  assert.equal(store.list()[0].version, '1.0.0');
  assert.equal(store.list()[0].hash, hash1);
  assert.equal(store.forAccount('g1:a1').loads.length, 1);
  assert.equal(store.rollback(ID).ok, true, 'dá para avançar de novo');
  assert.equal(store.list()[0].version, '2.0.0');
});

test('uma terceira versão apaga a pasta da mais antiga', async () => {
  const serve = { crx: crxOf(simpleExtension()) };
  const { root, store } = setup(serve);
  store.confirmInstall((await store.prepareStore(ID)).token);
  for (const v of ['2.0.0', '3.0.0']) {
    serve.crx = crxOf(simpleExtension({ version: v }));
    store.confirmUpdate((await store.prepareUpdate(ID)).token);
  }
  assert.deepEqual(fs.readdirSync(path.join(root, ID)).sort(), ['2.0.0', '3.0.0']);
});

test('versão nova que pede o que é proibido não entra', async () => {
  const serve = { crx: crxOf(simpleExtension()) };
  const { store } = setup(serve);
  store.confirmInstall((await store.prepareStore(ID)).token);
  serve.crx = crxOf(simpleExtension({ version: '2.0.0', permissions: ['cookies'] }));
  const up = await store.prepareUpdate(ID);
  assert.equal(up.diff.blocked, true);
  assert.equal(store.confirmUpdate(up.token).ok, false);
  assert.equal(store.list()[0].version, '1.0.0');
});

test('análise abandonada pode ser descartada, e a pasta de espera é limpa ao abrir o app', async () => {
  const { root, store } = setup({ crx: crxOf(simpleExtension()) });
  const r = await store.prepareStore(ID);
  assert.ok(fs.existsSync(path.join(root, '.staging', r.token)));
  store.discard(r.token);
  assert.ok(!fs.existsSync(path.join(root, '.staging', r.token)));
  assert.equal(store.confirmInstall(r.token).ok, false);
  const r2 = await store.prepareStore(ID);
  new ExtensionStore({ root, getConfig: () => ({ games: [] }), saveConfig() {} });
  assert.ok(!fs.existsSync(path.join(root, '.staging', r2.token)));
});

test('remover apaga os arquivos e a lista', async () => {
  const { root, store } = setup({ crx: crxOf(simpleExtension()) });
  store.confirmInstall((await store.prepareStore(ID)).token, ['g1:a2']);
  assert.deepEqual(store.remove(ID), { ok: true, accounts: ['g1:a2'] });
  assert.deepEqual(store.list(), []);
  assert.ok(!fs.existsSync(path.join(root, ID)));
  assert.equal(store.remove(ID).ok, false);
});

// ----- pasta local
function writeFolder(base, files) {
  const d = fs.mkdtempSync(path.join(dir, `${base}-`));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(d, f.name)), { recursive: true });
    fs.writeFileSync(path.join(d, f.name), f.data);
  }
  return d;
}

test('instala de uma pasta: cria a chave, copia os arquivos e o ID não depende da pasta', () => {
  const { root, store } = setup();
  const src = writeFolder('src', [...simpleExtension(), { name: 'node_modules/x/index.js', data: 'ignorado' }, { name: '.git/HEAD', data: 'ignorado' }]);
  const r = store.prepareFolder(src);
  assert.equal(r.ok, true);
  const done = store.confirmInstall(r.token, ['g1:a1']);
  assert.equal(done.ok, true);
  const id = store.list()[0].id;
  assert.match(id, /^[a-p]{32}$/);
  assert.deepEqual(fs.readdirSync(path.join(root, id, '1.0.0')).sort(), ['content.js', 'manifest.json']);
  assert.equal(store.list()[0].source, 'folder');
  assert.equal(store.forAccount('g1:a1').loads[0].id, id);
  assert.equal(store.prepareFolder(src).ok, true, 'outra pasta sem chave própria vira outra extensão');
});

test('pasta que já tem a própria chave no manifest usa o ID dela', () => {
  const { store } = setup();
  const kp = newKeyPair();
  const src = writeFolder('keyed', simpleExtension({ key: kp.der.toString('base64') }));
  const done = store.confirmInstall(store.prepareFolder(src).token);
  assert.equal(done.id, buildCrx(buildZip(simpleExtension()), kp).id);
  assert.equal(store.prepareFolder(src).ok, false, 'a mesma extensão não entra duas vezes');
});

test('atualizar de pasta mantém o ID e mostra o que mudou', () => {
  const { store } = setup();
  const v1 = writeFolder('v1', simpleExtension());
  const id = store.confirmInstall(store.prepareFolder(v1).token).id;
  const v2 = writeFolder('v2', simpleExtension({ version: '1.1.0', permissions: ['tabs'] }));
  const up = store.prepareUpdateFolder(id, v2);
  assert.equal(up.ok, true);
  assert.deepEqual(up.diff.newPermissions, ['tabs']);
  assert.equal(store.confirmUpdate(up.token).ok, true);
  assert.equal(store.list()[0].id, id);
  assert.equal(store.list()[0].version, '1.1.0');
  assert.equal(store.prepareUpdateFolder(id, v2).upToDate, true);
});

test('pasta sem manifest ou com manifest quebrado', () => {
  const { store } = setup();
  assert.match(store.prepareFolder(writeFolder('vazia', [{ name: 'a.js', data: '1' }])).error, /manifest/);
  assert.match(store.prepareFolder(writeFolder('quebrada', [{ name: 'manifest.json', data: '{ não é json' }])).error, /inválido/);
  assert.equal(store.prepareFolder(path.join(dir, 'nao-existe')).ok, false);
});
