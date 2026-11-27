const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const daily = require('../src/main/daily');
const { summarize } = require('../src/main/events');

const H = 3600 * 1000;
const MIN = 60 * 1000;
// Datas locais (o agendador usa a hora do PC): 27/11/2026 em diante.
const at = (day, h, m = 0) => new Date(2026, 10, day, h, m, 0, 0).getTime();

// ---------- horário

test('parseTime / normalizeTime: aceita HH:MM e recusa o resto', () => {
  assert.deepStrictEqual(daily.parseTime('21:00'), { h: 21, m: 0 });
  assert.deepStrictEqual(daily.parseTime('7:05'), { h: 7, m: 5 });
  for (const bad of ['24:00', '12:60', '9', '', null, undefined, 'abc', '12:5', '12:00:00']) assert.strictEqual(daily.parseTime(bad), null, String(bad));
  assert.strictEqual(daily.normalizeTime('7:05'), '07:05');
  assert.strictEqual(daily.normalizeTime('lixo'), '21:00');
  assert.strictEqual(daily.normalizeTime('lixo', '08:30'), '08:30');
});

test('nextDue: hoje se o horário ainda não passou, senão amanhã (e vira o mês)', () => {
  assert.strictEqual(daily.nextDue(at(27, 10), '21:00'), at(27, 21));
  assert.strictEqual(daily.nextDue(at(27, 21), '21:00'), at(28, 21), 'na hora exata já é o próximo');
  assert.strictEqual(daily.nextDue(at(27, 23, 59), '21:00'), at(28, 21));
  assert.strictEqual(daily.nextDue(at(30, 22), '21:00'), new Date(2026, 11, 1, 21, 0).getTime(), 'virada de mês');
  assert.strictEqual(daily.nextDue(at(27, 0, 0), '00:00'), at(28, 0));
});

test('lastDue: hoje se já passou, senão ontem', () => {
  assert.strictEqual(daily.lastDue(at(27, 22), '21:00'), at(27, 21));
  assert.strictEqual(daily.lastDue(at(27, 21), '21:00'), at(27, 21));
  assert.strictEqual(daily.lastDue(at(27, 8), '21:00'), at(26, 21));
});

// ---------- quando mandar

test('dueNow: não é hora ainda (o horário de hoje não chegou e o de ontem já foi)', () => {
  assert.strictEqual(daily.dueNow({ now: at(27, 8), time: '21:00', lastAt: at(26, 21) }), null);
});

test('dueNow: na hora, devolve as 24 h até o horário marcado', () => {
  const r = daily.dueNow({ now: at(27, 21, 1), time: '21:00', lastAt: at(26, 21) });
  assert.deepStrictEqual(r, { from: at(26, 21), to: at(27, 21) });
});

test('dueNow: não repete depois de enviado', () => {
  assert.strictEqual(daily.dueNow({ now: at(27, 21, 30), time: '21:00', lastAt: at(27, 21) }), null);
  assert.strictEqual(daily.dueNow({ now: at(27, 23, 59), time: '21:00', lastAt: at(27, 21) }), null);
});

test('dueNow: PC desligado ou dormindo no horário manda uma vez ao voltar, se não passou tempo demais', () => {
  // dormiu às 20:00 e acordou às 23:30 (2h30 depois do horário)
  const r = daily.dueNow({ now: at(27, 23, 30), time: '21:00', lastAt: at(26, 21) });
  assert.deepStrictEqual(r, { from: at(26, 21), to: at(27, 21) });
  // passaram mais de 6 h: o resumo de ontem não interessa mais
  assert.strictEqual(daily.dueNow({ now: at(28, 5), time: '21:00', lastAt: at(26, 21) }), null);
  // no limite
  assert.ok(daily.dueNow({ now: at(28, 3), time: '21:00', lastAt: at(26, 21) }));
  assert.strictEqual(daily.dueNow({ now: at(28, 3, 1), time: '21:00', lastAt: at(26, 21) }), null);
});

test('dueNow: nunca enviado (lastAt 0) manda se o horário acabou de passar', () => {
  assert.ok(daily.dueNow({ now: at(27, 21, 5), time: '21:00', lastAt: 0 }));
  assert.ok(daily.dueNow({ now: at(27, 21, 5), time: '21:00' }));
});

