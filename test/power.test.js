const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { resumePlan, setupPower, LONG_SLEEP_MS, STAGGER_MS, ONLINE_POLL_MS, ONLINE_MAX_WAIT_MS } = require('../src/main/power');

test('resumePlan: sono curto só confere', () => {
  const plan = resumePlan({ sleptMs: LONG_SLEEP_MS - 1, keys: ['a:1', 'a:2'] });
  assert.strictEqual(plan.mode, 'check');
  assert.deepStrictEqual(plan.items, []);
});

test('resumePlan: sono longo recarrega e escalona as contas', () => {
  const plan = resumePlan({ sleptMs: LONG_SLEEP_MS, keys: ['a:1', 'a:2', 'b:1'] });
  assert.strictEqual(plan.mode, 'reload');
  assert.deepStrictEqual(plan.items, [
    { key: 'a:1', delayMs: 0 },
    { key: 'a:2', delayMs: STAGGER_MS },
    { key: 'b:1', delayMs: 2 * STAGGER_MS },
  ]);
});

test('resumePlan: lista vazia ou entrada estranha não quebra', () => {
  assert.deepStrictEqual(resumePlan({ sleptMs: LONG_SLEEP_MS * 2, keys: [] }), { mode: 'reload', items: [] });
  assert.strictEqual(resumePlan({ sleptMs: NaN, keys: ['a:1'] }).mode, 'check');
  assert.strictEqual(resumePlan({ sleptMs: LONG_SLEEP_MS, keys: null }).items.length, 0);
});

// Monta powerMonitor, mgr e net falsos, com relógio controlado.
function setup({ online = true, keys = ['a:1', 'a:2', 'a:3'] } = {}) {
  const powerMonitor = new EventEmitter();
  const calls = { reload: [], tick: 0, logs: [] };
  const clock = { t: 1000 };
  const state = { online };
  const mgr = {
    liveKeys: () => keys,
    reloadForResume: (key, reason) => calls.reload.push([key, reason]),
    tick: () => { calls.tick++; },
    log: (rt, text) => calls.logs.push(text),
  };
  const net = { isOnline: () => state.online };
  const power = setupPower({ powerMonitor, mgr, net, now: () => clock.t });
  return { powerMonitor, calls, clock, state, power };
}

test('setupPower: sono longo recarrega uma conta de cada vez e avisa uma vez só', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { powerMonitor, calls, clock, power } = setup();
  powerMonitor.emit('suspend');
  clock.t += LONG_SLEEP_MS + 1;
  powerMonitor.emit('resume');

  assert.strictEqual(calls.logs.length, 1);
  assert.match(calls.logs[0], /voltou da suspensão/);
  assert.deepStrictEqual(calls.reload.map((c) => c[0]), ['a:1']);
  t.mock.timers.tick(STAGGER_MS);
  assert.deepStrictEqual(calls.reload.map((c) => c[0]), ['a:1', 'a:2']);
  t.mock.timers.tick(STAGGER_MS);
  assert.deepStrictEqual(calls.reload.map((c) => c[0]), ['a:1', 'a:2', 'a:3']);
  assert.strictEqual(calls.tick, 0);
  power.dispose();
});

test('setupPower: sono curto chama só o tick do watchdog', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { powerMonitor, calls, clock } = setup();
  powerMonitor.emit('suspend');
  clock.t += 30000;
  powerMonitor.emit('resume');
  assert.strictEqual(calls.tick, 1);
  assert.strictEqual(calls.reload.length, 0);
  assert.strictEqual(calls.logs.length, 0);
});

test('setupPower: espera a internet voltar antes de recarregar', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { powerMonitor, calls, clock, state } = setup({ online: false, keys: ['a:1'] });
  powerMonitor.emit('suspend');
  clock.t += LONG_SLEEP_MS;
  powerMonitor.emit('resume');
  t.mock.timers.tick(ONLINE_POLL_MS * 3);
  assert.strictEqual(calls.reload.length, 0);
  state.online = true;
  t.mock.timers.tick(ONLINE_POLL_MS);
  assert.deepStrictEqual(calls.reload.map((c) => c[0]), ['a:1']);
});

test('setupPower: sem internet depois de 60 s segue assim mesmo', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { powerMonitor, calls, clock } = setup({ online: false, keys: ['a:1'] });
  powerMonitor.emit('suspend');
  clock.t += LONG_SLEEP_MS;
  powerMonitor.emit('resume');
  // Passo a passo, como o relógio de verdade (cada espera agenda a próxima).
  for (let ms = 0; ms < ONLINE_MAX_WAIT_MS - ONLINE_POLL_MS; ms += ONLINE_POLL_MS) t.mock.timers.tick(ONLINE_POLL_MS);
  assert.strictEqual(calls.reload.length, 0);
  t.mock.timers.tick(ONLINE_POLL_MS);
  assert.deepStrictEqual(calls.reload.map((c) => c[0]), ['a:1']);
});

test('setupPower: suspender de novo cancela as recargas que faltavam', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { powerMonitor, calls, clock } = setup();
  powerMonitor.emit('suspend');
  clock.t += LONG_SLEEP_MS;
  powerMonitor.emit('resume');
  powerMonitor.emit('suspend');
  t.mock.timers.tick(STAGGER_MS * 5);
  assert.deepStrictEqual(calls.reload.map((c) => c[0]), ['a:1']);
});

test('setupPower: retomar sem ter suspendido conta como sono curto', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { powerMonitor, calls } = setup();
  powerMonitor.emit('resume');
  assert.strictEqual(calls.tick, 1);
  assert.strictEqual(calls.reload.length, 0);
});
