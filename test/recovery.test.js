// Regras de recuperação do watchdog (src/main/recovery.js): funções puras, sem Electron.
const test = require('node:test');
const assert = require('node:assert');
const {
  FAILURE_LIMIT, FAILURE_WINDOW_MS, backoffMs, recordFailure, tooManyFailures, classifyPage, createInternetCheck,
  RECONNECT_LIMIT_MS, reconnectingTooLong,
} = require('../src/main/recovery');

const SEC = 1000;
const MIN = 60 * SEC;

test('espera entre tentativas cresce de 30 s até 15 min e trava aí', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(backoffMs), [30 * SEC, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN]);
  assert.equal(backoffMs(6), 15 * MIN);
  assert.equal(backoffMs(99), 15 * MIN);
});

test('espera com valor estranho volta para a primeira', () => {
  assert.equal(backoffMs(-1), 30 * SEC);
  assert.equal(backoffMs(NaN), 30 * SEC);
  assert.equal(backoffMs(undefined), 30 * SEC);
});

test('5 quedas em 10 minutos é desistir; 4 não', () => {
  let h = [];
  const t0 = 1_000_000;
  for (let i = 0; i < FAILURE_LIMIT - 1; i++) {
    h = recordFailure(h, t0 + i * MIN);
    assert.equal(tooManyFailures(h, t0 + i * MIN), false);
  }
  h = recordFailure(h, t0 + (FAILURE_LIMIT - 1) * MIN);
  assert.equal(tooManyFailures(h, t0 + (FAILURE_LIMIT - 1) * MIN), true);
});

test('quedas fora da janela de 10 minutos não contam', () => {
  const t0 = 5_000_000;
  let h = [];
  for (let i = 0; i < FAILURE_LIMIT; i++) h = recordFailure(h, t0 + i * 3 * MIN); // uma a cada 3 min
  assert.equal(tooManyFailures(h, t0 + (FAILURE_LIMIT - 1) * 3 * MIN), false);
  // E com o tempo, o histórico antigo é descartado.
  const later = t0 + 10 * FAILURE_WINDOW_MS;
  assert.deepEqual(recordFailure(h, later), [later]);
});

test('recordFailure não altera a lista de entrada', () => {
  const h = [1];
  recordFailure(h, 2);
  assert.deepEqual(h, [1]);
});

test('reconhece a tela de verificação do Cloudflare', () => {
  assert.equal(classifyPage({ title: 'Just a moment...', text: '' }), 'cloudflare');
  assert.equal(classifyPage({ title: 'Um momento…', text: '' }), 'cloudflare');
  assert.equal(classifyPage({ title: 'Attention Required! | Cloudflare', text: 'Sorry, you have been blocked' }), 'cloudflare');
  assert.equal(classifyPage({ title: 'pokeidle.com', text: 'Verifying you are human. This may take a few seconds.' }), 'cloudflare');
  assert.equal(classifyPage({ title: 'x', text: 'Verificando se você é humano. Isso pode levar alguns segundos.' }), 'cloudflare');
  assert.equal(classifyPage({ title: 'x', text: 'Checking your browser before accessing the site.' }), 'cloudflare');
  assert.equal(classifyPage({ title: 'x', text: 'pokeidle.com needs to review the security of your connection before proceeding.' }), 'cloudflare');
});

test('reconhece os erros 52x do Cloudflare', () => {
  assert.deepEqual(classifyPage({ title: 'pokeidle.com | 521: Web server is down', text: '' }), { kind: 'server-error', code: 521 });
  assert.deepEqual(classifyPage({ title: 'x', text: 'Error code 522\nConnection timed out' }), { kind: 'server-error', code: 522 });
  assert.deepEqual(classifyPage({ title: 'x | 524: A timeout occurred', text: '' }), { kind: 'server-error', code: 524 });
  assert.deepEqual(classifyPage({ title: 'x', text: 'Error code 525 SSL handshake failed' }), { kind: 'server-error', code: 525 });
  assert.deepEqual(classifyPage({ title: 'Error 520', text: 'Cloudflare\nWeb server is returning an unknown error' }), { kind: 'server-error', code: 520 });
  assert.deepEqual(classifyPage({ title: 'x', text: 'Error code 527 Cloudflare' }), { kind: 'server-error', code: 527 });
});

