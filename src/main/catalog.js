// Catálogo de jogos prontos: uma lista (catalog/games.json) que vem junto com o app e
// também é baixada da internet, para entrarem jogos novos sem lançar uma versão.
// É só DADOS: nada daqui é executado, e tudo é conferido com regras rígidas antes de valer.
// Aqui ficam só funções puras e o serviço (com o "fetch" injetado, para testar sem rede).
const fs = require('fs');
const path = require('path');

const CATALOG_URL = 'https://raw.githubusercontent.com/RicardooFilho/IdleHub/main/catalog/games.json';
const REFRESH_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 256 * 1024; // o catálogo é pequeno; mais que isso é suspeito
const MAX_GAMES = 100;
const MAX_ACCOUNTS = 12; // o mesmo teto do app

// Campos do jogo que o catálogo atualiza (se a pessoa não tiver mexido neles).
const SYNCED_FIELDS = ['name', 'short', 'color', 'url', 'loggedOut', 'sessionTaken', 'reconnecting'];

const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Texto curto: sem quebras de linha nem caracteres de controle, dentro do tamanho.
const text = (v, max, min = 0) => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  // eslint-disable-next-line no-control-regex
  if (s.length < min || s.length > max || /[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
};

// Só links https (nada de http, file:, javascript: nem endereço com usuário e senha).
function httpsUrl(v) {
  const s = text(v, 2000, 1);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && u.hostname.includes('.') && !u.username && !u.password ? s : null;
  } catch {
    return null;
  }
}

// Lista de frases: minúsculas, curtas, sem repetir. null se não for uma lista de textos.
function phrases(v, { maxItems = 30, maxLen = 100 } = {}) {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > maxItems) return null;
  const out = [];
  for (const item of v) {
    const s = text(item, maxLen, 1);
    if (s === null) return null;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

// Alerta pronto: só do tipo "texto", sem seletor e sem regex (palavra simples), e sempre
// desligado: a pessoa liga depois de olhar o jogo. Nada que rode código ou trave a página.
function validWatcher(w) {
  if (!isObj(w)) return null;
  const name = text(w.name, 40, 1);
  const pattern = text(w.pattern, 60, 1);
  if (!name || !pattern || w.kind !== 'text' || (w.selector ?? '') !== '' || /[\\^$.*+?()[\]{}|]/.test(pattern)) return null;
  return { name, kind: 'text', selector: '', pattern, op: '>=', value: 0, enabled: false };
}

// Um jogo do catálogo. Devolve o jogo limpo ou null se for inválido.
function validateGame(g) {
  if (!isObj(g)) return null;
  const id = text(g.id, 40, 2);
  const name = text(g.name, 40, 1);
  const short = text(g.short, 4, 1);
  const url = httpsUrl(g.url);
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id) || !name || !short || !url) return null;
  if (typeof g.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(g.color)) return null;

  let maxAccounts = null;
  if (g.maxAccounts !== undefined && g.maxAccounts !== null) {
    if (!Number.isInteger(g.maxAccounts) || g.maxAccounts < 1 || g.maxAccounts > MAX_ACCOUNTS) return null;
    maxAccounts = g.maxAccounts;
  }
  let suggested = g.suggestedAccounts ?? 1;
  if (!Number.isInteger(suggested) || suggested < 1 || suggested > MAX_ACCOUNTS) return null;
  if (maxAccounts && suggested > maxAccounts) suggested = maxAccounts;

  let banWarning = '';
  if (g.banWarning !== undefined && g.banWarning !== null) {
    banWarning = text(g.banWarning, 300);
    if (banWarning === null) return null;
  }

  const loggedOut = g.loggedOut ?? {};
  const taken = g.sessionTaken ?? {};
  const reconn = g.reconnecting ?? {};
  if (!isObj(loggedOut) || !isObj(taken) || !isObj(reconn)) return null;
  const urlIncludes = phrases(loggedOut.urlIncludes);
  const loText = phrases(loggedOut.textIncludes);
  const takenText = phrases(taken.textIncludes);
  const reconnText = phrases(reconn.textIncludes);
  if (!urlIncludes || !loText || !takenText || !reconnText) return null;

  const rawWatchers = g.watchers ?? [];
  if (!Array.isArray(rawWatchers) || rawWatchers.length > 10) return null;
  const watchers = [];
  for (const w of rawWatchers) {
    const ok = validWatcher(w);
    if (!ok) return null;
    watchers.push(ok);
  }

  return {
    id,
    name,
    short,
    color: g.color.toLowerCase(),
    url,
    suggestedAccounts: suggested,
    maxAccounts,
    banWarning,
    loggedOut: { urlIncludes, textIncludes: loText },
    sessionTaken: { textIncludes: takenText.map((s) => s.toLowerCase()) },
    reconnecting: { textIncludes: reconnText.map((s) => s.toLowerCase()) },
    watchers,
  };
}

