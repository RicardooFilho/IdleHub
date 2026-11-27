const test = require('node:test');
const assert = require('node:assert');
const {
  MetricsTracker, Ring, normalizeCpu, avgCpu, isHeavy, keyOfGame, APP, OTHER,
  MAX_POINTS, HEAVY_MEM_DEFAULT_MB, HEAVY_CPU_MIN_SAMPLES,
} = require('../src/main/metrics');

// Processo falso no formato do app.getAppMetrics(): cpu em % de um núcleo, memória em KB.
const proc = (cpu, mb) => ({ cpu: { percentUsage: cpu }, memory: { workingSetSize: mb * 1024 } });

test('normalizeCpu: converte % de um núcleo em % do PC e limita entre 0 e 100', () => {
  assert.strictEqual(normalizeCpu(100, 4), 25);
  assert.strictEqual(normalizeCpu(50, 8), 6.3);
  assert.strictEqual(normalizeCpu(1000, 4), 100);
  assert.strictEqual(normalizeCpu(-5, 4), 0);
  assert.strictEqual(normalizeCpu(undefined, 4), 0);
  assert.strictEqual(normalizeCpu(NaN, 4), 0);
  assert.strictEqual(normalizeCpu(40, 0), 40); // núcleos inválidos não dividem por zero
});

test('Ring: guarda só os últimos itens', () => {
  const r = new Ring(3);
  for (let i = 1; i <= 5; i++) r.push(i);
  assert.deepStrictEqual(r.toArray(), [3, 4, 5]);
  assert.strictEqual(r.last(), 5);
  assert.strictEqual(new Ring(2).last(), undefined);
});

test('avgCpu: só conta pontos dentro da janela', () => {
  const pts = [{ t: 0, cpu: 100 }, { t: 50_000, cpu: 10 }, { t: 60_000, cpu: 20 }];
  assert.deepStrictEqual(avgCpu(pts, 70_000, 60_000), { avg: 15, n: 2 });
  assert.deepStrictEqual(avgCpu([], 1000), { avg: 0, n: 0 });
  assert.deepStrictEqual(avgCpu(null, 1000), { avg: 0, n: 0 });
});

test('isHeavy: memória passa de 80% do limite das Configurações', () => {
  assert.strictEqual(isHeavy({ mem: 1201, memLimitMB: 1500 }), true);
  assert.strictEqual(isHeavy({ mem: 1200, memLimitMB: 1500 }), false);
});

test('isHeavy: sem limite, 1 GB é o teto', () => {
  assert.strictEqual(isHeavy({ mem: HEAVY_MEM_DEFAULT_MB + 1, memLimitMB: 0 }), true);
  assert.strictEqual(isHeavy({ mem: HEAVY_MEM_DEFAULT_MB, memLimitMB: 0 }), false);
});

test('isHeavy: CPU média de quase um núcleo cheio, só com amostras suficientes', () => {
  // 4 núcleos: 80% de um núcleo = 20% do PC
  assert.strictEqual(isHeavy({ cpuAvg: 20, cpuSamples: HEAVY_CPU_MIN_SAMPLES, cores: 4 }), true);
  assert.strictEqual(isHeavy({ cpuAvg: 19.9, cpuSamples: 6, cores: 4 }), false);
  assert.strictEqual(isHeavy({ cpuAvg: 90, cpuSamples: HEAVY_CPU_MIN_SAMPLES - 1, cores: 4 }), false);
  assert.strictEqual(isHeavy({ cpuAvg: 79, cpuSamples: 6, cores: 1 }), false);
  assert.strictEqual(isHeavy({}), false);
});

test('ingest: soma por jogo, app inteiro e "outros"', () => {
  const t = new MetricsTracker({ cores: 4 });
  const cur = t.ingest({
    accounts: [
      { key: 'poke:1', gameId: 'poke', cpu: 5, mem: 400 },
      { key: 'poke:2', gameId: 'poke', cpu: 3.5, mem: 300 },
      { key: 'lol:1', gameId: 'lol', cpu: 2, mem: 200 },
    ],
    processes: [proc(400, 300), proc(40, 700), proc(80, 700)], // total 520% de núcleo = 130%?? limitado a 100
  }, 1000);
  assert.deepStrictEqual(cur.games.poke, { cpu: 8.5, mem: 700 });
  assert.deepStrictEqual(cur.games.lol, { cpu: 2, mem: 200 });
  assert.strictEqual(cur.app.mem, 1700);
  assert.strictEqual(cur.app.cpu, 100);
  assert.strictEqual(cur.other.mem, 800);
  assert.strictEqual(cur.other.cpu, 89.5);
});

