// Cofre de logins (src/main/vault.js): criptografia, senha mestra, trancar, 2FA e área de transferência.
// Sem Electron: o safeStorage é um falso injetado, e a pasta de dados é temporária.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createVault, createClipboardGuard, VAULT_FILE } = require('../src/main/vault');

const KEY = 'game1:acc1';
const KEY2 = 'game1:acc2';

// safeStorage falso: "criptografa" com XOR + prefixo, o suficiente para provar que o texto não vai puro para o arquivo.
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.concat([Buffer.from('FAKE:'), Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)]),
  decryptString: (buf) => {
    if (buf.subarray(0, 5).toString() !== 'FAKE:') throw new Error('não é desta conta');
    return Buffer.from(buf.subarray(5).map((b) => b ^ 0x5a)).toString('utf8');
  },
});

// scrypt barato para os testes (o app usa N=65536).
const FAST = { N: 1024, r: 8, p: 1 };

const setup = (opts = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-vault-'));
  const timers = [];
  const locks = [];
  const safe = opts.safe || fakeSafeStorage();
  const vault = createVault({
    getSafeStorage: () => safe,
    getDir: () => dir,
    params: FAST,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false, unref() {} };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.cleared = true;
    },
    onLockChange: () => locks.push(1),
  });
  const raw = () => fs.readFileSync(path.join(dir, VAULT_FILE), 'utf8');
  const live = () => timers.filter((t) => !t.cleared);
  return { vault, dir, raw, timers, live, locks, safe };
};

const SECRET = { username: 'eu@exemplo.com', password: 'S3nha-Muito-Secreta', notes: 'pergunta: gato' };
const TOTP = 'JBSWY3DPEHPK3PXP';

test('salva e lê de volta; nada fica em texto puro no arquivo', () => {
  const { vault, raw } = setup();
  assert.deepEqual(vault.save(KEY, { ...SECRET, host: 'login.exemplo.com', totp: TOTP }, { totpAck: true }), { ok: true });
  const text = raw();
  for (const s of [SECRET.username, SECRET.password, SECRET.notes, TOTP]) assert.ok(!text.includes(s), `não pode ter "${s}" no arquivo`);
  const r = vault.secretFor(KEY);
  assert.equal(r.ok, true);
  assert.equal(r.secret.username, SECRET.username);
  assert.equal(r.secret.password, SECRET.password);
  assert.equal(r.secret.notes, SECRET.notes);
  assert.equal(r.secret.totp.secret, TOTP);
  assert.equal(r.secret.host, 'login.exemplo.com');
});

test('a tela só recebe o usuário e se tem senha/notas/2FA, nunca os segredos', () => {
  const { vault } = setup();
  vault.save(KEY, { ...SECRET, totp: TOTP }, { totpAck: true });
  const list = vault.entries();
  assert.deepEqual(list[KEY], { pw: true, totp: true, notes: true, host: '', username: SECRET.username });
  const json = JSON.stringify(list);
  for (const s of [SECRET.password, SECRET.notes, TOTP]) assert.ok(!json.includes(s));
});

test('sem criptografia no Windows: recusa salvar e explica', () => {
  const { vault, dir } = setup({ safe: fakeSafeStorage(false) });
  const r = vault.save(KEY, SECRET);
  assert.equal(r.ok, false);
  assert.match(r.error, /com segurança/);
  assert.equal(fs.existsSync(path.join(dir, VAULT_FILE)), false);
  assert.equal(vault.status().available, false);
});

test('atualiza só o que veio: ausente mantém, null apaga', () => {
  const { vault } = setup();
  vault.save(KEY, SECRET);
  vault.save(KEY, { username: 'novo@x.com' });
  let s = vault.secretFor(KEY).secret;
  assert.equal(s.username, 'novo@x.com');
  assert.equal(s.password, SECRET.password); // manteve
  vault.save(KEY, { notes: null });
  s = vault.secretFor(KEY).secret;
  assert.equal(s.notes, undefined);
  assert.equal(vault.entries()[KEY].notes, false);
});

