// "Enquanto você estava fora": percebe que a pessoa voltou ao PC depois de horas parada
// (tempo ocioso do Windows, ou o PC dormiu) e avisa quem monta o resumo (events.js).

const POLL_MS = 30 * 1000;
const HOUR_MS = 3600 * 1000;
// A ociosidade só "zera" quando a pessoa mexe; uma queda menor que isso é só imprecisão do relógio.
const RESET_SLACK_MS = 5000;

// Parte pura, uma consulta por vez. `state` é { at, idleMs } da consulta anterior (ou null).
// Devolve { state, away }: `away` ({ from, to }) só quando a pessoa acabou de voltar de uma ausência >= thresholdMs.
//   from = quando ela parou de mexer no PC; to = quando voltou.
function trackAway(state, { now, idleMs, thresholdMs }) {
  const next = { at: now, idleMs: Math.max(0, Number(idleMs) || 0) };
  if (!state || !(thresholdMs > 0)) return { state: next, away: null };
  const returned = next.idleMs + RESET_SLACK_MS < state.idleMs; // a ociosidade caiu: houve atividade
  if (!returned || state.idleMs < thresholdMs) return { state: next, away: null };
  const from = state.at - state.idleMs;
  const to = now - next.idleMs;
  if (to - from < thresholdMs) return { state: next, away: null };
  return { state: next, away: { from, to } };
}

// PC que dormiu: a ociosidade do Windows não mostra isso (ela zera ao acordar), então olha a suspensão.
// `idleAtSuspendMs` é há quanto tempo a pessoa estava parada quando o PC dormiu.
function awayOnResume({ suspendedAt, resumedAt, idleAtSuspendMs = 0, thresholdMs }) {
  if (suspendedAt == null || !(thresholdMs > 0)) return null;
  const from = suspendedAt - Math.max(0, idleAtSuspendMs);
  if (resumedAt - from < thresholdMs) return null;
  return { from, to: resumedAt };
}

const thresholdOf = (hours) => {
  const h = Number(hours);
  return Number.isFinite(h) && h > 0 ? h * HOUR_MS : 0; // 0 = desligado
};

// Liga o powerMonitor ao aviso. `onBack({ from, to, via })` é chamado uma vez por volta.
// Devolve { poll, dispose } para os testes e o encerramento.
function setupAway({ powerMonitor, getHours, onBack, now = Date.now, pollMs = POLL_MS }) {
  let state = null;
  let suspend = null; // { at, idleMs } de quando o PC foi dormir

  const idleNow = () => {
    try {
      return powerMonitor.getSystemIdleTime() * 1000;
    } catch {
      return 0;
    }
  };

  function poll() {
    const thresholdMs = thresholdOf(getHours());
    const r = trackAway(state, { now: now(), idleMs: idleNow(), thresholdMs });
    state = r.state;
    if (r.away) onBack({ ...r.away, via: 'idle' });
  }

  // Suspende: guarda o que se sabia (a última consulta) para o resume calcular desde quando a pessoa saiu.
  const onSuspend = () => {
    const t = now();
    suspend = { at: t, idleMs: state ? state.idleMs + (t - state.at) : 0 };
  };
  const onResume = () => {
    const thresholdMs = thresholdOf(getHours());
    const s = suspend;
    suspend = null;
    state = null; // a ociosidade de antes do sono não vale mais
    if (!s) return;
    const away = awayOnResume({ suspendedAt: s.at, resumedAt: now(), idleAtSuspendMs: s.idleMs, thresholdMs });
    if (away) onBack({ ...away, via: 'resume' });
  };
  powerMonitor.on('suspend', onSuspend);
  powerMonitor.on('resume', onResume);

  const timer = setInterval(poll, pollMs);
  timer.unref?.();
  return {
    poll,
    dispose() {
      clearInterval(timer);
      powerMonitor.removeListener?.('suspend', onSuspend);
      powerMonitor.removeListener?.('resume', onResume);
    },
  };
}

module.exports = { trackAway, awayOnResume, setupAway, thresholdOf, POLL_MS, HOUR_MS, RESET_SLACK_MS };
