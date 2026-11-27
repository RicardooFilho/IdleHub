// Registro de eventos das contas: o que aconteceu, quando e em qual conta.
// Fica em events.jsonl (um evento por linha) na pasta de dados, por 7 dias, e serve de base
// para qualquer resumo ("Enquanto você estava fora", resumo do dia...). Sem Electron aqui:
// quem usa passa a pasta de dados. Não guarda nada sensível: sem links, sem texto de página.
const fs = require('fs');
const path = require('path');

const FILE = 'events.jsonl';
const RETENTION_MS = 7 * 24 * 3600 * 1000;
const MAX_EVENTS = 20000; // teto de segurança, caso algo gere eventos sem parar
const FLUSH_MS = 3000;
const PRUNE_EVERY_MS = 6 * 3600 * 1000;
const MAX_DETAIL = 120;

// Tipos de evento. "Queda" é qualquer um de ISSUE_TYPES: abre um problema que só fecha com 'recovered'.
const ISSUE_TYPES = new Set(['reload', 'crash', 'server-down', 'logged-out', 'session-taken', 'challenge', 'gave-up']);
const EVENT_TYPES = new Set([
  ...ISSUE_TYPES,
  'recovered', // a conta voltou a ficar ok depois de uma queda
  'alert', // alerta do jogador disparou (detail = nome do alerta)
  'live-start', // conta ligada (aberta, não dormindo)
  'live-stop', // conta dormiu ou foi removida
  'offline', // a internet do PC caiu (sem conta)
  'online', // a internet voltou (sem conta)
  'suspend', // o PC foi dormir (sem conta)
  'resume', // o PC acordou (sem conta)
  'app-start', // o IdleHub abriu (sem conta)
  'app-stop', // o IdleHub fechou (sem conta)
]);

// Deixa o evento no formato guardado, ou null se não presta. Tira links do texto.
function sanitize(ev, now) {
  if (!ev || !EVENT_TYPES.has(ev.type)) return null;
  const str = (v, max) => (v == null || v === '' ? null : String(v).replace(/https?:\/\/\S+/gi, '[link]').replace(/\s+/g, ' ').trim().slice(0, max) || null);
  const t = Number(ev.t);
  return {
    t: Number.isFinite(t) && t > 0 ? Math.round(t) : now,
    key: str(ev.key, 80),
    game: str(ev.game, 60),
    who: str(ev.who, 60), // nome da conta, para o resumo não depender da conta ainda existir
    type: ev.type,
    detail: str(ev.detail, MAX_DETAIL),
  };
}

function parse(text, now, retentionMs) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (EVENT_TYPES.has(ev?.type) && Number.isFinite(ev.t) && ev.t > now - retentionMs) out.push(ev);
    } catch {} // linha cortada por um fechamento no meio da escrita
  }
  return out.slice(-MAX_EVENTS);
}

// Registro em disco. add() não bloqueia: junta e grava em lote, de tempos em tempos.
function createEventLog({ dir, now = Date.now, retentionMs = RETENTION_MS, flushMs = FLUSH_MS, pruneEveryMs = PRUNE_EVERY_MS } = {}) {
  const file = dir ? path.join(dir, FILE) : null;
  let events = [];
  let pending = [];
  let timer = null;
  let pruneTimer = null;
  let chain = Promise.resolve(); // uma operação de disco por vez, em ordem

  if (file) {
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {}
    events = parse(raw, now(), retentionMs);
    // Havia eventos velhos ou linhas quebradas: reescreve já limpo.
    if (raw && events.length !== raw.split('\n').filter((l) => l.trim()).length) rewriteSync();
  }

  function rewriteSync() {
    if (!file) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
      fs.renameSync(tmp, file);
    } catch {}
  }

  const enqueue = (op) => (chain = chain.then(op).catch(() => {}));

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!file || !pending.length) return chain;
    const lines = pending.map((e) => JSON.stringify(e)).join('\n') + '\n';
    pending = [];
    return enqueue(async () => {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.appendFile(file, lines);
    });
  }

  // Na hora de fechar o app não dá para esperar: grava tudo de uma vez.
  function flushSync() {
    clearTimeout(timer);
    timer = null;
    if (!file || !pending.length) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, pending.map((e) => JSON.stringify(e)).join('\n') + '\n');
    } catch {}
    pending = [];
  }

  // Tira o que passou de 7 dias e reescreve o arquivo (o chain evita brigar com uma gravação em andamento).
  function prune() {
    const cut = now() - retentionMs;
    const before = events.length;
    events = events.filter((e) => e.t > cut);
    if (events.length === before) return chain;
    return enqueue(() => {
      flushSync();
      rewriteSync();
    });
  }

  function add(raw) {
    const ev = sanitize({ t: now(), ...raw }, now());
    if (!ev) return null;
    events.push(ev);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    if (file) {
      pending.push(ev);
      if (!timer) {
        timer = setTimeout(flush, flushMs);
        timer.unref?.();
      }
    }
    return ev;
  }

  if (file && pruneEveryMs > 0) {
    pruneTimer = setInterval(prune, pruneEveryMs);
    pruneTimer.unref?.();
  }

  return {
    file,
    add,
    // Eventos entre from e to (inclusive), do mais antigo para o mais novo.
    query: (from = 0, to = Infinity) => events.filter((e) => e.t >= from && e.t <= to),
    all: () => events.slice(),
    flush,
    flushSync,
    prune,
    close() {
      clearInterval(pruneTimer);
      flushSync();
    },
  };
}

