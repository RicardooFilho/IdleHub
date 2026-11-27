// Regras de "otimizar conta" (fechar a página e reabrir num processo novo, no mesmo
// login, para devolver memória que um simples recarregar não devolve). Só funções
// puras, sem Electron, para dar para testar com node:test.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// Conta recém-aberta não é otimizada sozinha: se o jogo já nasce acima do limite de
// memória, isso viraria um loop de reaberturas. No máximo uma vez a cada 10 minutos.
const AUTO_MIN_AGE_MS = 10 * MINUTE;
// Espaço entre uma otimização automática e a próxima (no app todo), para o PC não
// reabrir todas as contas juntas.
const AUTO_GAP_MS = 20 * 1000;
// Espaço entre as contas quando a pessoa pede "Otimizar todas".
const ALL_GAP_MS = 5 * 1000;

// Sufixos de dois níveis comuns (com.br, co.uk…): nesses, o "site" tem 3 partes.
const SECOND_LEVEL = new Set(['com', 'co', 'org', 'net', 'gov', 'edu']);

const hostOf = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

// "Site" da página: os últimos 2 (ou 3) pedaços do endereço.
const siteOf = (host) => {
  const parts = host.split('.');
  const n = parts.length >= 3 && parts[parts.length - 1].length === 2 && SECOND_LEVEL.has(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-n).join('.');
};

const sameSite = (a, b) => {
  const ha = hostOf(a);
  const hb = hostOf(b);
  return !!ha && !!hb && siteOf(ha) === siteOf(hb);
};

// Para onde a conta volta depois de reaberta: a página em que ela estava, se for
// http(s), do mesmo site do jogo e não for tela de login; senão o link inicial.
// `loggedOutUrls` são os trechos de endereço que o jogo marca como "deslogada".
const pickReturnUrl = (currentUrl, gameUrl, loggedOutUrls = []) => {
  if (!currentUrl || !gameUrl || !sameSite(currentUrl, gameUrl)) return gameUrl;
  const low = String(currentUrl).toLowerCase();
  if ((loggedOutUrls || []).some((p) => p && low.includes(String(p).toLowerCase()))) return gameUrl;
  return currentUrl;
};

// Atrasos (ms) de cada conta quando várias são otimizadas em fila: 0, gap, 2·gap…
const staggerDelays = (count, gapMs = ALL_GAP_MS) =>
  Array.from({ length: Math.max(0, Math.floor(count) || 0) }, (_, i) => i * gapMs);

// Decide se uma conta funcionando bem deve ser otimizada agora. Devolve o motivo
// (texto para a Atividade) ou null.
//  - memória: passou do limite (limitMB 0 = sem limite);
//  - tempo: aberta há mais de `everyHours` (0 = desligado).
// `nextAllowedAt` é o horário em que a próxima otimização automática do app pode começar.
const autoOptimizeReason = ({ now, createdAt, everyHours, mem, limitMB, nextAllowedAt = 0 }) => {
  if (now < nextAllowedAt) return null;
  if (!(createdAt > 0) || now - createdAt < AUTO_MIN_AGE_MS) return null;
  const limit = Number(limitMB) || 0;
  if (limit > 0 && mem > limit) return `passou de ${limit} MB de memória (${mem} MB)`;
  const hours = Number(everyHours) || 0;
  if (hours > 0 && now - createdAt >= hours * HOUR) return `aberta há mais de ${hours} h`;
  return null;
};

module.exports = {
  AUTO_MIN_AGE_MS, AUTO_GAP_MS, ALL_GAP_MS, sameSite, pickReturnUrl, staggerDelays, autoOptimizeReason,
};
