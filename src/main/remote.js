// Avisos fora do PC ("Avisos no celular"): o IdleHub manda os mesmos avisos do Windows para
// canais que a pessoa liga (Discord e Telegram), sem servidor nosso.
//
// Três partes:
//  1. Cofre de segredos (secrets.json): links e tokens ficam criptografados com o safeStorage
//     do Electron (no Windows, ligado à conta do usuário) e nunca vão para o config.json.
//  2. Canais: { id, label, settingKey, isValidSecret(valor), send(segredo, { title, body }, { fetch, signal }) }.
//     O segredo de um canal é UMA string (se precisar de mais de um dado, junte num texto só: o Telegram
//     guarda um JSON { token, chatId, ... }). Ganchos opcionais: prepare(valor, ctx) (confere o que a pessoa
//     colou e devolve o segredo a guardar), findChat(segredo, ctx), isReady(segredo) e describe(segredo)
//     (só dados públicos para a tela, nunca o token).
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
  'Este Windows não deixou o IdleHub guardar o link ou o token com segurança, então ele não foi salvo.';

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
      return { ok: false, error: 'Não consegui salvar. Tente de novo.' };
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

// Muitos avisos de uma vez: o canal manda esperar. Espera pouco e tenta uma vez só.
const sendWithRetry = async (attempt) => {
  let r = await attempt();
  if (!r.ok && r.retryAfterMs !== undefined && r.retryAfterMs <= MAX_RETRY_WAIT_MS) {
    await sleep(r.retryAfterMs);
    r = await attempt();
  }
  return r.ok ? r : { ok: false, error: r.error };
};

const discord = {
  id: 'discord',
  label: 'Discord',
  settingKey: 'notifyDiscord',
  normalizeSecret: normalizeDiscordWebhook,
  invalidMessage: 'Esse link não parece um webhook do Discord. Copie de novo em Integrações → Webhooks → Copiar URL do webhook.',
  isValidSecret: (v) => normalizeDiscordWebhook(v) !== null,
  async send(secret, message, { fetch, signal }) {
    return sendWithRetry(async () =>
      discordResult(
        await fetch(secret, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildDiscordPayload(message)),
          signal,
        })
      )
    );
  },
};

// ---------- canal Telegram ----------
// A pessoa cria um bot no @BotFather e cola o token. O segredo guardado é um JSON
// { token, botName, chatId, chatName }: a conversa é descoberta depois que ela manda /start para o bot.
const TELEGRAM_TOKEN = /^\d+:[A-Za-z0-9_-]{30,}$/;
const TELEGRAM_MAX_CHARS = 4096;
const TELEGRAM_MAX_TITLE = 256;

const normalizeTelegramToken = (value) => {
  const t = String(value || '').trim();
  return TELEGRAM_TOKEN.test(t) ? t : null;
};

// Segredo guardado -> { token, botName, chatId, chatName } ou null.
const parseTelegramSecret = (raw) => {
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || !normalizeTelegramToken(o.token)) return null;
    return {
      token: o.token,
      botName: typeof o.botName === 'string' ? o.botName : '',
      chatId: Number.isSafeInteger(o.chatId) ? o.chatId : null,
      chatName: typeof o.chatName === 'string' ? o.chatName : '',
    };
  } catch {
    return null;
  }
};

const stringifyTelegramSecret = ({ token, botName = '', chatId = null, chatName = '' }) =>
  JSON.stringify({ token, botName, chatId, chatName });

// parse_mode HTML do Telegram: só estes três símbolos precisam de escape.
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Corta pelo texto de verdade (o limite de 4096 vale depois de o Telegram ler o HTML, em que &amp; conta 1).
// Cortar antes de escapar também evita deixar um "&am" pela metade.
const cutText = (s, max) => {
  if (s.length <= max) return s;
  let out = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1); // não racha um emoji ao meio
  return `${out}…`;
};

const buildTelegramPayload = (chatId, { title, body } = {}) => {
  const head = cutText(String(title || '').trim(), TELEGRAM_MAX_TITLE);
  const text = String(body || '').trim();
  const room = TELEGRAM_MAX_CHARS - (head ? head.length + 1 : 0);
  const cutBody = cutText(text, Math.max(room, 1));
  const html = [head && `<b>${escapeHtml(head)}</b>`, escapeHtml(cutBody)].filter(Boolean).join('\n') || 'IdleHub';
  return { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true };
};

const telegramName = (chat) =>
  [chat.first_name, chat.last_name].filter(Boolean).join(' ') || (chat.username ? `@${chat.username}` : '');