test('precisa de usuário ou senha; limites e chave de conta', () => {
  const { vault } = setup();
  assert.equal(vault.save(KEY, {}).ok, false);
  assert.equal(vault.save(KEY, { password: 'x'.repeat(501) }).ok, false);
  assert.equal(vault.save('qualquer coisa', SECRET).ok, false);
  assert.equal(vault.save('../../x:y', SECRET).ok, false);
});

test('endereço de login: guarda só o site e recusa o Google', () => {
  const { vault } = setup();
  assert.equal(vault.save(KEY, { ...SECRET, host: 'https://Login.Exemplo.com/entrar?x=1' }).ok, true);
  assert.equal(vault.secretFor(KEY).secret.host, 'login.exemplo.com');
  assert.equal(vault.save(KEY, { host: 'accounts.google.com' }).ok, false);
  assert.equal(vault.save(KEY, { host: 'http://sem-https.com' }).ok, false);
  assert.equal(vault.save(KEY, { host: null }).ok, true);
  assert.equal(vault.entries()[KEY].host, '');
});

test('2FA: só guarda com o aviso confirmado, e confere o segredo', () => {
  const { vault } = setup();
  vault.save(KEY, SECRET);
  const no = vault.save(KEY, { totp: TOTP });
  assert.equal(no.ok, false);
  assert.match(no.error, /aviso/);
  assert.equal(vault.entries()[KEY].totp, false);
  assert.equal(vault.save(KEY, { totp: 'não é base32!' }, { totpAck: true }).ok, false);
  assert.equal(vault.save(KEY, { totp: TOTP }, { totpAck: true }).ok, true);
  const c = vault.totpCode(KEY, 59 * 1000);
  assert.equal(c.ok, true);
  assert.equal(c.code.length, 6);
  assert.equal(c.remaining, 1);
  assert.equal(c.period, 30);
  vault.save(KEY, { totp: null });
  assert.equal(vault.totpCode(KEY).ok, false);
});

test('2FA vira otpauth://: usa o algoritmo e os dígitos do link', () => {
  const { vault } = setup();
  vault.save(KEY, { ...SECRET, totp: `otpauth://totp/x?secret=${TOTP}&algorithm=SHA256&digits=8&period=60` }, { totpAck: true });
  const c = vault.totpCode(KEY, 75 * 1000);
  assert.equal(c.code.length, 8);
  assert.equal(c.period, 60);
  assert.equal(c.remaining, 45);
});

test('remove e prune apagam os segredos das contas que sumiram', () => {
  const { vault, raw } = setup();
  vault.save(KEY, SECRET);
  vault.save(KEY2, { username: 'b@b.com', password: 'outra-senha-xyz' });
  assert.equal(vault.prune([KEY]), 1);
  assert.deepEqual(Object.keys(vault.entries()), [KEY]);
  assert.ok(!raw().includes(KEY2));
  vault.remove(KEY);
  assert.deepEqual(vault.entries(), {});
  assert.equal(vault.secretFor(KEY).ok, false);
});

test('arquivo de outra conta do Windows: não abre e avisa, sem quebrar', () => {
  const { vault, dir, safe } = setup();
  vault.save(KEY, SECRET);
  const other = createVault({
    getSafeStorage: () => ({ ...safe, isEncryptionAvailable: () => true, decryptString: () => { throw new Error('outra conta'); } }),
    getDir: () => dir,
    params: FAST,
  });
  assert.equal(other.entries()[KEY].unreadable, true);
  assert.equal(other.entries()[KEY].username, null);
  const r = other.secretFor(KEY);
  assert.equal(r.ok, false);
  assert.match(r.error, /Salve de novo/);
});

