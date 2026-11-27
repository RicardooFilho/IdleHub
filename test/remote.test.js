// Avisos fora do PC (src/main/remote.js): validação do link, mensagem, cofre e envio. Sem rede e sem Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeDiscordWebhook,
  buildDiscordPayload,
  DISCORD_MAX_CHARS,
  SECRETS_FILE,
  createSecretStore,
  createRemote,
  discord,
} = require('../src/main/remote');

const GOOD = 'https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL123';

// ---------- link do webhook ----------
test('aceita links de webhook do Discord e limpa o endereço', () => {
  assert.equal(normalizeDiscordWebhook(GOOD), GOOD);
  assert.equal(normalizeDiscordWebhook(`  ${GOOD}  \n`), GOOD);
  assert.equal(normalizeDiscordWebhook(`${GOOD}?wait=true#x`), GOOD);
  assert.equal(normalizeDiscordWebhook('https://discordapp.com/api/webhooks/1/a-b_c'), 'https://discordapp.com/api/webhooks/1/a-b_c');
  assert.equal(normalizeDiscordWebhook('https://canary.discord.com/api/v10/webhooks/1/tok/'), 'https://canary.discord.com/api/webhooks/1/tok');
});

test('recusa o que não é webhook do Discord', () => {
  for (const bad of [
    '',
    null,
    undefined,
    'texto qualquer',
    'http://discord.com/api/webhooks/1/tok', // sem https
    'https://discord.com.evil.com/api/webhooks/1/tok',
    'https://evil.com/api/webhooks/1/tok',
    'https://discord.com@evil.com/api/webhooks/1/tok',
    'https://user:pw@discord.com/api/webhooks/1/tok',
    'https://discord.com:8443/api/webhooks/1/tok',
    'https://discord.com/api/webhooks/abc/tok', // id não numérico
    'https://discord.com/api/webhooks/1',
    'https://discord.com/api/webhooks/1/tok/extra',
    'https://discord.com/channels/1/2',
  ]) {
    assert.equal(normalizeDiscordWebhook(bad), null, String(bad));
    assert.equal(discord.isValidSecret(bad), false, String(bad));
  }
  assert.equal(discord.isValidSecret(GOOD), true);
});

// ---------- mensagem ----------
test('monta a mensagem com título em negrito e sem marcar ninguém', () => {
  const p = buildDiscordPayload({ title: 'Conta 2 caiu', body: 'Recarregando.' });
  assert.equal(p.username, 'IdleHub');
  assert.equal(p.content, '**Conta 2 caiu**\nRecarregando.');
  assert.deepEqual(p.allowed_mentions, { parse: [] });
});

test('título com símbolos do Discord não vira formatação', () => {
  assert.equal(buildDiscordPayload({ title: 'a*b_c', body: '@everyone' }).content, '**a\\*b\\_c**\n@everyone');
});

test('mensagem sem título ou sem corpo continua válida', () => {
  assert.equal(buildDiscordPayload({ title: 'Só título' }).content, '**Só título**');
  assert.equal(buildDiscordPayload({ body: 'Só corpo' }).content, 'Só corpo');
  assert.equal(buildDiscordPayload({}).content, 'IdleHub');
  assert.equal(buildDiscordPayload().content, 'IdleHub');
});

test('corta a mensagem no limite de 2000 caracteres do Discord', () => {
  const p = buildDiscordPayload({ title: 'T', body: 'x'.repeat(5000) });
  assert.equal(p.content.length, DISCORD_MAX_CHARS);
  assert.ok(p.content.endsWith('…'));
  assert.equal(buildDiscordPayload({ body: 'x'.repeat(DISCORD_MAX_CHARS) }).content.length, DISCORD_MAX_CHARS);
});