// Resposta do getUpdates -> { id, name } da conversa privada mais recente, ou null.
// Quem mandou /start vale mais que qualquer outra mensagem (ninguém "entra" no bot por acaso).
const pickChatFromUpdates = (updates) => {
  if (!Array.isArray(updates)) return null;
  const msgs = updates
    .map((u) => ({ id: Number(u?.update_id) || 0, m: u?.message || u?.edited_message }))
    .filter(({ m }) => m && m.chat && m.chat.type === 'private' && Number.isSafeInteger(m.chat.id) && m.chat.id > 0 && !m.from?.is_bot)
    .sort((a, b) => b.id - a.id);
  const best = msgs.find(({ m }) => /^\/start\b/.test(m.text || '')) || msgs[0];
  return best ? { id: best.m.chat.id, name: telegramName(best.m.chat) } : null;
};

// Tira o token de qualquer texto que vá para o log (a URL da API tem o token no meio).
const maskSecrets = (text) =>
  String(text)
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot***')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '***')
    .replace(/(webhooks\/\d+\/)[\w-]+/g, '$1***');

const telegramApi = async (token, method, params, { fetch, signal }) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params || {}),
    signal,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok && json.ok !== false, json };
};

// Resposta de erro do Telegram -> { ok: false, error, retryAfterMs? } com frase para a pessoa ler.
const telegramError = ({ status, json }) => {
  const code = Number(json?.error_code) || status;
  if (code === 429) {
    const secs = Number(json?.parameters?.retry_after);
    return { ok: false, error: 'O Telegram pediu para ir mais devagar. Tente de novo daqui a pouco.', retryAfterMs: Number.isFinite(secs) ? secs * 1000 : undefined };
  }
  if (code === 401 || code === 404) return { ok: false, error: 'O Telegram não aceitou esse token. Ele pode ter sido trocado: pegue o token de novo no @BotFather.' };
  if (code === 403) return { ok: false, error: 'O bot não pode falar com você. Abra o bot no Telegram e mande /start (se você o bloqueou, desbloqueie).' };
  if (code === 400 && /chat not found/i.test(json?.description || '')) {
    return { ok: false, error: 'O Telegram não achou a conversa. Abra o bot, mande /start e clique em Procurar conversa.' };
  }
  return { ok: false, error: `O Telegram não conseguiu receber o aviso (erro ${code}). Tente de novo mais tarde.` };
};

const botLabel = (botName) => (botName ? `@${botName}` : 'o bot');

const telegram = {
  id: 'telegram',
  label: 'Telegram',
  settingKey: 'notifyTelegram',
  normalizeSecret: normalizeTelegramToken,
  invalidMessage: 'Esse token não parece de um bot do Telegram. Ele é parecido com 123456789:AAH… (copie inteiro da conversa com o @BotFather).',
  isValidSecret: (v) => normalizeTelegramToken(v) !== null,

  // Confere o token no Telegram (getMe) e já guarda o @ do bot. Trocar o token apaga a conversa antiga.
  async prepare(token, ctx) {
    const r = await telegramApi(token, 'getMe', {}, ctx);
    if (!r.ok) return telegramError(r);
    return { ok: true, secret: stringifyTelegramSecret({ token, botName: r.json?.result?.username || '' }) };
  },

  // Procura a conversa privada mais recente com o bot (getUpdates) e devolve o segredo já com ela.
  async findChat(secret, ctx) {
    const s = parseTelegramSecret(secret);
    if (!s) return { ok: false, error: 'Cole e salve o token do bot antes.' };
    const r = await telegramApi(s.token, 'getUpdates', { limit: 100, timeout: 0, allowed_updates: ['message', 'edited_message'] }, ctx);
    if (r.status === 409) {
      return { ok: false, error: 'Esse bot está ligado a outro programa (webhook), então o IdleHub não consegue ler as conversas dele. Crie um bot novo no @BotFather.' };
    }
    if (!r.ok) return telegramError(r);
    const chat = pickChatFromUpdates(r.json?.result);
    if (!chat) {
      return { ok: false, error: `Não achei nenhuma conversa. Abra ${botLabel(s.botName)} no Telegram, mande /start e clique em Procurar conversa de novo.` };
    }
    return { ok: true, secret: stringifyTelegramSecret({ ...s, chatId: chat.id, chatName: chat.name }) };
  },

  // Só manda se já achou a conversa.
  isReady: (secret) => parseTelegramSecret(secret)?.chatId != null,

  // Dados que a tela pode mostrar (nunca o token).
  describe(secret) {
    const s = parseTelegramSecret(secret);
    return s ? { bot: s.botName, chat: s.chatId != null, chatName: s.chatName } : {};
  },

  async send(secret, message, { fetch, signal }) {
    const s = parseTelegramSecret(secret);
    if (!s) return { ok: false, error: 'O token do Telegram salvo está inválido. Cole o token de novo.' };
    if (s.chatId == null) return { ok: false, error: `Abra ${botLabel(s.botName)} no Telegram, mande /start e clique em Procurar conversa.` };
    return sendWithRetry(async () => {
      const r = await telegramApi(s.token, 'sendMessage', buildTelegramPayload(s.chatId, message), { fetch, signal });
      return r.ok ? { ok: true } : telegramError(r);
    });
  },
};