// ---------- senha mestra ----------
test('senha mestra: criptografa por cima, tranca e destranca', async () => {
  const { vault, raw } = setup();
  vault.save(KEY, SECRET);
  assert.equal((await vault.setMaster('curta')).ok, false); // menos de 8
  assert.deepEqual(await vault.setMaster('minha senha mestra'), { ok: true });
  assert.deepEqual(vault.status(), { available: true, hasMaster: true, locked: false, lockMinutes: 10 });
  assert.equal(vault.secretFor(KEY).secret.password, SECRET.password);

  const file = JSON.parse(raw());
  assert.ok(!raw().includes('minha senha mestra'), 'a senha mestra nunca é guardada');
  assert.ok(file.master.salt && file.master.check.tag);

  vault.lock();
  assert.equal(vault.status().locked, true);
  const locked = vault.secretFor(KEY);
  assert.equal(locked.ok, false);
  assert.equal(locked.locked, true);
  assert.equal(vault.entries()[KEY].username, null); // trancado: nem o usuário aparece
  assert.equal(vault.entries()[KEY].pw, true); // mas sabe que existe
  assert.equal(vault.save(KEY, { username: 'x@y.com' }).locked, true);
  assert.equal(vault.totpCode(KEY).locked, true);

  assert.equal((await vault.unlock('senha errada')).ok, false);
  assert.equal(vault.status().locked, true);
  assert.deepEqual(await vault.unlock('minha senha mestra'), { ok: true });
  assert.equal(vault.secretFor(KEY).secret.password, SECRET.password);
});

test('com senha mestra, a camada de dentro é AES-GCM: o safeStorage sozinho não abre', async () => {
  const { vault, dir, safe } = setup();
  vault.save(KEY, SECRET);
  await vault.setMaster('minha senha mestra');
  const blob = JSON.parse(fs.readFileSync(path.join(dir, VAULT_FILE), 'utf8')).entries[KEY].blob;
  const inner = JSON.parse(safe.decryptString(Buffer.from(blob, 'base64'))); // quem só tem o Windows chega aqui…
  assert.ok(inner.m && !inner.s);
  assert.ok(!JSON.stringify(inner).includes(SECRET.password)); // …e vê só a caixa AES
  assert.ok(inner.m.iv && inner.m.tag && inner.m.data);
});

test('dado mexido no arquivo não abre (GCM confere)', async () => {
  const { vault, dir, safe } = setup();
  vault.save(KEY, SECRET);
  await vault.setMaster('minha senha mestra');
  const f = path.join(dir, VAULT_FILE);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const inner = JSON.parse(safe.decryptString(Buffer.from(d.entries[KEY].blob, 'base64')));
  const data = Buffer.from(inner.m.data, 'base64');
  data[0] ^= 1;
  inner.m.data = data.toString('base64');
  d.entries[KEY].blob = safe.encryptString(JSON.stringify(inner)).toString('base64');
  fs.writeFileSync(f, JSON.stringify(d));
  assert.equal(vault.secretFor(KEY).ok, false);
});

test('trocar a senha mestra refaz as entradas; a antiga deixa de valer', async () => {
  const { vault } = setup();
  await vault.setMaster('senha mestra antiga');
  vault.save(KEY, { ...SECRET, totp: TOTP }, { totpAck: true });
  assert.equal((await vault.changeMaster('errada demais', 'senha mestra nova')).ok, false);
  assert.deepEqual(await vault.changeMaster('senha mestra antiga', 'senha mestra nova'), { ok: true });
  vault.lock();
  assert.equal((await vault.unlock('senha mestra antiga')).ok, false);
  assert.equal((await vault.unlock('senha mestra nova')).ok, true);
  assert.equal(vault.secretFor(KEY).secret.password, SECRET.password);
  assert.equal(vault.totpCode(KEY).ok, true);
});

test('tirar a senha mestra pede a senha e deixa só o safeStorage', async () => {
  const { vault, raw } = setup();
  await vault.setMaster('minha senha mestra');
  vault.save(KEY, SECRET);
  assert.equal((await vault.removeMaster('errada errada')).ok, false);
  assert.deepEqual(await vault.removeMaster('minha senha mestra'), { ok: true });
  assert.equal(vault.status().hasMaster, false);
  assert.equal(JSON.parse(raw()).master, null);
  assert.equal(vault.secretFor(KEY).secret.password, SECRET.password); // abre sem senha
});

