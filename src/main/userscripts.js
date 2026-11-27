// Scripts de usuário (.user.js, estilo Tampermonkey) por conta (TAG-35). Só funções puras: ler o cabeçalho,
// decidir em quais páginas o script roda, analisar o risco antes de instalar e montar o código que vai para a
// página. A parte com arquivos, rede e contas fica em userscript-store.js. Sem Electron aqui, para testar com node:test.
// Regras de docs/extensoes.md: só nos sites dos jogos do usuário, nunca no login do Google, sem código
// baixado de outros sites (@require) e rede só para os endereços do @connect.
const crypto = require('node:crypto');
const risk = require('./extrisk');

const LIMITS = { code: 3 * 1024 * 1024, header: 64 * 1024, maxList: 60 };

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// Mesmo conteúdo = mesmo hash: sem BOM e com quebra de linha única, o arquivo baixado e o colado dão o mesmo.
const normalizeCode = (code) => String(code ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');

// ---------- cabeçalho ----------
const RUN_AT = new Set(['document-start', 'document-body', 'document-end', 'document-idle', 'context-menu']);

// Lê o bloco `// ==UserScript==` . Lança erro em português se não for um script de usuário.
function parseMetadata(code) {
  const text = normalizeCode(code).slice(0, LIMITS.header);
  const block = /(?:^|\n)[ \t]*\/\/[ \t]*==UserScript==[ \t]*\n([\s\S]*?)\n[ \t]*\/\/[ \t]*==\/UserScript==/.exec(text);
  if (!block) throw new Error('Isso não parece um script de usuário: falta o bloco "// ==UserScript==" no começo.');
  const meta = {
    name: '', namespace: '', version: '', description: '', author: '', homepage: '',
    matches: [], includes: [], excludes: [], excludeMatches: [], grants: [], connects: [], requires: [], resources: [],
    runAt: 'document-idle', noframes: false, updateURL: '', downloadURL: '',
  };
  const lists = { match: 'matches', include: 'includes', exclude: 'excludes', 'exclude-match': 'excludeMatches', grant: 'grants', connect: 'connects', require: 'requires', resource: 'resources' };
  const scalars = { name: 'name', namespace: 'namespace', version: 'version', description: 'description', author: 'author', homepage: 'homepage', homepageurl: 'homepage', updateurl: 'updateURL', downloadurl: 'downloadURL' };
  for (const line of block[1].split('\n')) {
    const m = /^\s*\/\/\s*@([\w:.-]+)(?:[ \t]+(.*?))?\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = (m[2] || '').trim().slice(0, 600);
    if (key === 'noframes') meta.noframes = true;
    else if (key === 'run-at') meta.runAt = RUN_AT.has(value) ? value : 'document-idle';
    else if (lists[key]) {
      if (value && meta[lists[key]].length < LIMITS.maxList) meta[lists[key]].push(value);
    } else if (scalars[key] && !meta[scalars[key]]) meta[scalars[key]] = value; // o primeiro vale; @name:pt-BR (com ":") é ignorado
  }
  if (!meta.name) throw new Error('O script não tem @name no cabeçalho.');
  meta.name = meta.name.slice(0, 80);
  meta.version = meta.version.slice(0, 30);
  meta.description = meta.description.slice(0, 300);
  return meta;
}

// Identidade do script (como no Tampermonkey): nome + namespace. Serve de pasta e de ID.
const scriptId = (meta) => sha256(`${meta.namespace}\n${meta.name}`).slice(0, 16);

// ---------- endereços ----------
const toUrl = (url) => {
  try {
    return new URL(String(url));
  } catch {
    return null;
  }
};
const isHttp = (u) => !!u && (u.protocol === 'http:' || u.protocol === 'https:');
const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

// Páginas do Google (login, contas, YouTube): nenhum script roda nelas, de jeito nenhum.
const GOOGLE_HOST = /(^|\.)(google\.[a-z.]{2,}|youtube\.com|gstatic\.com|googleapis\.com|googleusercontent\.com)$/i;
const isGoogleHost = (host) => GOOGLE_HOST.test(String(host));

// Padrão do Chrome: <esquema>://<site><caminho>. null se não for válido.
function parseMatch(pat) {
  const p = String(pat).trim();
  if (p === '<all_urls>') return { all: true };
  const m = /^(\*|https?):\/\/([^/]*)(\/.*)$/i.exec(p);
  if (!m) return null;
  let host = m[2].toLowerCase();
  let port = '';
  const pm = /^(.*):(\d+|\*)$/.exec(host);
  if (pm) {
    host = pm[1];
    port = pm[2];
  }
  if (!host || (host.includes('*') && !(host === '*' || /^\*\.[^*]+$/.test(host)))) return null;
  return { scheme: m[1].toLowerCase(), host, port, path: m[3] };
}

const globRe = (glob) => new RegExp(`^${glob.split('*').map(escapeRe).join('.*')}$`, 'i');

function matchesPattern(pat, url) {
  const p = typeof pat === 'string' ? parseMatch(pat) : pat;
  const u = toUrl(url);
  if (!p || !isHttp(u)) return false;
  if (p.all) return true;
  if (p.scheme !== '*' && u.protocol !== `${p.scheme}:`) return false;
  const h = u.hostname.toLowerCase();
  if (p.host !== '*') {
    if (p.host.startsWith('*.')) {
      const base = p.host.slice(2);
      if (h !== base && !h.endsWith(`.${base}`)) return false;
    } else if (h !== p.host) {
      return false;
    }
  }
  if (p.port && p.port !== '*' && (u.port || (u.protocol === 'https:' ? '443' : '80')) !== p.port) return false;
  return globRe(p.path).test(u.pathname + u.search);
}

// @include / @exclude: texto com "*" (qualquer coisa) sobre o endereço inteiro. /expressão/ não é aceita.
const isRegexInclude = (s) => /^\/.*\/[a-z]*$/.test(s) && s.length > 2;
function matchesGlob(glob, url) {
  const u = toUrl(url);
  if (!u || isRegexInclude(glob)) return false;
  return globRe(glob).test(u.href);
}

const gameSitesOf = (gameHosts) => new Set((gameHosts || []).map(risk.siteOf));

// O script roda NESTA página? Só em http(s), nunca no Google, só em sites dos jogos configurados, e conforme os padrões.
function scriptMatches(meta, url, gameHosts) {
  const u = toUrl(url);
  if (!isHttp(u) || isGoogleHost(u.hostname)) return false;
  if (!gameSitesOf(gameHosts).has(risk.siteOf(u.hostname))) return false;
  const hit = meta.matches.some((p) => matchesPattern(p, u.href)) || meta.includes.some((g) => matchesGlob(g, u.href));
  if (!hit) return false;
  return !(meta.excludes.some((g) => matchesGlob(g, u.href)) || meta.excludeMatches.some((p) => matchesPattern(p, u.href)));
}

// O @include só vale se mirar sites dos jogos. Com "esquema://" confere como o @match; sem, o texto tem de citar o site.
function includeAllowed(glob, gameHosts) {
  const m = /^(https?\*?|\*):\/\/([^/]*)(\/.*)?$/i.exec(glob);
  if (m) {
    const scheme = m[1] !== '*' && m[1].endsWith('*') ? '*' : m[1].toLowerCase(); // "http*" vale para http e https
    return risk.patternAllowed(`${scheme}://${m[2]}${m[3] || '/*'}`, gameHosts);
  }
  const low = glob.toLowerCase();
  return [...gameSitesOf(gameHosts)].some((site) => low.includes(site));
}

// ---------- permissões (@grant) ----------
// Chave sem maiúsculas: GM_getValue e GM.getValue são a mesma coisa.
const grantKey = (g) => {
  const m = /^GM[_.](\w+)$/i.exec(String(g));
  return m ? m[1].toLowerCase() : String(g).toLowerCase();
};

const GRANTS = {
  getvalue: ['low', 'lê dados que o próprio script guardou (por conta)'],
  setvalue: ['low', 'guarda dados do próprio script (por conta)'],
  deletevalue: ['low', 'apaga dados do próprio script'],
  listvalues: ['low', 'lista os dados do próprio script'],
  addstyle: ['low', 'muda o visual da página'],
  notification: ['low', 'mostra notificações'],
  xmlhttprequest: ['medium', 'faz pedidos de rede só para os endereços do @connect, sem os cookies da conta'],
};
const GRANT_NAMES = { getvalue: 'GM_getValue', setvalue: 'GM_setValue', deletevalue: 'GM_deleteValue', listvalues: 'GM_listValues', addstyle: 'GM_addStyle', notification: 'GM_notification', xmlhttprequest: 'GM_xmlhttpRequest' };
// Funções que o IdleHub oferece (as que não estão em GRANTS não precisam de aviso).
const SUPPORTED = new Set([...Object.keys(GRANTS), 'info', 'log', 'registermenucommand', 'unregistermenucommand', 'addvaluechangelistener', 'removevaluechangelistener']);
// Pedem algo que o IdleHub recusa por segurança.
const BLOCKED_GRANTS = { cookie: 'lê e muda os cookies (o login das contas)' };

// Como o script roda: 'main' (mesmo mundo da página, sem GM_*) ou 'isolated' (mundo à parte, com GM_*).
function modeOf(meta) {
  const keys = meta.grants.map(grantKey);
  if (!keys.length || keys.includes('none')) return 'main';
  return keys.some((k) => SUPPORTED.has(k)) ? 'isolated' : 'main';
}
const hasGrant = (meta, key) => meta.grants.some((g) => grantKey(g) === key);

// ---------- análise antes de instalar ----------
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

function analyze(meta, { gameHosts = [] } = {}) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const permissions = [];
  if (!gameHosts.length) errors.push('Adicione primeiro o jogo no IdleHub: o script só pode agir nos sites dos seus jogos.');
  if (!meta.matches.length && !meta.includes.length) errors.push('O script não diz em quais sites roda (@match ou @include).');

  const outside = [];
  for (const p of meta.matches) if (!parseMatch(p) || !risk.patternAllowed(p, gameHosts)) outside.push(p);
  for (const g of meta.includes) {
    if (isRegexInclude(g)) errors.push(`Usa uma expressão regular no @include (${g.slice(0, 50)}). O IdleHub só aceita endereços com "*", para conferir o site.`);
    else if (!includeAllowed(g, gameHosts)) outside.push(g);
  }
  if (gameHosts.length && outside.length) {
    errors.push(`Quer rodar em sites que não são dos seus jogos (${[...new Set(outside)].slice(0, 4).join(', ')}${outside.length > 4 ? '…' : ''}). Isso incluiria até o login do Google. O IdleHub só instala scripts que ficam no site do jogo.`);
  }
  if (meta.requires.length) errors.push(`Carrega código de outro site (@require: ${meta.requires[0].slice(0, 60)}${meta.requires.length > 1 ? ' e mais' : ''}). O IdleHub não baixa código de fora, porque ele poderia mudar depois de você aceitar. Use uma versão do script com tudo dentro do arquivo.`);
  if (meta.resources.length) errors.push('Carrega arquivos de outro site (@resource). O IdleHub ainda não aceita isso. Use uma versão do script com tudo dentro do arquivo.');

  const connects = [];
  for (const c of meta.connects) {
    const h = c.toLowerCase();
    if (h === '*') errors.push('Pede para falar com qualquer site (@connect *). O IdleHub só aceita uma lista de endereços.');
    else if (h === 'self' || HOST_RE.test(h)) connects.push(h);
    else errors.push(`O @connect "${c.slice(0, 40)}" não é um endereço válido.`);
  }

  const keys = [...new Set(meta.grants.map(grantKey))];
  for (const k of keys) {
    if (BLOCKED_GRANTS[k]) errors.push(`Pede a função GM_${k}: ${BLOCKED_GRANTS[k]}. O IdleHub não instala scripts assim.`);
  }
  if (keys.includes('xmlhttprequest') && !connects.length) warnings.push('Pede GM_xmlhttpRequest sem @connect: ela não vai conseguir fazer nenhum pedido de rede.');
  if (connects.length && !keys.includes('xmlhttprequest')) notes.push('Lista @connect, mas não pede GM_xmlhttpRequest: o @connect não vai ser usado.');

  const mode = modeOf(meta);
  if (mode === 'main') {
    permissions.push({ name: 'none', level: 'medium', label: 'roda junto com o jogo, no mesmo mundo da página: vê e muda tudo que ele vê e guarda' });
    if (keys.includes('none') && keys.some((k) => SUPPORTED.has(k))) notes.push('Pede @grant none junto com funções GM_*: o IdleHub roda no mundo da página e as funções GM_* não existem.');
  } else {
    permissions.push({ name: 'isolado', level: 'low', label: 'roda num mundo à parte: lê a página, mas não enxerga as variáveis do jogo' });
  }
  for (const k of keys) if (GRANTS[k]) permissions.push({ name: GRANT_NAMES[k], level: GRANTS[k][0], label: GRANTS[k][1] });

  const unsupported = keys.filter((k) => !SUPPORTED.has(k) && k !== 'none' && k !== 'unsafewindow' && !BLOCKED_GRANTS[k]);
  if (unsupported.length) notes.push(`Usa recursos que o IdleHub não tem (${unsupported.slice(0, 5).join(', ')}). O script pode funcionar só em parte.`);
  if (keys.includes('unsafewindow')) {
    notes.push(mode === 'isolated' ? 'Usa unsafeWindow junto com funções GM_*: aqui o script roda num mundo à parte e não enxerga as variáveis do jogo, então pode quebrar.' : 'Usa unsafeWindow: aqui ele é a própria janela da página.');
  }
  if (meta.runAt === 'context-menu') notes.push('Roda pelo menu do botão direito, que o IdleHub não tem: ele roda quando a página termina de carregar.');
  if (meta.noframes) notes.push('O IdleHub só roda scripts na página principal, nunca em quadros (iframes).');

  return { errors: [...new Set(errors)], warnings, notes, permissions, connects, mode, unsupported, keys };
}

