// Conexão de cada conta com o servidor do jogo: "conectada", "sem dados há N min" ou
// "conexão caiu". O IdleHub só olha QUANDO chegou dado (WebSocket e pedidos XHR/fetch do
// próprio site do jogo), nunca o conteúdo. Só funções puras (sem Electron), para testar
// com node:test. Quem alimenta é accounts.js; as regras de recarga segura (sem internet,
// limite de quedas) continuam em recovery.js.

const SECOND = 1000;
const MINUTE = 60 * SECOND;

// Sem dado por tanto tempo vira "sem dados" (a configuração "avisar se ficar sem dados" troca isso).
const SILENT_DEFAULT_MS = 5 * MINUTE;
// Socket fechou e nenhum abriu de novo nesse tempo: "conexão caiu" (o jogo costuma reconectar sozinho).
const DROP_GRACE_MS = 30 * SECOND;
// Se continua caída depois disso, recarrega a conta (dá tempo de o próprio jogo reconectar antes).
const RELOAD_AFTER_DROP_MS = 2 * MINUTE;
// Espaço entre duas recargas por conexão caída no app todo (ex.: a internet voltou e várias caíram juntas).
const RELOAD_GAP_MS = 5 * SECOND;
// Jogo sem WebSocket só conta como "com ritmo" depois de pedidos em vários momentos diferentes:
// os pedidos da carga da página sozinhos não provam que ele fala com o servidor o tempo todo.
const RHYTHM_BUCKET_MS = 30 * SECOND;
const RHYTHM_BUCKETS = 3;

// Estado de uma conta (uma página). Zera sempre que a página carrega de novo.
const createConnection = () => ({
  lastActivityAt: 0, // último dado recebido (pedido do site, mensagem ou abertura de socket)
  sockets: 0, // WebSockets abertos agora
  everOpened: false, // algum socket já abriu nesta página
  lastCloseAt: 0, // quando o último socket fechou
  buckets: 0, // em quantos blocos de 30 s diferentes houve pedido
  lastBucket: -1,
});

// Chegou resposta de um pedido do site do jogo.
const noteHttp = (c, now) => {
  c.lastActivityAt = Math.max(c.lastActivityAt, now);
  const bucket = Math.floor(now / RHYTHM_BUCKET_MS);
  if (bucket !== c.lastBucket) {
    c.lastBucket = bucket;
    c.buckets++;
  }
};

// `snap` é o que a página informa sobre os sockets (idades em ms; -1 = nunca):
// { open, ever, msg, opened, closed }. Vem de fora do app, então tudo é conferido.
const noteSockets = (c, snap, now) => {
  if (!snap || typeof snap !== 'object') return;
  const age = (v) => (Number.isFinite(v) && v >= 0 ? Math.min(v, 7 * 24 * 3600 * SECOND) : -1);
  const at = (v) => (age(v) < 0 ? 0 : now - age(v));
  c.sockets = Math.max(0, Math.min(1000, Math.floor(Number(snap.open)) || 0));
  if (snap.ever || c.sockets > 0) c.everOpened = true;
  c.lastActivityAt = Math.max(c.lastActivityAt, at(snap.msg), at(snap.opened));
  c.lastCloseAt = Math.max(c.lastCloseAt, at(snap.closed));
};

// Recomeça a espera de "caiu" agora (ex.: a internet acabou de voltar: o jogo precisa de tempo para reconectar).
const restartDropWait = (c, now) => {
  if (c.everOpened && c.sockets === 0) c.lastCloseAt = now;
};

// Diz como está a conexão:
//  - 'unknown': ainda não dá para julgar (jogo sem conexão contínua ou recém-aberto);
//  - 'connected': chegou dado há pouco ou não há motivo para duvidar;
//  - 'silent': já houve dado, mas faz `silentAfterMs` ou mais que não chega nada (idleMs);
//  - 'dropped': tinha WebSocket aberto, fechou e nenhum abriu de novo (nem pedidos chegando).
// `reload` é true quando a queda já durou o bastante para recarregar a conta.
const connectionState = (c, now, { silentAfterMs = SILENT_DEFAULT_MS } = {}) => {
  if (!c) return { state: 'unknown', idleMs: 0, reload: false };
  const rhythm = c.everOpened || c.buckets >= RHYTHM_BUCKETS;
  if (!rhythm || !c.lastActivityAt) return { state: 'unknown', idleMs: 0, reload: false };

  const idleMs = Math.max(0, now - c.lastActivityAt);
  if (c.everOpened && c.sockets === 0 && c.lastCloseAt > 0 && c.lastActivityAt <= c.lastCloseAt) {
    const downMs = Math.max(0, now - c.lastCloseAt);
    if (downMs >= DROP_GRACE_MS) return { state: 'dropped', idleMs: downMs, reload: downMs >= RELOAD_AFTER_DROP_MS };
  }
  if (idleMs >= Math.max(MINUTE, silentAfterMs)) return { state: 'silent', idleMs, reload: false };
  return { state: 'connected', idleMs, reload: false };
};

// "avisar se ficar sem dados por N minutos" (0 = desligado) vira os ms que valem para "sem dados".
const silentAfterMs = (minutes) => {
  const n = Math.floor(Number(minutes));
  return Number.isFinite(n) && n > 0 ? n * MINUTE : SILENT_DEFAULT_MS;
};

// Só avisa se a pessoa ligou o aviso (minutes > 0) e uma vez por período sem dados.
const shouldNotifySilence = ({ state, minutes, notified }) => state === 'silent' && Math.floor(Number(minutes)) > 0 && !notified;

// "há 7 min", "há 1 h 05 min": texto curto para a tela.
const fmtIdle = (ms) => {
  const min = Math.max(1, Math.floor(ms / MINUTE));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
};

// Só deve contar pedido do próprio site do jogo (anúncios e estatísticas de terceiros não
// provam que o jogo está falando com o servidor) e que o servidor tenha respondido de verdade.
const countsAsActivity = ({ resourceType, statusCode, fromCache }) =>
  resourceType === 'xhr' && !fromCache && statusCode > 0 && statusCode < 500;

module.exports = {
  SILENT_DEFAULT_MS,
  DROP_GRACE_MS,
  RELOAD_AFTER_DROP_MS,
  RELOAD_GAP_MS,
  RHYTHM_BUCKETS,
  RHYTHM_BUCKET_MS,
  createConnection,
  noteHttp,
  noteSockets,
  restartDropWait,
  connectionState,
  silentAfterMs,
  shouldNotifySilence,
  countsAsActivity,
  fmtIdle,
};
