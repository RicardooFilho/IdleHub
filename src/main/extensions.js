// Extensões do Chrome por conta (TAG-34) com aviso de risco e versão travada (TAG-36).
// Guarda as extensões em <dados>/extensions/<id>/<versão> (pasta estável: o ID da extensão e o
// chrome.storage dela dependem disso) e, em config.json, quais contas usam cada uma. Sem Electron aqui:
// quem carrega a extensão na sessão da conta é o accounts.js. Nada é instalado sem a pessoa confirmar,
// e nada é ligado em conta nenhuma sem ela escolher.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { LIMITS, sha256, idFromKey, safeRelPath, readZip, writeFiles, parseCrx3 } = require('./crx');
const risk = require('./extrisk');

const STORE_HOSTS = new Set(['chromewebstore.google.com', 'chrome.google.com']);
const DOWNLOAD_HOSTS = /(^|\.)(googleusercontent\.com|google\.com|gvt1\.com)$/i;
const CODE_FILE = /\.(m?js|cjs|html?)$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', '_metadata']);

// Aceita o link da Chrome Web Store (novo ou antigo) ou só o ID (32 letras de a a p).
function parseStoreInput(text) {
  const s = String(text || '').trim();
  if (/^[a-p]{32}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || !STORE_HOSTS.has(u.hostname)) return null;
    return u.pathname.split('/').find((seg) => /^[a-p]{32}$/.test(seg)) || null;
  } catch {
    return null;
  }
}

const updateUrl = (id, chrome = '156.0.0.0') =>
  `https://clients2.google.com/service/update2/crx?acceptformat=crx3&prodversion=${encodeURIComponent(chrome)}&x=${encodeURIComponent(`id=${id}&uc`)}`;

// Resposta do servidor de atualização do Google: o endereço do .crx, o tamanho e o SHA-256 esperados.
function parseUpdateXml(xml, id) {
  const app = new RegExp(`<app\\b[^>]*appid="${id}"[^>]*>([\\s\\S]*?)</app>`).exec(String(xml));
  const tag = app && /<updatecheck\b([^>]*?)\/?>/.exec(app[1]);
  if (!tag) throw new Error('A Chrome Web Store não achou essa extensão. Confira o link.');
  const attr = {};
  for (const m of tag[1].matchAll(/([\w-]+)="([^"]*)"/g)) attr[m[1]] = m[2];
  if (attr.status !== 'ok' || !attr.codebase) throw new Error('A Chrome Web Store não deixou baixar essa extensão (ela pode ter sido removida).');
  let url;
  try {
    url = new URL(attr.codebase);
  } catch {
    throw new Error('A Chrome Web Store mandou um endereço de download inválido.');
  }
  if (url.protocol !== 'https:' || !DOWNLOAD_HOSTS.test(url.hostname)) throw new Error('A Chrome Web Store mandou um endereço de download estranho. Por segurança, não baixei.');
  return { version: attr.version || '', codebase: url.href, sha256: (attr.hash_sha256 || '').toLowerCase(), size: Number(attr.size) || 0 };
}

// ---------- arquivos ----------
// Mesmo conteúdo = mesmo hash: no manifest.json a chave "key" (que o IdleHub grava para fixar o ID) não conta.
function normalizedFile(rel, buf) {
  if (rel !== 'manifest.json') return buf;
  try {
    const m = JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
    delete m.key;
    return Buffer.from(JSON.stringify(m));
  } catch {
    return buf;
  }
}

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}

// Map caminho -> sha256 de cada arquivo da pasta.
function fileHashes(dir) {
  const map = new Map();
  for (const rel of walk(dir)) map.set(rel, sha256(normalizedFile(rel, fs.readFileSync(path.join(dir, rel)))));
  return map;
}

const treeHash = (map) => sha256(Buffer.from([...map].map(([k, v]) => `${k}\0${v}\n`).join('')));

// Copia uma pasta de extensão (escolhida pela pessoa) para a memória, com os mesmos limites do zip.
// Não segue atalhos (symlinks) e pula .git e node_modules.
function readFolder(dir) {
  const files = [];
  let total = 0;
  const visit = (base) => {
    for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new Error(`A pasta tem um atalho (${rel}), que o IdleHub não segue por segurança.`);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(rel);
        continue;
      }
      safeRelPath(rel);
      const full = path.join(dir, rel);
      const size = fs.statSync(full).size;
      total += size;
      if (size > LIMITS.file || total > LIMITS.total || files.length >= LIMITS.entries) throw new Error('A pasta é grande demais para uma extensão.');
      files.push({ name: rel, data: fs.readFileSync(full) });
    }
  };
  visit('');
  return files;
}

