// Medidores de CPU e memória: histórico da última hora de cada conta, de cada jogo e do app inteiro,
// e a regra que decide quando uma conta está "pesada". Só números e nenhuma chamada cara: quem lê as
// métricas do Electron (app.getAppMetrics) é o main.js; aqui só se soma e se guarda (testado em test/metrics.test.js).
const os = require('node:os');

const SAMPLE_MS = 10 * 1000; // um ponto no histórico a cada 10 s...
const HISTORY_MS = 60 * 60 * 1000; // ...guardando 1 hora
const MAX_POINTS = HISTORY_MS / SAMPLE_MS; // 360 pontos por série, no máximo

// Regra de "pesada" (conta destacada em amarelo). Basta uma das duas:
//  - memória: passou de 80% do limite das Configurações (memoryLimitMB), que é quando o IdleHub recarrega a
//    conta. Sem limite (0), passou de 1 GB;
//  - CPU: a média do último minuto ficou em 80% de um núcleo inteiro ou mais. Um jogo idle roda numa linha só
//    da CPU, então "quase um núcleo cheio" já é anormal. Em % do PC, o limite é 80 / número de núcleos.
const HEAVY_MEM_FRACTION = 0.8;
const HEAVY_MEM_DEFAULT_MB = 1024;
const HEAVY_CPU_CORE_FRACTION = 0.8;
const HEAVY_CPU_WINDOW_MS = 60 * 1000;
const HEAVY_CPU_MIN_SAMPLES = 3; // com menos de 30 s de histórico (app recém-aberto) não dá para saber

const CORES = Math.max(1, os.cpus().length || 1);

const round1 = (n) => Math.round(n * 10) / 10;

// percentUsage do Electron é por núcleo (um núcleo cheio = 100, e pode passar disso). Convertido para
// "% do PC inteiro" (0 a 100), o mesmo número que o Gerenciador de Tarefas mostra.
function normalizeCpu(raw, cores = CORES) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return round1(Math.min(100, n / Math.max(1, cores)));
}

// Média de CPU dos pontos dentro da janela. Devolve { avg, n }.
function avgCpu(points, now, windowMs = HEAVY_CPU_WINDOW_MS) {
  let sum = 0;
  let n = 0;
  for (const p of points || []) {
    if (p.t > now - windowMs) {
      sum += p.cpu;
      n++;
    }
  }
  return { avg: n ? sum / n : 0, n };
}

// mem em MB, cpu em % do PC (média de 1 minuto), memLimitMB = limite das Configurações (0 = sem limite).
function isHeavy({ mem = 0, cpuAvg = 0, cpuSamples = 0, memLimitMB = 0, cores = CORES } = {}) {
  const memLimit = memLimitMB > 0 ? memLimitMB * HEAVY_MEM_FRACTION : HEAVY_MEM_DEFAULT_MB;
  if (mem > memLimit) return true;
  const cpuLimit = (HEAVY_CPU_CORE_FRACTION * 100) / Math.max(1, cores);
  return cpuSamples >= HEAVY_CPU_MIN_SAMPLES && cpuAvg >= cpuLimit;
}

// Lista circular: guarda só os últimos `max` itens.
class Ring {
  constructor(max) {
    this.max = max;
    this.items = [];
  }
  push(item) {
    this.items.push(item);
    if (this.items.length > this.max) this.items.shift();
  }
  last() {
    return this.items[this.items.length - 1];
  }
  toArray() {
    return this.items.slice();
  }
}

const keyOfGame = (id) => `@game:${id}`;
const APP = '@app';
const OTHER = '@other'; // o que o app gasta fora das contas (janela, Painel, GPU, utilitários)

class MetricsTracker {
  constructor({ cores = CORES, sampleMs = SAMPLE_MS, historyMs = HISTORY_MS } = {}) {
    this.cores = cores;
    this.sampleMs = sampleMs;
    this.historyMs = historyMs;
    this.maxPoints = Math.ceil(historyMs / sampleMs);
    this.series = new Map(); // chave -> Ring de { t, cpu, mem }
    this.pending = new Map(); // chave -> { cpuSum, n, mem }: o que chegou desde o último ponto
    this.lastCommit = 0;
    this.latest = { app: { cpu: 0, mem: 0 }, other: { cpu: 0, mem: 0 }, games: {}, accounts: {} };
  }