// ---------- cofre ----------
// "Criptografia" de mentira, só para provar que o arquivo não guarda o texto puro.
const fakeSafe = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).reverse().toString('latin1')}`, 'latin1'),
  decryptString: (b) => {
    const t = b.toString('latin1');
    if (!t.startsWith('ENC:')) throw new Error('inválido');
    return Buffer.from(t.slice(4), 'latin1').reverse().toString();
  },
});

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-remote-'));

test('cofre guarda criptografado e lê de volta', () => {
  const dir = tmpDir();
  const store = createSecretStore({ getSafeStorage: () => fakeSafe(), getDir: () => dir });
  assert.equal(store.hasSecret('discord'), false);
  assert.deepEqual(store.setSecret('discord', GOOD), { ok: true });
  assert.equal(store.hasSecret('discord'), true);
  assert.equal(store.getSecret('discord'), GOOD);
  const raw = fs.readFileSync(path.join(dir, SECRETS_FILE), 'utf8');
  assert.ok(!raw.includes(GOOD) && !raw.includes('abcDEF'), 'o segredo não pode estar em texto puro');
  assert.ok(!raw.includes('discord.com'));
  assert.deepEqual(store.clearSecret('discord'), { ok: true });
  assert.equal(store.hasSecret('discord'), false);
});

test('sem criptografia no Windows o cofre não salva nada', () => {
  const dir = tmpDir();
  const store = createSecretStore({ getSafeStorage: () => fakeSafe(false), getDir: () => dir });
  const r = store.setSecret('discord', GOOD);
  assert.equal(r.ok, false);
  assert.match(r.error, /guardar o link com segurança/);
  assert.equal(fs.existsSync(path.join(dir, SECRETS_FILE)), false);
  assert.equal(store.isAvailable(), false);
});

test('cofre ignora arquivo quebrado e segredo que não abre', () => {
  const dir = tmpDir();
  const store = createSecretStore({ getSafeStorage: () => fakeSafe(), getDir: () => dir });
  fs.writeFileSync(path.join(dir, SECRETS_FILE), '{ não é json');
  assert.equal(store.getSecret('discord'), null);
  assert.deepEqual(store.setSecret('discord', GOOD), { ok: true }); // refaz o arquivo
  fs.writeFileSync(path.join(dir, SECRETS_FILE), JSON.stringify({ secrets: { discord: Buffer.from('lixo').toString('base64') } }));
  assert.equal(store.getSecret('discord'), null);
  assert.equal(store.hasSecret('discord'), false);
});

// ---------- envio ----------
const res = (status, { headers = {}, json = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => json,
});

const setup = ({ settings = { notifyDiscord: true }, fetchImpl, available = true } = {}) => {
  const dir = tmpDir();
  const calls = [];
  const logs = [];
  const store = createSecretStore({ getSafeStorage: () => fakeSafe(available), getDir: () => dir });
  const remote = createRemote({
    store,
    getSettings: () => settings,
    getFetch: () => async (url, opts) => {
      calls.push({ url, opts });
      return fetchImpl ? fetchImpl(url, opts, calls.length) : res(204);
    },
    log: (...a) => logs.push(a.join(' ')),
    timeoutMs: 200,
  });
  return { remote, store, calls, logs, settings };
};

test('sendAll manda para o Discord ligado, com o JSON certo', async () => {
  const { remote, calls } = setup();
  assert.deepEqual(remote.set('discord', GOOD), { ok: true });
  const out = await remote.sendAll({ title: 'Oi', body: 'mundo' });
  assert.deepEqual(out, [{ ok: true }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GOOD);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(calls[0].opts.body).content, '**Oi**\nmundo');
});

test('sendAll não manda com o canal desligado ou sem link salvo', async () => {
  const off = setup({ settings: { notifyDiscord: false } });
  off.remote.set('discord', GOOD);
  assert.deepEqual(await off.remote.sendAll({ title: 'x', body: 'y' }), []);
  const empty = setup();
  assert.deepEqual(await empty.remote.sendAll({ title: 'x', body: 'y' }), []);
  assert.equal(off.calls.length + empty.calls.length, 0);
});

test('set recusa link inválido e canal desconhecido', () => {
  const { remote, store } = setup();
  const bad = remote.set('discord', 'https://exemplo.com/webhook');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /webhook do Discord/);
  assert.equal(store.hasSecret('discord'), false);
  assert.equal(remote.set('zap', GOOD).ok, false);
  assert.equal(remote.clear('zap').ok, false);
});

test('status diz se está configurado, sem devolver o link', () => {
  const { remote, settings } = setup();
  assert.deepEqual(remote.status().channels.discord, { label: 'Discord', configured: false, enabled: true });
  remote.set('discord', GOOD);
  settings.notifyDiscord = false;
  const st = remote.status();
  assert.equal(st.encryption, true);
  assert.deepEqual(st.channels.discord, { label: 'Discord', configured: true, enabled: false });
  assert.ok(!JSON.stringify(st).includes('abcDEF'));
  remote.clear('discord');
  assert.equal(remote.status().channels.discord.configured, false);
});

test('teste manda mesmo com o canal desligado e explica quando falta o link', async () => {
  const { remote, calls } = setup({ settings: { notifyDiscord: false } });
  const sem = await remote.test('discord');
  assert.equal(sem.ok, false);
  assert.match(sem.error, /antes de testar/);
  remote.set('discord', GOOD);
  assert.deepEqual(await remote.test('discord'), { ok: true });
  assert.match(JSON.parse(calls[0].opts.body).content, /Teste do IdleHub/);
});

test('erros do Discord viram frases simples e nunca derrubam', async () => {
  const msg = async (status) => {
    const { remote } = setup({ fetchImpl: () => res(status) });
    remote.set('discord', GOOD);
    return remote.test('discord');
  };
  const notFound = await msg(404);
  assert.equal(notFound.ok, false);
  assert.match(notFound.error, /não aceitou esse link/);
  assert.match((await msg(500)).error, /erro 500/);
});

test('falha de rede e demora viram erro sem vazar o link no log', async () => {
  const net = setup({ fetchImpl: () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); } });
  net.remote.set('discord', GOOD);
  const r = await net.remote.test('discord');
  assert.equal(r.ok, false);
  assert.match(r.error, /internet/);
  assert.ok(net.logs.length === 1 && !net.logs[0].includes('abcDEF'));

  const slow = setup({
    fetchImpl: (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('abortado'), { name: 'AbortError' })))),
  });
  slow.remote.set('discord', GOOD);
  assert.match((await slow.remote.test('discord')).error, /demorou demais/);
});

test('429 do Discord: espera o tempo pedido e tenta de novo uma vez', async () => {
  const { remote, calls } = setup({
    fetchImpl: (u, o, n) => (n === 1 ? res(429, { headers: { 'retry-after': '0' } }) : res(204)),
  });
  remote.set('discord', GOOD);
  assert.deepEqual(await remote.test('discord'), { ok: true });
  assert.equal(calls.length, 2);
});

test('avisos seguidos saem um de cada vez, na ordem', async () => {
  const order = [];
  let active = 0;
  let maxActive = 0;
  const { remote } = setup({
    fetchImpl: async (u, o) => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(JSON.parse(o.body).content);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return res(204);
    },
  });
  remote.set('discord', GOOD);
  await Promise.all([1, 2, 3].map((n) => remote.sendAll({ title: `n${n}` })));
  assert.deepEqual(order, ['**n1**', '**n2**', '**n3**']);
  assert.equal(maxActive, 1);
});
