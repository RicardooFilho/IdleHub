// "Resumo do dia": num horário escolhido, monta o resumo das últimas 24 h (events.js) e entrega
// no app e nos canais ligados (Discord/Telegram, remote.js).
//
// Parte pura (horários e texto, testável sem Electron) + setupDaily, que confere a hora a cada
// minuto. Um setTimeout de horas não serve: com o PC dormindo ele atrasa. Se o PC estava
// desligado ou dormindo no horário, o resumo sai uma vez ao voltar, desde que não tenha passado
// muito tempo (MISSED_GRACE_MS) — um resumo de ontem chegando dois dias depois só atrapalha.

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const POLL_MS = 60 * 1000;
const RESUME_DELAY_MS = 20 * 1000; // ao acordar, espera a internet voltar antes de mandar
const MISSED_GRACE_MS = 6 * HOUR_MS;
const DEFAULT_TIME = '21:00';
const TITLE = 'Resumo do dia — IdleHub';

// "21:00" -> { h, m }, ou null se não for um horário HH:MM válido.
function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? { h, m: min } : null;
}

// Devolve "HH:MM" com zeros, ou o padrão se não for válido.
function normalizeTime(value, fallback = DEFAULT_TIME) {
  const t = parseTime(value);
  return t ? `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}` : fallback;
}

// Horário `time` do dia (local) de `now`, somando `dayOffset` dias. Monta pelo calendário, não por 24 h fixas,
// para o horário de verão não deslocar o resumo.
const atTime = (now, time, dayOffset = 0) => {
  const t = parseTime(time) || parseTime(DEFAULT_TIME);
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, t.h, t.m, 0, 0).getTime();
};

// Último horário marcado que já passou (hoje, ou ontem se hoje ainda não chegou).
function lastDue(now, time) {
  const today = atTime(now, time);
  return today <= now ? today : atTime(now, time, -1);
}

// Próximo horário marcado, no futuro (hoje ou amanhã).
function nextDue(now, time) {
  const today = atTime(now, time);
  return today > now ? today : atTime(now, time, 1);
}

// Já é hora de mandar? `lastAt` é o horário marcado do último resumo enviado (config.lastDailySummaryAt).
// Devolve { from, to } (as 24 h até o horário marcado) ou null (já mandou, ainda não é hora, ou passou tempo demais).
function dueNow({ now, time, lastAt = 0, graceMs = MISSED_GRACE_MS }) {
  const due = lastDue(now, time);
  if ((Number(lastAt) || 0) >= due) return null;
  if (now - due > graceMs) return null;
  return { from: atTime(due, time, -1), to: due };
}

// Resumo manual ("Ver resumo agora"): as últimas 24 h até agora.
const lastDayPeriod = (now) => ({ from: now - DAY_MS, to: now });

// ---------------------------------------------------------------- texto

const STATUS_LABEL = {
  unresponsive: 'Sem resposta',
  crashed: 'Travou',
  'logged-out': 'Deslogada',
  'session-taken': 'Aberta em outro lugar',
  'no-internet': 'Sem internet',
  'server-down': 'Jogo fora do ar',
  challenge: 'Verificação',
  attention: 'Precisa de atenção',
};

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'menos de 1 min';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const MAX_ALERT_NAMES = 5;
const MAX_ATTENTION = 8;

