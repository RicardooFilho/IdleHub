// Catálogo de jogos (src/main/catalog.js): validação, escolha da fonte, atualização sem
// pisar no que a pessoa mudou, e baixar/guardar a cópia local. Sem rede (o fetch é injetado).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateGame, validateCatalog, pickSource, syncGame, baseOf, toPreset, createCatalog, MAX_BYTES } = require('../src/main/catalog');
const { BUNDLED, gameFromPreset } = require('../src/main/games');

const good = (extra = {}) => ({
  id: 'meujogo',
  name: 'Meu Jogo',
  short: 'MJ',
  color: '#AABBCC',
  url: 'https://meujogo.com/jogar',
  suggestedAccounts: 3,
  maxAccounts: 4,
  banWarning: 'Mais de 4 contas bane todas.',
  loggedOut: { urlIncludes: ['login'], textIncludes: ['Entrar'] },
  sessionTaken: { textIncludes: ['Aberta em outra aba'] },
  reconnecting: { textIncludes: ['reconectando'] },
  ...extra,
});
const cat = (version, ...games) => ({ version, games });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-catalog-'));
const reply = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 500, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const ids = (svc) => svc.presets().map((p) => p.preset);

// ---------- validação ----------
test('aceita um jogo completo e limpa os campos', () => {
  const g = validateGame(good());
  assert.equal(g.id, 'meujogo');
  assert.equal(g.color, '#aabbcc');
  assert.equal(g.maxAccounts, 4);
  assert.equal(g.banWarning, 'Mais de 4 contas bane todas.');
  assert.deepEqual(g.sessionTaken.textIncludes, ['aberta em outra aba']); // minúsculas, como o app compara
  assert.deepEqual(g.watchers, []);
});

test('só aceita link https de verdade', () => {
  for (const url of ['http://meujogo.com', 'javascript:alert(1)', 'file:///c:/x', 'https://user:pass@meujogo.com', 'meujogo.com', 'https://localhost', '', 5, null]) {
    assert.equal(validateGame(good({ url })), null, String(url));
  }
});

test('recusa cor, id, nome e sigla fora do formato', () => {
  for (const bad of [{ color: 'red' }, { color: '#fff' }, { id: 'Meu Jogo' }, { id: 'a' }, { name: '' }, { name: 'x'.repeat(41) }, { short: 'ABCDE' }, { short: '' }]) {
    assert.equal(validateGame(good(bad)), null, JSON.stringify(bad));
  }
});

test('limite de contas e aviso: tipos e tamanhos', () => {
  assert.equal(validateGame(good({ maxAccounts: 0 })), null);
  assert.equal(validateGame(good({ maxAccounts: 13 })), null);
  assert.equal(validateGame(good({ maxAccounts: 2.5 })), null);
  assert.equal(validateGame(good({ maxAccounts: '4' })), null);
  assert.equal(validateGame(good({ banWarning: 'x'.repeat(301) })), null);
  assert.equal(validateGame(good({ banWarning: 'linha 1\nlinha 2' })), null);
  const open = validateGame(good({ maxAccounts: undefined, banWarning: undefined }));
  assert.equal(open.maxAccounts, null);
  assert.equal(open.banWarning, '');
  // Sugestão acima do limite é reduzida ao limite.
  assert.equal(validateGame(good({ suggestedAccounts: 8, maxAccounts: 4 })).suggestedAccounts, 4);
  assert.equal(validateGame(good({ suggestedAccounts: 20, maxAccounts: undefined })), null);
});

test('listas de textos: só frases curtas, sem repetir, sem lixo', () => {
  assert.equal(validateGame(good({ sessionTaken: { textIncludes: 'texto' } })), null);
  assert.equal(validateGame(good({ sessionTaken: { textIncludes: [1] } })), null);
  assert.equal(validateGame(good({ reconnecting: { textIncludes: ['x'.repeat(101)] } })), null);
  assert.equal(validateGame(good({ reconnecting: { textIncludes: Array.from({ length: 31 }, (_, i) => `t${i}`) } })), null);
  assert.deepEqual(validateGame(good({ reconnecting: { textIncludes: ['a', 'a', 'b'] } })).reconnecting.textIncludes, ['a', 'b']);
});

test('alertas do catálogo: só texto simples, sem seletor nem regex, e sempre desligados', () => {
  const w = { name: 'Shiny', kind: 'text', selector: '', pattern: 'shiny', enabled: true };
  const g = validateGame(good({ watchers: [w] }));
  assert.equal(g.watchers[0].enabled, false);
  assert.equal(g.watchers[0].selector, '');
  for (const bad of [{ ...w, selector: '#x' }, { ...w, kind: 'number' }, { ...w, pattern: '(a+)+$' }, { ...w, pattern: '.*' }, { ...w, name: '' }]) {
    assert.equal(validateGame(good({ watchers: [bad] })), null, JSON.stringify(bad));
  }
});