// Lê o código (.js e .html) da extensão para procurar endereços de rede e sinais de automação.
function scanDir(dir, rels) {
  const files = [];
  let total = 0;
  for (const rel of rels) {
    if (!CODE_FILE.test(rel)) continue;
    const buf = fs.readFileSync(path.join(dir, rel));
    total += buf.length;
    if (buf.length > 5 * 1024 * 1024 || total > 30 * 1024 * 1024) continue; // grande demais: fica sem análise
    files.push({ name: rel, text: buf.toString('utf8') });
  }
  return risk.scanCode(files);
}

const readManifest = (dir) => {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  } catch {
    throw new Error('Essa pasta não tem um manifest.json: não parece uma extensão do Chrome.');
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('O manifest.json da extensão está inválido.');
  }
};

const newKey = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } }).publicKey.toString('base64');
const rmDir = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const fail = (error) => ({ ok: false, error });
const userMessage = (e) => (e && e.code && /^E[A-Z]+$/.test(e.code) ? `Não consegui mexer nos arquivos da extensão (${e.code}).` : (e && e.message) || 'Algo deu errado.');

// ---------- o gerenciador ----------
class ExtensionStore {
  constructor({ root, getConfig, saveConfig, fetch = globalThis.fetch, chromeVersion }) {
    this.root = root;
    this.getConfig = getConfig;
    this.saveConfig = saveConfig;
    this.fetch = fetch;
    this.chromeVersion = chromeVersion;
    this.pending = new Map(); // token -> extensão analisada, esperando a confirmação da pessoa
    rmDir(path.join(root, '.staging')); // sobras de uma análise que não foi confirmada
  }

  items() {
    const c = this.getConfig();
    if (!c.extensions || typeof c.extensions.items !== 'object' || !c.extensions.items) c.extensions = { items: {} };
    return c.extensions.items;
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

  dirOf(rec, version = rec.current) {
    return path.join(this.root, rec.id, version.dir);
  }

  // ----- rede
  async getBuffer(url, limit) {
    let res;
    try {
      res = await this.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(45000) });
    } catch {
      throw new Error('Não consegui falar com a Chrome Web Store. Confira a internet e tente de novo.');
    }
    if (!res.ok) throw new Error(`A Chrome Web Store respondeu com erro (${res.status}). Tente de novo mais tarde.`);
    if (Number(res.headers.get('content-length')) > limit) throw new Error('O arquivo da extensão é grande demais.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) throw new Error('O arquivo da extensão é grande demais.');
    return buf;
  }

  // Baixa o .crx pelo servidor de atualização do Google e confere tamanho e SHA-256 que ele mesmo informou.
  async download(id) {
    const xml = (await this.getBuffer(updateUrl(id, this.chromeVersion), 1024 * 1024)).toString('utf8');
    const info = parseUpdateXml(xml, id);
    const buf = await this.getBuffer(info.codebase, LIMITS.crx);
    if (info.size && buf.length !== info.size) throw new Error('O tamanho do arquivo baixado não bate com o da loja. Tente de novo.');
    if (info.sha256 && sha256(buf) !== info.sha256) throw new Error('O arquivo baixado não bate com a impressão digital (SHA-256) da loja. Por segurança, não instalei.');
    return buf;
  }

  // ----- análise (nada é instalado aqui)
  // Monta a extensão numa pasta de espera, grava a chave que fixa o ID e gera o resumo de risco.
  stage({ files, key, source, crxSha256, forId }) {
    const token = crypto.randomBytes(8).toString('hex');
    const dir = path.join(this.root, '.staging', token);
    try {
      writeFiles(files, dir);
      const manifest = readManifest(dir);
      manifest.key = key;
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      const id = idFromKey(Buffer.from(key, 'base64'));
      if (forId && id !== forId) throw new Error('Essa não é a mesma extensão que está instalada.');
      const fileMap = fileHashes(dir);
      const summary = this.inspect(dir, manifest, id, fileMap);
      const p = { token, dir, id, manifest, key, source, crxSha256: crxSha256 || null, hash: treeHash(fileMap), fileMap, summary, forId: forId || null };
      if (forId) {
        const rec = this.items()[forId];
        const cur = this.dirOf(rec);
        const oldMap = fileHashes(cur);
        const oldSum = this.inspect(cur, readManifest(cur), forId, oldMap);
        p.diff = risk.diffVersions(oldSum, summary, oldMap, fileMap);
        p.same = p.hash === rec.current.hash;
      }
      while (this.pending.size >= 4) this.discard(this.pending.keys().next().value); // não acumula análises abandonadas
      this.pending.set(token, p);
      return p;
    } catch (e) {
      rmDir(dir);
      throw e;
    }
  }

