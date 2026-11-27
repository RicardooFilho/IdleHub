// Conexão da conta com o servidor do jogo (src/main/connection.js): só funções puras, sem Electron.
const test = require('node:test');
const assert = require('node:assert');
const {
  SILENT_DEFAULT_MS, DROP_GRACE_MS, RELOAD_AFTER_DROP_MS, RHYTHM_BUCKET_MS, RHYTHM_BUCKETS,
  createConnection, noteHttp, noteSockets, restartDropWait, connectionState, silentAfterMs,
  shouldNotifySilence, countsAsActivity, fmtIdle,
} = require('../src/main/connection');

const SEC = 1000;
const MIN = 60 * SEC;
const T0 = 10_000_000;
const state = (c, now, opts) => connectionState(c, now, opts).state;

// Página com um WebSocket aberto que mandou a última mensagem há `msgAge` ms.
const openSnap = (msgAge = 0) => ({ open: 1, ever: true, msg: msgAge, opened: 60 * SEC, closed: -1 });

test('conta recém-aberta, sem nenhuma atividade, não é julgada', () => {
  const c = createConnection();
  assert.equal(state(c, T0), 'unknown');
  assert.equal(state(null, T0), 'unknown');
  noteSockets(c, null, T0); // lixo da página não quebra
  noteSockets(c, 'oi', T0);
  assert.equal(state(c, T0), 'unknown');
});

test('WebSocket aberto recebendo mensagens: conectada', () => {
  const c = createConnection();
  noteSockets(c, openSnap(2 * SEC), T0);
  assert.deepEqual(connectionState(c, T0), { state: 'connected', idleMs: 2 * SEC, reload: false });
});

test('WebSocket aberto mas calado por 5 minutos: sem dados, e não manda recarregar', () => {
  const c = createConnection();
  noteSockets(c, openSnap(10 * SEC), T0);
  const r = connectionState(c, T0 + SILENT_DEFAULT_MS);
  assert.equal(r.state, 'silent');
  assert.equal(r.idleMs, 10 * SEC + SILENT_DEFAULT_MS);
  assert.equal(r.reload, false);
  assert.equal(connectionState(c, T0 + 30 * MIN).reload, false);
});

test('chegou mensagem de novo: volta a ficar conectada', () => {
  const c = createConnection();
  noteSockets(c, openSnap(0), T0);
  assert.equal(state(c, T0 + 6 * MIN), 'silent');
  noteSockets(c, openSnap(SEC), T0 + 6 * MIN);
  assert.equal(state(c, T0 + 6 * MIN), 'connected');
});

test('socket fechou e nenhum abriu: depois da tolerância é "caiu", e só recarrega depois da espera', () => {
  const c = createConnection();
  noteSockets(c, { open: 0, ever: true, msg: 20 * SEC, opened: 60 * SEC, closed: 10 * SEC }, T0 + 20 * SEC); // fechou em T0+10s
  const closedAt = T0 + 10 * SEC;
  assert.equal(state(c, closedAt + DROP_GRACE_MS - SEC), 'connected', 'o jogo ainda pode reconectar sozinho');
  const dropped = connectionState(c, closedAt + DROP_GRACE_MS);
  assert.equal(dropped.state, 'dropped');
  assert.equal(dropped.reload, false);
  assert.equal(connectionState(c, closedAt + RELOAD_AFTER_DROP_MS - SEC).reload, false);
  assert.equal(connectionState(c, closedAt + RELOAD_AFTER_DROP_MS).reload, true);
});

test('o jogo reconectou dentro da tolerância: nunca vira "caiu"', () => {
  const c = createConnection();
  noteSockets(c, { open: 0, ever: true, msg: 5 * SEC, opened: 60 * SEC, closed: 4 * SEC }, T0);
  noteSockets(c, { open: 1, ever: true, msg: 1 * SEC, opened: 2 * SEC, closed: 12 * SEC }, T0 + 14 * SEC); // abriu outro
  assert.equal(state(c, T0 + 3 * MIN), 'connected');
});

test('jogo sem WebSocket não é acusado de cair', () => {
  const c = createConnection();
  for (let i = 0; i < RHYTHM_BUCKETS; i++) noteHttp(c, T0 + i * RHYTHM_BUCKET_MS);
  noteSockets(c, { open: 0, ever: false, msg: -1, opened: -1, closed: -1 }, T0 + 90 * SEC);
  assert.equal(c.everOpened, false);
  assert.equal(state(c, T0 + 90 * SEC + 3 * MIN), 'connected');
});

test('pedidos HTTP depois do socket fechar: a conta ainda fala com o servidor, não "caiu"', () => {
  const c = createConnection();
  noteSockets(c, { open: 0, ever: true, msg: 60 * SEC, opened: 90 * SEC, closed: 50 * SEC }, T0); // fechou em T0-50s
  assert.equal(state(c, T0), 'dropped');
  noteHttp(c, T0 + SEC);
  assert.equal(state(c, T0 + 2 * SEC), 'connected');
});

