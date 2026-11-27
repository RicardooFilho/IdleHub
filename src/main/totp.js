// Códigos 2FA (TOTP, RFC 6238) feitos com o crypto do Node, sem pacote novo. Só funções puras:
// ler o segredo (base32 ou link otpauth://), gerar o código e dizer quantos segundos faltam.
const crypto = require('crypto');

const ALGORITHMS = { SHA1: 'sha1', SHA256: 'sha256', SHA512: 'sha512' };
const DEFAULTS = { algorithm: 'SHA1', digits: 6, period: 30 };
const MIN_SECRET_BYTES = 8;
const MAX_INPUT = 600;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Base32 (RFC 4648): ignora espaços, hífens, "=" no fim e maiúsculas/minúsculas. null se tiver letra inválida.
const decodeBase32 = (text) => {
  const clean = String(text || '').replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase();
  if (!clean) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

const intIn = (v, min, max, def) => {
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

// Aceita o segredo puro (base32) ou o link otpauth://totp/… do QR code. Devolve os parâmetros já limpos
// ({ secret, algorithm, digits, period }) ou { error } com um texto para a pessoa ler.
const parseTotpInput = (input) => {
  const raw = String(input ?? '').trim();
  if (!raw) return { error: 'Cole o segredo do 2FA ou o link otpauth://.' };
  if (raw.length > MAX_INPUT) return { error: 'Esse texto é grande demais para ser um segredo de 2FA.' };

  let secret = raw;
  let algorithm = DEFAULTS.algorithm;
  let digits = DEFAULTS.digits;
  let period = DEFAULTS.period;
  if (/^otpauth:/i.test(raw)) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      return { error: 'Esse link otpauth:// não está certo.' };
    }
    if (u.hostname.toLowerCase() !== 'totp') return { error: 'Só códigos por tempo (TOTP) são aceitos.' };
    secret = u.searchParams.get('secret') || '';
    algorithm = String(u.searchParams.get('algorithm') || DEFAULTS.algorithm).toUpperCase();
    if (!ALGORITHMS[algorithm]) return { error: 'Esse tipo de código (algoritmo) não é aceito. Use SHA1, SHA256 ou SHA512.' };
    digits = intIn(u.searchParams.get('digits'), 6, 8, DEFAULTS.digits);
    period = intIn(u.searchParams.get('period'), 10, 120, DEFAULTS.period);
    if (digits == null || period == null) return { error: 'Os números do link otpauth:// (dígitos ou tempo) não são aceitos.' };
  }
  const bytes = decodeBase32(secret);
  if (!bytes) return { error: 'O segredo do 2FA só tem letras de A a Z e números de 2 a 7. Confira se copiou inteiro.' };
  if (bytes.length < MIN_SECRET_BYTES) return { error: 'Esse segredo é curto demais. Confira se copiou inteiro.' };
  return { secret: secret.replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase(), algorithm, digits, period };
};

// HOTP (RFC 4226): o código de um contador.
const hotp = (keyBytes, counter, { algorithm = DEFAULTS.algorithm, digits = DEFAULTS.digits } = {}) => {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac(ALGORITHMS[algorithm] || 'sha1', keyBytes).update(msg).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
};

// TOTP (RFC 6238) de agora (`now` em ms). `remaining` = segundos até o código mudar.
const totp = (params, now = Date.now()) => {
  const p = { ...DEFAULTS, ...params };
  const keyBytes = decodeBase32(p.secret);
  if (!keyBytes) return null;
  const sec = Math.floor(now / 1000);
  return { code: hotp(keyBytes, Math.floor(sec / p.period), p), remaining: p.period - (sec % p.period), period: p.period };
};

// Só guarda o que a conta do código precisa (nada do resto do link, como o nome do site).
const sanitizeTotp = (t) => {
  const r = t && typeof t === 'object' ? parseTotpInput(`otpauth://totp/x?secret=${encodeURIComponent(t.secret)}&algorithm=${t.algorithm}&digits=${t.digits}&period=${t.period}`) : null;
  return r && !r.error ? r : null;
};

module.exports = { decodeBase32, parseTotpInput, hotp, totp, sanitizeTotp, DEFAULTS };
