// Avisos fora do PC ("Avisos no celular"): o IdleHub manda os mesmos avisos do Windows para
// canais que a pessoa liga (Discord agora; Telegram depois), sem servidor nosso.
//
// Três partes:
//  1. Cofre de segredos (secrets.json): links e tokens ficam criptografados com o safeStorage
//     do Electron (no Windows, ligado à conta do usuário) e nunca vão para o config.json.
//  2. Canais: { id, label, settingKey, isValidSecret(valor), send(segredo, { title, body }, { fetch, signal }) }.
//     O segredo de um canal é UMA string (se precisar de mais de um dado, junte num texto só).
//  3. createRemote(): junta cofre + canais. sendAll() manda para todos os canais ligados, sem esperar
//     e sem nunca derrubar o app.
//
// O que é puro (validar link, montar mensagem) e o cofre/envio recebem tudo por parâmetro, e o
// Electron só é carregado na hora de usar (como o recovery.js): dá para testar com node:test.

const fs = require('fs');
const path = require('path');

const SECRETS_FILE = 'secrets.json';
const SEND_TIMEOUT_MS = 8000;
const MAX_QUEUE = 20; // por canal: se acumular mais que isso (sem internet, por exemplo), descarta o resto
const MAX_RETRY_WAIT_MS = 5000;

// ---------- cofre de segredos ----------
const NO_ENCRYPTION =
  'Este Windows não deixou o IdleHub guardar o link com segurança, então ele não foi salvo.';

const defaultSafeStorage = () => require('electron').safeStorage;
const defaultDir = () => process.env.IDLEHUB_DATA || require('electron').app.getPath('userData');

const createSecretStore = ({ getSafeStorage = defaultSafeStorage, getDir = defaultDir } = {}) => {
  const file = () => path.join(getDir(), SECRETS_FILE);

  const readAll = () => {
    try {
      const data = JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^﻿/, ''));
      return data && typeof data.secrets === 'object' && data.secrets ? data.secrets : {};
    } catch {
      return {};
    }
  };

  const writeAll = (secrets) => {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, secrets }, null, 2));
    fs.renameSync(tmp, f);
  };

  const available = () => {
    try {
      return !!getSafeStorage().isEncryptionAvailable();
    } catch {
      return false;
    }
  };

  // Nunca guarda em texto puro: sem criptografia, não salva.
  const setSecret = (name, value) => {
    if (!available()) return { ok: false, error: NO_ENCRYPTION };
    try {
      const enc = getSafeStorage().encryptString(String(value)).toString('base64');
      writeAll({ ...readAll(), [name]: enc });
      return { ok: true };
    } catch {
      return { ok: false, error: 'Não consegui salvar o link. Tente de novo.' };
    }
  };

  // null = não existe ou não dá para abrir (ex.: o arquivo veio de outra conta do Windows).
  const getSecret = (name) => {
    const enc = readAll()[name];
    if (typeof enc !== 'string' || !available()) return null;
    try {
      return getSafeStorage().decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return null;
    }
  };

  const hasSecret = (name) => getSecret(name) !== null;

  const clearSecret = (name) => {
    try {
      const all = readAll();
      if (!(name in all)) return { ok: true };
      delete all[name];
      writeAll(all);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Não consegui apagar o link. Tente de novo.' };
    }
  };

  return { isAvailable: available, setSecret, getSecret, hasSecret, clearSecret };
};

// ---------- canal Discord ----------
const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']);
const DISCORD_PATH = /^\/api\/(?:v\d+\/)?webhooks\/(\d+)\/([\w-]+)\/?$/;
const DISCORD_MAX_CHARS = 2000;