// Procura sinais no código (rede, automação). `risk.scanCode` é o mesmo das extensões.
const scanSource = (code) => risk.scanCode([{ name: 'script.user.js', text: code }]);

// Resumo para a tela de risco: mesmo formato das extensões (extrisk.buildSummary), com os campos a mais dos scripts.
function buildSummary({ meta, id, analysis, code, gameHosts = [] }) {
  const sites = new Set((gameHosts || []).map(risk.siteOf));
  const patterns = [...meta.matches, ...meta.includes];
  const s = risk.buildSummary({
    manifest: { name: meta.name, version: meta.version || 'sem versão', description: meta.description },
    id,
    analysis: { errors: analysis.errors, warnings: analysis.warnings, permissions: analysis.permissions, scriptHosts: patterns, hostPermissions: [] },
    code: scanSource(code),
    gameHosts,
  });
  const connectSites = [...new Set(analysis.connects.filter((h) => h !== 'self' && !sites.has(risk.siteOf(h))))];
  s.kind = 'script';
  s.mode = analysis.mode;
  s.runAt = meta.runAt;
  s.connectSites = connectSites;
  s.codeSites = [...new Set([...s.codeSites, ...connectSites])].slice(0, 15);
  if (connectSites.length) s.risk = 'high'; // pode mandar dados para fora do jogo
  s.warnings = [...s.warnings, ...analysis.warnings.filter((w) => !s.warnings.includes(w))];
  s.compat = { level: analysis.errors.length ? 'incompatible' : analysis.notes.length || analysis.warnings.length ? 'limited' : 'ok', notes: analysis.notes };
  return s;
}