test('jogo sem WebSocket: só os pedidos da carga da página não bastam para dizer "sem dados"', () => {
  const c = createConnection();
  for (let i = 0; i < 20; i++) noteHttp(c, T0 + i * 100); // rajada ao abrir
  assert.equal(state(c, T0 + 30 * MIN), 'unknown');
});

test('jogo sem WebSocket que pede de tempos em tempos: depois do ritmo, o silêncio conta', () => {
  const c = createConnection();
  for (let i = 0; i < RHYTHM_BUCKETS; i++) noteHttp(c, T0 + i * RHYTHM_BUCKET_MS);
  const last = T0 + (RHYTHM_BUCKETS - 1) * RHYTHM_BUCKET_MS;
  assert.equal(state(c, last + 2 * MIN), 'connected');
  assert.equal(state(c, last + SILENT_DEFAULT_MS), 'silent');
});

test('o tempo do "sem dados" vem da configuração, com piso de 1 minuto', () => {
  assert.equal(silentAfterMs(0), SILENT_DEFAULT_MS);
  assert.equal(silentAfterMs(undefined), SILENT_DEFAULT_MS);
  assert.equal(silentAfterMs('x'), SILENT_DEFAULT_MS);
  assert.equal(silentAfterMs(10), 10 * MIN);
  const c = createConnection();
  noteSockets(c, openSnap(0), T0);
  assert.equal(state(c, T0 + 9 * MIN, { silentAfterMs: silentAfterMs(10) }), 'connected');
  assert.equal(state(c, T0 + 10 * MIN, { silentAfterMs: silentAfterMs(10) }), 'silent');
  assert.equal(state(c, T0 + 61 * SEC, { silentAfterMs: 5 }), 'silent', 'nunca abaixo de 1 minuto');
  assert.equal(state(c, T0 + 59 * SEC, { silentAfterMs: 5 }), 'connected');
});

test('aviso de "sem dados": só se ligado, e uma vez por período', () => {
  assert.equal(shouldNotifySilence({ state: 'silent', minutes: 0, notified: false }), false);
  assert.equal(shouldNotifySilence({ state: 'silent', minutes: 5, notified: false }), true);
  assert.equal(shouldNotifySilence({ state: 'silent', minutes: 5, notified: true }), false);
  assert.equal(shouldNotifySilence({ state: 'connected', minutes: 5, notified: false }), false);
  assert.equal(shouldNotifySilence({ state: 'dropped', minutes: 5, notified: false }), false);
});

test('internet voltou: a espera de "caiu" recomeça do zero', () => {
  const c = createConnection();
  noteSockets(c, { open: 0, ever: true, msg: 20 * MIN, opened: 30 * MIN, closed: 10 * MIN }, T0);
  assert.equal(connectionState(c, T0).reload, true);
  restartDropWait(c, T0);
  assert.notEqual(state(c, T0 + DROP_GRACE_MS - SEC), 'dropped');
  assert.equal(state(c, T0 + DROP_GRACE_MS), 'dropped');
  assert.equal(connectionState(c, T0 + DROP_GRACE_MS).reload, false);
  // Com socket aberto, não mexe em nada.
  const d = createConnection();
  noteSockets(d, openSnap(0), T0);
  restartDropWait(d, T0 + MIN);
  assert.equal(d.lastCloseAt, 0);
});

test('valores estranhos da página são ignorados', () => {
  const c = createConnection();
  noteSockets(c, { open: -5, ever: false, msg: NaN, opened: 'x', closed: Infinity }, T0);
  assert.equal(c.sockets, 0);
  assert.equal(c.lastActivityAt, 0);
  assert.equal(c.lastCloseAt, 0);
  noteSockets(c, { open: 1e9, ever: true, msg: -1, opened: -1, closed: -1 }, T0);
  assert.equal(c.sockets, 1000);
});

test('só pedidos XHR que o servidor respondeu de verdade contam', () => {
  assert.equal(countsAsActivity({ resourceType: 'xhr', statusCode: 200, fromCache: false }), true);
  assert.equal(countsAsActivity({ resourceType: 'xhr', statusCode: 404, fromCache: false }), true);
  assert.equal(countsAsActivity({ resourceType: 'xhr', statusCode: 503, fromCache: false }), false);
  assert.equal(countsAsActivity({ resourceType: 'xhr', statusCode: 200, fromCache: true }), false);
  assert.equal(countsAsActivity({ resourceType: 'image', statusCode: 200, fromCache: false }), false);
  assert.equal(countsAsActivity({ resourceType: 'xhr', statusCode: 0, fromCache: false }), false);
});

test('tempo sem dados em texto curto', () => {
  assert.equal(fmtIdle(10 * SEC), '1 min');
  assert.equal(fmtIdle(7 * MIN + 40 * SEC), '7 min');
  assert.equal(fmtIdle(60 * MIN), '1 h');
  assert.equal(fmtIdle(65 * MIN), '1 h 05 min');
});
