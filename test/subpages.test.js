// Regras das subpáginas da conta (src/main/subpages.js): funções puras, sem Electron.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.IDLEHUB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-sub-')); // antes de carregar games.js/config.js
const {
  MAX_SUBPAGES, GAME_TAB, normalizeUrl, sanitizeSubpages, initialTabs, selectTab, closeTab, pruneTabs,
} = require('../src/main/subpages');
const { sanitizeGame } = require('../src/main/games');

const sp = (id, url = `https://site.example.com/${id}`) => ({ id, title: id, url });

test('só aceita https e completa o link sem protocolo', () => {
  assert.equal(normalizeUrl('https://pokeidle.io/votar'), 'https://pokeidle.io/votar');
  assert.equal(normalizeUrl('  pokeidle.io/wiki  '), 'https://pokeidle.io/wiki');
  assert.equal(normalizeUrl('HTTPS://Site.Example.com'), 'https://site.example.com/');
});

test('recusa link que não é https, sem site ou com senha', () => {
  for (const bad of ['http://site.example.com', 'ftp://site.example.com', 'file:///C:/x.html', 'javascript:alert(1)', 'data:text/html,x',
    'https://user:pass@site.example.com', 'https://', '', '   ', null, undefined, 'https://' + 'a'.repeat(2100)]) {
    assert.equal(normalizeUrl(bad), null, String(bad).slice(0, 40));
  }
});

test('sanitizeSubpages guarda no máximo 6 e descarta o que não tem link válido', () => {
  const many = Array.from({ length: 9 }, (_, i) => sp(`s${i}`));
  assert.equal(sanitizeSubpages(many).length, MAX_SUBPAGES);
  const out = sanitizeSubpages([sp('a'), { id: 'b', title: 'ruim', url: 'http://x.example.com' }, { id: 'c', title: 'vazio', url: '' }, sp('d')]);
  assert.deepEqual(out.map((s) => s.id), ['a', 'd']);
  assert.deepEqual(sanitizeSubpages(undefined), []);
  assert.deepEqual(sanitizeSubpages('x'), []);
});

test('sanitizeSubpages dá id novo ao que não tem, repete ou usa o nome da aba do jogo', () => {
  let n = 0;
  const makeId = () => `novo${++n}`;
  const out = sanitizeSubpages([sp('a'), sp('a'), { title: 'Sem id', url: 'https://x.example.com' }, sp(GAME_TAB)], makeId);
  assert.deepEqual(out.map((s) => s.id), ['a', 'novo1', 'novo2', 'novo3']);
});

test('sanitizeSubpages corta o título e usa o site quando ele falta', () => {
  const [a, b] = sanitizeSubpages([
    { id: 'a', title: '  Votar todo dia no ranking  ', url: 'https://x.example.com' },
    { id: 'b', title: '', url: 'https://www.wiki.example.com/pagina' },
  ]);
  assert.equal(a.title, 'Votar todo dia no ra');
  assert.equal(b.title, 'wiki.example.com');
});

test('sanitizeGame guarda as subpáginas de cada conta e aceita conta sem elas', () => {
  const g = sanitizeGame({ name: 'X', accounts: [{ id: 'a1', name: 'Conta 1', subpages: [sp('v'), sp('w', 'http://nao.example.com')] }, { id: 'a2', name: 'Conta 2' }] });
  assert.deepEqual(g.accounts[0].subpages, [sp('v')]);
  assert.deepEqual(g.accounts[1].subpages, []);
});

test('abrir uma subpágina a mostra e marca como aberta; abrir de novo não repete', () => {
  const list = [sp('a'), sp('b')];
  let t = initialTabs();
  assert.deepEqual(t, { active: GAME_TAB, open: [] });
  t = selectTab(t, 'a', list);
  assert.deepEqual(t, { active: 'a', open: ['a'] });
  t = selectTab(t, 'b', list);
  assert.deepEqual(t, { active: 'b', open: ['a', 'b'] });
  t = selectTab(t, 'a', list);
  assert.deepEqual(t, { active: 'a', open: ['a', 'b'] });
});

test('voltar ao jogo esconde a subpágina mas ela continua aberta', () => {
  const list = [sp('a')];
  const t = selectTab(selectTab(initialTabs(), 'a', list), GAME_TAB, list);
  assert.deepEqual(t, { active: GAME_TAB, open: ['a'] });
});

test('aba que não existe não muda nada', () => {
  const t = initialTabs();
  assert.equal(selectTab(t, 'fantasma', [sp('a')]), t);
});

test('fechar a subpágina da frente volta ao jogo; fechar outra não mexe na que aparece', () => {
  const list = [sp('a'), sp('b')];
  const t = selectTab(selectTab(initialTabs(), 'a', list), 'b', list);
  assert.deepEqual(closeTab(t, 'b'), { active: GAME_TAB, open: ['a'] });
  assert.deepEqual(closeTab(t, 'a'), { active: 'b', open: ['b'] });
  assert.deepEqual(closeTab(initialTabs(), 'a'), initialTabs());
});

test('pruneTabs tira as abas que saíram da configuração', () => {
  const list = [sp('a'), sp('b')];
  const t = selectTab(selectTab(initialTabs(), 'a', list), 'b', list);
  assert.deepEqual(pruneTabs(t, [sp('a')]), { active: GAME_TAB, open: ['a'] });
  assert.deepEqual(pruneTabs(t, list), t);
  assert.deepEqual(pruneTabs(t, []), { active: GAME_TAB, open: [] });
});

test('as funções não mudam o estado que recebem', () => {
  const list = [sp('a')];
  const t = Object.freeze({ active: GAME_TAB, open: Object.freeze([]) });
  assert.doesNotThrow(() => closeTab(selectTab(t, 'a', list), 'a'));
  assert.doesNotThrow(() => pruneTabs(t, list));
});