// ---------------------------------------------------------------- resumo (parte pura)

// Eventos que são do PC ou do app, não de uma conta.
const GLOBAL_TYPES = new Set(['offline', 'online', 'suspend', 'resume', 'app-start', 'app-stop']);

const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

// Resume o que aconteceu entre `from` e `to`. Receba o registro INTEIRO (events.all()): os eventos
// de antes de `from` dizem se a conta já estava ligada ou com problema quando o período começou.
// `accounts` (opcional) é o estado de agora: { 'jogo:conta': { game, who, status } }.
//   → { from, to, durationMs, empty,
//       totals: { drops, resolved, unresolved, alerts, reloads, runningMs, accounts },
//       offline: { count, ms }, suspendedMs,
//       byAccount: [{ key, game, who, drops, resolved, unresolved, alerts, alertNames, reloads, runningMs }],
//       byGame: [{ game, drops, resolved, alerts, reloads, runningMs }],
//       needsAttention: [{ key, game, who, status }] }
// Queda = primeiro evento de problema de uma conta depois de ela estar ok; vale até o 'recovered'.
// Queda "resolvida" = a conta voltou a ficar ok antes de `to`.
function summarize(events, from, to, { accounts = {} } = {}) {
  const list = (Array.isArray(events) ? events : []).filter((e) => e && Number.isFinite(e.t) && e.t <= to).sort((a, b) => a.t - b.t);
  const rows = new Map();
  const row = (e) => {
    let r = rows.get(e.key);
    if (!r) {
      r = { key: e.key, game: e.game || '', who: e.who || e.key, drops: 0, resolved: 0, unresolved: 0, alerts: 0, alertCounts: {}, reloads: 0, runningMs: 0 };
      rows.set(e.key, r);
    }
    if (e.game) r.game = e.game;
    if (e.who) r.who = e.who;
    return r;
  };

  const open = new Map(); // conta -> começo do período ligada
  const runs = new Map(); // conta -> [[início, fim]] de cada período ligada
  const incident = new Map(); // conta -> começo da queda ainda aberta
  const pauses = []; // PC dormindo: o tempo não conta como "rodando"
  let suspendAt = null;
  let offlineAt = null;
  const offline = { count: 0, ms: 0 };
  let lastT = null;

  const closeRun = (key, at) => {
    const start = open.get(key);
    if (start == null) return;
    open.delete(key);
    if (at > start) (runs.get(key) || runs.set(key, []).get(key)).push([start, at]);
  };
  const closeAllRuns = (at) => [...open.keys()].forEach((k) => closeRun(k, at));

  for (const e of list) {
    if (!e.key && !GLOBAL_TYPES.has(e.type)) continue; // evento de conta sem conta: ignora
    const inRange = e.t >= from;
    switch (e.type) {
      case 'app-start':
        // O app fechou sem avisar (queda de energia, travamento): o que estava aberto parou na última coisa que se soube.
        closeAllRuns(lastT ?? e.t);
        if (suspendAt != null) pauses.push([suspendAt, lastT ?? e.t]);
        suspendAt = null;
        offlineAt = null;
        incident.clear();
        break;
      case 'app-stop':
        closeAllRuns(e.t);
        if (suspendAt != null) pauses.push([suspendAt, e.t]);
        suspendAt = null;
        offlineAt = null;
        break;
      case 'suspend':
        suspendAt = e.t;
        break;
      case 'resume':
        if (suspendAt != null) pauses.push([suspendAt, e.t]);
        suspendAt = null;
        break;
      case 'offline':
        if (offlineAt == null) {
          offlineAt = e.t;
          if (inRange) offline.count++;
        }
        break;
      case 'online':
        if (offlineAt != null) offline.ms += overlap(offlineAt, e.t, from, to);
        offlineAt = null;
        break;
      case 'live-start':
        row(e);
        if (!open.has(e.key)) open.set(e.key, e.t);
        break;
      case 'live-stop':
        row(e);
        closeRun(e.key, e.t);
        incident.delete(e.key);
        break;
      case 'alert':
        if (inRange) {
          const r = row(e);
          r.alerts++;
          if (e.detail) r.alertCounts[e.detail] = (r.alertCounts[e.detail] || 0) + 1;
        }
        break;
      case 'recovered':
        if (incident.has(e.key)) {
          const startedAt = incident.get(e.key);
          incident.delete(e.key);
          if (startedAt >= from) row(e).resolved++;
        }
        break;
      default:
        if (ISSUE_TYPES.has(e.type) && e.key) {
          const r = row(e);
          if (e.type === 'reload' && inRange) r.reloads++;
          if (!incident.has(e.key)) {
            incident.set(e.key, e.t);
            if (inRange) r.drops++;
          }
        }
    }
    lastT = e.t;
  }
  // O que ainda estava aberto no fim do período.
  closeAllRuns(to);
  if (suspendAt != null) pauses.push([suspendAt, to]);
  if (offlineAt != null) offline.ms += overlap(offlineAt, to, from, to);
  for (const [key, startedAt] of incident) if (startedAt >= from) row({ key }).unresolved++;

  const suspendedMs = pauses.reduce((s, [a, b]) => s + overlap(a, b, from, to), 0);

  // Tempo "rodando" não conta o PC dormindo: as contas não rodam suspensas.
  for (const [key, spans] of runs) {
    const r = rows.get(key);
    if (!r) continue;
    r.runningMs = spans.reduce((s, [a, b]) => {
      const inside = overlap(a, b, from, to);
      const paused = pauses.reduce((p, [pa, pb]) => p + overlap(Math.max(a, pa), Math.min(b, pb), from, to), 0);
      return s + Math.max(0, inside - paused);
    }, 0);
  }

  const byAccount = [...rows.values()]
    .filter((r) => r.key)
    .map(({ alertCounts, ...r }) => ({
      ...r,
      alertNames: Object.entries(alertCounts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.drops - a.drops || b.alerts - a.alerts || b.runningMs - a.runningMs);

  const sum = (rowsIn, f) => rowsIn.reduce((s, r) => s + r[f], 0);
  const gameMap = new Map();
  for (const r of byAccount) {
    const g = gameMap.get(r.game) || { game: r.game, drops: 0, resolved: 0, alerts: 0, reloads: 0, runningMs: 0 };
    for (const f of ['drops', 'resolved', 'alerts', 'reloads', 'runningMs']) g[f] += r[f];
    gameMap.set(r.game, g);
  }

  const needsAttention = Object.entries(accounts || {})
    .filter(([, a]) => a && ATTENTION_STATUS.has(a.status))
    .map(([key, a]) => ({ key, game: a.game || '', who: a.who || key, status: a.status }));

  const totals = {
    drops: sum(byAccount, 'drops'),
    resolved: sum(byAccount, 'resolved'),
    unresolved: sum(byAccount, 'unresolved'),
    alerts: sum(byAccount, 'alerts'),
    reloads: sum(byAccount, 'reloads'),
    runningMs: sum(byAccount, 'runningMs'),
    accounts: byAccount.filter((r) => r.runningMs > 0).length,
  };
  return {
    from,
    to,
    durationMs: Math.max(0, to - from),
    empty: !totals.drops && !totals.alerts && !totals.reloads && !totals.runningMs && !offline.count && !needsAttention.length,
    totals,
    offline,
    suspendedMs,
    byAccount,
    byGame: [...gameMap.values()].sort((a, b) => b.drops - a.drops || b.alerts - a.alerts),
    needsAttention,
  };
}

// Estados de conta que pedem a atenção da pessoa (o resto se resolve sozinho ou nem é problema).
const ATTENTION_STATUS = new Set(['attention', 'logged-out', 'session-taken', 'challenge', 'crashed', 'server-down', 'no-internet', 'unresponsive']);

module.exports = { createEventLog, summarize, sanitize, EVENT_TYPES, ISSUE_TYPES, ATTENTION_STATUS, FILE, RETENTION_MS, MAX_EVENTS };