test('jogo com 520 no texto não é página de erro', () => {
  assert.equal(classifyPage({ title: 'LoLdle', text: 'Ouro: 520 · Gemas: 12' }), null);
  assert.equal(classifyPage({ title: 'PokeIdle', text: 'Onda 520: o chefe apareceu' }), null);
  assert.equal(classifyPage({ title: 'Level 521: Boss', text: 'Você tem 522 moedas' }), null);
  assert.equal(classifyPage({ title: 'Jogo', text: 'Error code 520' }), null); // número sem a frase do erro
  assert.equal(classifyPage({ title: 'Jogo', text: 'Mostra se a conexão foi interrompida: connection timed out' }), null); // frase sem o número
  assert.equal(classifyPage({ title: 'Jogo', text: 'Um momento de silêncio' }), null);
});

test('texto de página grande não conta, só o título', () => {
  const big = `${'texto do jogo '.repeat(400)} Error code 522 connection timed out Verifying you are human`;
  assert.equal(classifyPage({ title: 'Jogo', text: big }), null);
  // O texto pode vir cortado: o tamanho real da página decide.
  assert.equal(classifyPage({ title: 'Jogo', text: 'Verifying you are human', length: 50_000 }), null);
  assert.equal(classifyPage({ title: 'Jogo', text: 'Verifying you are human', length: 200 }), 'cloudflare');
  assert.deepEqual(classifyPage({ title: 'x | 522: Connection timed out', text: big }), { kind: 'server-error', code: 522 });
});

test('entrada vazia ou estranha devolve null', () => {
  assert.equal(classifyPage(), null);
  assert.equal(classifyPage({}), null);
  assert.equal(classifyPage({ title: null, text: undefined }), null);
});

// ---------- teste de internet (com net falso) ----------
const fakeNet = ({ online = true, fetch }) => ({ isOnline: () => online, fetch });

test('sem rede do Windows, nem tenta a requisição', async () => {
  let calls = 0;
  const check = createInternetCheck({ getNet: () => fakeNet({ online: false, fetch: async () => calls++ }) });
  assert.equal(await check(), false);
  assert.equal(calls, 0);
});

test('com rede e uma resposta, há internet; só HEAD, sem dados da pessoa', async () => {
  const seen = [];
  const check = createInternetCheck({
    getNet: () => fakeNet({ fetch: async (url, opts) => (seen.push([url, opts.method]), { status: 204 }) }),
  });
  assert.equal(await check(), true);
  assert.ok(seen.length > 0 && seen.every(([, method]) => method === 'HEAD'));
});

test('se um endereço falha mas o outro responde, há internet', async () => {
  let n = 0;
  const check = createInternetCheck({
    getNet: () => fakeNet({ fetch: async () => (n++ === 0 ? Promise.reject(new Error('x')) : { status: 200 }) }),
  });
  assert.equal(await check(), true);
});

test('se todos falham ou passam do tempo, está sem internet', async () => {
  const fail = createInternetCheck({ getNet: () => fakeNet({ fetch: async () => { throw new Error('down'); } }) });
  assert.equal(await fail(), false);
  const hang = createInternetCheck({
    timeoutMs: 20,
    getNet: () => fakeNet({
      fetch: (_url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('abort')))),
    }),
  });
  assert.equal(await hang(), false);
});

test('várias contas perguntando juntas dividem uma requisição só', async () => {
  let calls = 0;
  const check = createInternetCheck({
    urls: ['https://a.test/'],
    getNet: () => fakeNet({ fetch: async () => (calls++, { status: 204 }) }),
  });
  const r = await Promise.all([check(), check(), check()]);
  assert.deepEqual(r, [true, true, true]);
  assert.equal(calls, 1);
});

test('a resposta vale por alguns segundos e depois testa de novo', async () => {
  let calls = 0;
  let clock = 0;
  const check = createInternetCheck({
    urls: ['https://a.test/'],
    now: () => clock,
    getNet: () => fakeNet({ fetch: async () => (calls++, { status: 204 }) }),
  });
  await check();
  clock = 1000;
  await check();
  assert.equal(calls, 1);
  clock = 10_000;
  await check();
  assert.equal(calls, 2);
});

test('reconectando só vale depois de 3 minutos seguidos', () => {
  const t0 = 1_000_000;
  assert.equal(RECONNECT_LIMIT_MS, 3 * MIN);
  assert.equal(reconnectingTooLong(0, t0), false); // texto não está na tela
  assert.equal(reconnectingTooLong(t0, t0), false);
  assert.equal(reconnectingTooLong(t0, t0 + 3 * MIN - 1), false);
  assert.equal(reconnectingTooLong(t0, t0 + 3 * MIN), true);
  assert.equal(reconnectingTooLong(t0, t0 + 10 * MIN), true);
});
