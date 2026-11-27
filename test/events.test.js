const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEventLog, summarize, sanitize, FILE, RETENTION_MS } = require('../src/main/events');

const H = 3600 * 1000;
const MIN = 60 * 1000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-events-'));
const ev = (t, type, key = null, extra = {}) => ({ t, type, key, game: key ? 'PokeIdle' : null, who: key ? `Conta ${key.split(':')[1]}` : null, ...extra });

// ---------- sanitize

test('sanitize: tira links, corta o tamanho e recusa tipo desconhecido', () => {
  const e = sanitize({ type: 'reload', key: 'a:1', detail: 'foi para https://x.com/?token=abc123 depois' }, 5);
  assert.strictEqual(e.detail, 'foi para [link] depois');
  assert.strictEqual(sanitize({ type: 'reload', detail: 'x'.repeat(500) }, 5).detail.length, 120);
  assert.strictEqual(sanitize({ type: 'nao-existe' }, 5), null);
  assert.strictEqual(sanitize(null, 5), null);
  assert.strictEqual(sanitize({ type: 'crash' }, 77).t, 77); // sem hora: usa a de agora
});

// ---------- registro em disco

test('createEventLog: grava em lote no events.jsonl e relê na próxima abertura', async () => {
  const dir = tmp();
  let now = 1_000_000;
  const log = createEventLog({ dir, now: () => now, flushMs: 10_000 });
  log.add({ type: 'app-start' });
  log.add({ type: 'crash', key: 'a:1', game: 'PokeIdle', who: 'Conta 1', detail: 'crashed' });
  assert.strictEqual(fs.existsSync(path.join(dir, FILE)), false, 'ainda não gravou: a escrita é em lote');
  await log.flush();
  const lines = fs.readFileSync(path.join(dir, FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines.map((l) => l.type), ['app-start', 'crash']);
  assert.deepStrictEqual(Object.keys(lines[1]).sort(), ['detail', 'game', 'key', 't', 'type', 'who']);

  const again = createEventLog({ dir, now: () => now });
  assert.strictEqual(again.all().length, 2);
  assert.strictEqual(again.query(0, Infinity)[1].key, 'a:1');
  log.close();
  again.close();
});

test('createEventLog: close() grava o que faltava (fechamento do app)', () => {
  const dir = tmp();
  const log = createEventLog({ dir, flushMs: 60_000 });
  log.add({ type: 'app-stop' });
  log.close();
  assert.match(fs.readFileSync(path.join(dir, FILE), 'utf8'), /app-stop/);
});

test('createEventLog: ao abrir, apaga o que passou de 7 dias e linhas quebradas', () => {
  const dir = tmp();
  const now = 100 * 24 * H;
  const old = { t: now - RETENTION_MS - H, type: 'crash', key: 'a:1' };
  const fresh = { t: now - H, type: 'crash', key: 'a:1' };
  fs.writeFileSync(path.join(dir, FILE), [JSON.stringify(old), '{linha cortada', JSON.stringify(fresh), ''].join('\n'));
  const log = createEventLog({ dir, now: () => now });
  assert.deepStrictEqual(log.all().map((e) => e.t), [fresh.t]);
  const onDisk = fs.readFileSync(path.join(dir, FILE), 'utf8').trim().split('\n');
  assert.strictEqual(onDisk.length, 1, 'o arquivo foi reescrito já limpo');
  log.close();
});

test('createEventLog: prune() com o app aberto tira o velho do arquivo e da memória', async () => {
  const dir = tmp();
  let now = 50 * 24 * H;
  const log = createEventLog({ dir, now: () => now, pruneEveryMs: 0 });
  log.add({ type: 'crash', key: 'a:1' });
  now += RETENTION_MS + H; // passam 7 dias e 1 hora
  log.add({ type: 'recovered', key: 'a:1' });
  await log.prune();
  assert.deepStrictEqual(log.all().map((e) => e.type), ['recovered']);
  const onDisk = fs.readFileSync(path.join(dir, FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(onDisk.map((e) => e.type), ['recovered']);
  log.close();
});

test('createEventLog: sem pasta funciona só na memória e query filtra por período', () => {
  const log = createEventLog({ now: () => 10 });
  log.add({ t: 100, type: 'crash', key: 'a:1' });
  log.add({ t: 200, type: 'recovered', key: 'a:1' });
  assert.strictEqual(log.file, null);
  assert.deepStrictEqual(log.query(150, 250).map((e) => e.type), ['recovered']);
  assert.strictEqual(log.add({ type: 'lixo' }), null);
});

// ---------- summarize

test('summarize: queda resolvida, queda sem resolver e alertas por conta', () => {
  const t0 = 10 * H;
  const events = [
    ev(t0 - H, 'app-start'),
    ev(t0 - H, 'live-start', 'p:1'),
    ev(t0 - H, 'live-start', 'p:2'),
    ev(t0 + 10 * MIN, 'crash', 'p:1', { detail: 'crashed' }),
    ev(t0 + 11 * MIN, 'reload', 'p:1', { detail: 'a página tinha travado' }),
    ev(t0 + 12 * MIN, 'recovered', 'p:1'),
    ev(t0 + 30 * MIN, 'server-down', 'p:2'),
    ev(t0 + 40 * MIN, 'alert', 'p:2', { detail: 'Energia cheia' }),
    ev(t0 + 50 * MIN, 'alert', 'p:2', { detail: 'Energia cheia' }),
    ev(t0 + 55 * MIN, 'alert', 'p:2', { detail: 'Boss' }),
  ];
  const s = summarize(events, t0, t0 + 2 * H, { accounts: { 'p:2': { game: 'PokeIdle', who: 'Conta 2', status: 'server-down' }, 'p:1': { status: 'ok' } } });
  assert.strictEqual(s.totals.drops, 2);
  assert.strictEqual(s.totals.resolved, 1);
  assert.strictEqual(s.totals.unresolved, 1);
  assert.strictEqual(s.totals.alerts, 3);
  assert.strictEqual(s.totals.reloads, 1);
  const p1 = s.byAccount.find((r) => r.key === 'p:1');
  assert.deepStrictEqual([p1.drops, p1.resolved, p1.unresolved, p1.reloads], [1, 1, 0, 1], 'crash + reload + recovered = uma queda só');
  const p2 = s.byAccount.find((r) => r.key === 'p:2');
  assert.deepStrictEqual(p2.alertNames, [{ name: 'Energia cheia', count: 2 }, { name: 'Boss', count: 1 }]);
  assert.deepStrictEqual(s.needsAttention, [{ key: 'p:2', game: 'PokeIdle', who: 'Conta 2', status: 'server-down' }]);
  assert.strictEqual(s.byGame.length, 1);
  assert.strictEqual(s.byGame[0].drops, 2);
  assert.strictEqual(s.empty, false);
});

test('summarize: tempo rodando só conta o período e desconta o PC dormindo', () => {
  const t0 = 100 * H;
  const events = [
    ev(t0 - 5 * H, 'live-start', 'p:1'), // já rodava antes do período
    ev(t0 + 1 * H, 'suspend'),
    ev(t0 + 2 * H, 'resume'),
    ev(t0 + 3 * H, 'live-stop', 'p:1'),
    ev(t0 + 3 * H, 'live-start', 'p:2'),
  ];
  const s = summarize(events, t0, t0 + 4 * H);
  assert.strictEqual(s.byAccount.find((r) => r.key === 'p:1').runningMs, 2 * H, '3 h ligada menos 1 h dormindo');
  assert.strictEqual(s.byAccount.find((r) => r.key === 'p:2').runningMs, 1 * H, 'ainda ligada no fim do período');
  assert.strictEqual(s.suspendedMs, 1 * H);
  assert.strictEqual(s.totals.runningMs, 3 * H);
  assert.strictEqual(s.totals.accounts, 2);
});

test('summarize: app fechado sem avisar para o tempo na última coisa que se soube', () => {
  const t0 = 10 * H;
  const events = [
    ev(t0, 'app-start'),
    ev(t0, 'live-start', 'p:1'),
    ev(t0 + 1 * H, 'alert', 'p:1', { detail: 'x' }), // última notícia antes da queda de energia
    ev(t0 + 5 * H, 'app-start'),
    ev(t0 + 5 * H, 'live-start', 'p:1'),
  ];
  const s = summarize(events, t0, t0 + 6 * H);
  assert.strictEqual(s.byAccount[0].runningMs, 1 * H + 1 * H);
  // app-stop é exato
  const s2 = summarize([ev(t0, 'live-start', 'p:1'), ev(t0 + 2 * H, 'app-stop')], t0, t0 + 6 * H);
  assert.strictEqual(s2.byAccount[0].runningMs, 2 * H);
});

test('summarize: internet caída conta quantas vezes e por quanto tempo', () => {
  const t0 = 10 * H;
  const events = [ev(t0 + 10 * MIN, 'offline'), ev(t0 + 40 * MIN, 'online'), ev(t0 + 90 * MIN, 'offline')];
  const s = summarize(events, t0, t0 + 2 * H);
  assert.strictEqual(s.offline.count, 2);
  assert.strictEqual(s.offline.ms, 30 * MIN + 30 * MIN, 'a segunda queda ainda estava aberta no fim');
});

test('summarize: queda que começou antes do período não entra, e o que vem depois de "to" é ignorado', () => {
  const t0 = 10 * H;
  const events = [
    ev(t0 - 2 * H, 'crash', 'p:1'),
    ev(t0 + 10 * MIN, 'recovered', 'p:1'),
    ev(t0 + 3 * H, 'crash', 'p:1'), // depois do fim
  ];
  const s = summarize(events, t0, t0 + 1 * H);
  assert.strictEqual(s.totals.drops, 0);
  assert.strictEqual(s.totals.resolved, 0);
});

test('summarize: quedas seguidas da mesma conta sem recuperação são uma só', () => {
  const t0 = 10 * H;
  const events = [ev(t0 + MIN, 'server-down', 'p:1'), ev(t0 + 2 * MIN, 'reload', 'p:1'), ev(t0 + 3 * MIN, 'gave-up', 'p:1')];
  const s = summarize(events, t0, t0 + H, { accounts: { 'p:1': { game: 'PokeIdle', who: 'Conta 1', status: 'attention' } } });
  assert.strictEqual(s.totals.drops, 1);
  assert.strictEqual(s.totals.unresolved, 1);
  assert.strictEqual(s.needsAttention.length, 1);
});

test('summarize: período vazio e entrada estranha não quebram', () => {
  const s = summarize([], 0, H);
  assert.strictEqual(s.empty, true);
  assert.deepStrictEqual(s.byAccount, []);
  assert.strictEqual(summarize(null, 0, H).empty, true);
  assert.strictEqual(summarize([{ t: 'x', type: 'crash' }, null, ev(5, 'crash')], 0, H).totals.drops, 0, 'evento de conta sem conta é ignorado');
  assert.strictEqual(s.durationMs, H);
});
