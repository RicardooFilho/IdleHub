const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { trackAway, awayOnResume, setupAway, thresholdOf, HOUR_MS } = require('../src/main/away');

const MIN = 60 * 1000;
const T = 2 * HOUR_MS;

test('thresholdOf: horas viram ms e 0 ou lixo desliga', () => {
  assert.strictEqual(thresholdOf(2), 2 * HOUR_MS);
  assert.strictEqual(thresholdOf(0.5), 30 * MIN);
  assert.strictEqual(thresholdOf(0), 0);
  assert.strictEqual(thresholdOf('abc'), 0);
  assert.strictEqual(thresholdOf(-1), 0);
});

test('trackAway: a primeira consulta só guarda o estado', () => {
  const r = trackAway(null, { now: 1000, idleMs: 5000, thresholdMs: T });
  assert.deepStrictEqual(r, { state: { at: 1000, idleMs: 5000 }, away: null });
});

test('trackAway: ocioso por horas e voltou a mexer = ausência, com início e fim certos', () => {
  const t = 50 * HOUR_MS;
  // última consulta: parado há 3 h; agora: mexeu há 10 s
  const r = trackAway({ at: t, idleMs: 3 * HOUR_MS }, { now: t + 30_000, idleMs: 10_000, thresholdMs: T });
  assert.deepStrictEqual(r.away, { from: t - 3 * HOUR_MS, to: t + 30_000 - 10_000 });
  assert.deepStrictEqual(r.state, { at: t + 30_000, idleMs: 10_000 });
});

test('trackAway: ainda parado, ausência curta ou sem queda da ociosidade não avisa', () => {
  const t = 50 * HOUR_MS;
  assert.strictEqual(trackAway({ at: t, idleMs: 3 * HOUR_MS }, { now: t + 30_000, idleMs: 3 * HOUR_MS + 30_000, thresholdMs: T }).away, null, 'ainda fora');
  assert.strictEqual(trackAway({ at: t, idleMs: 30 * MIN }, { now: t + 30_000, idleMs: 1000, thresholdMs: T }).away, null, 'saiu só 30 min');
  assert.strictEqual(trackAway({ at: t, idleMs: 3 * HOUR_MS }, { now: t + 30_000, idleMs: 3 * HOUR_MS - 2000, thresholdMs: T }).away, null, 'oscilação pequena');
});

test('trackAway: desligado (0 horas) nunca avisa', () => {
  const t = 50 * HOUR_MS;
  assert.strictEqual(trackAway({ at: t, idleMs: 9 * HOUR_MS }, { now: t + 30_000, idleMs: 0, thresholdMs: 0 }).away, null);
});

test('awayOnResume: PC dormiu por horas = ausência desde que a pessoa parou de mexer', () => {
  const t = 80 * HOUR_MS;
  const r = awayOnResume({ suspendedAt: t, resumedAt: t + 8 * HOUR_MS, idleAtSuspendMs: 10 * MIN, thresholdMs: T });
  assert.deepStrictEqual(r, { from: t - 10 * MIN, to: t + 8 * HOUR_MS });
  assert.strictEqual(awayOnResume({ suspendedAt: t, resumedAt: t + 30 * MIN, thresholdMs: T }), null);
  assert.strictEqual(awayOnResume({ suspendedAt: null, resumedAt: t, thresholdMs: T }), null);
  assert.strictEqual(awayOnResume({ suspendedAt: t, resumedAt: t + 9 * HOUR_MS, thresholdMs: 0 }), null);
});

// powerMonitor falso com relógio e ociosidade controlados.
function setup({ hours = 2 } = {}) {
  const pm = new EventEmitter();
  const clock = { t: 1000 * HOUR_MS, idle: 0 };
  pm.getSystemIdleTime = () => clock.idle / 1000;
  const backs = [];
  const cfg = { hours };
  const away = setupAway({ powerMonitor: pm, getHours: () => cfg.hours, onBack: (b) => backs.push(b), now: () => clock.t, pollMs: 1e9 });
  const step = (ms, idleMs) => {
    clock.t += ms;
    clock.idle = idleMs;
    away.poll();
  };
  return { pm, clock, backs, cfg, away, step };
}

test('setupAway: acompanha a ociosidade e avisa uma vez quando a pessoa volta', () => {
  const { backs, step, clock, away } = setup();
  step(0, 0);
  for (let i = 1; i <= 8; i++) step(30 * MIN, i * 30 * MIN); // 4 h parado
  assert.strictEqual(backs.length, 0, 'ainda fora');
  const leftAt = clock.t - 4 * HOUR_MS;
  step(30_000, 5000); // mexeu o mouse
  assert.strictEqual(backs.length, 1);
  assert.strictEqual(backs[0].via, 'idle');
  assert.strictEqual(backs[0].from, leftAt);
  step(30_000, 35_000);
  assert.strictEqual(backs.length, 1, 'não repete');
  away.dispose();
});

test('setupAway: suspensão longa avisa ao acordar e ignora a ociosidade velha', () => {
  const { pm, clock, backs, step, away } = setup();
  step(0, 0);
  step(30_000, 10 * MIN); // parado há 10 min
  pm.emit('suspend');
  clock.t += 7 * HOUR_MS;
  clock.idle = 0;
  pm.emit('resume');
  assert.strictEqual(backs.length, 1);
  assert.strictEqual(backs[0].via, 'resume');
  assert.ok(backs[0].to - backs[0].from >= 7 * HOUR_MS);
  step(30_000, 1000);
  assert.strictEqual(backs.length, 1);
  away.dispose();
});

test('setupAway: suspensão curta e configuração em 0 não avisam', () => {
  const a = setup();
  a.step(0, 0);
  a.pm.emit('suspend');
  a.clock.t += 20 * MIN;
  a.pm.emit('resume');
  assert.strictEqual(a.backs.length, 0);
  a.away.dispose();

  const b = setup({ hours: 0 });
  b.step(0, 0);
  b.pm.emit('suspend');
  b.clock.t += 9 * HOUR_MS;
  b.pm.emit('resume');
  assert.strictEqual(b.backs.length, 0);
  b.away.dispose();
});