test('ingest: "outros" nunca fica negativo', () => {
  const t = new MetricsTracker({ cores: 4 });
  const cur = t.ingest({ accounts: [{ key: 'a:1', gameId: 'a', cpu: 10, mem: 900 }], processes: [proc(20, 800)] }, 1);
  assert.strictEqual(cur.other.cpu, 0);
  assert.strictEqual(cur.other.mem, 0);
});

test('histórico: um ponto a cada intervalo, com a média da CPU do período', () => {
  const t = new MetricsTracker({ cores: 1, sampleMs: 10_000 });
  const feed = (cpu, mem, now) => t.ingest({ accounts: [{ key: 'a:1', gameId: 'a', cpu, mem }], processes: [] }, now);
  feed(10, 100, 1000); // primeiro ingest já vira ponto
  feed(20, 110, 4000);
  feed(40, 120, 8000);
  assert.strictEqual(t.history(8000).series['a:1'].length, 1);
  feed(60, 130, 11_000); // passou 10 s: fecha o ponto com a média de 20, 40 e 60
  const pts = t.history(11_000).series['a:1'];
  assert.strictEqual(pts.length, 2);
  assert.deepStrictEqual(pts[1], [11_000, 40, 130]);
});

test('histórico: guarda no máximo uma hora (360 pontos)', () => {
  const t = new MetricsTracker({ cores: 1 });
  assert.strictEqual(t.maxPoints, MAX_POINTS);
  for (let i = 0; i < MAX_POINTS + 50; i++) t.ingest({ accounts: [{ key: 'a:1', gameId: 'a', cpu: 1, mem: i }], processes: [] }, 1000 + i * 10_000);
  const pts = t.history().series['a:1'];
  assert.strictEqual(pts.length, MAX_POINTS);
  assert.strictEqual(pts[0][2], 50); // os 50 mais antigos saíram
});

test('histórico: tem série do app, de "outros", dos jogos e das contas', () => {
  const t = new MetricsTracker({ cores: 2 });
  t.ingest({ accounts: [{ key: 'a:1', gameId: 'a', cpu: 1, mem: 10 }], processes: [proc(10, 50)] }, 1000);
  const h = t.history(1000);
  assert.deepStrictEqual(Object.keys(h.series).sort(), [APP, OTHER, keyOfGame('a'), 'a:1'].sort());
  assert.strictEqual(h.cores, 2);
  assert.strictEqual(h.current.app.mem, 50);
});

test('histórico: conta removida some depois de uma hora sem pontos', () => {
  const t = new MetricsTracker({ cores: 1, sampleMs: 10_000, historyMs: 60_000 });
  t.ingest({ accounts: [{ key: 'a:1', gameId: 'a', cpu: 1, mem: 1 }, { key: 'b:1', gameId: 'b', cpu: 1, mem: 1 }], processes: [] }, 1000);
  for (let now = 11_000; now <= 91_000; now += 10_000) t.ingest({ accounts: [{ key: 'a:1', gameId: 'a', cpu: 1, mem: 1 }], processes: [] }, now);
  const keys = Object.keys(t.history().series);
  assert.ok(keys.includes('a:1'));
  assert.ok(!keys.includes('b:1'));
});

test('heavy: usa a média do último minuto do histórico', () => {
  const t = new MetricsTracker({ cores: 4, sampleMs: 10_000 });
  const feed = (cpu, now) => t.ingest({ accounts: [{ key: 'a:1', gameId: 'a', cpu, mem: 100 }], processes: [] }, now);
  feed(30, 1000);
  assert.strictEqual(t.heavy('a:1', 100, 1500, 1000), false); // só 1 ponto: cedo demais
  feed(30, 11_000);
  feed(30, 21_000);
  assert.strictEqual(t.heavy('a:1', 100, 1500, 21_000), true); // 30% do PC com 4 núcleos > 20%
  assert.strictEqual(t.heavy('a:1', 100, 1500, 200_000), false); // pontos velhos saíram da janela
  assert.strictEqual(t.heavy('a:1', 1300, 1500, 200_000), true); // memória sozinha basta
  assert.strictEqual(t.heavy('desconhecida', 0, 1500, 21_000), false);
});