test('dueNow: depois da meia-noite o horário marcado é o de ontem', () => {
  const r = daily.dueNow({ now: at(28, 0, 10), time: '23:55', lastAt: at(26, 23, 55) });
  assert.deepStrictEqual(r, { from: at(26, 23, 55), to: at(27, 23, 55) });
});

// ---------- agendador

const fakePower = () => Object.assign(new EventEmitter(), { removeListener(...a) { return EventEmitter.prototype.removeListener.apply(this, a); } });

function makeJob({ now, settings = { dailySummary: true, dailySummaryTime: '21:00' }, lastAt = 0 }) {
  const state = { now, lastAt, calls: [], settings };
  const power = fakePower();
  const job = daily.setupDaily({
    getSettings: () => state.settings,
    getLastAt: () => state.lastAt,
    setLastAt: (t) => { state.lastAt = t; },
    onDue: (p) => state.calls.push(p),
    powerMonitor: power,
    now: () => state.now,
    pollMs: 1e9,
    resumeDelayMs: 1e9, // os testes chamam check() à mão
  });
  return { state, job, power };
}

test('setupDaily: manda uma vez por dia, e marca o horário enviado', () => {
  const { state, job } = makeJob({ now: at(27, 20, 59), lastAt: at(26, 21) });
  assert.strictEqual(job.check(), null);
  state.now = at(27, 21, 0);
  assert.deepStrictEqual(job.check(), { from: at(26, 21), to: at(27, 21) });
  assert.strictEqual(state.lastAt, at(27, 21));
  state.now = at(27, 21, 1);
  assert.strictEqual(job.check(), null);
  state.now = at(28, 21, 0);
  assert.ok(job.check());
  assert.strictEqual(state.calls.length, 2);
  job.dispose();
});

test('setupDaily: desligado não manda', () => {
  const { state, job } = makeJob({ now: at(27, 21, 5), settings: { dailySummary: false, dailySummaryTime: '21:00' } });
  assert.strictEqual(job.check(), null);
  assert.strictEqual(state.calls.length, 0);
  job.dispose();
});