// O catálogo inteiro: { version, games }. Jogos inválidos ou repetidos são descartados;
// se o formato geral estiver errado, devolve null (e o app segue com o que já tinha).
function validateCatalog(raw) {
  if (!isObj(raw) || !Number.isInteger(raw.version) || raw.version < 1 || !Array.isArray(raw.games)) return null;
  const games = [];
  const seen = new Set();
  for (const g of raw.games.slice(0, MAX_GAMES)) {
    const ok = validateGame(g);
    if (!ok || seen.has(ok.id)) continue;
    seen.add(ok.id);
    games.push(ok);
  }
  return { version: raw.version, games };
}

// Fonte do catálogo: a maior versão válida vence; empatou, vale remoto > cópia local > do app.
function pickSource({ remote, cache, bundled }) {
  const list = [['remote', remote], ['cache', cache], ['bundled', bundled]].filter(([, c]) => c && c.games);
  let best = null;
  for (const [source, c] of list) if (!best || c.version > best.catalog.version) best = { source, catalog: c };
  return best || { source: 'none', catalog: { version: 0, games: [] } };
}

// Um jogo do catálogo no formato de "perfil" que o app já usava (preset = id do catálogo).
const toPreset = (g) => ({ preset: g.id, ...clone({ ...g, id: undefined }) });

// Os campos de um perfil que o catálogo atualiza, para comparar com o que a pessoa tem.
const baseOf = (p) => clone(Object.fromEntries(SYNCED_FIELDS.map((f) => [f, p[f]])));

// Atualiza um jogo já criado com o perfil novo do catálogo, SEM mexer no que a pessoa mudou:
// só troca o campo que ainda é igual ao padrão antigo (g.catalogBase; sem ele, o padrão de
// fábrica). Contas, alertas e todo o resto ficam como estão. Devolve true se mudou algo.
function syncGame(g, preset, fallbackBase) {
  if (!preset) return false;
  const old = isObj(g.catalogBase) ? g.catalogBase : fallbackBase ? baseOf(fallbackBase) : null;
  const fresh = baseOf(preset);
  let changed = false;
  if (old) {
    for (const f of SYNCED_FIELDS) {
      if (same(g[f], old[f]) && !same(old[f], fresh[f])) {
        g[f] = clone(fresh[f]);
        changed = true;
      }
    }
  }
  if (!same(g.catalogBase, fresh)) {
    g.catalogBase = fresh;
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------- serviço
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

// bundled: o catálogo que vem no app (já validado). file: a cópia local (catalog.json na pasta de dados).
// getFetch: devolve a função de rede (no app, a do Electron). onChange(presets): chamado quando a lista muda.
function createCatalog({ bundled, file, getFetch = () => require('electron').net.fetch, url = CATALOG_URL, onChange = () => {}, log = () => {}, timeoutMs = FETCH_TIMEOUT_MS }) {
  let cache = null;
  let remote = null;
  let current = pickSource({ bundled });
  let timer = null;

  const recompute = () => {
    const next = pickSource({ remote, cache, bundled });
    const changed = !same(next.catalog, current.catalog);
    current = next;
    return changed;
  };

  // Lê a cópia salva na pasta de dados (se existir e for válida).
  const load = () => {
    cache = validateCatalog(readJson(file));
    recompute();
    return current;
  };

  const save = (catalog) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: catalog.version, games: catalog.games }, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      log('não guardei a cópia do catálogo:', err.message);
    }
  };

  // Baixa o catálogo. Nunca lança: se algo der errado, segue com o que já tem.
  const refresh = async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await getFetch()(url, { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      if (body.length > MAX_BYTES) throw new Error('arquivo grande demais');
      const valid = validateCatalog(JSON.parse(body));
      if (!valid) throw new Error('formato inválido');
      remote = valid;
      const before = current;
      const changed = recompute();
      // Guarda a cópia local só quando o baixado é mesmo o que está valendo e é diferente da cópia que já temos.
      if (current.source === 'remote' && !same(cache, valid)) {
        cache = valid;
        save(valid);
      }
      if (changed) onChange(current);
      return { ok: true, changed, source: current.source, before: before.source };
    } catch (err) {
      log('catálogo não atualizado:', err.name === 'AbortError' ? 'demorou demais' : err.message);
      return { ok: false, error: err.message };
    } finally {
      clearTimeout(t);
    }
  };

  const start = () => {
    refresh();
    timer = setInterval(refresh, REFRESH_MS);
    timer.unref?.();
  };
  const stop = () => clearInterval(timer);

  return {
    load,
    refresh,
    start,
    stop,
    get: () => current,
    presets: () => current.catalog.games.map(toPreset),
    preset: (id) => {
      const g = current.catalog.games.find((x) => x.id === id);
      return g ? toPreset(g) : null;
    },
  };
}

module.exports = {
  CATALOG_URL,
  REFRESH_MS,
  MAX_BYTES,
  SYNCED_FIELDS,
  validateGame,
  validateCatalog,
  pickSource,
  toPreset,
  baseOf,
  syncGame,
  createCatalog,
};
