// Preencher login (src/main/loginfill.js): quando pode preencher, e o que a função da página faz num DOM de mentira.
const test = require('node:test');
const assert = require('node:assert/strict');

const { canFill, normalizeLoginHost, isGoogleHost, fillLoginInPage, runFill, FILL_WORLD } = require('../src/main/loginfill');

// ---------- quando pode preencher ----------
test('só https e só no mesmo site do jogo', () => {
  const game = 'https://pokeidle.net/play';
  assert.deepEqual(canFill({ pageUrl: 'https://pokeidle.net/login', gameUrl: game }), { ok: true, origin: 'https://pokeidle.net' });
  assert.equal(canFill({ pageUrl: 'https://auth.pokeidle.net/entrar', gameUrl: game }).ok, true); // subdomínio do mesmo site
  assert.deepEqual(canFill({ pageUrl: 'http://pokeidle.net/login', gameUrl: game }), { ok: false, reason: 'not-https' });
  assert.deepEqual(canFill({ pageUrl: 'https://evil-pokeidle.net/login', gameUrl: game }), { ok: false, reason: 'other-site' });
  assert.deepEqual(canFill({ pageUrl: 'https://pokeidle.net.evil.com/login', gameUrl: game }), { ok: false, reason: 'other-site' });
  assert.deepEqual(canFill({ pageUrl: 'about:blank', gameUrl: game }), { ok: false, reason: 'not-https' });
  assert.deepEqual(canFill({ pageUrl: '', gameUrl: game }), { ok: false, reason: 'not-https' });
  assert.equal(canFill({ pageUrl: 'https://pokeidle.net/', gameUrl: '' }).ok, false); // jogo sem link
});

test('o endereço de login salvo na conta também vale (só ele)', () => {
  const game = 'https://jogo.com/';
  assert.equal(canFill({ pageUrl: 'https://sso.outro.com/entrar', gameUrl: game }).ok, false);
  assert.equal(canFill({ pageUrl: 'https://sso.outro.com/entrar', gameUrl: game, loginHost: 'sso.outro.com' }).ok, true);
  assert.equal(canFill({ pageUrl: 'https://SSO.outro.com/x', gameUrl: game, loginHost: 'sso.outro.com' }).ok, true);
  assert.equal(canFill({ pageUrl: 'https://www.outro.com/x', gameUrl: game, loginHost: 'sso.outro.com' }).ok, false); // só o host salvo
  assert.equal(canFill({ pageUrl: 'http://sso.outro.com/x', gameUrl: game, loginHost: 'sso.outro.com' }).ok, false);
});

test('nunca no Google, nem se o jogo for do Google ou o endereço estiver salvo', () => {
  for (const u of ['https://accounts.google.com/signin', 'https://accounts.google.com.br/x', 'https://accounts.youtube.com/x', 'https://myaccount.google.com/']) {
    assert.deepEqual(canFill({ pageUrl: u, gameUrl: 'https://accounts.google.com/', loginHost: new URL(u).hostname }), { ok: false, reason: 'google' }, u);
  }
  assert.equal(isGoogleHost('google.itch.io'), false); // não confunde com sites que só têm a palavra
  assert.equal(isGoogleHost('notgoogle.com'), false);
});

test('endereço de login: aceita nome ou link https, recusa o resto', () => {
  assert.equal(normalizeLoginHost('login.site.com'), 'login.site.com');
  assert.equal(normalizeLoginHost('https://Login.Site.com:8443/a?b=1#c'), 'login.site.com');
  assert.equal(normalizeLoginHost(''), null);
  assert.equal(normalizeLoginHost('http://site.com'), null);
  assert.equal(normalizeLoginHost('https://user:pw@site.com'), null);
  assert.equal(normalizeLoginHost('localhost'), null);
  assert.equal(normalizeLoginHost('site com'), null);
  assert.equal(normalizeLoginHost('accounts.google.com'), null);
  assert.equal(normalizeLoginHost('https://accounts.youtube.com/x'), null);
});

