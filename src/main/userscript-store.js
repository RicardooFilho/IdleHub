// Gerenciador de scripts de usuário (TAG-35) com aviso de risco e versão travada (TAG-36), no mesmo molde de
// extensions.js: guarda os scripts em <dados>/userscripts/<id>/<hash>.user.js e, em config.json, quais contas
// usam cada um. Sem Electron aqui: o accounts.js só recarrega a conta e o main.js liga as pontes (IPC).
// Nada é instalado sem a pessoa confirmar, e nada é ligado em conta nenhuma sem ela escolher.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const risk = require('./extrisk');
const us = require('./userscripts');

const MAX_SCRIPTS = 30; // instalados
const MAX_PER_PAGE = 12; // rodando na mesma página
const WORLD_BASE = 1000; // mundos isolados do Electron: 1000 em diante, um por script na página

// De onde dá para baixar um script (e por onde o link pode passar). Nada de servidor qualquer.
const DOWNLOAD_HOSTS = new Set(['greasyfork.org', 'update.greasyfork.org', 'openuserjs.org', 'raw.githubusercontent.com', 'gist.githubusercontent.com', 'github.com']);

const REQ_LIMITS = { timeoutMin: 1000, timeoutMax: 60000, timeoutDefault: 30000, body: 2 * 1024 * 1024, response: 10 * 1024 * 1024, concurrent: 4, redirects: 5, url: 2000 };
const VALUE_LIMITS = { name: 200, value: 512 * 1024, count: 500, total: 5 * 1024 * 1024 };
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']);
const FORBIDDEN_HEADERS = /^(cookie2?|host|content-length|connection|transfer-encoding|upgrade|via|proxy-.*|sec-.*|origin|keep-alive|te|trailer|expect|dnt)$/i;
const NOTIFY_GAP_MS = 8000;
const ERROR_GAP_MS = 60000;

