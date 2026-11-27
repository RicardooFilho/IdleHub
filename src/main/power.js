// Suspensão do PC: depois que o PC volta, os WebSockets dos jogos costumam estar
// mortos e a página ainda responde (o watchdog não percebe). Aqui o app espera a
// internet voltar e então recarrega as contas, uma de cada vez, ou só confere.

// Dormiu pelo menos isso: as conexões dos jogos já devem ter caído, então recarrega.
const LONG_SLEEP_MS = 5 * 60 * 1000;
// Espaço entre uma recarga e outra, para 11 contas não carregarem de uma vez.
const STAGGER_MS = 4000;
const ONLINE_POLL_MS = 2000;
const ONLINE_MAX_WAIT_MS = 60000;

// Parte pura: decide o que fazer ao voltar. `keys` são só as contas ligadas.
function resumePlan({ sleptMs, keys }) {
  const list = Array.isArray(keys) ? keys : [];
  if (!(sleptMs >= LONG_SLEEP_MS)) return { mode: 'check', items: [] };
  return { mode: 'reload', items: list.map((key, i) => ({ key, delayMs: i * STAGGER_MS })) };
}

// Liga a suspensão/retomada do PC às contas. Devolve { dispose } para os testes e o encerramento.
function setupPower({ powerMonitor, mgr, net, now = Date.now }) {
  let suspendedAt = null;
  let run = 0; // número da retomada atual: uma nova cancela a anterior
  let timers = [];

  const cancel = () => {
    run++;
    timers.forEach(clearTimeout);
    timers = [];
  };
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));

  // Espera a internet voltar (até ~60 s). Passado o prazo segue assim mesmo:
  // as contas tentam de novo sozinhas (did-fail-load e watchdog).
  const waitOnline = (id, done) => {
    let waited = 0;
    const poll = () => {
      if (id !== run) return;
      let online = true;
      try {
        online = net.isOnline();
      } catch {}
      if (online || waited >= ONLINE_MAX_WAIT_MS) return done();
      waited += ONLINE_POLL_MS;
      later(poll, ONLINE_POLL_MS);
    };
    poll();
  };

  powerMonitor.on('suspend', () => {
    cancel();
    suspendedAt = now();
  });

  powerMonitor.on('resume', () => {
    const sleptMs = suspendedAt == null ? 0 : now() - suspendedAt;
    suspendedAt = null;
    cancel();
    const id = run;
    waitOnline(id, () => {
      const plan = resumePlan({ sleptMs, keys: mgr.liveKeys() });
      if (plan.mode === 'check') return mgr.tick();
      if (!plan.items.length) return;
      mgr.log(null, 'O PC voltou da suspensão: recarregando as contas.');
      for (const { key, delayMs } of plan.items) {
        const go = () => mgr.reloadForResume(key, 'o PC voltou da suspensão');
        if (delayMs > 0) later(go, delayMs);
        else go(); // a primeira não precisa esperar
      }
    });
  });

  return { dispose: cancel };
}

module.exports = { resumePlan, setupPower, LONG_SLEEP_MS, STAGGER_MS, ONLINE_POLL_MS, ONLINE_MAX_WAIT_MS };