test('reset apaga o cofre inteiro (esqueceu a senha mestra)', async () => {
  const { vault, dir } = setup();
  vault.save(KEY, SECRET);
  await vault.setMaster('minha senha mestra');
  assert.equal(vault.reset().ok, true);
  assert.equal(fs.existsSync(path.join(dir, VAULT_FILE)), false);
  assert.deepEqual(vault.status(), { available: true, hasMaster: false, locked: false, lockMinutes: 10 });
  assert.deepEqual(vault.entries(), {});
});

// ---------- trancar sozinho ----------
test('tranca sozinho depois de N minutos parado, e cada uso adia', async () => {
  const { vault, live, locks } = setup();
  vault.setLockMinutes(5);
  await vault.setMaster('minha senha mestra');
  assert.equal(live().length, 1);
  assert.equal(live()[0].ms, 5 * 60 * 1000);
  const first = live()[0];
  vault.save(KEY, SECRET); // usar adia: o temporizador antigo é cancelado e nasce outro
  assert.equal(first.cleared, true);
  assert.equal(live().length, 1);
  const before = locks.length;
  live()[0].fn(); // o tempo passou
  assert.equal(vault.status().locked, true);
  assert.equal(locks.length, before + 1);
  assert.equal(live().length, 0);
});

test('0 minutos = não tranca por tempo (só ao bloquear o PC)', async () => {
  const { vault, live } = setup();
  vault.setLockMinutes(0);
  await vault.setMaster('minha senha mestra');
  assert.equal(live().length, 0);
  vault.lock(); // o que o main.js faz no lock-screen e no suspend
  assert.equal(vault.status().locked, true);
});

test('sem senha mestra o cofre nunca fica trancado e não usa temporizador', () => {
  const { vault, live } = setup();
  vault.save(KEY, SECRET);
  vault.lock();
  assert.equal(vault.status().locked, false);
  assert.equal(live().length, 0);
  assert.equal(vault.setLockMinutes(9999).lockMinutes, 480);
  assert.equal(vault.setLockMinutes('abc').ok, false);
});

// ---------- área de transferência ----------
const fakeClipboard = () => {
  let text = '';
  return { writeText: (t) => (text = t), readText: () => text, clear: () => (text = ''), set: (t) => (text = t) };
};
const fakeTimers = () => {
  const list = [];
  return { list, setTimer: (fn, ms) => (list.push({ fn, ms }), { unref() {} }), clearTimer: () => {} };
};

test('área de transferência: limpa depois de 30 s se ainda for a senha copiada', () => {
  const clip = fakeClipboard();
  const t = fakeTimers();
  const guard = createClipboardGuard({ clipboard: clip, setTimer: t.setTimer, clearTimer: t.clearTimer });
  assert.equal(guard.copy('senha123'), 30000);
  assert.equal(clip.readText(), 'senha123');
  assert.equal(t.list[0].ms, 30000);
  t.list[0].fn();
  assert.equal(clip.readText(), '');
});

test('área de transferência: se a pessoa copiou outra coisa, não apaga', () => {
  const clip = fakeClipboard();
  const t = fakeTimers();
  const guard = createClipboardGuard({ clipboard: clip, setTimer: t.setTimer, clearTimer: t.clearTimer });
  guard.copy('senha123');
  clip.set('outra coisa importante');
  t.list[0].fn();
  assert.equal(clip.readText(), 'outra coisa importante');
});

test('área de transferência: clearNow (ao fechar o app) limpa na hora', () => {
  const clip = fakeClipboard();
  const t = fakeTimers();
  const guard = createClipboardGuard({ clipboard: clip, setTimer: t.setTimer, clearTimer: t.clearTimer });
  guard.copy('123456');
  guard.clearNow();
  assert.equal(clip.readText(), '');
  clip.set('depois');
  guard.clearNow(); // de novo não faz nada
  assert.equal(clip.readText(), 'depois');
});
