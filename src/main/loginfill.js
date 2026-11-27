// "Preencher login": põe o usuário e a senha do cofre nos campos da página, só quando a pessoa clica.
//
// Regras (a parte de decidir é pura e tem teste; a parte da página roda num mundo isolado do Electron):
//  - só página https, do MESMO site do jogo (ou do endereço de login que a pessoa salvou para a conta);
//  - nunca no Google: o login dele continua à mão;
//  - NUNCA envia o formulário e nunca aperta Enter: a pessoa confere e clica em Entrar;
//  - os valores vão só nesta chamada e a função não deixa nada para trás na página.
const { sameSite } = require('./optimize');

// Mundo isolado (só o DOM é compartilhado com a página): os scripts do site não enxergam nem mexem nas variáveis daqui.
const FILL_WORLD = 7001;

const GOOGLE_HOST = /(^|\.)google\.(com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$|(^|\.)youtube\.com$/;
const isGoogleHost = (host) => GOOGLE_HOST.test(String(host || '').toLowerCase());

// Endereço de login salvo na conta: aceita "login.site.com" ou um link https e devolve só o nome do site.
// null se não serve (não é nome de site, ou é do Google).
const normalizeLoginHost = (input) => {
  let raw = String(input ?? '').trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' || u.username || u.password || host.length > 253) return null;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) || isGoogleHost(host)) return null;
    return host;
  } catch {
    return null;
  }
};

// Pode preencher esta página? Devolve { ok: true, origin } ou { ok: false, reason }.
const canFill = ({ pageUrl, gameUrl, loginHost }) => {
  let u;
  try {
    u = new URL(String(pageUrl || ''));
  } catch {
    return { ok: false, reason: 'not-https' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'not-https' };
  const host = u.hostname.toLowerCase();
  if (isGoogleHost(host)) return { ok: false, reason: 'google' };
  const saved = loginHost ? String(loginHost).toLowerCase() : '';
  if (sameSite(pageUrl, gameUrl) || (saved && host === saved)) return { ok: true, origin: u.origin };
  return { ok: false, reason: 'other-site' };
};

// Roda DENTRO da página, no mundo isolado. Precisa ser autocontida. p = { origin, username, password }.
// Devolve só { status, user, pass } (nunca os valores).
function fillLoginInPage(p) {
  if (window !== window.top || location.origin !== p.origin) return { status: 'origin' }; // a página mudou desde o clique

  const visible = (el) => {
    if (!el.isConnected || !el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const usable = (el) => !el.disabled && !el.readOnly && visible(el);
  const attr = (el, n) => String(el.getAttribute(n) || '');
  const label = (el) => `${attr(el, 'name')} ${el.id} ${attr(el, 'placeholder')} ${attr(el, 'aria-label')} ${attr(el, 'autocomplete')}`;

  const inputs = Array.from(document.querySelectorAll('input'));
  const pass = inputs.find((el) => el.type === 'password' && usable(el)) || null;
  const SKIP = /search|busca|pesquis|captcha|otp|2fa|token|verif|c[oó]digo|code|cupom|coupon/i;
  const HINT = /user|e-?mail|login|account|conta|usu[aá]rio|nick|apelido|identifier/i;
  const textLike = (el) => ['text', 'email', 'tel', ''].includes(el.type) && usable(el) && !SKIP.test(label(el));
  const strong = (el) => /username|email/i.test(attr(el, 'autocomplete')) || el.type === 'email' || HINT.test(label(el));

  let user = null;
  if (pass) {
    // O campo de texto mais perto da senha, antes dela, no mesmo formulário.
    const before = inputs.filter((el) => textLike(el) && el.form === pass.form && el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING);
    user = before.length ? before[before.length - 1] : null;
  } else {
    // Login em dois passos: só aparece o usuário. Só preenche se o campo tem cara de usuário.
    user = inputs.find((el) => textLike(el) && strong(el)) || null;
  }

  const setValue = (el, v) => {
    // O setter nativo (e não el.value = …) faz React, Vue e afins perceberem a mudança.
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    el.focus();
    desc.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  let didUser = false;
  let didPass = false;
  if (user && p.username) {
    setValue(user, p.username);
    didUser = true;
  }
  if (pass && p.password) {
    setValue(pass, p.password);
    didPass = true;
  }
  return { status: didUser || didPass ? 'ok' : 'none', user: didUser, pass: didPass };
}

// Preenche a página de `wc`. Devolve { ok, user, pass } ou { ok: false, reason: 'origin' | 'none' | 'failed' }.
const runFill = async (wc, { origin, username, password }) => {
  const code = `(${fillLoginInPage})(${JSON.stringify({ origin, username: username || '', password: password || '' })})`;
  let res;
  try {
    res = await wc.executeJavaScriptInIsolatedWorld(FILL_WORLD, [{ code }], false);
  } catch {
    return { ok: false, reason: 'failed' };
  }
  if (res?.status === 'ok') return { ok: true, user: !!res.user, pass: !!res.pass };
  return { ok: false, reason: res?.status === 'origin' ? 'origin' : res?.status === 'none' ? 'none' : 'failed' };
};

module.exports = { FILL_WORLD, isGoogleHost, normalizeLoginHost, canFill, fillLoginInPage, runFill };