// ---------- a função que roda na página, num DOM de mentira ----------
class FakeInput extends EventTarget {
  constructor({ type = 'text', name = '', id = '', placeholder = '', autocomplete = '', form = null, visible = true, disabled = false, readOnly = false } = {}) {
    super();
    Object.assign(this, { type, id, form, disabled, readOnly, isConnected: true });
    this.attrs = { name, placeholder, autocomplete };
    this.visible = visible;
    this.log = []; // eventos que a página recebeu
    this.focused = false;
    for (const t of ['input', 'change']) this.addEventListener(t, (e) => this.log.push(`${e.type}:${this._v}`));
  }
  getAttribute(n) {
    return this.attrs[n] ?? null;
  }
  getClientRects() {
    return this.visible ? [{}] : [];
  }
  getBoundingClientRect() {
    return { width: 200, height: 30 };
  }
  focus() {
    this.focused = true;
  }
  compareDocumentPosition(other) {
    return DOC.indexOf(this) < DOC.indexOf(other) ? 4 : 2; // 4 = DOCUMENT_POSITION_FOLLOWING
  }
}
// O setter "nativo" fica no protótipo, como no navegador: é o que o preenchimento precisa usar.
Object.defineProperty(FakeInput.prototype, 'value', { configurable: true, get() { return this._v ?? ''; }, set(v) { this._v = v; } });

let DOC = [];
const FORM_A = { id: 'a' };
const FORM_B = { id: 'b' };

