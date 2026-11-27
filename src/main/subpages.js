// Subpáginas de uma conta: outros sites do jogo (votação, wiki, loja) abertos no mesmo login,
// como abas acima do jogo. Só funções puras (sem Electron), para testar sem abrir nada.
// Quem usa é src/main/accounts.js (as views) e src/main/games.js (validação ao salvar).
const crypto = require('crypto');

const MAX_SUBPAGES = 6;
const GAME_TAB = 'game'; // a aba do próprio jogo; as outras são os ids das subpáginas
const MAX_TITLE = 20;

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

// Só https. Aceita sem "https://" na frente (a pessoa digita "pokeidle.io/votar") e devolve o
// endereço completo, ou null se não servir (outro protocolo, sem site, com usuário e senha).
function normalizeUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s || s.length > 2000) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
  return u.href;
}

// Limpa a lista vinda da tela de edição: descarta o que não tem link válido, passa do máximo
// ou repete o id. Sem título, usa o nome do site.
function sanitizeSubpages(list, makeId = newId) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (out.length >= MAX_SUBPAGES) break;
    const url = normalizeUrl(raw?.url);
    if (!url) continue;
    let id = String(raw?.id ?? '').trim().slice(0, 40);
    if (!id || id === GAME_TAB || seen.has(id)) id = makeId();
    seen.add(id);
    const title = String(raw?.title ?? '').trim().slice(0, MAX_TITLE) || new URL(url).hostname.replace(/^www\./, '').slice(0, MAX_TITLE);
    out.push({ id, title, url });
  }
  return out;
}

// ---------- abas abertas de uma conta ----------
// Estado: { active: GAME_TAB | id, open: [ids] }. "open" são as subpáginas que já têm view criada
// (carregam só no primeiro clique); "active" é a que aparece. Funções puras: devolvem um estado novo.
const initialTabs = () => ({ active: GAME_TAB, open: [] });

function selectTab(tabs, id, subpages) {
  if (id === GAME_TAB) return { ...tabs, active: GAME_TAB };
  if (!subpages.some((s) => s.id === id)) return tabs; // aba que não existe (mais)
  return { active: id, open: tabs.open.includes(id) ? tabs.open : [...tabs.open, id] };
}

// Fecha a view da subpágina; se era a que aparecia, volta para o jogo.
function closeTab(tabs, id) {
  return { active: tabs.active === id ? GAME_TAB : tabs.active, open: tabs.open.filter((x) => x !== id) };
}

// Tira do estado as abas que não existem mais na configuração.
function pruneTabs(tabs, subpages) {
  const ids = new Set(subpages.map((s) => s.id));
  const open = tabs.open.filter((id) => ids.has(id));
  return { active: tabs.active === GAME_TAB || ids.has(tabs.active) ? tabs.active : GAME_TAB, open };
}

module.exports = { MAX_SUBPAGES, GAME_TAB, MAX_TITLE, normalizeUrl, sanitizeSubpages, initialTabs, selectTab, closeTab, pruneTabs };
