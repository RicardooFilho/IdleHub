// Perfis prontos dos jogos. Eles vêm do catálogo (catalog/games.json, que vai junto com o
// app e também é baixado da internet: veja catalog.js). Cada perfil é só um ponto de partida:
// tudo pode ser editado no app (link, contas, detecção de logout e alertas).
const crypto = require('crypto');
const { validateCatalog, toPreset, baseOf, SYNCED_FIELDS } = require('./catalog');

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

// O catálogo que vem junto com o app: vale sempre, mesmo sem internet e sem cópia baixada.
const BUNDLED = validateCatalog(require('../../catalog/games.json'));
if (!BUNDLED || !BUNDLED.games.length) throw new Error('catalog/games.json inválido');

const PRESETS = BUNDLED.games.map(toPreset);

function makeAccounts(n, from = 1) {
  return Array.from({ length: n }, (_, i) => ({ id: newId(), name: `Conta ${from + i}`, sleeping: false }));
}

function gameFromPreset(p, { url, accounts } = {}) {
  return {
    id: newId(),
    preset: p.preset,
    name: p.name,
    short: p.short,
    color: p.color,
    url: url ?? p.url,
    accounts: makeAccounts(Math.max(1, Math.min(12, accounts ?? p.suggestedAccounts))),
    loggedOut: JSON.parse(JSON.stringify(p.loggedOut)),
    sessionTaken: JSON.parse(JSON.stringify(p.sessionTaken)),
    reconnecting: JSON.parse(JSON.stringify(p.reconnecting)),
    watchers: p.watchers.map((w) => ({ ...w, id: newId() })),
    catalogBase: baseOf(p), // o padrão do catálogo agora: só o que a pessoa não mudou é atualizado depois
  };
}

// O padrão do catálogo guardado no jogo (veja syncGame em catalog.js): só vale se tiver todos os campos.
const validBase = (b) => {
  if (!b || typeof b !== 'object' || !SYNCED_FIELDS.every((f) => f in b)) return null;
  return JSON.parse(JSON.stringify(Object.fromEntries(SYNCED_FIELDS.map((f) => [f, b[f]]))));
};

// Limpa e valida um jogo vindo da tela de edição.
function sanitizeGame(g) {
  const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
  const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((s) => str(s, 100)).filter(Boolean);
  let url = str(g.url, 2000);
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  return {
    id: str(g.id, 40) || newId(),
    preset: str(g.preset, 40) || null,
    name: str(g.name, 40) || 'Jogo',
    short: str(g.short, 4) || str(g.name, 2).toUpperCase() || 'J',
    color: /^#[0-9a-f]{6}$/i.test(g.color) ? g.color : '#7c5cff',
    url,
    accounts: (g.accounts || []).slice(0, 12).map((a, i) => ({
      id: str(a.id, 40) || newId(),
      name: str(a.name, 30) || `Conta ${i + 1}`,
      sleeping: !!a.sleeping,
    })),
    loggedOut: {
      urlIncludes: list(g.loggedOut?.urlIncludes),
      textIncludes: list(g.loggedOut?.textIncludes),
    },
    sessionTaken: { textIncludes: list(g.sessionTaken?.textIncludes) },
    reconnecting: { textIncludes: list(g.reconnecting?.textIncludes) },
    ...(validBase(g.catalogBase) ? { catalogBase: validBase(g.catalogBase) } : {}),
    watchers: (g.watchers || []).slice(0, 30).map((w) => ({
      id: str(w.id, 40) || newId(),
      name: str(w.name, 40) || 'Alerta',
      kind: w.kind === 'number' ? 'number' : 'text',
      selector: str(w.selector, 300),
      pattern: str(w.pattern, 200),
      op: ['>=', '<=', '>', '<', '=', 'change'].includes(w.op) ? w.op : '>=',
      value: Number(w.value) || 0,
      enabled: !!w.enabled,
    })),
  };
}

// Jogos salvos antes do aviso de "conta aberta em outro lugar" não têm o campo:
// os de preset ganham os textos padrão; os de link livre ficam com a lista vazia
// (ligado por quem quiser). Devolve true se mudou algo. Lista vazia salva de
// propósito (o campo existe) nunca é refeita.
function migrateSessionTaken(g, presets = PRESETS) {
  if (g.sessionTaken && Array.isArray(g.sessionTaken.textIncludes)) return false;
  const p = presets.find((x) => x.preset === g.preset);
  g.sessionTaken = { textIncludes: p ? [...p.sessionTaken.textIncludes] : [] };
  return true;
}

// Mesma regra para os textos de "Reconectando…": jogos antigos de preset ganham o
// padrão, os de link livre ficam com a lista vazia (recurso desligado até a pessoa
// escolher os textos) e uma lista vazia salva de propósito nunca é refeita.
function migrateReconnecting(g, presets = PRESETS) {
  if (g.reconnecting && Array.isArray(g.reconnecting.textIncludes)) return false;
  const p = presets.find((x) => x.preset === g.preset);
  g.reconnecting = { textIncludes: p ? [...p.reconnecting.textIncludes] : [] };
  return true;
}

module.exports = { BUNDLED, PRESETS, newId, gameFromPreset, sanitizeGame, makeAccounts, migrateSessionTaken, migrateReconnecting };