  inspect(dir, manifest, id, fileMap) {
    const hosts = this.gameHosts();
    const analysis = risk.analyzeManifest(manifest, { gameHosts: hosts, files: [...fileMap.keys()] });
    return risk.buildSummary({ manifest, id, analysis, code: scanDir(dir, fileMap.keys()), gameHosts: hosts });
  }

  reply(p) {
    return { ok: true, token: p.token, summary: p.summary, diff: p.diff || null, upToDate: !!p.same };
  }

  // Instalar pela Web Store (link ou ID).
  async prepareStore(input) {
    const id = parseStoreInput(input);
    if (!id) return fail('Cole o link da extensão na Chrome Web Store (ou o ID de 32 letras).');
    if (this.items()[id]) return fail('Essa extensão já está instalada. Use "Procurar atualização" na lista.');
    try {
      const buf = await this.download(id);
      const crx = parseCrx3(buf);
      if (crx.id !== id) return fail('O arquivo baixado é de outra extensão. Por segurança, não instalei.');
      return this.reply(this.stage({ files: readZip(crx.zip), key: crx.key, source: 'store', crxSha256: sha256(buf) }));
    } catch (e) {
      return fail(userMessage(e));
    }
  }

  // Instalar de uma pasta (extensão descompactada).
  prepareFolder(dir) {
    try {
      const files = readFolder(String(dir));
      const manifest = JSON.parse((files.find((f) => f.name === 'manifest.json')?.data.toString('utf8') || '').replace(/^﻿/, '') || 'null');
      if (!manifest) throw new Error('Essa pasta não tem um manifest.json: não parece uma extensão do Chrome.');
      const key = manifest.key && typeof manifest.key === 'string' ? manifest.key.replace(/\s+/g, '') : newKey(); // sem chave própria, o IdleHub cria uma para fixar o ID
      const id = idFromKey(Buffer.from(key, 'base64'));
      if (this.items()[id]) return fail('Essa extensão já está instalada. Use "Atualizar da pasta" na lista.');
      return this.reply(this.stage({ files, key, source: 'folder' }));
    } catch (e) {
      return fail(e instanceof SyntaxError ? 'O manifest.json da extensão está inválido.' : userMessage(e));
    }
  }

  // Procurar atualização de uma extensão da loja: baixa, compara e mostra o que mudou. Não troca nada.
  async prepareUpdate(id) {
    const rec = this.items()[String(id)];
    if (!rec) return fail('Extensão não encontrada.');
    if (rec.source !== 'store') return fail('Essa extensão veio de uma pasta: use "Atualizar da pasta".');
    try {
      const buf = await this.download(rec.id);
      const crx = parseCrx3(buf);
      if (crx.id !== rec.id) return fail('O arquivo baixado é de outra extensão. Por segurança, não atualizei.');
      const p = this.stage({ files: readZip(crx.zip), key: crx.key, source: 'store', crxSha256: sha256(buf), forId: rec.id });
      if (p.same) this.discard(p.token);
      return this.reply(p);
    } catch (e) {
      return fail(userMessage(e));
    }
  }

  // Atualizar uma extensão de pasta com uma pasta nova (reaproveita a mesma chave: o ID e os dados continuam).
  prepareUpdateFolder(id, dir) {
    const rec = this.items()[String(id)];
    if (!rec) return fail('Extensão não encontrada.');
    try {
      const files = readFolder(String(dir));
      const p = this.stage({ files, key: rec.key, source: 'folder', forId: rec.id });
      if (p.same) this.discard(p.token);
      return this.reply(p);
    } catch (e) {
      return fail(userMessage(e));
    }
  }

  discard(token) {
    const p = this.pending.get(token);
    if (!p) return;
    this.pending.delete(token);
    rmDir(p.dir);
  }