const withDom = (inputs, { origin = 'https://jogo.com', top = true } = {}, run) => {
  DOC = inputs;
  const win = {};
  win.top = top ? win : {};
  const saved = {};
  const globals = {
    window: win,
    location: { origin },
    document: { querySelectorAll: (s) => (s === 'input' ? DOC : []) },
    getComputedStyle: (el) => ({ visibility: el.hidden ? 'hidden' : 'visible', display: 'block' }),
    HTMLInputElement: FakeInput,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
  };
  for (const [k, v] of Object.entries(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  try {
    return run();
  } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  }
};

const CREDS = { origin: 'https://jogo.com', username: 'eu@exemplo.com', password: 'senha-de-teste' };

test('preenche usuário e senha com o setter nativo e avisa a página (input e change)', () => {
  const user = new FakeInput({ type: 'email', name: 'email', form: FORM_A });
  const pass = new FakeInput({ type: 'password', name: 'senha', form: FORM_A });
  const res = withDom([user, pass], {}, () => fillLoginInPage(CREDS));
  assert.deepEqual(res, { status: 'ok', user: true, pass: true });
  assert.equal(user.value, CREDS.username);
  assert.equal(pass.value, CREDS.password);
  assert.deepEqual(user.log, [`input:${CREDS.username}`, `change:${CREDS.username}`]);
  assert.deepEqual(pass.log, [`input:${CREDS.password}`, `change:${CREDS.password}`]);
});

test('devolve só status e booleanos, nunca os valores', () => {
  const res = withDom([new FakeInput({ name: 'user' }), new FakeInput({ type: 'password' })], {}, () => fillLoginInPage(CREDS));
  const json = JSON.stringify(res);
  assert.ok(!json.includes(CREDS.username) && !json.includes(CREDS.password));
});

test('não envia o formulário nem aperta Enter: só os eventos input e change', () => {
  const seen = [];
  const user = new FakeInput({ name: 'user', form: FORM_A });
  const pass = new FakeInput({ type: 'password', form: FORM_A });
  for (const el of [user, pass]) for (const t of ['keydown', 'keyup', 'keypress', 'submit', 'click']) el.addEventListener(t, () => seen.push(t));
  withDom([user, pass], {}, () => fillLoginInPage(CREDS));
  assert.deepEqual(seen, []);
});

test('escolhe o campo certo: o de texto mais perto da senha, no mesmo formulário', () => {
  const busca = new FakeInput({ type: 'search', name: 'q' });
  const outroForm = new FakeInput({ name: 'newsletter', form: FORM_B });
  const user = new FakeInput({ name: 'login', form: FORM_A });
  const pass = new FakeInput({ type: 'password', form: FORM_A });
  withDom([busca, outroForm, user, pass], {}, () => fillLoginInPage(CREDS));
  assert.equal(user.value, CREDS.username);
  assert.equal(outroForm.value, '');
  assert.equal(busca.value, '');
});

test('ignora campos escondidos, desativados e só de leitura', () => {
  const hiddenUser = new FakeInput({ name: 'user', visible: false });
  const roUser = new FakeInput({ name: 'user2', readOnly: true });
  const hiddenPass = new FakeInput({ type: 'password', visible: false });
  const realUser = new FakeInput({ name: 'user3' });
  const realPass = new FakeInput({ type: 'password' });
  const res = withDom([hiddenUser, roUser, hiddenPass, realUser, realPass], {}, () => fillLoginInPage(CREDS));
  assert.equal(res.status, 'ok');
  assert.equal(hiddenUser.value, '');
  assert.equal(roUser.value, '');
  assert.equal(hiddenPass.value, '');
  assert.equal(realUser.value, CREDS.username);
  assert.equal(realPass.value, CREDS.password);
});

test('login em dois passos: sem campo de senha, só preenche o usuário se o campo tem cara de usuário', () => {
  const email = new FakeInput({ type: 'email', name: 'identifier' });
  assert.deepEqual(withDom([email], {}, () => fillLoginInPage(CREDS)), { status: 'ok', user: true, pass: false });
  assert.equal(email.value, CREDS.username);
  const coupon = new FakeInput({ name: 'cupom' });
  assert.deepEqual(withDom([coupon], {}, () => fillLoginInPage(CREDS)), { status: 'none', user: false, pass: false });
  assert.equal(coupon.value, '');
});

test('só a senha salva: não escreve usuário vazio por cima', () => {
  const user = new FakeInput({ name: 'user', form: FORM_A });
  user.value = 'ja-digitado';
  const pass = new FakeInput({ type: 'password', form: FORM_A });
  const res = withDom([user, pass], {}, () => fillLoginInPage({ ...CREDS, username: '' }));
  assert.deepEqual(res, { status: 'ok', user: false, pass: true });
  assert.equal(user.value, 'ja-digitado');
});

test('a página mudou de endereço depois do clique: não toca em nada', () => {
  const user = new FakeInput({ name: 'user' });
  const pass = new FakeInput({ type: 'password' });
  const res = withDom([user, pass], { origin: 'https://outro-site.com' }, () => fillLoginInPage(CREDS));
  assert.deepEqual(res, { status: 'origin' });
  assert.equal(pass.value, '');
});

test('dentro de um iframe: não toca em nada', () => {
  const pass = new FakeInput({ type: 'password' });
  assert.deepEqual(withDom([pass], { top: false }, () => fillLoginInPage(CREDS)), { status: 'origin' });
  assert.equal(pass.value, '');
});

test('página sem campos de login: status none', () => {
  assert.deepEqual(withDom([new FakeInput({ name: 'q', type: 'search' })], {}, () => fillLoginInPage(CREDS)), { status: 'none', user: false, pass: false });
});

// ---------- runFill: o que vai para o Electron ----------
test('runFill roda no mundo isolado (não no da página) e repassa só o resultado', async () => {
  let call;
  const wc = {
    executeJavaScript: () => assert.fail('nunca no mundo principal'),
    executeJavaScriptInIsolatedWorld: async (world, scripts, gesture) => {
      call = { world, scripts, gesture };
      return { status: 'ok', user: true, pass: true };
    },
  };
  const r = await runFill(wc, CREDS);
  assert.deepEqual(r, { ok: true, user: true, pass: true });
  assert.equal(call.world, FILL_WORLD);
  assert.notEqual(call.world, 0);
  assert.equal(call.scripts.length, 1);
  assert.match(call.scripts[0].code, /^\(function fillLoginInPage/);
  assert.ok(call.scripts[0].code.includes(JSON.stringify(CREDS.password))); // os valores vão só nesta chamada
  assert.ok(!/submit\(|requestSubmit|Enter|KeyboardEvent/.test(call.scripts[0].code), 'não pode enviar nem apertar Enter');
});

test('runFill traduz os resultados e erros', async () => {
  const mk = (res) => ({ executeJavaScriptInIsolatedWorld: async () => res });
  assert.deepEqual(await runFill(mk({ status: 'origin' }), CREDS), { ok: false, reason: 'origin' });
  assert.deepEqual(await runFill(mk({ status: 'none' }), CREDS), { ok: false, reason: 'none' });
  assert.deepEqual(await runFill(mk(undefined), CREDS), { ok: false, reason: 'failed' });
  const boom = { executeJavaScriptInIsolatedWorld: async () => { throw new Error('página fechou'); } };
  assert.deepEqual(await runFill(boom, CREDS), { ok: false, reason: 'failed' });
});
