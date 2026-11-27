// Perfis prontos de jogos. Cada perfil é só um ponto de partida: tudo pode
// ser editado no app (link, contas, detecção de logout e alertas).
const crypto = require('crypto');

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

// Frases (comparadas em minúsculas) com que os jogos avisam que a conta foi
// aberta em outro lugar. Conservadoras de propósito: frases inteiras, nunca
// palavras soltas como "sessão", para não pausar uma conta à toa.
const SESSION_TAKEN_TEXTS = [
  'aberta em outro lugar',
  'conectado em outro lugar',
  'logado em outro dispositivo',
  'outra aba',
  'logged in elsewhere',
  'logged in from another',
  'opened in another tab',
  'another session',
  'session has been taken',
];

const PRESETS = [
  {
    preset: 'pokeidle',
    name: 'PokeIdle',
    short: 'PK',
    color: '#e5484d',
    url: 'https://pokeidle.io/',
    suggestedAccounts: 4,
    loggedOut: { urlIncludes: ['login'], textIncludes: [] },
    sessionTaken: { textIncludes: SESSION_TAKEN_TEXTS },
    watchers: [
      // Exemplos desligados: ajuste o texto/seletor depois de olhar o jogo
      // com "Inspecionar" e ligue.
      { name: 'Shiny apareceu', kind: 'text', selector: '', pattern: 'shiny', op: '>=', value: 0, enabled: false },
      { name: 'Lendário apareceu', kind: 'text', selector: '', pattern: 'lendário', op: '>=', value: 0, enabled: false },
    ],
  },
  {
    preset: 'lolidle',
    name: 'LoLdle', // mesmo nome usado no Painel (IdleLive)
    short: 'LoL',
    color: '#c8a13a',
    url: 'https://lolidle.com/jogar#entrar',
    suggestedAccounts: 5,
    loggedOut: { urlIncludes: ['login'], textIncludes: [] },
    sessionTaken: { textIncludes: SESSION_TAKEN_TEXTS },
    watchers: [],
  },
  {
    preset: 'onepieceidle',
    name: 'One Piece Idle',
    short: 'OP',
    color: '#3e7bfa',
    url: 'https://oneidlepiece.com/entrar',
    suggestedAccounts: 2,
    loggedOut: { urlIncludes: ['login'], textIncludes: [] },
    sessionTaken: { textIncludes: SESSION_TAKEN_TEXTS },
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
    sessionTaken: JSON.parse(JSON.stringify(p.sessionTaken)),
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
    sessionTaken: { textIncludes: list(g.sessionTaken?.textIncludes) },
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
function migrateSessionTaken(g) {
  if (g.sessionTaken && Array.isArray(g.sessionTaken.textIncludes)) return false;
  const p = PRESETS.find((x) => x.preset === g.preset);
  g.sessionTaken = { textIncludes: p ? [...p.sessionTaken.textIncludes] : [] };
  return true;
}

module.exports = { PRESETS, newId, gameFromPreset, sanitizeGame, makeAccounts, migrateSessionTaken };
