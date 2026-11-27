// Regras do watchdog para não ficar recarregando em loop: espera crescente entre
// tentativas, limite de quedas seguidas, reconhecimento das telas do Cloudflare
// e teste de internet. Só funções puras (o Electron é carregado dentro do teste
// de internet), para dar para testar com node:test.

const MINUTE = 60 * 1000;

// Quedas seguidas de uma conta: 5 em 10 minutos quer dizer "desistir e avisar".
const FAILURE_LIMIT = 5;
const FAILURE_WINDOW_MS = 10 * MINUTE;

// Espera entre as tentativas de um jogo fora do ar: cada vez mais longa, até 15 min.
const BACKOFF_STEPS_MS = [30 * 1000, 1 * MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE];

// Depois disso com a tela de verificação do Cloudflare aberta, avisa a pessoa.
const CHALLENGE_NOTIFY_MS = 2 * MINUTE;

// Páginas de erro são curtas. Texto maior que isso é um jogo, então só o título vale.
const ERROR_PAGE_MAX_CHARS = 2500;

// attempt começa em 0 (primeira espera = 30 s) e trava no último degrau.
const backoffMs = (attempt) => {
  const i = Math.floor(Number(attempt));
  if (!Number.isFinite(i) || i < 0) return BACKOFF_STEPS_MS[0];
  return BACKOFF_STEPS_MS[Math.min(i, BACKOFF_STEPS_MS.length - 1)];
};

// ---------- quedas seguidas ----------
// O histórico é uma lista de horários (ms). Os fora da janela de 10 min saem.
const recentFailures = (history, now) => (history || []).filter((t) => now - t < FAILURE_WINDOW_MS);
const recordFailure = (history, now) => [...recentFailures(history, now), now];
const tooManyFailures = (history, now) => recentFailures(history, now).length >= FAILURE_LIMIT;

// ---------- páginas de erro ----------
const CHALLENGE_TITLES = [
  /^just a moment(\.{3}|…)?$/,
  /^um momento(\.{3}|…)?$/,
  /^un instant(\.{3}|…)?$/,
  /^einen moment(\.{3}|…)?$/,
  /^attention required!?( \|.*cloudflare)?$/,
];
const CHALLENGE_TEXTS = [
  'verifying you are human',
  'verify you are human',
  'verificando se você é humano',
  'verifique se você é humano',
  'checking your browser before accessing',
  'needs to review the security of your connection',
  'precisa revisar a segurança da sua conexão',
];

// Texto que o Cloudflare mostra em cada erro 52x.
const SERVER_ERROR_TEXTS = [
  'web server is down',
  'web server is returning an unknown error',
  'connection timed out',
  'origin is unreachable',
  'a timeout occurred',
  'ssl handshake failed',
  'invalid ssl certificate',
];
const SERVER_ERROR_CODE = /\b(?:(?:error code|error|erro)\s*(52[0-7])|(52[0-7])\s*:)/;

// Reconhece a tela do Cloudflare ('cloudflare'), o erro 52x ({ kind, code }) ou nada (null).
// Conservador: um jogo com "520" no texto não pode casar, então o número só vale
// junto com a frase do erro ou com "Cloudflare", e o texto só vale em página curta.
// `length` é o tamanho do texto da página inteira (o `text` pode vir cortado).
const classifyPage = ({ title, text, length } = {}) => {
  const t = String(title || '').trim().toLowerCase();
  const body = String(text || '').trim().toLowerCase();
  const textCounts = (length ?? body.length) <= ERROR_PAGE_MAX_CHARS;
  const both = textCounts ? `${t}\n${body}` : t;

  if (CHALLENGE_TITLES.some((re) => re.test(t))) return 'cloudflare';
  if (textCounts && CHALLENGE_TEXTS.some((p) => body.includes(p))) return 'cloudflare';

  const m = both.match(SERVER_ERROR_CODE);
  if (m && (both.includes('cloudflare') || SERVER_ERROR_TEXTS.some((p) => both.includes(p)))) {
    return { kind: 'server-error', code: Number(m[1] || m[2]) };
  }
  return null;
};

// ---------- teste de internet ----------
// Endereços neutros de conectividade. Nenhum dado da pessoa vai junto.
const CONNECTIVITY_URLS = ['https://www.gstatic.com/generate_204', 'https://1.1.1.1/'];
const INTERNET_TIMEOUT_MS = 5000;
const INTERNET_CACHE_MS = 5000;

// `net` pode ser trocado nos testes. Várias contas perguntando ao mesmo tempo
// dividem a mesma resposta (e ela vale por alguns segundos).
const createInternetCheck = ({ getNet, urls = CONNECTIVITY_URLS, timeoutMs = INTERNET_TIMEOUT_MS, cacheMs = INTERNET_CACHE_MS, now = Date.now } = {}) => {
  let pending = null;
  let last = { at: -Infinity, up: true };

  const probe = async () => {
    const net = getNet();
    if (!net.isOnline()) return false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // Qualquer resposta do servidor prova que há internet; só vale o primeiro.
      await Promise.any(urls.map((url) => net.fetch(url, { method: 'HEAD', cache: 'no-store', signal: ctrl.signal })));
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      ctrl.abort(); // solta a requisição que sobrou
    }
  };

  return () => {
    if (now() - last.at < cacheMs) return Promise.resolve(last.up);
    pending ||= probe().then((up) => {
      last = { at: now(), up };
      pending = null;
      return up;
    });
    return pending;
  };
};

const checkInternet = createInternetCheck({ getNet: () => require('electron').net });

module.exports = {
  FAILURE_LIMIT,
  FAILURE_WINDOW_MS,
  CHALLENGE_NOTIFY_MS,
  backoffMs,
  recordFailure,
  tooManyFailures,
  classifyPage,
  createInternetCheck,
  checkInternet,
};
