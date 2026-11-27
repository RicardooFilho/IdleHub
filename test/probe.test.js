// probeInPage roda dentro da página do jogo. Aqui ela roda com um document/location falsos.
const test = require('node:test');
const assert = require('node:assert');
const { probeInPage } = require('../src/main/accounts');

function page({ text = '', href = 'https://jogo.com/', title = '', els = {}, media = false } = {}) {
  globalThis.location = { href };
  globalThis.document = {
    title,
    body: { innerText: text },
    querySelector: (sel) => (sel === 'canvas,img,video,iframe,svg' ? (media ? {} : null) : els[sel] ? { innerText: els[sel] } : null),
  };
}
const probe = (w = [], lo = { url: [], text: [] }, st = []) => probeInPage({ lo, st, w });
const num = (value, extra = {}) => ({ id: 'n', kind: 'number', selector: '#v', pattern: '', ...extra, _v: value });
const read = (value, extra) => {
  page({ els: { '#v': value } });
  return probe([num(value, extra)]).watchers[0];
};

test.afterEach(() => {
  delete globalThis.document;
  delete globalThis.location;
});

test('página sem texto nem imagem conta como tela em branco', () => {
  page({ text: '   ' });
  assert.equal(probe().blank, true);
  page({ text: '', media: true });
  assert.equal(probe().blank, false);
});

test('detecta logout pelo link ou pelo texto', () => {
  page({ href: 'https://jogo.com/LOGIN', text: 'oi' });
  assert.equal(probe([], { url: ['login'], text: [] }).loggedOut, true);
  page({ text: 'Faça login para continuar' });
  assert.equal(probe([], { url: [], text: ['faça login'] }).loggedOut, true);
  page({ text: 'Bem-vindo' });
  assert.equal(probe([], { url: ['login'], text: ['entrar'] }).loggedOut, false);
});

test('detecta conta aberta em outro lugar pelo texto, sem diferenciar maiúsculas', () => {
  const st = ['aberta em outro lugar', 'Logged In Elsewhere'];
  page({ text: 'Sua conta foi ABERTA EM OUTRO LUGAR.' });
  assert.equal(probe([], undefined, st).sessionTaken, true);
  page({ text: 'You are logged in elsewhere' });
  assert.equal(probe([], undefined, st).sessionTaken, true);
  page({ text: 'Bem-vindo de volta! Sua sessão está ótima.' });
  assert.equal(probe([], undefined, st).sessionTaken, false);
  // Sem textos configurados (ou sem o campo), nunca detecta.
  page({ text: 'aberta em outro lugar' });
  assert.equal(probe().sessionTaken, false);
  assert.equal(probeInPage({ lo: { url: [], text: [] }, w: [] }).sessionTaken, false);
});

test('alerta de texto ignora maiúsculas', () => {
  page({ text: 'Um SHINY apareceu!' });
  assert.equal(probe([{ id: 't', kind: 'text', selector: '', pattern: 'shiny' }]).watchers[0].value, true);
});

test('lê números em formato brasileiro, americano e abreviado', () => {
  assert.equal(read('1.234.567').value, 1234567);
  assert.equal(read('1,234,567').value, 1234567);
  assert.equal(read('1.234,5').value, 1234.5);
  assert.equal(read('1,5k').value, 1500);
  assert.equal(read('2.5M').value, 2500000);
  assert.equal(read('Nível 42').value, 42);
});

test('número com regex usa o grupo', () => {
  page({ text: 'Ouro: 3.400 · Gemas: 12' });
  const w = probe([{ id: 'g', kind: 'number', selector: '', pattern: 'Gemas:\\s*(\\d+)' }]).watchers[0];
  assert.equal(w.value, 12);
});

test('número sem seletor nem regex não lê a página inteira', () => {
  page({ text: 'Ouro 10' });
  assert.equal(probe([{ id: 'x', kind: 'number', selector: '', pattern: '' }]).watchers[0].found, false);
});

test('devolve título e começo do texto para reconhecer telas de erro', () => {
  page({ text: 'Error code 522 Connection timed out', title: 'jogo.com | 522: Connection timed out' });
  const r = probe();
  assert.equal(r.title, 'jogo.com | 522: Connection timed out');
  assert.equal(r.head, 'Error code 522 Connection timed out');
  assert.equal(r.len, 35);
  page({ text: 'a'.repeat(5000) });
  const big = probe();
  assert.equal(big.head.length, 1500);
  assert.equal(big.len, 5000);
});

test('página sem título devolve texto vazio', () => {
  page({ text: 'oi' });
  assert.equal(probe().title, '');
});

test('seletor que não existe na página não quebra', () => {
  page({ text: 'x' });
  assert.equal(probe([num('1', { selector: '#nao-existe' })]).watchers[0].found, false);
});
