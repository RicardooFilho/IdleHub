// Cofre de logins: usuário, senha, notas e (opcional) o segredo do 2FA de cada conta, criptografados neste PC.
// Fica em vault.json, na pasta de dados, e NUNCA no config.json, nos registros ou em qualquer envio.
//
// Camadas:
//  1. Sempre: safeStorage do Electron (no Windows, ligado à conta do usuário do Windows).
//  2. Opcional, com senha mestra: por baixo dela, AES-256-GCM com chave derivada por scrypt (sal aleatório).
//     A senha mestra não é guardada; só o sal e uma "prova" criptografada para conferir a senha.
//     Com senha mestra, o cofre fica trancado (a chave só existe na memória) até a pessoa digitar a senha, e
//     tranca de novo sozinho depois de um tempo parado e quando o PC bloqueia ou dorme (veja main.js).
//
// O Electron, o relógio, o disco e os temporizadores entram por parâmetro: dá para testar com node:test.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sanitizeTotp, parseTotpInput, totp } = require('./totp');
const { normalizeLoginHost } = require('./loginfill');

const VAULT_FILE = 'vault.json';
const DEFAULT_LOCK_MIN = 10;
const MAX_LOCK_MIN = 480;
const MIN_MASTER_LEN = 8;
const CLIPBOARD_CLEAR_MS = 30 * 1000;
// Custo do scrypt (padrão OWASP: N=2^16, r=8, p=2). Fica no arquivo, então dá para mudar depois.
const SCRYPT = { N: 1 << 16, r: 8, p: 2 };
const KEY_RE = /^[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_-]{1,40}$/;
const LIMITS = { username: 200, password: 500, notes: 2000 };
const CHECK_TEXT = 'idlehub-vault-v1';

const NO_ENCRYPTION = 'Este Windows não deixou o IdleHub guardar logins com segurança, então nada foi salvo.';
const LOCKED = 'O cofre está trancado. Digite a senha mestra para continuar.';
const WRONG_MASTER = 'Senha mestra incorreta.';

const defaultSafeStorage = () => require('electron').safeStorage;
const defaultDir = () => process.env.IDLEHUB_DATA || require('electron').app.getPath('userData');

const defaultScrypt = (password, salt, { N, r, p }) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(password.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)))
  );

// ---------- AES-256-GCM (senha mestra) ----------
const box = (key, text) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
};

// Lança se a chave estiver errada ou o dado tiver sido mexido.
const unbox = (key, b) => {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(b.iv, 'base64'));
  d.setAuthTag(Buffer.from(b.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(b.data, 'base64')), d.final()]).toString('utf8');
};

const isBox = (b) => !!b && typeof b.iv === 'string' && typeof b.tag === 'string' && typeof b.data === 'string';
const str = (v, max) => String(v ?? '').slice(0, max);

const publicMeta = (s) => ({ pw: !!s.password, totp: !!s.totp, notes: !!s.notes, host: s.host || '' });