test('o catálogo descarta jogos inválidos e repetidos, mas guarda os bons', () => {
  const c = validateCatalog(cat(3, good(), good({ id: 'outro', url: 'http://x.com' }), good(), { lixo: true }, good({ id: 'ok2' })));
  assert.equal(c.version, 3);
  assert.deepEqual(c.games.map((g) => g.id), ['meujogo', 'ok2']);
});

test('catálogo com formato geral errado vira null', () => {
  for (const raw of [null, [], 'x', {}, { version: 0, games: [] }, { version: '1', games: [] }, { version: 1.5, games: [] }, { version: 1, games: {} }]) {
    assert.equal(validateCatalog(raw), null, JSON.stringify(raw));
  }
  assert.deepEqual(validateCatalog({ version: 1, games: [] }), { version: 1, games: [] });
});

test('o catálogo que vem no app é válido e mantém os jogos de sempre', () => {
  assert.deepEqual(BUNDLED.games.map((g) => g.id), ['pokeidle', 'lolidle', 'onepieceidle']);
  for (const g of BUNDLED.games) assert.match(g.url, /^https:\/\//);
  // Nenhum jogo do arquivo foi descartado pela validação.
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'games.json'), 'utf8'));
  assert.equal(raw.games.length, BUNDLED.games.length);
});

// ---------- fonte ----------
test('vale a maior versão válida; empate: baixado > cópia local > do app', () => {
  const b = cat(2);
  assert.equal(pickSource({ bundled: b }).source, 'bundled');
  assert.equal(pickSource({ bundled: b, cache: cat(3) }).source, 'cache');
  assert.equal(pickSource({ bundled: b, cache: cat(3), remote: cat(4) }).source, 'remote');
  // App novo com catálogo mais recente que a cópia velha: vale o do app.
  assert.equal(pickSource({ bundled: cat(5), cache: cat(3) }).source, 'bundled');
  assert.equal(pickSource({ bundled: b, cache: cat(2), remote: cat(2) }).source, 'remote');
  assert.equal(pickSource({ bundled: b, cache: cat(2) }).source, 'cache');
  assert.equal(pickSource({ bundled: b, remote: null, cache: null }).source, 'bundled');
});

// ---------- atualizar jogos já criados ----------
test('atualiza o padrão do jogo, mas nunca o que a pessoa mudou', () => {
  const v1 = toPreset(validateGame(good()));
  const g = gameFromPreset(v1);
  // A pessoa trocou só os textos de reconectando.
  g.reconnecting.textIncludes = ['meu texto'];

  const v2 = toPreset(validateGame(good({ color: '#112233', url: 'https://novo.com/', reconnecting: { textIncludes: ['de novo'] } })));
  assert.equal(syncGame(g, v2), true);
  assert.equal(g.color, '#112233'); // não mexido: atualiza
  assert.equal(g.url, 'https://novo.com/');
  assert.deepEqual(g.reconnecting.textIncludes, ['meu texto']); // mexido: fica
  assert.deepEqual(g.catalogBase, baseOf(v2));
  // Sem novidade, não muda nada.
  assert.equal(syncGame(g, v2), false);
});

test('jogo antigo, sem cópia do padrão, usa o padrão de fábrica como base', () => {
  const p = toPreset(BUNDLED.games[0]);
  const old = gameFromPreset(p);
  delete old.catalogBase;
  old.color = '#000000'; // personalizada
  const next = { ...p, color: '#ffffff', short: 'XX' };
  assert.equal(syncGame(old, next, p), true);
  assert.equal(old.color, '#000000');
  assert.equal(old.short, 'XX');
  // Sem base nem padrão de fábrica: só guarda o padrão, não troca nada.
  const free = { name: 'Meu', short: 'MM', color: '#123456', url: 'https://a.com' };
  assert.equal(syncGame(free, next), true);
  assert.equal(free.short, 'MM');
});

test('contas e alertas de quem já joga não são tocados', () => {
  const p = toPreset(BUNDLED.games[0]);
  const g = gameFromPreset(p, { accounts: 3 });
  const accounts = JSON.stringify(g.accounts);
  const watchers = JSON.stringify(g.watchers);
  syncGame(g, { ...p, name: 'Outro', maxAccounts: 2, banWarning: 'cuidado' });
  assert.equal(JSON.stringify(g.accounts), accounts);
  assert.equal(JSON.stringify(g.watchers), watchers);
  assert.equal(g.maxAccounts, undefined); // limite e aviso não são copiados: a tela lê direto do catálogo
});