// Link de Greasy Fork, OpenUserJS ou GitHub -> endereço do arquivo .user.js. null se não for um desses.
function resolveScriptUrl(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  const isFile = /\.user\.js$/i.test(u.pathname);
  if (host === 'greasyfork.org' || host === 'update.greasyfork.org') {
    if (isFile) return u.href;
    const i = parts.indexOf('scripts');
    const id = i >= 0 && /^(\d+)(-|$)/.exec(parts[i + 1] || '');
    return id ? `https://update.greasyfork.org/scripts/${id[1]}/script.user.js` : null;
  }
  if (host === 'openuserjs.org') {
    if (isFile && parts[0] === 'install') return u.href;
    if (parts[0] === 'scripts' && parts.length >= 3) return `https://openuserjs.org/install/${parts[1]}/${parts[2].replace(/\.user\.js$/i, '')}.user.js`;
    return null;
  }
  if (host === 'raw.githubusercontent.com' || host === 'gist.githubusercontent.com') return isFile ? u.href : null;
  if (host === 'github.com') {
    if (!isFile) return null;
    if (parts[2] === 'blob' && parts.length >= 5) return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join('/')}`;
    return parts[2] === 'raw' ? u.href : null;
  }
  return null;
}

// O @updateURL de muitos scripts aponta só o cabeçalho (.meta.js): o código está no .user.js do lado.
const updateSourceOf = (meta) => resolveScriptUrl((meta.downloadURL || meta.updateURL || '').replace(/\.meta\.js(\?.*)?$/i, '.user.js'));

const rmDir = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const fail = (error) => ({ ok: false, error });
const userMessage = (e) => (e && e.code && /^E[A-Z]+$/.test(e.code) ? `Não consegui mexer nos arquivos do script (${e.code}).` : (e && e.message) || 'Algo deu errado.');
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);

// "api.exemplo.com" vale para o próprio endereço e para os de dentro dele (como no Tampermonkey).
const hostMatches = (host, rule) => host === rule || (!/^[\d.]+$/.test(rule) && rule !== 'localhost' && host.endsWith(`.${rule}`));

class UserScriptStore {
  constructor({ root, getConfig, saveConfig, fetch = globalThis.fetch, appVersion = '', notify = () => {}, onProblem = () => {} }) {
    this.root = root;
    this.getConfig = getConfig;
    this.saveConfig = saveConfig;
    this.fetch = fetch;
    this.appVersion = appVersion;
    this.notifyFn = notify; // (chave da conta, nome do script, título, texto)
    this.onProblem = onProblem; // (chave da conta, texto): vai para a Atividade
    this.pending = new Map(); // token -> script analisado, esperando a confirmação da pessoa
    this.cache = new Map(); // id -> { hash, meta } do que já foi conferido
    this.values = new Map(); // `${id}|${conta}` -> { data, dirty }
    this.requests = new Map(); // `${conta}|${id}|${pedido}` -> AbortController
    this.lastNotify = new Map();
    this.lastError = new Map();
    this.flushTimer = null;
  }

  items() {
    const c = this.getConfig();
    if (!c.userscripts || typeof c.userscripts.items !== 'object' || !c.userscripts.items) c.userscripts = { items: {} };
    return c.userscripts.items;
  }

  gameHosts() {
    const out = new Set();
    for (const g of this.getConfig().games || []) {
      try {
        if (g.url) out.add(new URL(g.url).hostname);
      } catch {}
    }
    return [...out];
  }

  accountKeys() {
    const set = new Set();
    for (const g of this.getConfig().games || []) for (const a of g.accounts || []) set.add(`${g.id}:${a.id}`);
    return set;
  }

  fileOf(rec, version = rec.current) {
    return path.join(this.root, rec.id, version.file);
  }

  // ----- rede
  // Baixa o texto de um script. Cada passo do redirecionamento tem de ficar nos sites permitidos.
  async getText(url) {
    let cur = url;
    for (let hop = 0; hop <= 5; hop++) {
      const u = new URL(cur);
      if (u.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(u.hostname.toLowerCase())) throw new Error('O link foi para um site que o IdleHub não usa para baixar scripts. Por segurança, não baixei.');
      let res;
      try {
        res = await this.fetch(cur, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(30000) });
      } catch {
        throw new Error('Não consegui baixar o script. Confira a internet e o link e tente de novo.');
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('O link do script redireciona para lugar nenhum.');
        cur = new URL(loc, cur).href;
        continue;
      }
      if (!res.ok) throw new Error(`O site do script respondeu com erro (${res.status}). Confira o link.`);
      if (Number(res.headers.get('content-length')) > us.LIMITS.code) throw new Error('O script é grande demais.');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > us.LIMITS.code) throw new Error('O script é grande demais.');
      return buf.toString('utf8');
    }
    throw new Error('O link do script redireciona demais.');
  }

  // ----- análise (nada é instalado aqui)
  stage({ code, source, sourceUrl, forId }) {
    const text = us.normalizeCode(code);
    if (!text.trim()) throw new Error('Cole o código do script.');
    if (text.length > us.LIMITS.code) throw new Error('O script é grande demais.');
    const meta = us.parseMetadata(text);
    const id = us.scriptId(meta);
    if (forId && id !== forId) throw new Error('Esse não é o mesmo script que está instalado (o nome ou o namespace mudou).');
    if (!forId && this.items()[id]) throw new Error('Esse script já está instalado. Use "Procurar atualização" na lista.');
    if (!forId && Object.keys(this.items()).length >= MAX_SCRIPTS) throw new Error(`Chegou no limite de ${MAX_SCRIPTS} scripts. Remova algum para instalar outro.`);
    const summary = this.summarize(meta, id, text);
    const p = { token: crypto.randomBytes(8).toString('hex'), id, meta, code: text, hash: us.sha256(text), source, sourceUrl: sourceUrl || null, summary, forId: forId || null };
    if (forId) {
      const rec = this.items()[forId];
      const old = this.read(rec);
      const oldSum = this.summarize(old.meta, forId, old.code);
      const oldFiles = new Map([['script.user.js', rec.current.hash]]);
      const newFiles = new Map([['script.user.js', p.hash]]);
      p.diff = { ...risk.diffVersions(oldSum, summary, oldFiles, newFiles), code: us.lineDiff(old.code, text) };
      p.same = p.hash === rec.current.hash;
    }
    while (this.pending.size >= 4) this.discard(this.pending.keys().next().value); // não acumula análises abandonadas
    this.pending.set(p.token, p);
    return p;
  }

  summarize(meta, id, code) {
    const gameHosts = this.gameHosts();
    return us.buildSummary({ meta, id, analysis: us.analyze(meta, { gameHosts }), code, gameHosts });
  }

  reply(p) {
    return { ok: true, token: p.token, summary: p.summary, diff: p.diff || null, upToDate: !!p.same };
  }

  // Instalar por link (Greasy Fork, OpenUserJS ou GitHub).
  async prepareUrl(input) {
    const url = resolveScriptUrl(input);
    if (!url) return fail('Use o link de uma página do Greasy Fork ou do OpenUserJS, ou o link de um arquivo .user.js do GitHub. Ou cole o código do script.');
    try {
      return this.reply(this.stage({ code: await this.getText(url), source: 'url', sourceUrl: url }));
    } catch (e) {
      return fail(userMessage(e));
    }
  }

  // Instalar colando o código.
  prepareCode(code) {
    try {
      return this.reply(this.stage({ code, source: 'paste' }));
    } catch (e) {
      return fail(userMessage(e));
    }
  }

  // De onde baixar a atualização de um script (null = só colando o código novo).
  updateUrlOf(rec) {
    if (rec.sourceUrl) return rec.sourceUrl;
    try {
      return updateSourceOf(this.read(rec).meta);
    } catch {
      return null;
    }
  }

  // Procurar atualização: baixa, compara e mostra o que mudou. Não troca nada.
  async prepareUpdate(id) {
    const rec = this.items()[String(id)];
    if (!rec) return fail('Script não encontrado.');
    const url = this.updateUrlOf(rec);
    if (!url) return fail('Esse script não diz de onde atualizar. Use "Atualizar colando o código".');
    try {
      const p = this.stage({ code: await this.getText(url), source: rec.source, sourceUrl: rec.sourceUrl, forId: rec.id });
      if (p.same) this.discard(p.token);
      return this.reply(p);
    } catch (e) {
      return fail(userMessage(e));
    }
  }

  prepareUpdateCode(id, code) {
    const rec = this.items()[String(id)];
    if (!rec) return fail('Script não encontrado.');
    try {
      const p = this.stage({ code, source: rec.source, sourceUrl: rec.sourceUrl, forId: rec.id });
      if (p.same) this.discard(p.token);
      return this.reply(p);
    } catch (e) {
      return fail(userMessage(e));
    }
  }

  discard(token) {
    this.pending.delete(token);
  }

  // ----- confirmação
  // Grava o arquivo (nome = começo do hash: o mesmo código nunca vira dois arquivos).
  place(p) {
    const dir = path.join(this.root, p.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = `${p.hash.slice(0, 16)}.user.js`;
    const dest = path.join(dir, file);
    if (!fs.existsSync(dest)) {
      fs.writeFileSync(`${dest}.tmp`, p.code);
      fs.renameSync(`${dest}.tmp`, dest);
    }
    this.pending.delete(p.token);
    return { version: p.meta.version || 'sem versão', file, hash: p.hash, installedAt: Date.now() };
  }

  updateUrlFor(p) {
    return p.sourceUrl || updateSourceOf(p.meta) || null;
  }

  // Instala depois do "sim" da pessoa. `accountKeys`: contas escolhidas por ela (pode ser nenhuma: fica desligado).
  confirmInstall(token, accountKeys = []) {
    const p = this.pending.get(String(token));
    if (!p || p.forId) return fail('A análise expirou. Escolha o script de novo.');
    if (p.summary.blocked) return fail('O IdleHub não instala esse script.');
    const items = this.items();
    if (items[p.id]) return fail('Esse script já está instalado.');
    const valid = this.accountKeys();
    try {
      const current = this.place(p);
      items[p.id] = {
        id: p.id, name: p.summary.name, namespace: p.meta.namespace, source: p.source, sourceUrl: p.sourceUrl,
        updateUrl: this.updateUrlFor(p), installedAt: current.installedAt, risk: p.summary.risk, compat: p.summary.compat.level,
        mode: p.summary.mode, runAt: p.meta.runAt, current, previous: null,
        accounts: [...new Set((accountKeys || []).map(String).filter((k) => valid.has(k)))],
      };
      this.saveConfig();
      return { ok: true, id: p.id, accounts: items[p.id].accounts };
    } catch (e) {
      return fail(userMessage(e));
    }
  }

  // Troca para a versão nova (só depois de a pessoa ver o que mudou). A antiga fica guardada para voltar.
  confirmUpdate(token) {
    const p = this.pending.get(String(token));
    const rec = p?.forId && this.items()[p.forId];
    if (!rec) return fail('A análise expirou. Procure a atualização de novo.');
    if (p.summary.blocked) return fail('A versão nova pede coisas que o IdleHub não aceita. Continuei na versão que você já tem.');
    try {
      const old = rec.previous;
      rec.previous = rec.current;
      rec.current = this.place(p);
      rec.name = p.summary.name;
      rec.risk = p.summary.risk;
      rec.compat = p.summary.compat.level;
      rec.mode = p.summary.mode;
      rec.runAt = p.meta.runAt;
      rec.updateUrl = this.updateUrlFor(p);
      if (old && old.file !== rec.current.file && old.file !== rec.previous.file) fs.rmSync(this.fileOf(rec, old), { force: true }); // só guarda uma versão antiga
      this.cache.delete(rec.id);
      this.stop(null, rec.id);
      this.saveConfig();
      return { ok: true, id: rec.id, accounts: [...rec.accounts] };
    } catch (e) {
      return fail(userMessage(e));
    }
  }

  // Volta para a versão anterior (o arquivo dela foi mantido).
  rollback(id) {
    const rec = this.items()[String(id)];
    if (!rec?.previous) return fail('Não há versão anterior guardada.');
    if (!fs.existsSync(this.fileOf(rec, rec.previous))) return fail('O arquivo da versão anterior não existe mais.');
    [rec.current, rec.previous] = [rec.previous, rec.current];
    try {
      const { meta } = this.read(rec);
      rec.mode = us.modeOf(meta);
      rec.runAt = meta.runAt;
      rec.updateUrl = rec.sourceUrl || updateSourceOf(meta);
    } catch (e) {
      [rec.current, rec.previous] = [rec.previous, rec.current];
      return fail(userMessage(e));
    }
    this.cache.delete(rec.id);
    this.stop(null, rec.id);
    this.saveConfig();
    return { ok: true, id: rec.id, accounts: [...rec.accounts] };
  }

  remove(id) {
    const items = this.items();
    const rec = items[String(id)];
    if (!rec) return fail('Script não encontrado.');
    const accounts = [...rec.accounts];
    this.stop(null, rec.id);
    delete items[rec.id];
    this.cache.delete(rec.id);
    for (const k of [...this.values.keys()]) if (k.startsWith(`${rec.id}|`)) this.values.delete(k);
    rmDir(path.join(this.root, rec.id));
    this.saveConfig();
    return { ok: true, accounts };
  }

  // ----- por conta
  setAccount(id, key, on) {
    const rec = this.items()[String(id)];
    if (!rec) return fail('Script não encontrado.');
    if (!this.accountKeys().has(String(key))) return fail('Conta não encontrada.');
    const set = new Set(rec.accounts);
    if (on) set.add(String(key));
    else set.delete(String(key));
    rec.accounts = [...set];
    this.stop(String(key), rec.id);
    this.saveConfig();
    return { ok: true };
  }

  // Conta ou jogo removidos: tira das listas e apaga os dados guardados daquela conta.
  pruneAccounts() {
    const valid = this.accountKeys();
    const validFiles = new Set([...valid].map((k) => `${safeName(k)}.json`));
    let changed = false;
    for (const rec of Object.values(this.items())) {
      const keep = rec.accounts.filter((k) => valid.has(k));
      if (keep.length !== rec.accounts.length) {
        rec.accounts = keep;
        changed = true;
      }
      const dir = path.join(this.root, rec.id, 'values');
      try {
        for (const f of fs.readdirSync(dir)) if (!validFiles.has(f)) fs.rmSync(path.join(dir, f), { force: true });
      } catch {}
    }
    if (changed) this.saveConfig();
  }

  // ----- leitura (sempre conferida contra o hash guardado)
  read(rec, version = rec.current) {
    const code = fs.readFileSync(this.fileOf(rec, version), 'utf8');
    if (us.sha256(code) !== version.hash) throw new Error('os arquivos do script foram alterados depois de instalado');
    return { code, meta: us.parseMetadata(code) };
  }

  // Meta do script já conferida (guarda enquanto o hash instalado for o mesmo).
  metaOf(rec) {
    const hit = this.cache.get(rec.id);
    if (hit && hit.hash === rec.current.hash) return hit.meta;
    const { meta } = this.read(rec);
    this.cache.set(rec.id, { hash: rec.current.hash, meta });
    return meta;
  }

  problem(key, id, name, text, gap = ERROR_GAP_MS) {
    const k = `${key}|${id}|${text}`;
    const now = Date.now();
    if (now - (this.lastError.get(k) || 0) < gap) return;
    this.lastError.set(k, now);
    if (this.lastError.size > 200) this.lastError.clear();
    this.onProblem(key, `Script ${name}: ${text}`);
  }

  // O que rodar nesta página da conta (o preload pede ao abrir cada página).
  plan(key, pageUrl) {
    const out = [];
    const gameHosts = this.gameHosts();
    for (const rec of Object.values(this.items())) {
      if (out.length >= MAX_PER_PAGE || !rec.accounts.includes(key)) continue;
      let loaded;
      try {
        loaded = this.read(rec);
      } catch (e) {
        this.cache.delete(rec.id); // arquivo mexido: nem os pedidos de uma página já aberta valem mais
        this.problem(key, rec.id, rec.name, `não rodei:${userMessage(e)}. Reinstale pela tela Extensões.`);
        continue;
      }
      this.cache.set(rec.id, { hash: rec.current.hash, meta: loaded.meta });
      const { meta, code } = loaded;
      if (!us.scriptMatches(meta, pageUrl, gameHosts)) continue;
      const mode = us.modeOf(meta);
      out.push({
        id: rec.id, name: rec.name, mode, runAt: meta.runAt, world: WORLD_BASE + out.length,
        code: us.buildRun({ meta, code, values: mode === 'isolated' ? this.valuesOf(rec.id, key) : {}, appVersion: this.appVersion }),
      });
    }
    return out;
  }

  // Confere que o pedido de uma página é de um script ligado nesta conta, que combina com a página e tem a permissão.
  authorize(key, id, pageUrl, need) {
    const rec = key && this.items()[String(id)];
    if (!rec || !rec.accounts.includes(key)) return null;
    let meta;
    try {
      meta = this.metaOf(rec);
    } catch {
      return null;
    }
    if (!us.scriptMatches(meta, pageUrl, this.gameHosts())) return null;
    if (need && !us.hasGrant(meta, need)) return null;
    return { rec, meta };
  }

  // ----- dados do script (GM_setValue), por conta
  valuesFile(id, key) {
    return path.join(this.root, id, 'values', `${safeName(key)}.json`);
  }

  entry(id, key) {
    const k = `${id}|${key}`;
    let e = this.values.get(k);
    if (!e) {
      let data = {};
      try {
        const raw = JSON.parse(fs.readFileSync(this.valuesFile(id, key), 'utf8'));
        if (raw && typeof raw === 'object') for (const [n, v] of Object.entries(raw)) if (typeof v === 'string') data[n] = v;
      } catch {}
      e = { data, dirty: false };
      this.values.set(k, e);
    }
    return e;
  }

  valuesOf(id, key) {
    return { ...this.entry(id, key).data };
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 400);
    this.flushTimer.unref?.();
  }

  setValue(key, id, name, json) {
    const n = String(name);
    const v = String(json);
    if (!n || n.length > VALUE_LIMITS.name || v.length > VALUE_LIMITS.value) return false;
    const e = this.entry(id, key);
    const names = Object.keys(e.data);
    const total = names.reduce((s, k) => s + k.length + e.data[k].length, 0) - (n in e.data ? n.length + e.data[n].length : 0);
    if ((!(n in e.data) && names.length >= VALUE_LIMITS.count) || total + n.length + v.length > VALUE_LIMITS.total) return false;
    e.data[n] = v;
    e.dirty = true;
    this.scheduleFlush();
    return true;
  }

  deleteValue(key, id, name) {
    const e = this.entry(id, key);
    if (!(String(name) in e.data)) return;
    delete e.data[String(name)];
    e.dirty = true;
    this.scheduleFlush();
  }

  // Grava o que mudou (também ao fechar o app).
  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const [k, e] of this.values) {
      if (!e.dirty) continue;
      const [id, key] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
      if (!this.items()[id]) continue;
      try {
        const file = this.valuesFile(id, key);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(e.data));
        fs.renameSync(`${file}.tmp`, file);
        e.dirty = false;
      } catch {}
    }
  }

  // ----- notificações (GM_notification)
  notify(key, id, pageUrl, o) {
    const a = this.authorize(key, id, pageUrl, 'notification');
    if (!a) return false;
    const k = `${key}|${id}`;
    const now = Date.now();
    if (now - (this.lastNotify.get(k) || 0) < NOTIFY_GAP_MS) return false; // um script não enche a tela de avisos
    this.lastNotify.set(k, now);
    this.notifyFn(key, a.rec.name, String(o?.title ?? '').slice(0, 80), String(o?.text ?? '').slice(0, 300));
    return true;
  }

  reportError(key, id, message) {
    const rec = this.items()[String(id)];
    if (rec?.accounts.includes(key)) this.problem(key, id, rec.name, `deu erro (${String(message).slice(0, 160)}).`);
  }

  // ----- pedidos de rede (GM_xmlhttpRequest): só para o que o @connect declara
  connectAllowed(meta, host, pageHost) {
    const h = host.toLowerCase();
    return meta.connects.some((c) => {
      const rule = c.toLowerCase();
      return rule !== '*' && (rule === 'self' ? h === pageHost.toLowerCase() : hostMatches(h, rule));
    });
  }

  async request(key, id, pageUrl, reqId, req) {
    const a = this.authorize(key, id, pageUrl, 'xmlhttprequest');
    if (!a) return { error: 'Esse script não pode fazer pedidos de rede.' };
    const page = new URL(pageUrl);
    const method = String(req?.method || 'GET').toUpperCase();
    if (!METHODS.has(method)) return { error: `Método ${method.slice(0, 10)} não aceito.` };
    let target;
    try {
      if (String(req?.url).length > REQ_LIMITS.url) throw new Error('longo');
      target = new URL(String(req.url), pageUrl);
    } catch {
      return { error: 'Endereço inválido.' };
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return { error: 'O IdleHub só faz pedidos http e https.' };
    const refuse = (u) => (this.connectAllowed(a.meta, u.hostname, page.hostname) ? null : { error: `O endereço ${u.hostname} não está no @connect do script. Pedido recusado.` });
    const refused = refuse(target);
    if (refused) {
      this.problem(key, id, a.rec.name, `tentou falar com ${target.hostname}, que não está no @connect. Recusei.`);
      return refused;
    }
    const base = `${key}|${id}|`;
    if ([...this.requests.keys()].filter((k) => k.startsWith(base)).length >= REQ_LIMITS.concurrent) return { error: 'Pedidos demais ao mesmo tempo.' };
    const rk = `${base}${String(reqId).slice(0, 40)}`;
    const ctl = new AbortController();
    this.requests.set(rk, ctl);
    const timeout = Math.min(REQ_LIMITS.timeoutMax, Math.max(REQ_LIMITS.timeoutMin, Number(req.timeout) || REQ_LIMITS.timeoutDefault));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, timeout);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) if (!FORBIDDEN_HEADERS.test(k) && /^[\w-]+$/.test(k)) headers[k] = String(v).slice(0, 2000);
    let body = method === 'GET' || method === 'HEAD' || req.data == null ? undefined : String(req.data);
    if (body && body.length > REQ_LIMITS.body) {
      clearTimeout(timer);
      this.requests.delete(rk);
      return { error: 'O corpo do pedido é grande demais.' };
    }
    try {
      let cur = target;
      let m = method;
      for (let hop = 0; hop <= REQ_LIMITS.redirects; hop++) {
        const res = await this.fetch(cur.href, { method: m, headers, body, redirect: 'manual', credentials: 'omit', signal: ctl.signal });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          cur = new URL(res.headers.get('location'), cur);
          if (cur.protocol !== 'https:' && cur.protocol !== 'http:') return { error: 'O pedido foi redirecionado para um endereço que o IdleHub não aceita.' };
          const bad = refuse(cur);
          if (bad) return bad; // a resposta nem é lida: o destino não está no @connect
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && m === 'POST')) {
            m = m === 'HEAD' ? 'HEAD' : 'GET';
            body = undefined;
          }
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > REQ_LIMITS.response) return { error: 'A resposta é grande demais.' };
        let hdr = '';
        res.headers.forEach?.((v, k) => {
          if (!/^set-cookie2?$/i.test(k)) hdr += `${k}: ${v}\r\n`;
        });
        return { status: res.status, statusText: res.statusText || '', finalUrl: cur.href, headers: hdr, text: buf.toString('utf8') };
      }
      return { error: 'O pedido redirecionou demais.' };
    } catch (e) {
      if (timedOut) return { error: 'Tempo esgotado.', timeout: true };
      return { error: ctl.signal.aborted ? 'Pedido cancelado.' : 'Não consegui falar com o endereço.' };
    } finally {
      clearTimeout(timer);
      this.requests.delete(rk);
    }
  }

  abort(key, id, reqId) {
    this.requests.get(`${key}|${id}|${String(reqId).slice(0, 40)}`)?.abort();
  }

  // Conta dormiu, foi otimizada ou removida (key) ou o script mudou (id): cancela os pedidos em andamento.
  stop(key, id) {
    for (const [k, ctl] of this.requests) {
      const [kk, ii] = k.split('|');
      if ((!key || kk === key) && (!id || ii === id)) ctl.abort();
    }
    if (key && !id) this.flush();
  }

  // O que a interface mostra (sem caminhos do PC).
  list() {
    return Object.values(this.items())
      .map((r) => ({
        id: r.id, name: r.name, source: r.source, version: r.current.version, hash: r.current.hash, installedAt: r.installedAt,
        risk: r.risk, compat: r.compat, mode: r.mode, runAt: r.runAt, accounts: [...r.accounts],
        previousVersion: r.previous?.version || null, canUpdateByUrl: !!(r.sourceUrl || r.updateUrl),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

module.exports = { UserScriptStore, resolveScriptUrl, updateSourceOf, DOWNLOAD_HOSTS, WORLD_BASE, REQ_LIMITS, VALUE_LIMITS };
