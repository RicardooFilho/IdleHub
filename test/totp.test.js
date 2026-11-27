// Códigos 2FA (src/main/totp.js): vetores de teste da RFC 6238 e leitura do segredo / link otpauth://.
const test = require('node:test');
const assert = require('node:assert/strict');

const { decodeBase32, parseTotpInput, hotp, totp, sanitizeTotp } = require('../src/main/totp');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const encodeBase32 = (buf) => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += B32[(value << (5 - bits)) & 31];
  return out;
};

// Segredos de teste da RFC 6238 (Apêndice B), cada um do tamanho da sua função de hash.
const KEYS = {
  SHA1: Buffer.from('12345678901234567890'),
  SHA256: Buffer.from('12345678901234567890123456789012'),
  SHA512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
};
const VECTORS = [
  [59, { SHA1: '94287082', SHA256: '46119246', SHA512: '90693936' }],
  [1111111109, { SHA1: '07081804', SHA256: '68084774', SHA512: '25091201' }],
  [1111111111, { SHA1: '14050471', SHA256: '67062674', SHA512: '99943326' }],
  [1234567890, { SHA1: '89005924', SHA256: '91819424', SHA512: '93441116' }],
  [2000000000, { SHA1: '69279037', SHA256: '90698825', SHA512: '38618901' }],
  [20000000000, { SHA1: '65353130', SHA256: '77737706', SHA512: '47863826' }],
];

test('base32: decodifica com espaços, minúsculas e "="', () => {
  assert.equal(decodeBase32('MZXW6YTBOI======').toString(), 'foobar');
  assert.equal(decodeBase32('mzxw 6ytb-oi').toString(), 'foobar');
  assert.equal(decodeBase32('MZXW1'), null); // "1" não existe em base32
  assert.equal(decodeBase32(''), null);
  assert.equal(encodeBase32(Buffer.from('foobar')), 'MZXW6YTBOI');
});

for (const [time, expected] of VECTORS) {
  for (const algorithm of Object.keys(KEYS)) {
    test(`RFC 6238: ${algorithm} em t=${time}`, () => {
      const secret = encodeBase32(KEYS[algorithm]);
      const r = totp({ secret, algorithm, digits: 8, period: 30 }, time * 1000);
      assert.equal(r.code, expected[algorithm]);
      assert.equal(r.period, 30);
    });
  }
}

test('RFC 4226: vetores do HOTP (SHA1, 6 dígitos)', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, i) => assert.equal(hotp(KEYS.SHA1, i), code));
});

test('segundos que faltam para o código mudar', () => {
  const secret = encodeBase32(KEYS.SHA1);
  assert.equal(totp({ secret }, 59 * 1000).remaining, 1);
  assert.equal(totp({ secret }, 60 * 1000).remaining, 30);
  assert.equal(totp({ secret }, 75 * 1000).remaining, 15);
  assert.equal(totp({ secret, period: 60 }, 75 * 1000).remaining, 45);
});

test('o código muda só quando o período vira', () => {
  const secret = encodeBase32(KEYS.SHA1);
  assert.equal(totp({ secret }, 30000).code, totp({ secret }, 59999).code);
  assert.notEqual(totp({ secret }, 59999).code, totp({ secret }, 60000).code);
});

test('padrão: SHA1, 6 dígitos, 30 s', () => {
  const secret = encodeBase32(KEYS.SHA1);
  const r = totp({ secret }, 59 * 1000);
  assert.equal(r.code, '287082'); // os 6 últimos dígitos do vetor de 8 dígitos
  assert.equal(r.code.length, 6);
});

test('segredo puro: limpa espaços e põe em maiúsculas', () => {
  const r = parseTotpInput('jbsw y3dp ehpk 3pxp');
  assert.deepEqual(r, { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 });
});

test('otpauth://: lê algoritmo, dígitos e período', () => {
  const r = parseTotpInput('otpauth://totp/Jogo:eu@x.com?secret=JBSWY3DPEHPK3PXP&issuer=Jogo&algorithm=sha256&digits=8&period=60');
  assert.deepEqual(r, { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 8, period: 60 });
  const plain = parseTotpInput('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP');
  assert.deepEqual(plain, { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 });
});

test('rejeita o que não serve', () => {
  assert.ok(parseTotpInput('').error);
  assert.ok(parseTotpInput('isso não é base32!').error);
  assert.ok(parseTotpInput('ABCD').error); // curto demais
  assert.ok(parseTotpInput('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1').error); // só TOTP
  assert.ok(parseTotpInput('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5').error);
  assert.ok(parseTotpInput('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=12').error);
  assert.ok(parseTotpInput('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0').error);
  assert.ok(parseTotpInput('otpauth://totp/x').error); // sem segredo
  assert.ok(parseTotpInput('A'.repeat(700)).error);
});

test('sanitizeTotp: só o que o código precisa', () => {
  assert.deepEqual(sanitizeTotp({ secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA512', digits: 7, period: 45, extra: 'x' }), {
    secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA512', digits: 7, period: 45,
  });
  assert.equal(sanitizeTotp({ secret: '!!!' }), null);
  assert.equal(sanitizeTotp(null), null);
});
