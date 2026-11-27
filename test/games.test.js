const test = require('node:test');
const assert = require('node:assert');
const { PRESETS, gameFromPreset, sanitizeGame, migrateSessionTaken, migrateReconnecting } = require('../src/main/games');

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

test('os jogos prontos vêm com textos de conta aberta em outro lugar', () => {
  for (const p of PRESETS) {
    assert.ok(p.sessionTaken.textIncludes.length > 0);
    // Frases, não palavras soltas: nada de "sessão" sozinha.
    assert.ok(p.sessionTaken.textIncludes.every((t) => t.includes(' ')));
    assert.deepEqual(gameFromPreset(p).sessionTaken, p.sessionTaken);
  }
  // Cada jogo ganha uma cópia: editar um não muda o perfil.
  const g = gameFromPreset(PRESETS[0]);
  g.sessionTaken.textIncludes.push('x');
  assert.ok(!PRESETS[0].sessionTaken.textIncludes.includes('x'));
});

test('sanitizeGame limpa os textos de conta aberta em outro lugar', () => {
  assert.deepEqual(sanitizeGame({ name: 'X', sessionTaken: { textIncludes: 'outra aba, , logged in elsewhere' } }).sessionTaken.textIncludes, ['outra aba', 'logged in elsewhere']);
  assert.deepEqual(sanitizeGame({ name: 'X', sessionTaken: { textIncludes: ['a', '  ', 'b'] } }).sessionTaken.textIncludes, ['a', 'b']);
  assert.deepEqual(sanitizeGame({ name: 'X' }).sessionTaken.textIncludes, []);
});

test('a migração preenche os jogos antigos com os textos do perfil, sem refazer o que já existe', () => {
  const old = { id: 'a', preset: 'pokeidle', name: 'PokeIdle' };
  assert.equal(migrateSessionTaken(old), true);
  assert.deepEqual(old.sessionTaken, PRESETS.find((p) => p.preset === 'pokeidle').sessionTaken);
  // Jogo de link livre: lista vazia (ligado só por quem quiser).
  const custom = { id: 'b', preset: null, name: 'Meu' };
  assert.equal(migrateSessionTaken(custom), true);
  assert.deepEqual(custom.sessionTaken, { textIncludes: [] });
  // Quem já tem o campo (mesmo vazio, de propósito) não é mexido.
  const mine = { id: 'c', preset: 'pokeidle', sessionTaken: { textIncludes: [] } };
  assert.equal(migrateSessionTaken(mine), false);
  assert.deepEqual(mine.sessionTaken.textIncludes, []);
});

test('os jogos prontos vêm com textos de reconectando, em frases e copiados para cada jogo', () => {
  for (const p of PRESETS) {
    assert.ok(p.reconnecting.textIncludes.length > 0);
    assert.ok(p.reconnecting.textIncludes.every((t) => t === t.toLowerCase()));
    assert.deepEqual(gameFromPreset(p).reconnecting, p.reconnecting);
  }
  const g = gameFromPreset(PRESETS[0]);
  g.reconnecting.textIncludes.push('x');
  assert.ok(!PRESETS[0].reconnecting.textIncludes.includes('x'));
});

test('sanitizeGame limpa os textos de reconectando', () => {
  assert.deepEqual(sanitizeGame({ name: 'X', reconnecting: { textIncludes: 'reconectando, , connection lost' } }).reconnecting.textIncludes, ['reconectando', 'connection lost']);
  assert.deepEqual(sanitizeGame({ name: 'X' }).reconnecting.textIncludes, []);
});

test('a migração dos textos de reconectando preenche só jogos antigos de preset', () => {
  const old = { id: 'a', preset: 'pokeidle', name: 'PokeIdle' };
  assert.equal(migrateReconnecting(old), true);
  assert.deepEqual(old.reconnecting, PRESETS.find((p) => p.preset === 'pokeidle').reconnecting);
  const custom = { id: 'b', preset: null, name: 'Meu' };
  assert.equal(migrateReconnecting(custom), true);
  assert.deepEqual(custom.reconnecting, { textIncludes: [] });
  const mine = { id: 'c', preset: 'pokeidle', reconnecting: { textIncludes: [] } };
  assert.equal(migrateReconnecting(mine), false);
  assert.deepEqual(mine.reconnecting.textIncludes, []);
});