  // accounts: [{ key, gameId, cpu (% do PC), mem (MB) }]. processes: o que vem de app.getAppMetrics().
  // Chamado a cada emitState: só soma e guarda. Vira um ponto do histórico a cada sampleMs.
  ingest({ accounts = [], processes = [] }, now = Date.now()) {
    let appCpu = 0;
    let appMem = 0;
    for (const p of processes) {
      appCpu += Number(p.cpu?.percentUsage) || 0;
      appMem += Number(p.memory?.workingSetSize) || 0;
    }
    const app = { cpu: normalizeCpu(appCpu, this.cores), mem: Math.round(appMem / 1024) };

    const games = {};
    const accs = {};
    let accCpu = 0;
    let accMem = 0;
    for (const a of accounts) {
      accs[a.key] = { cpu: a.cpu || 0, mem: a.mem || 0 };
      const g = (games[a.gameId] ||= { cpu: 0, mem: 0 });
      g.cpu = round1(g.cpu + (a.cpu || 0));
      g.mem += a.mem || 0;
      accCpu += a.cpu || 0;
      accMem += a.mem || 0;
    }
    // O app inclui as contas: o que sobra é "outros" (nunca negativo: as medidas não são do mesmo instante).
    const other = { cpu: round1(Math.max(0, app.cpu - accCpu)), mem: Math.max(0, app.mem - accMem) };
    this.latest = { app, other, games, accounts: accs };

    const add = (key, v) => {
      const p = this.pending.get(key) || { cpuSum: 0, n: 0, mem: 0 };
      p.cpuSum += v.cpu;
      p.n++;
      p.mem = v.mem;
      this.pending.set(key, p);
    };
    add(APP, app);
    add(OTHER, other);
    for (const [id, v] of Object.entries(games)) add(keyOfGame(id), v);
    for (const [key, v] of Object.entries(accs)) add(key, v);

    if (!this.lastCommit || now - this.lastCommit >= this.sampleMs) this.commit(now);
    return this.latest;
  }

  // Fecha o ponto: média da CPU do período, memória do último instante.
  commit(now) {
    for (const [key, p] of this.pending) {
      let ring = this.series.get(key);
      if (!ring) this.series.set(key, (ring = new Ring(this.maxPoints)));
      ring.push({ t: now, cpu: round1(p.cpuSum / p.n), mem: p.mem });
    }
    this.pending.clear();
    this.lastCommit = now;
    // Conta ou jogo removido: a série para de receber pontos e some depois de uma hora.
    for (const [key, ring] of this.series) {
      if ((ring.last()?.t || 0) < now - this.historyMs) this.series.delete(key);
    }
  }

  // Média de CPU do último minuto de uma série (para a regra de "pesada").
  cpuAverage(key, now = Date.now()) {
    return avgCpu(this.series.get(key)?.toArray(), now);
  }

  heavy(key, mem, memLimitMB, now = Date.now()) {
    const { avg, n } = this.cpuAverage(key, now);
    return isHeavy({ mem, cpuAvg: avg, cpuSamples: n, memLimitMB, cores: this.cores });
  }

  // Para a interface (sob pedido, não a cada "state"): pontos como [t, cpu, mem] para ocupar pouco.
  history(now = Date.now()) {
    const series = {};
    for (const [key, ring] of this.series) series[key] = ring.toArray().map((p) => [p.t, p.cpu, p.mem]);
    return { now, sampleMs: this.sampleMs, historyMs: this.historyMs, cores: this.cores, current: this.latest, series };
  }
}

module.exports = {
  MetricsTracker,
  Ring,
  normalizeCpu,
  avgCpu,
  isHeavy,
  keyOfGame,
  APP,
  OTHER,
  CORES,
  SAMPLE_MS,
  HISTORY_MS,
  MAX_POINTS,
  HEAVY_MEM_FRACTION,
  HEAVY_MEM_DEFAULT_MB,
  HEAVY_CPU_CORE_FRACTION,
  HEAVY_CPU_WINDOW_MS,
  HEAVY_CPU_MIN_SAMPLES,
};