  // ----- confirmação
  // Tira a pasta da espera e põe em <id>/<versão>. Se a pasta já existe (mesma versão, conteúdo diferente), muda o nome.
  place(p) {
    const base = path.join(this.root, p.id);
    fs.mkdirSync(base, { recursive: true });
    let name = String(p.manifest.version).replace(/[^0-9A-Za-z._-]/g, '_').slice(0, 40) || 'v';
    if (fs.existsSync(path.join(base, name))) name = `${name}+${p.hash.slice(0, 8)}`;
    const dest = path.join(base, name);
    try {
      fs.renameSync(p.dir, dest);
    } catch {
      fs.cpSync(p.dir, dest, { recursive: true });
      rmDir(p.dir);
    }
    this.pending.delete(p.token);
    return { version: String(p.manifest.version), dir: name, hash: p.hash, crxSha256: p.crxSha256, installedAt: Date.now() };
  }

  // Instala depois do "sim" da pessoa. `accountKeys`: contas escolhidas por ela (pode ser nenhuma: fica desligada).
  confirmInstall(token, accountKeys = []) {
    const p = this.pending.get(String(token));
    if (!p || p.forId) return fail('A análise expirou. Escolha a extensão de novo.');
    if (p.summary.blocked) return fail('O IdleHub não instala essa extensão.');
    const items = this.items();
    if (items[p.id]) return fail('Essa extensão já está instalada.');
    const valid = this.accountKeys();
    try {
      const current = this.place(p);
      items[p.id] = {
        id: p.id, name: p.summary.name, source: p.source, key: p.key, installedAt: current.installedAt,
        risk: p.summary.risk, compat: p.summary.compat.level, current, previous: null,
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
      if (old && old.dir !== rec.current.dir && old.dir !== rec.previous.dir) rmDir(this.dirOf(rec, old)); // só guarda uma versão antiga
      this.saveConfig();
      return { ok: true, id: rec.id, accounts: [...rec.accounts] };
    } catch (e) {
      return fail(userMessage(e));
    }
  }

  // Volta para a versão anterior (a pasta dela foi mantida).
  rollback(id) {
    const rec = this.items()[String(id)];
    if (!rec?.previous) return fail('Não há versão anterior guardada.');
    if (!fs.existsSync(this.dirOf(rec, rec.previous))) return fail('A pasta da versão anterior não existe mais.');
    [rec.current, rec.previous] = [rec.previous, rec.current];
    this.saveConfig();
    return { ok: true, id: rec.id, accounts: [...rec.accounts] };
  }

  remove(id) {
    const items = this.items();
    const rec = items[String(id)];
    if (!rec) return fail('Extensão não encontrada.');
    const accounts = [...rec.accounts];
    delete items[rec.id];
    rmDir(path.join(this.root, rec.id));
    this.saveConfig();
    return { ok: true, accounts };
  }

  // ----- por conta
  setAccount(id, key, on) {
    const rec = this.items()[String(id)];
    if (!rec) return fail('Extensão não encontrada.');
    if (!this.accountKeys().has(String(key))) return fail('Conta não encontrada.');
    const set = new Set(rec.accounts);
    if (on) set.add(String(key));
    else set.delete(String(key));
    rec.accounts = [...set];
    this.saveConfig();
    return { ok: true };
  }

  // Conta ou jogo removidos: tira das listas (o login e os dados da conta somem junto com ela).
  pruneAccounts() {
    const valid = this.accountKeys();
    let changed = false;
    for (const rec of Object.values(this.items())) {
      const keep = rec.accounts.filter((k) => valid.has(k));
      if (keep.length !== rec.accounts.length) {
        rec.accounts = keep;
        changed = true;
      }
    }
    if (changed) this.saveConfig();
  }

  // O que carregar na sessão desta conta. Confere os arquivos contra o hash guardado: se mudaram (programa de
  // fora mexeu na pasta), a extensão NÃO carrega e vai para `problems`.
  forAccount(key) {
    const loads = [];
    const problems = [];
    for (const rec of Object.values(this.items())) {
      if (!rec.accounts.includes(key)) continue;
      const dir = this.dirOf(rec);
      let ok = false;
      try {
        ok = treeHash(fileHashes(dir)) === rec.current.hash;
      } catch {}
      if (ok) loads.push({ id: rec.id, name: rec.name, dir });
      else problems.push({ id: rec.id, name: rec.name });
    }
    return { loads, problems };
  }

  // O que a interface mostra (sem caminhos do PC).
  list() {
    return Object.values(this.items())
      .map((r) => ({
        id: r.id, name: r.name, source: r.source, version: r.current.version, hash: r.current.hash, installedAt: r.installedAt,
        risk: r.risk, compat: r.compat, accounts: [...r.accounts], previousVersion: r.previous?.version || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

module.exports = { ExtensionStore, parseStoreInput, parseUpdateXml, updateUrl, fileHashes, treeHash, readFolder, normalizedFile };