// Quantas linhas entraram e saíram entre duas versões (para "O que mudou").
function lineDiff(oldCode, newCode) {
  const count = (text) => {
    const m = new Map();
    for (const l of String(text).split('\n')) m.set(l, (m.get(l) || 0) + 1);
    return m;
  };
  const a = count(oldCode);
  const b = count(newCode);
  let added = 0;
  let removed = 0;
  for (const [l, n] of b) added += Math.max(0, n - (a.get(l) || 0));
  for (const [l, n] of a) removed += Math.max(0, n - (b.get(l) || 0));
  return { added, removed };
}

// ---------- o que vai para a página ----------
// Parâmetros que o script enxerga (os que não foram pedidos em @grant ficam `undefined`, como no Tampermonkey).
const PARAMS = ['GM_info', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues', 'GM_addStyle', 'GM_xmlhttpRequest', 'GM_notification', 'GM_log', 'GM_registerMenuCommand', 'GM_unregisterMenuCommand', 'GM_addValueChangeListener', 'GM_removeValueChangeListener', 'GM'];

const infoOf = (meta, version) => ({
  scriptHandler: 'IdleHub',
  version: String(version || ''),
  script: {
    name: meta.name, namespace: meta.namespace, version: meta.version, description: meta.description, author: meta.author,
    matches: meta.matches, includes: meta.includes, excludes: meta.excludes, grant: meta.grants, connect: meta.connects, 'run-at': meta.runAt,
  },
});

const sourceUrl = (name) => `idlehub-userscript/${String(name).replace(/[^\w.-]+/g, '_').slice(0, 60)}.user.js`;

// Fábrica autocontida (o texto dela vai para a página, como em selector.js): monta GM_* e GM.* sobre a ponte
// `bridge` (só existe no mundo isolado do script). Os valores já vêm de fora; guardar é pedir ao processo principal.
function createGmRuntime(bridge, init) {
  const granted = new Set(init.grants);
  const values = new Map(Object.entries(init.values || {}));
  const listeners = new Map();
  let seq = 0;
  const parse = (s, d) => {
    try {
      return JSON.parse(s);
    } catch {
      return d;
    }
  };
  const fail = (e) => console.error(`[IdleHub] ${init.info.script.name}:`, e);
  const safe = (fn, ...args) => {
    try {
      return fn(...args);
    } catch (e) {
      fail(e);
    }
  };

  const getValue = (n, d) => (values.has(String(n)) ? parse(values.get(String(n)), d) : d);
  const fire = (k, oldV, newV) => {
    const m = listeners.get(k);
    if (m) for (const fn of [...m.values()]) safe(fn, k, oldV, newV, false);
  };
  const deleteValue = (n) => {
    const k = String(n);
    if (!values.has(k)) return;
    const old = getValue(k);
    values.delete(k);
    bridge.del(k);
    fire(k, old, undefined);
  };
  const setValue = (n, v) => {
    const k = String(n);
    if (v === undefined) return deleteValue(k);
    const s = JSON.stringify(v);
    if (s === undefined) return;
    const old = getValue(k);
    values.set(k, s);
    bridge.set(k, s);
    fire(k, old, v);
  };
  const listValues = () => [...values.keys()];

  const addStyle = (css) => {
    const el = document.createElement('style');
    el.textContent = String(css);
    const put = () => (document.head || document.documentElement).appendChild(el);
    if (document.head || document.documentElement) put();
    else document.addEventListener('DOMContentLoaded', put, { once: true }); // document-start: a página ainda não tem <html>
    // Página com regra de CSP que barra <style>: tenta uma folha de estilo montada por código.
    if (el.isConnected && !el.sheet && typeof CSSStyleSheet === 'function' && document.adoptedStyleSheets) {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(String(css));
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      } catch (e) {}
    }
    return el;
  };

  // Pedido de rede: quem decide se pode (e para onde) é o processo principal, pelo @connect.
  const request = (d) => {
    d = d || {};
    const id = `r${++seq}`;
    const headers = {};
    for (const [k, v] of Object.entries(d.headers || {})) headers[String(k)] = String(v);
    const req = {
      url: String(d.url || ''), method: String(d.method || 'GET').toUpperCase(), headers,
      data: d.data == null ? undefined : String(d.data), timeout: Number(d.timeout) || 0, responseType: d.responseType === 'json' ? 'json' : 'text',
    };
    const call = (name, arg) => typeof d[name] === 'function' && safe(d[name].bind(d), arg);
    const base = { readyState: 4, finalUrl: req.url, responseHeaders: '', responseText: '', response: null, status: 0, statusText: '', context: d.context };
    let aborted = false;
    const promise = Promise.resolve(bridge.xhr(id, req)).then(
      (r) => {
        if (aborted) return { ...base, aborted: true };
        if (!r || r.error) {
          const res = { ...base, error: (r && r.error) || 'Falhou', timedOut: !!(r && r.timeout) };
          call(res.timedOut ? 'ontimeout' : 'onerror', res);
          call('onloadend', res);
          return res;
        }
        const res = { ...base, status: r.status, statusText: r.statusText, finalUrl: r.finalUrl, responseHeaders: r.headers, responseText: r.text, response: req.responseType === 'json' ? parse(r.text, null) : r.text };
        call('onload', res);
        call('onloadend', res);
        return res;
      },
      (e) => {
        const res = { ...base, error: String((e && e.message) || e) };
        call('onerror', res);
        call('onloadend', res);
        return res;
      }
    );
    const handle = {
      abort() {
        if (aborted) return;
        aborted = true;
        bridge.abort(id);
        call('onabort', { ...base, aborted: true });
      },
    };
    return { handle, promise };
  };

  const notification = (a, title, image, onclick) => {
    const o = a && typeof a === 'object' ? a : { text: a, title, image, onclick };
    bridge.notify({ title: String(o.title || ''), text: String(o.text || '') });
    if (typeof o.ondone === 'function') safe(o.ondone.bind(o));
  };
  const addListener = (name, fn) => {
    const id = ++seq;
    if (!listeners.has(String(name))) listeners.set(String(name), new Map());
    listeners.get(String(name)).set(id, fn);
    return id;
  };
  const removeListener = (id) => listeners.forEach((m) => m.delete(id));
  const log = (...a) => console.log(`[${init.info.script.name}]`, ...a);
  const noop = () => 0;
  const later = (fn) => (...a) =>
    new Promise((res, rej) => {
      try {
        res(fn(...a));
      } catch (e) {
        rej(e);
      }
    });

  const legacy = {
    GM_getValue: getValue, GM_setValue: setValue, GM_deleteValue: deleteValue, GM_listValues: listValues, GM_addStyle: addStyle,
    GM_xmlhttpRequest: (d) => request(d).handle, GM_notification: notification, GM_log: log,
    GM_registerMenuCommand: noop, GM_unregisterMenuCommand: noop, GM_addValueChangeListener: addListener, GM_removeValueChangeListener: removeListener,
  };
  const modern = {
    getValue: later(getValue), setValue: later(setValue), deleteValue: later(deleteValue), listValues: later(listValues), addStyle: later(addStyle),
    xmlHttpRequest: (d) => request(d).promise, xmlhttpRequest: (d) => request(d).promise, notification: later(notification), log: later(log),
    registerMenuCommand: later(noop), unregisterMenuCommand: later(noop),
  };
  const api = { GM_info: init.info };
  for (const k of Object.keys(legacy)) if (granted.has(k)) api[k] = legacy[k];
  const GM = { info: init.info };
  for (const k of Object.keys(modern)) if (granted.has(`GM.${k}`) || (k === 'xmlhttpRequest' && granted.has('GM.xmlHttpRequest'))) GM[k] = modern[k];
  api.GM = GM;
  return { api };
}

