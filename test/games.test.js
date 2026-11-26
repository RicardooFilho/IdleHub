const test = require('node:test');
const assert = require('node:assert');
const { PRESETS, gameFromPreset, sanitizeGame } = require('../src/main/games');

test('os três jogos prontos vêm com link e número de contas', () => {
  const byId = Object.fromEntries(PRESETS.map((p) => [p.preset, p]));
  assert.equal(byId.pokeidle.suggestedAccounts, 4);
  assert.equal(byId.lolidle.name, 'LoLdle');
  assert.equal(byId.lolidle.suggestedAccounts, 5);
  assert.equal(byId.onepieceidle.suggestedAccounts, 2);
  for (const p of PRESETS) assert.match(p.url, /^https:\/\//);
});

test('gameFromPreset cria contas e alertas com ids próprios', () => {
  const g = gameFromPreset(PRESETS[0], { accounts: 3 });
  assert.equal(g.accounts.length, 3);
  assert.deepEqual(g.accounts.map((a) => a.name), ['Conta 1', 'Conta 2', 'Conta 3']);
  assert.equal(new Set(g.accounts.map((a) => a.id)).size, 3);
  assert.ok(g.watchers.every((w) => w.id));
});

test('gameFromPreset limita as contas entre 1 e 12', () => {
  assert.equal(gameFromPreset(PRESETS[0], { accounts: 0 }).accounts.length, 1);
  assert.equal(gameFromPreset(PRESETS[0], { accounts: 50 }).accounts.length, 12);
});

test('sanitizeGame completa o link sem https e limpa campos ruins', () => {
  const g = sanitizeGame({
    name: '  Meu Jogo  ',
    url: 'meujogo.com/jogar',
    color: 'vermelho',
    accounts: [{ name: '' }],
    loggedOut: { urlIncludes: 'login, , signin', textIncludes: [] },
    watchers: [{ name: 'Ouro', kind: 'number', op: 'qualquer', value: '12' }],
  });
  assert.equal(g.name, 'Meu Jogo');
  assert.equal(g.url, 'https://meujogo.com/jogar');
  assert.equal(g.color, '#7c5cff');
  assert.equal(g.accounts[0].name, 'Conta 1');
  assert.deepEqual(g.loggedOut.urlIncludes, ['login', 'signin']);
  assert.equal(g.watchers[0].op, '>=');
  assert.equal(g.watchers[0].value, 12);
});

test('sanitizeGame guarda no máximo 12 contas', () => {
  const g = sanitizeGame({ name: 'X', accounts: Array.from({ length: 20 }, () => ({})) });
  assert.equal(g.accounts.length, 12);
});