// Nomes dos alertas somando todas as contas, do mais frequente para o menos.
function alertNames(summary) {
  const counts = new Map();
  for (const r of summary.byAccount || []) for (const a of r.alertNames || []) counts.set(a.name, (counts.get(a.name) || 0) + a.count);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

// summarize() -> { title, body } para o Discord/Telegram e para a notificação do Windows.
// Texto curto e simples: os canais já cortam o que passar do limite, mas um resumo longo ninguém lê.
function formatDaily(summary) {
  const t = summary.totals;
  const lines = [`Período: ${stamp(summary.from)} até ${stamp(summary.to)}`];

  if (!t.drops) lines.push('Quedas: nenhuma');
  else {
    const detail = t.unresolved ? `${t.resolved} resolvidas, ${t.unresolved} sem resolver` : t.drops === 1 ? 'resolvida' : 'todas resolvidas';
    lines.push(`Quedas: ${t.drops} (${detail})`);
  }

  const names = alertNames(summary);
  if (!t.alerts) lines.push('Alertas: nenhum');
  else {
    const list = names.slice(0, MAX_ALERT_NAMES).map((n) => (n.count > 1 ? `${n.name} ×${n.count}` : n.name));
    lines.push(`Alertas: ${t.alerts}${list.length ? ` — ${list.join(', ')}` : ''}`);
  }

  lines.push(t.runningMs ? `Rodando: ${fmtDuration(t.runningMs)}${t.accounts > 1 ? ` (somando ${t.accounts} contas)` : ''}` : 'Rodando: nenhuma conta rodou');

  if (summary.offline?.count) lines.push(`Internet fora: ${fmtDuration(summary.offline.ms)} (${plural(summary.offline.count, 'vez', 'vezes')})`);

  const attention = summary.needsAttention || [];
  if (attention.length) {
    lines.push('Precisam de atenção agora:');
    for (const a of attention.slice(0, MAX_ATTENTION)) {
      lines.push(`• ${a.game ? `${a.game} · ${a.who}` : a.who} — ${STATUS_LABEL[a.status] || a.status}`);
    }
    if (attention.length > MAX_ATTENTION) lines.push(`• …e mais ${attention.length - MAX_ATTENTION}`);
  } else if (!t.drops && !t.alerts && t.runningMs) {
    lines.push('Tudo certo com as contas.');
  }
  return { title: TITLE, body: lines.join('\n') };
}

// Frase curta para a notificação do Windows (a lista inteira fica no app e nos canais).
function shortLine(summary) {
  const t = summary.totals;
  const bits = [];
  bits.push(t.drops ? `${plural(t.drops, 'queda', 'quedas')}${t.unresolved ? ` (${t.unresolved} sem resolver)` : ''}` : 'sem quedas');
  bits.push(plural(t.alerts, 'alerta', 'alertas'));
  if (t.runningMs) bits.push(`${fmtDuration(t.runningMs)} rodando`);
  const n = (summary.needsAttention || []).length;
  return `${bits.join(' · ')}${n ? ` · ${plural(n, 'conta precisa', 'contas precisam')} de atenção` : ''}. Clique para ver.`;
}

// ---------------------------------------------------------------- agendador

// Confere o relógio a cada minuto e na volta da suspensão. `onDue({ from, to })` é chamado uma vez por dia.
// getSettings() -> { dailySummary, dailySummaryTime }; getLastAt()/setLastAt(ms) guardam o último horário enviado.
function setupDaily({ getSettings, getLastAt, setLastAt, onDue, powerMonitor, now = Date.now, pollMs = POLL_MS, resumeDelayMs = RESUME_DELAY_MS }) {
  const check = () => {
    const s = getSettings() || {};
    if (!s.dailySummary) return null;
    const due = dueNow({ now: now(), time: s.dailySummaryTime, lastAt: getLastAt() });
    if (!due) return null;
    setLastAt(due.to); // marca antes de montar: se algo falhar, não repete a cada minuto
    try {
      onDue(due);
    } catch (err) {
      console.warn('[daily]', err?.message || err);
    }
    return due;
  };

  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    timers.add(t);
  };
  const timer = setInterval(check, pollMs);
  timer.unref?.();
  const onResume = () => later(check, resumeDelayMs);
  powerMonitor?.on?.('resume', onResume);
  later(check, resumeDelayMs); // PC ligado depois do horário: manda assim que o app abrir

  return {
    check,
    dispose() {
      clearInterval(timer);
      timers.forEach(clearTimeout);
      powerMonitor?.removeListener?.('resume', onResume);
    },
  };
}

module.exports = {
  TITLE,
  DEFAULT_TIME,
  MISSED_GRACE_MS,
  DAY_MS,
  parseTime,
  normalizeTime,
  lastDue,
  nextDue,
  dueNow,
  lastDayPeriod,
  fmtDuration,
  formatDaily,
  shortLine,
  setupDaily,
};