// ---------- canais ligados ----------
const CHANNELS = [discord, telegram];

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

  // Roda uma chamada de rede com tempo limite. Nunca lança: devolve { ok: false, error } se falhar.
  const guarded = async (channel, fn) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fn({ fetch: getFetch(), signal: ctrl.signal });
    } catch (err) {
      log(`${channel.id}: ${maskSecrets(err?.message || err)}`); // sem o link/token: são segredos
      return { ok: false, error: friendlyError(err, channel.label) };
    } finally {
      clearTimeout(timer);
    }
  };

  // Manda um aviso e nunca lança: devolve { ok } ou { ok: false, error }.
  const deliver = (channel, secret, message) => guarded(channel, (ctx) => channel.send(secret, message, ctx));

  // Um canal por vez, na ordem, para não estourar o limite de envios do canal.
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
        channels.map((c) => {
          const secret = store.getSecret(secretName(c));
          const info = { label: c.label, configured: secret !== null, enabled: !!s[c.settingKey] };
          if (c.describe && secret !== null) info.detail = c.describe(secret); // só dados públicos
          return [c.id, info];
        })
      ),
    };
  };

  // Para todos os canais ligados (e com segredo salvo e pronto). Não espera: devolve só para os testes.
  const sendAll = (message) => {
    const s = getSettings() || {};
    const jobs = [];
    for (const c of channels) {
      if (!s[c.settingKey]) continue;
      const secret = store.getSecret(secretName(c));
      if (secret && (!c.isReady || c.isReady(secret))) jobs.push(enqueue(c, secret, message));
    }
    return Promise.all(jobs);
  };

  const validate = (id, value) => {
    const c = byId(id);
    if (!c) return { error: 'Canal desconhecido.' };
    if (!c.isValidSecret(value)) return { error: c.invalidMessage || `Isso não parece um dado válido do ${c.label}.` };
    return { c, secret: c.normalizeSecret ? c.normalizeSecret(value) : String(value).trim() };
  };

  // Guarda o que a pessoa colou (sem rede). Canais que precisam conferir online usam connect().
  const set = (id, value) => {
    const v = validate(id, value);
    return v.error ? { ok: false, error: v.error } : store.setSecret(secretName(v.c), v.secret);
  };

  // Igual a set(), mas deixa o canal conferir o dado online antes de guardar (ex.: token do Telegram).
  const connect = async (id, value) => {
    const v = validate(id, value);
    if (v.error) return { ok: false, error: v.error };
    if (!v.c.prepare) return store.setSecret(secretName(v.c), v.secret);
    const r = await guarded(v.c, (ctx) => v.c.prepare(v.secret, ctx));
    return r.ok ? store.setSecret(secretName(v.c), r.secret) : { ok: false, error: r.error };
  };

  // Canais que precisam descobrir algo depois de salvar (ex.: conversa do Telegram).
  const findChat = async (id) => {
    const c = byId(id);
    if (!c?.findChat) return { ok: false, error: 'Canal desconhecido.' };
    const secret = store.getSecret(secretName(c));
    if (!secret) return { ok: false, error: `Cole e salve o token do ${c.label} antes.` };
    const r = await guarded(c, (ctx) => c.findChat(secret, ctx));
    if (!r.ok) return r;
    const saved = store.setSecret(secretName(c), r.secret);
    return saved.ok ? { ok: true, detail: c.describe?.(r.secret) } : saved;
  };

  const clear = (id) => {
    const c = byId(id);
    return c ? store.clearSecret(secretName(c)) : { ok: false, error: 'Canal desconhecido.' };
  };

  // Teste manual: manda mesmo com o canal desligado e espera a resposta.
  // Se ainda não achou a conversa (Telegram), tenta achar antes de mandar.
  const test = async (id) => {
    const c = byId(id);
    if (!c) return { ok: false, error: 'Canal desconhecido.' };
    let secret = store.getSecret(secretName(c));
    if (!secret) return { ok: false, error: `Cole e salve o ${c.id === 'telegram' ? 'token' : 'link'} do ${c.label} antes de testar.` };
    if (c.isReady && !c.isReady(secret)) {
      const f = await findChat(id);
      if (!f.ok) return f;
      secret = store.getSecret(secretName(c));
    }
    return enqueue(c, secret, { title: 'Teste do IdleHub', body: 'Deu certo! Os avisos das suas contas vão chegar aqui.' });
  };

  return { status, sendAll, set, connect, findChat, clear, test, channelOf: byId };
};

module.exports = {
  SECRETS_FILE,
  DISCORD_MAX_CHARS,
  TELEGRAM_MAX_CHARS,
  normalizeDiscordWebhook,
  buildDiscordPayload,
  normalizeTelegramToken,
  parseTelegramSecret,
  buildTelegramPayload,
  pickChatFromUpdates,
  escapeHtml,
  maskSecrets,
  discord,
  telegram,
  CHANNELS,
  createSecretStore,
  createRemote,
};
