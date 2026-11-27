// Regras de "otimizar conta" (src/main/optimize.js): funções puras, sem Electron.
const test = require('node:test');
const assert = require('node:assert');
const {
  AUTO_MIN_AGE_MS, AUTO_GAP_MS, ALL_GAP_MS, sameSite, pickReturnUrl, staggerDelays, autoOptimizeReason,
} = require('../src/main/optimize');

const HOUR = 60 * 60 * 1000;
const GAME = 'https://pokeidle.example.com/';

test('volta na página em que a conta estava, se for do mesmo site', () => {
  assert.equal(pickReturnUrl('https://pokeidle.example.com/battle?x=1#top', GAME), 'https://pokeidle.example.com/battle?x=1#top');
  assert.equal(pickReturnUrl('https://app.example.com/play', GAME), 'https://app.example.com/play');
});

test('página de outro site, vazia ou que não é http(s) volta para o link do jogo', () => {
  assert.equal(pickReturnUrl('https://accounts.google.com/signin', GAME), GAME);
  assert.equal(pickReturnUrl('', GAME), GAME);
  assert.equal(pickReturnUrl(undefined, GAME), GAME);
  assert.equal(pickReturnUrl('about:blank', GAME), GAME);
  assert.equal(pickReturnUrl('chrome-error://chromewebdata/', GAME), GAME);
  assert.equal(pickReturnUrl('file:///C:/x.html', GAME), GAME);
  assert.equal(pickReturnUrl('javascript:alert(1)', GAME), GAME);
});

test('tela de login do próprio jogo também volta para o link inicial', () => {
  assert.equal(pickReturnUrl('https://pokeidle.example.com/login?next=/', GAME, ['/login']), GAME);
  assert.equal(pickReturnUrl('https://pokeidle.example.com/battle', GAME, ['/login', '']), 'https://pokeidle.example.com/battle');
});

test('sem link inicial do jogo não há para onde voltar', () => {
  assert.equal(pickReturnUrl('https://pokeidle.example.com/x', ''), '');
});

test('mesmo site: subdomínios e sufixos como com.br', () => {
  assert.equal(sameSite('https://a.example.com', 'https://example.com'), true);
  assert.equal(sameSite('https://example.com', 'https://example.org'), false);
  assert.equal(sameSite('https://a.jogo.com.br/x', 'https://b.jogo.com.br/y'), true);
  assert.equal(sameSite('https://jogo.com.br', 'https://outro.com.br'), false);
  assert.equal(sameSite('lixo', GAME), false);
});

test('fila do "Otimizar todas" espaça as contas', () => {
  assert.deepEqual(staggerDelays(3, 5000), [0, 5000, 10000]);
  assert.deepEqual(staggerDelays(0), []);
  assert.deepEqual(staggerDelays(2), [0, ALL_GAP_MS]);
  assert.deepEqual(staggerDelays(-1), []);
});

const base = { now: 100 * HOUR, createdAt: 90 * HOUR, everyHours: 0, mem: 500, limitMB: 1500, nextAllowedAt: 0 };

test('nada a fazer com tudo desligado ou dentro do limite', () => {
  assert.equal(autoOptimizeReason(base), null);
  assert.equal(autoOptimizeReason({ ...base, limitMB: 0, mem: 99999 }), null);
});

test('passou do limite de memória: otimiza', () => {
  assert.match(autoOptimizeReason({ ...base, mem: 1600 }), /1500 MB.*1600 MB/);
  assert.equal(autoOptimizeReason({ ...base, mem: 1500 }), null); // só acima do limite
});

test('por tempo: só depois de N horas abertas, e 0 desliga', () => {
  const c = { ...base, everyHours: 6 };
  assert.equal(autoOptimizeReason({ ...c, createdAt: c.now - 5 * HOUR }), null);
  assert.match(autoOptimizeReason({ ...c, createdAt: c.now - 6 * HOUR }), /6 h/);
  assert.equal(autoOptimizeReason({ ...c, everyHours: 0, createdAt: c.now - 50 * HOUR }), null);
});

test('conta recém-aberta não é otimizada (evita loop com jogo que já nasce pesado)', () => {
  const now = 100 * HOUR;
  assert.equal(autoOptimizeReason({ ...base, now, createdAt: now - AUTO_MIN_AGE_MS + 1, mem: 9999 }), null);
  assert.ok(autoOptimizeReason({ ...base, now, createdAt: now - AUTO_MIN_AGE_MS, mem: 9999 }));
  assert.equal(autoOptimizeReason({ ...base, createdAt: 0, mem: 9999 }), null);
});

test('uma otimização automática por vez: espera o espaço entre elas', () => {
  const c = { ...base, mem: 9999 };
  assert.ok(autoOptimizeReason({ ...c, nextAllowedAt: c.now }));
  assert.equal(autoOptimizeReason({ ...c, nextAllowedAt: c.now + AUTO_GAP_MS }), null);
});

test('memória vem antes do tempo quando os dois valem', () => {
  assert.match(autoOptimizeReason({ ...base, everyHours: 1, mem: 2000 }), /memória/);
});