// Texto que o preload executa. `mode` 'main': mesmo mundo da página (sem ponte, sem GM_*). 'isolated': mundo à parte.
function buildRun({ meta, code, values = {}, appVersion = '' }) {
  const info = infoOf(meta, appVersion);
  const tail = `\n//# sourceURL=${sourceUrl(meta.name)}`;
  if (modeOf(meta) === 'main') {
    return `(function (GM_info, unsafeWindow) {\n${code}\n}).call(window, ${JSON.stringify(info)}, window);${tail}`;
  }
  const keys = new Set(meta.grants.map(grantKey));
  const init = {
    info,
    grants: meta.grants.filter((g) => SUPPORTED.has(grantKey(g))),
    values: keys.has('getvalue') || keys.has('listvalues') ? values : {},
  };
  return `(function () {\nconst __rt = (${createGmRuntime.toString()})(window.idleHubGM, ${JSON.stringify(init)});\n` +
    `(function (${PARAMS.join(', ')}, unsafeWindow) {\n${code}\n}).call(window, ${PARAMS.map((p) => `__rt.api.${p}`).join(', ')}, undefined);\n})();${tail}`;
}

module.exports = {
  LIMITS, PARAMS, sha256, normalizeCode, parseMetadata, scriptId, parseMatch, matchesPattern, matchesGlob, isRegexInclude, includeAllowed,
  scriptMatches, isGoogleHost, grantKey, hasGrant, modeOf, analyze, buildSummary, lineDiff, createGmRuntime, buildRun, GRANTS, SUPPORTED,
};