// Aceita o link copiado do Discord e devolve o endereço limpo (https, sem parâmetros), ou null.
const normalizeDiscordWebhook = (value) => {
  let u;
  try {
    u = new URL(String(value || '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || !DISCORD_HOSTS.has(u.hostname)) return null;
  const m = DISCORD_PATH.exec(u.pathname);
  return m ? `https://${u.hostname}/api/webhooks/${m[1]}/${m[2]}` : null;
};

// O texto do aviso vem dos jogos: o título não pode virar formatação do Discord.
const escapeMarkdown = (s) => String(s).replace(/([\\*_~`|])/g, '\\$1');

const truncate = (s, max) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

const buildDiscordPayload = ({ title, body } = {}) => {
  const head = String(title || '').trim();
  const text = String(body || '').trim();
  const content = [head && `**${escapeMarkdown(head)}**`, text].filter(Boolean).join('\n') || 'IdleHub';
  return {
    username: 'IdleHub',
    content: truncate(content, DISCORD_MAX_CHARS),
    allowed_mentions: { parse: [] }, // texto de jogo nunca marca @everyone
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resposta do Discord -> { ok } ou { ok: false, error, retryAfterMs? } (o erro é para a pessoa ler).
const discordResult = async (res) => {
  if (res.ok) return { ok: true };
  if (res.status === 429) {
    let secs = Number(res.headers?.get?.('retry-after'));
    if (!Number.isFinite(secs)) secs = Number((await res.json().catch(() => ({}))).retry_after);
    return { ok: false, error: 'O Discord pediu para ir mais devagar. Tente de novo daqui a pouco.', retryAfterMs: Number.isFinite(secs) ? secs * 1000 : undefined };
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return { ok: false, error: 'O Discord não aceitou esse link. Ele pode ter sido apagado: crie outro webhook e cole de novo.' };
  }
  return { ok: false, error: `O Discord não conseguiu receber o aviso (erro ${res.status}). Tente de novo mais tarde.` };
};

const discord = {
  id: 'discord',
  label: 'Discord',
  settingKey: 'notifyDiscord',
  normalizeSecret: normalizeDiscordWebhook,
  invalidMessage: 'Esse link não parece um webhook do Discord. Copie de novo em Integrações → Webhooks → Copiar URL do webhook.',
  isValidSecret: (v) => normalizeDiscordWebhook(v) !== null,
  async send(secret, message, { fetch, signal }) {
    const attempt = async () =>
      discordResult(
        await fetch(secret, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildDiscordPayload(message)),
          signal,
        })
      );
    let r = await attempt();
    // Muitos avisos de uma vez: o Discord manda esperar. Espera pouco e tenta uma vez só.
    if (!r.ok && r.retryAfterMs !== undefined && r.retryAfterMs <= MAX_RETRY_WAIT_MS) {
      await sleep(r.retryAfterMs);
      r = await attempt();
    }
    return r.ok ? r : { ok: false, error: r.error };
  },
};

// ---------- canais ligados ----------
const CHANNELS = [discord];

const friendlyError = (err, label) =>
  err?.name === 'AbortError'
    ? `O ${label} demorou demais para responder. Tente de novo.`
    : `Não consegui falar com o ${label}. Veja se o PC está com internet.`;

const createRemote = ({
  store = createSecretStore(),
  channels = CHANNELS,
  getSettings = () => ({}),
  getFetch = () => require('electron').net.fetch,
  log = (...a) => console.warn('[remote]', ...a),
  timeoutMs = SEND_TIMEOUT_MS,
} = {}) => {
  const byId = (id) => channels.find((c) => c.id === id) || null;
  const secretName = (c) => c.id;
  const queues = new Map(); // id -> { chain, pending }

  // Manda um aviso e nunca lança: devolve { ok } ou { ok: false, error }.
  const deliver = async (channel, secret, message) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await channel.send(secret, message, { fetch: getFetch(), signal: ctrl.signal });
    } catch (err) {
      log(`${channel.id}: ${err?.message || err}`); // sem o link: ele é segredo
      return { ok: false, error: friendlyError(err, channel.label) };
    } finally {
      clearTimeout(timer);
    }
  };

  // Um canal por vez, na ordem, para não estourar o limite de envios do Discord.
  const enqueue = (channel, secret, message) => {
    const q = queues.get(channel.id) || { chain: Promise.resolve(), pending: 0 };
    queues.set(channel.id, q);
    if (q.pending >= MAX_QUEUE) return Promise.resolve({ ok: false, error: 'Avisos demais ao mesmo tempo.' });
    q.pending++;
    const run = q.chain.then(() => deliver(channel, secret, message));
    q.chain = run.then(() => { q.pending--; }, () => { q.pending--; });
    return run;
  };

  const status = () => {
    const s = getSettings() || {};
    return {
      encryption: store.isAvailable(),
      channels: Object.fromEntries(
        channels.map((c) => [c.id, { label: c.label, configured: store.hasSecret(secretName(c)), enabled: !!s[c.settingKey] }])
      ),
    };
  };

  // Para todos os canais ligados (e com segredo salvo). Não espera: devolve só para os testes.
  const sendAll = (message) => {
    const s = getSettings() || {};
    const jobs = [];
    for (const c of channels) {
      if (!s[c.settingKey]) continue;
      const secret = store.getSecret(secretName(c));
      if (secret) jobs.push(enqueue(c, secret, message));
    }
    return Promise.all(jobs);
  };

  const set = (id, value) => {
    const c = byId(id);
    if (!c) return { ok: false, error: 'Canal desconhecido.' };
    if (!c.isValidSecret(value)) return { ok: false, error: c.invalidMessage || `Isso não parece um dado válido do ${c.label}.` };
    return store.setSecret(secretName(c), c.normalizeSecret ? c.normalizeSecret(value) : String(value).trim());
  };

  const clear = (id) => {
    const c = byId(id);
    return c ? store.clearSecret(secretName(c)) : { ok: false, error: 'Canal desconhecido.' };
  };

  // Teste manual: manda mesmo com o canal desligado e espera a resposta.
  const test = async (id) => {
    const c = byId(id);
    if (!c) return { ok: false, error: 'Canal desconhecido.' };
    const secret = store.getSecret(secretName(c));
    if (!secret) return { ok: false, error: `Cole e salve o link do ${c.label} antes de testar.` };
    return enqueue(c, secret, { title: 'Teste do IdleHub', body: 'Deu certo! Os avisos das suas contas vão chegar aqui.' });
  };

  return { status, sendAll, set, clear, test, channelOf: byId };
};

module.exports = {
  SECRETS_FILE,
  DISCORD_MAX_CHARS,
  normalizeDiscordWebhook,
  buildDiscordPayload,
  discord,
  CHANNELS,
  createSecretStore,
  createRemote,
};