// ---------- baixar e guardar ----------
test('baixa o catálogo novo, guarda a cópia local e avisa quem escuta', async () => {
  const file = path.join(tmp(), 'catalog.json');
  const seen = [];
  const bundled = cat(1, validateGame(good({ id: 'base' })));
  const svc = createCatalog({ bundled, file, getFetch: () => reply(cat(2, good({ id: 'novo' }))), onChange: (c) => seen.push(c.source) });
  assert.deepEqual(ids(svc), ['base']);
  const r = await svc.refresh();
  assert.equal(r.ok, true);
  assert.deepEqual(ids(svc), ['novo']);
  assert.equal(svc.preset('novo').maxAccounts, 4);
  assert.deepEqual(seen, ['remote']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
  assert.ok(!fs.existsSync(file + '.tmp'));
});

test('sem internet o app usa a cópia local; sem cópia, a do app', async () => {
  const dir = tmp();
  const file = path.join(dir, 'catalog.json');
  const bundled = cat(1, validateGame(good({ id: 'base' })));
  fs.writeFileSync(file, JSON.stringify(cat(7, good({ id: 'guardado' }))));
  const off = async () => {
    throw new Error('sem rede');
  };
  const svc = createCatalog({ bundled, file, getFetch: () => off });
  svc.load();
  assert.deepEqual(ids(svc), ['guardado']);
  assert.equal((await svc.refresh()).ok, false);
  assert.deepEqual(ids(svc), ['guardado']);

  const none = createCatalog({ bundled, file: path.join(dir, 'nao-existe.json'), getFetch: () => off });
  none.load();
  assert.deepEqual(ids(none), ['base']);
});

test('cópia local estragada é ignorada', () => {
  const file = path.join(tmp(), 'catalog.json');
  const bundled = cat(1, validateGame(good({ id: 'base' })));
  fs.writeFileSync(file, '{ não é json');
  const svc = createCatalog({ bundled, file });
  svc.load();
  assert.deepEqual(ids(svc), ['base']);
  fs.writeFileSync(file, JSON.stringify({ version: 99, games: 'x' }));
  svc.load();
  assert.deepEqual(ids(svc), ['base']);
});

test('resposta ruim nunca troca o que já valia nem cria a cópia', async () => {
  const file = path.join(tmp(), 'catalog.json');
  const bundled = cat(1, validateGame(good({ id: 'base' })));
  const replies = [
    reply('<html>erro</html>'),
    reply({ version: 5, games: 'x' }),
    reply(cat(5), false),
    reply('x'.repeat(MAX_BYTES + 1)),
    async () => ({
      ok: true,
      text: async () => {
        throw new Error('cortou');
      },
    }),
  ];
  for (const r of replies) {
    const svc = createCatalog({ bundled, file, getFetch: () => r });
    assert.equal((await svc.refresh()).ok, false);
    assert.deepEqual(ids(svc), ['base']);
  }
  assert.ok(!fs.existsSync(file));
});

test('catálogo baixado mais antigo que o do app não vale', async () => {
  const file = path.join(tmp(), 'catalog.json');
  const bundled = cat(5, validateGame(good({ id: 'base' })));
  const svc = createCatalog({ bundled, file, getFetch: () => reply(cat(2, good({ id: 'velho' }))) });
  assert.equal((await svc.refresh()).ok, true);
  assert.deepEqual(ids(svc), ['base']);
  assert.ok(!fs.existsSync(file));
});

test('internet que não responde não trava: o tempo limite cancela', async () => {
  const hang = () => (_url, { signal }) =>
    new Promise((_res, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('abortado'), { name: 'AbortError' }))));
  const svc = createCatalog({ bundled: cat(1, validateGame(good({ id: 'base' }))), file: path.join(tmp(), 'c.json'), getFetch: hang, timeoutMs: 20 });
  const r = await svc.refresh();
  assert.equal(r.ok, false);
  assert.deepEqual(ids(svc), ['base']);
});

test('baixar o mesmo catálogo de novo não avisa de mudança', async () => {
  let n = 0;
  const svc = createCatalog({
    bundled: cat(1, validateGame(good({ id: 'base' }))),
    file: path.join(tmp(), 'c.json'),
    getFetch: () => reply(cat(2, good({ id: 'novo' }))),
    onChange: () => n++,
  });
  await svc.refresh();
  await svc.refresh();
  assert.equal(n, 1);
});