test('setupDaily: se o envio falhar, não repete a cada minuto', () => {
  const state = { lastAt: at(26, 21), n: 0 };
  const job = daily.setupDaily({
    getSettings: () => ({ dailySummary: true, dailySummaryTime: '21:00' }),
    getLastAt: () => state.lastAt,
    setLastAt: (t) => { state.lastAt = t; },
    onDue: () => { state.n++; throw new Error('boom'); },
    now: () => at(27, 21, 2),
    pollMs: 1e9,
    resumeDelayMs: 1e9,
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    job.check();
    job.check();
  } finally {
    console.warn = warn;
  }
  assert.strictEqual(state.n, 1);
  job.dispose();
});

test('setupDaily: ao voltar da suspensão confere de novo (com a espera para a internet voltar)', async () => {
  const state = { now: at(27, 23, 0), lastAt: at(26, 21), calls: 0 };
  const power = fakePower();
  const job = daily.setupDaily({
    getSettings: () => ({ dailySummary: true, dailySummaryTime: '21:00' }),
    getLastAt: () => state.lastAt,
    setLastAt: (t) => { state.lastAt = t; },
    onDue: () => state.calls++,
    powerMonitor: power,
    now: () => state.now,
    pollMs: 1e9,
    resumeDelayMs: 5,
  });
  await new Promise((r) => setTimeout(r, 40)); // a conferência da abertura do app já manda
  assert.strictEqual(state.calls, 1);
  state.now = at(28, 21, 3);
  power.emit('resume');
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(state.calls, 2);
  job.dispose();
  assert.strictEqual(power.listenerCount('resume'), 0);
});

// ---------- texto

const ev = (t, type, key = null, extra = {}) => ({ t, type, key, game: key ? 'PokeIdle' : null, who: key ? `Conta ${key.split(':')[1]}` : null, ...extra });

test('fmtDuration', () => {
  assert.strictEqual(daily.fmtDuration(10_000), 'menos de 1 min');
  assert.strictEqual(daily.fmtDuration(45 * MIN), '45 min');
  assert.strictEqual(daily.fmtDuration(2 * H), '2 h');
  assert.strictEqual(daily.fmtDuration(14 * H + 20 * MIN), '14 h 20 min');
});

test('formatDaily: texto com quedas, alertas por nome, tempo rodando, internet e atenção', () => {
  const from = at(26, 21);
  const to = at(27, 21);
  const events = [
    ev(from - H, 'live-start', 'p:1'),
    ev(from - H, 'live-start', 'p:2'),
    ev(from + 1 * H, 'crash', 'p:1'),
    ev(from + 1 * H + MIN, 'recovered', 'p:1'),
    ev(from + 2 * H, 'logged-out', 'p:2'),
    ev(from + 3 * H, 'alert', 'p:1', { detail: 'Raro apareceu' }),
    ev(from + 3 * H, 'alert', 'p:2', { detail: 'Raro apareceu' }),
    ev(from + 4 * H, 'alert', 'p:2', { detail: 'Baú cheio' }),
    ev(from + 5 * H, 'offline'),
    ev(from + 5 * H + 12 * MIN, 'online'),
  ];
  const s = summarize(events, from, to, { accounts: { 'p:2': { game: 'PokeIdle', who: 'Conta 2', status: 'logged-out' } } });
  const { title, body } = daily.formatDaily(s);
  assert.strictEqual(title, 'Resumo do dia — IdleHub');
  const lines = body.split('\n');
  assert.match(lines[0], /^Período: 26\/11 21:00 até 27\/11 21:00$/);
  assert.ok(lines.includes('Quedas: 2 (1 resolvidas, 1 sem resolver)'), body);
  assert.ok(lines.includes('Alertas: 3 — Raro apareceu ×2, Baú cheio'), body);
  assert.ok(lines.includes('Rodando: 48 h (somando 2 contas)'), body);
  assert.ok(lines.includes('Internet fora: 12 min (1 vez)'), body);
  assert.ok(lines.includes('Precisam de atenção agora:'), body);
  assert.ok(lines.includes('• PokeIdle · Conta 2 — Deslogada'), body);
  assert.ok(body.length < 600);
});

test('formatDaily: dia tranquilo', () => {
  const from = at(26, 21);
  const to = at(27, 21);
  const s = summarize([ev(from - H, 'live-start', 'p:1')], from, to);
  const { body } = daily.formatDaily(s);
  assert.match(body, /Quedas: nenhuma/);
  assert.match(body, /Alertas: nenhum/);
  assert.match(body, /Rodando: 24 h/);
  assert.match(body, /Tudo certo com as contas\./);
  assert.doesNotMatch(body, /atenção agora/);
});

test('formatDaily: sem nenhuma conta rodando e com muita coisa para olhar, continua curto', () => {
  const s = summarize([], at(26, 21), at(27, 21), {
    accounts: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`p:${i}`, { game: 'PokeIdle', who: `Conta ${i}`, status: 'crashed' }])),
  });
  const { body } = daily.formatDaily(s);
  assert.match(body, /Rodando: nenhuma conta rodou/);
  assert.match(body, /• …e mais 4/);
  assert.strictEqual(body.split('\n').filter((l) => l.startsWith('• ')).length, 9);
});

test('formatDaily: o mais longo possível cabe nos limites do Discord e do Telegram', () => {
  const { DISCORD_MAX_CHARS, TELEGRAM_MAX_CHARS } = require('../src/main/remote');
  const from = at(26, 21);
  const events = [];
  for (let i = 0; i < 30; i++) events.push(ev(from + i * MIN, 'alert', `p:${i}`, { detail: `Alerta número ${i} com nome bem longo para encher` }));
  const s = summarize(events, from, at(27, 21), {
    accounts: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p:${i}`, { game: 'Jogo com nome comprido', who: `Conta ${i}`, status: 'session-taken' }])),
  });
  const { title, body } = daily.formatDaily(s);
  assert.ok(title.length + body.length < Math.min(DISCORD_MAX_CHARS, TELEGRAM_MAX_CHARS));
});

test('shortLine: frase curta para a notificação', () => {
  const from = at(26, 21);
  const s = summarize([ev(from - H, 'live-start', 'p:1'), ev(from + H, 'crash', 'p:1')], from, at(27, 21), {
    accounts: { 'p:1': { game: 'PokeIdle', who: 'Conta 1', status: 'crashed' } },
  });
  const line = daily.shortLine(s);
  assert.match(line, /1 queda \(1 sem resolver\)/);
  assert.match(line, /1 conta precisa de atenção/);
  assert.match(line, /Clique para ver\.$/);
});

test('lastDayPeriod: as últimas 24 h até agora', () => {
  assert.deepStrictEqual(daily.lastDayPeriod(100 * H), { from: 76 * H, to: 100 * H });
});