const createVault = ({
  getSafeStorage = defaultSafeStorage,
  getDir = defaultDir,
  scrypt = defaultScrypt,
  params = SCRYPT,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onLockChange = () => {},
} = {}) => {
  let key = null; // chave da senha mestra, só na memória e só enquanto destrancado
  let timer = null;
  const file = () => path.join(getDir(), VAULT_FILE);

  // ---------- arquivo ----------
  const emptyData = () => ({ version: 1, lockMinutes: DEFAULT_LOCK_MIN, master: null, entries: {} });
  const read = () => {
    try {
      const d = JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^﻿/, ''));
      const m = d.master;
      const master =
        m && typeof m.salt === 'string' && isBox(m.check) && Number.isInteger(m.N) && Number.isInteger(m.r) && Number.isInteger(m.p)
          ? { salt: m.salt, N: m.N, r: m.r, p: m.p, check: m.check }
          : null;
      const entries = {};
      for (const [k, e] of Object.entries(d.entries && typeof d.entries === 'object' ? d.entries : {})) {
        if (KEY_RE.test(k) && e && typeof e.blob === 'string') entries[k] = { meta: e.meta && typeof e.meta === 'object' ? e.meta : {}, blob: e.blob };
      }
      const min = Number(d.lockMinutes);
      return { version: 1, lockMinutes: Number.isFinite(min) ? Math.min(MAX_LOCK_MIN, Math.max(0, Math.round(min))) : DEFAULT_LOCK_MIN, master, entries };
    } catch {
      return emptyData();
    }
  };
  const write = (d) => {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
    fs.renameSync(tmp, f);
  };

  const available = () => {
    try {
      return !!getSafeStorage().isEncryptionAvailable();
    } catch {
      return false;
    }
  };

  // ---------- criptografia de uma entrada ----------
  // Dentro do safeStorage vai { v:1, s: segredos } (sem senha mestra) ou { v:1, m: caixa AES } (com ela).
  const wrap = (secret, k) => {
    const inner = k ? { v: 1, m: box(k, JSON.stringify(secret)) } : { v: 1, s: secret };
    return getSafeStorage().encryptString(JSON.stringify(inner)).toString('base64');
  };
  // { ok, secret } | { ok: false, locked } | { ok: false } (não dá para abrir: arquivo de outra conta do Windows, por exemplo)
  const unwrap = (entry, k) => {
    try {
      const inner = JSON.parse(getSafeStorage().decryptString(Buffer.from(entry.blob, 'base64')));
      if (inner.m) {
        if (!k) return { ok: false, locked: true };
        return { ok: true, secret: JSON.parse(unbox(k, inner.m)) };
      }
      return inner.s && typeof inner.s === 'object' ? { ok: true, secret: inner.s } : { ok: false };
    } catch {
      return { ok: false };
    }
  };

  // ---------- trancar e destrancar ----------
  const isLocked = () => !!read().master && !key;

  const stopTimer = () => {
    if (timer) clearTimer(timer);
    timer = null;
  };

  const lock = () => {
    stopTimer();
    if (!key) return;
    key.fill(0);
    key = null;
    onLockChange();
  };

  // Cada uso do cofre adia o trancamento automático.
  const touch = () => {
    stopTimer();
    if (!key) return;
    const min = read().lockMinutes;
    if (min > 0) {
      timer = setTimer(lock, min * 60 * 1000);
      timer.unref?.();
    }
  };

  const setKey = (k) => {
    if (key && key !== k) key.fill(0);
    key = k;
    touch();
    onLockChange();
  };

  // Confere a senha mestra e devolve a chave (ou null).
  const verify = async (password, master) => {
    try {
      const k = await scrypt(String(password ?? ''), Buffer.from(master.salt, 'base64'), master);
      return unbox(k, master.check) === CHECK_TEXT ? k : null;
    } catch {
      return null;
    }
  };

  const guard = () => {
    if (!available()) return { ok: false, error: NO_ENCRYPTION };
    if (isLocked()) return { ok: false, locked: true, error: LOCKED };
    return null;
  };

  // Refaz a criptografia de todas as entradas com `from` (chave de agora) para `to` (chave nova ou null).
  const rewrap = (d, from, to) => {
    const entries = {};
    for (const [k, e] of Object.entries(d.entries)) {
      const r = unwrap(e, from);
      entries[k] = r.ok ? { meta: e.meta, blob: wrap(r.secret, to) } : e; // o que não abre fica como está
    }
    return entries;
  };

  // ---------- consulta ----------
  const status = () => {
    const d = read();
    return { available: available(), hasMaster: !!d.master, locked: !!d.master && !key, lockMinutes: d.lockMinutes };
  };

  // Para a tela: só se tem senha/notas/2FA e o usuário (este, só destrancado). Nunca senha, notas nem segredo do 2FA.
  const entries = () => {
    const d = read();
    const locked = !!d.master && !key;
    const out = {};
    for (const [k, e] of Object.entries(d.entries)) {
      const meta = { pw: !!e.meta.pw, totp: !!e.meta.totp, notes: !!e.meta.notes, host: str(e.meta.host, 253), username: null };
      if (!locked) {
        const r = unwrap(e, key);
        if (r.ok) meta.username = str(r.secret.username, LIMITS.username);
        else meta.unreadable = true;
      }
      out[k] = meta;
    }
    return out;
  };

  const meta = (k) => {
    const e = read().entries[k];
    return e ? { pw: !!e.meta.pw, totp: !!e.meta.totp, notes: !!e.meta.notes, host: str(e.meta.host, 253) } : null;
  };

  // Para uso dentro do app (preencher, copiar, mostrar). Nunca vai inteiro para a interface.
  const secretFor = (k) => {
    const g = guard();
    if (g) return g;
    const e = read().entries[k];
    if (!e) return { ok: false, error: 'Nenhum login salvo para esta conta.' };
    const r = unwrap(e, key);
    if (!r.ok) return { ok: false, error: 'Não consegui abrir este login. Ele foi salvo em outra conta do Windows? Salve de novo.' };
    touch();
    return { ok: true, secret: r.secret };
  };

  // ---------- gravação ----------
  // patch: texto = troca; null = apaga; ausente (undefined) = mantém. `totp` é o texto colado (segredo ou otpauth://).
  const save = (k, patch = {}, { totpAck = false } = {}) => {
    if (!KEY_RE.test(String(k))) return { ok: false, error: 'Conta desconhecida.' };
    const g = guard();
    if (g) return g;
    const d = read();
    const old = d.entries[k] ? unwrap(d.entries[k], key) : { ok: false };
    const next = { ...(old.ok ? old.secret : {}) };
    for (const f of ['username', 'password', 'notes']) {
      if (patch[f] === undefined) continue;
      const v = patch[f] === null ? '' : String(patch[f]);
      if (v.length > LIMITS[f]) return { ok: false, error: 'Esse texto é grande demais.' };
      if (v) next[f] = v;
      else delete next[f];
    }
    if (patch.host !== undefined) {
      const h = patch.host === null ? '' : String(patch.host).trim();
      if (h) {
        const host = normalizeLoginHost(h);
        if (!host) return { ok: false, error: 'Esse endereço de login não serve. Use o site da página de login (https), que não seja do Google.' };
        next.host = host;
      } else delete next.host;
    }
    if (patch.totp !== undefined) {
      if (patch.totp === null || String(patch.totp).trim() === '') delete next.totp;
      else {
        if (!totpAck) return { ok: false, error: 'Marque que você entendeu o aviso do 2FA para guardar o código.' };
        const t = parseTotpInput(patch.totp);
        if (t.error) return { ok: false, error: t.error };
        next.totp = t;
      }
    }
    if (!next.username && !next.password) return { ok: false, error: 'Preencha o usuário ou a senha.' };
    try {
      d.entries[k] = { meta: publicMeta(next), blob: wrap(next, key) };
      write(d);
    } catch {
      return { ok: false, error: 'Não consegui salvar. Tente de novo.' };
    }
    touch();
    return { ok: true };
  };

  const remove = (k) => {
    try {
      const d = read();
      if (!(k in d.entries)) return { ok: true };
      delete d.entries[k];
      write(d);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Não consegui apagar. Tente de novo.' };
    }
  };

  // Conta apagada do IdleHub: some o login dela. `validKeys` = chaves das contas que ainda existem.
  const prune = (validKeys) => {
    try {
      const keep = new Set(validKeys);
      const d = read();
      const gone = Object.keys(d.entries).filter((k) => !keep.has(k));
      if (!gone.length) return 0;
      for (const k of gone) delete d.entries[k];
      write(d);
      return gone.length;
    } catch {
      return 0;
    }
  };

  // Apaga o cofre inteiro (para quem esqueceu a senha mestra).
  const reset = () => {
    try {
      lock();
      fs.rmSync(file(), { force: true });
      onLockChange();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Não consegui apagar o cofre. Tente de novo.' };
    }
  };

  const setLockMinutes = (n) => {
    const min = Number(n);
    if (!Number.isFinite(min)) return { ok: false, error: 'Esse tempo não serve.' };
    try {
      const d = read();
      d.lockMinutes = Math.min(MAX_LOCK_MIN, Math.max(0, Math.round(min)));
      write(d);
      touch();
      return { ok: true, lockMinutes: d.lockMinutes };
    } catch {
      return { ok: false, error: 'Não consegui salvar. Tente de novo.' };
    }
  };

  // ---------- senha mestra ----------
  const newMaster = async (password) => {
    const pw = String(password ?? '');
    if (pw.length < MIN_MASTER_LEN) return { error: `A senha mestra precisa ter pelo menos ${MIN_MASTER_LEN} caracteres.` };
    const salt = crypto.randomBytes(16);
    const k = await scrypt(pw, salt, params);
    return { k, master: { salt: salt.toString('base64'), ...params, check: box(k, CHECK_TEXT) } };
  };

  const setMaster = async (password) => {
    if (!available()) return { ok: false, error: NO_ENCRYPTION };
    const d = read();
    if (d.master) return { ok: false, error: 'O cofre já tem uma senha mestra.' };
    try {
      const n = await newMaster(password);
      if (n.error) return { ok: false, error: n.error };
      d.entries = rewrap(d, null, n.k);
      d.master = n.master;
      write(d);
      setKey(n.k);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Não consegui criar a senha mestra. Tente de novo.' };
    }
  };

  const changeMaster = async (current, next) => {
    if (!available()) return { ok: false, error: NO_ENCRYPTION };
    const d = read();
    if (!d.master) return { ok: false, error: 'O cofre ainda não tem senha mestra.' };
    const old = await verify(current, d.master);
    if (!old) return { ok: false, error: WRONG_MASTER };
    try {
      const n = await newMaster(next);
      if (n.error) return { ok: false, error: n.error };
      d.entries = rewrap(d, old, n.k);
      d.master = n.master;
      write(d);
      old.fill(0);
      setKey(n.k);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Não consegui trocar a senha mestra. Tente de novo.' };
    }
  };

  const removeMaster = async (current) => {
    if (!available()) return { ok: false, error: NO_ENCRYPTION };
    const d = read();
    if (!d.master) return { ok: true };
    const old = await verify(current, d.master);
    if (!old) return { ok: false, error: WRONG_MASTER };
    try {
      d.entries = rewrap(d, old, null);
      d.master = null;
      write(d);
      old.fill(0);
      lock();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Não consegui tirar a senha mestra. Tente de novo.' };
    }
  };

  const unlock = async (password) => {
    const d = read();
    if (!d.master) return { ok: true };
    const k = await verify(password, d.master);
    if (!k) return { ok: false, error: WRONG_MASTER };
    setKey(k);
    return { ok: true };
  };

  // Código 2FA de agora (só destrancado).
  const totpCode = (k, now = Date.now()) => {
    const r = secretFor(k);
    if (!r.ok) return r;
    const params2 = sanitizeTotp(r.secret.totp);
    const c = params2 && totp(params2, now);
    return c ? { ok: true, ...c } : { ok: false, error: 'Esta conta não tem código 2FA salvo.' };
  };

  return { status, entries, meta, secretFor, save, remove, prune, reset, setLockMinutes, setMaster, changeMaster, removeMaster, unlock, lock, totpCode };
};

// Copiar para a área de transferência e limpar depois de um tempo, só se ainda for o que copiamos
// (se a pessoa copiou outra coisa nesse meio tempo, não mexe).
const createClipboardGuard = ({ clipboard, setTimer = setTimeout, clearTimer = clearTimeout, ms = CLIPBOARD_CLEAR_MS } = {}) => {
  let timer = null;
  let value = null;
  const clearNow = () => {
    if (timer) clearTimer(timer);
    timer = null;
    const mine = value;
    value = null;
    if (mine === null) return;
    try {
      if (clipboard.readText() === mine) clipboard.clear();
    } catch {}
  };
  const copy = (text) => {
    if (timer) clearTimer(timer);
    clipboard.writeText(text);
    value = text;
    timer = setTimer(clearNow, ms);
    timer.unref?.();
    return ms;
  };
  return { copy, clearNow };
};

module.exports = { VAULT_FILE, DEFAULT_LOCK_MIN, MIN_MASTER_LEN, CLIPBOARD_CLEAR_MS, KEY_RE, createVault, createClipboardGuard };
