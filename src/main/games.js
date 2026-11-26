// Perfis prontos de jogos. Cada perfil é só um ponto de partida: tudo pode
// ser editado no app (link, contas, detecção de logout e alertas).
const crypto = require('crypto');

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

const PRESETS = [
  {
    preset: 'pokeidle',
    name: 'PokeIdle',
    short: 'PK',
    color: '#e5484d',
    url: 'https://pokeidle.io/',
    suggestedAccounts: 4,
    loggedOut: { urlIncludes: ['login'], textIncludes: [] },
    watchers: [
      // Exemplos desligados: ajuste o texto/seletor depois de olhar o jogo
      // com "Inspecionar" e ligue.
      { name: 'Shiny apareceu', kind: 'text', selector: '', pattern: 'shiny', op: '>=', value: 0, enabled: false },
      { name: 'Lendário apareceu', kind: 'text', selector: '', pattern: 'lendário', op: '>=', value: 0, enabled: false },
    ],
  },
  {
    preset: 'lolidle',
    name: 'LoL Idle',
    short: 'LoL',
    color: '#c8a13a',
    url: '',
    suggestedAccounts: 5,
    loggedOut: { urlIncludes: ['login'], textIncludes: [] },
    watchers: [],
  },
  {
    preset: 'onepieceidle',
    name: 'One Piece Idle',
    short: 'OP',
    color: '#3e7bfa',
    url: '',
    suggestedAccounts: 2,
    loggedOut: { urlIncludes: ['login'], textIncludes: [] },
    watchers: [],
  },
];

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
    watchers: p.watchers.map((w) => ({ ...w, id: newId() })),
  };
}

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

module.exports = { PRESETS, newId, gameFromPreset, sanitizeGame, makeAccounts };
