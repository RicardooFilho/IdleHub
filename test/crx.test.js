const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crx = require('../src/main/crx');
const { buildZip, buildCrx, newKeyPair, simpleExtension } = require('./helpers/crx-builder');

test('crc32 bate com o valor conhecido', () => {
  assert.equal(crx.crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('lê um zip com arquivos comprimidos e guardados', () => {
  const zip = buildZip([
    { name: 'a.txt', data: 'olá '.repeat(100) },
    { name: 'dir/b.bin', data: Buffer.from([1, 2, 3]), store: true },
    { name: 'dir/', data: '' },
  ]);
  const files = crx.readZip(zip);
  assert.deepEqual(files.map((f) => f.name), ['a.txt', 'dir/b.bin']);
  assert.equal(files[0].data.toString(), 'olá '.repeat(100));
  assert.deepEqual([...files[1].data], [1, 2, 3]);
});

test('recusa nomes que saem da pasta ou o Windows não aceita', () => {
  for (const name of ['../evil.js', 'a/../../b', '/abs.js', 'C:/x.js', 'a\b.js', 'con.js', 'a/', 'x:y', 'trailing.']) {
    if (name.endsWith('/')) continue; // pasta: ignorada, não é arquivo
    assert.throws(() => crx.readZip(buildZip([{ name, data: 'x' }])), /inválido/, name);
  }
});

test('recusa arquivo repetido só na caixa das letras', () => {
  assert.throws(() => crx.readZip(buildZip([{ name: 'A.js', data: '1' }, { name: 'a.JS', data: '2' }])), /repetido/);
});

test('recusa zip corrompido, truncado ou grande demais', () => {
  const zip = buildZip([{ name: 'a.js', data: 'conteúdo '.repeat(50), store: true }]);
  const bad = Buffer.from(zip);
  bad[40] ^= 0xff; // estraga um byte do conteúdo: o CRC não bate
  assert.throws(() => crx.readZip(bad), /corrompido/);
  assert.throws(() => crx.readZip(zip.subarray(0, 30)), /zip/);
  assert.throws(() => crx.readZip(zip, { ...crx.LIMITS, entries: 0 }), /arquivos demais/);
  assert.throws(() => crx.readZip(zip, { ...crx.LIMITS, file: 10 }), /grande demais/);
  assert.throws(() => crx.readZip(zip, { ...crx.LIMITS, total: 10 }), /grande demais/);
});

test('writeFiles pula _metadata e não deixa escapar da pasta', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-crx-'));
  try {
    crx.writeFiles([{ name: 'm.json', data: Buffer.from('1') }, { name: '_metadata/verified_contents.json', data: Buffer.from('2') }, { name: 'sub/x.js', data: Buffer.from('3') }], dir);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['m.json', 'sub']);
    assert.throws(() => crx.writeFiles([{ name: '../fora.js', data: Buffer.from('x') }], dir), /inválido/);
    assert.ok(!fs.existsSync(path.join(dir, '..', 'fora.js')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CRX3: confere a assinatura e o ID vem da chave', () => {
  const zip = buildZip(simpleExtension());
  const { crx: file, id, key } = buildCrx(zip);
  const r = crx.parseCrx3(file);
  assert.equal(r.id, id);
  assert.equal(r.key, key);
  assert.equal(crx.idFromKey(Buffer.from(key, 'base64')), id);
  assert.match(id, /^[a-p]{32}$/);
  assert.deepEqual(r.zip, zip);
});

test('CRX3 da loja: além da chave do dono, tem a chave da loja', () => {
  const { crx: file, id } = buildCrx(buildZip(simpleExtension()), newKeyPair(), { extra: [newKeyPair()] });
  assert.equal(crx.parseCrx3(file).id, id);
});

test('CRX3: zip alterado depois de assinado é recusado', () => {
  const { crx: file } = buildCrx(buildZip(simpleExtension()), newKeyPair(), { tamper: true });
  assert.throws(() => crx.parseCrx3(file), /assinatura/);
});

test('CRX3: sem a chave do ID declarado é recusado', () => {
  const { crx: file } = buildCrx(buildZip(simpleExtension()), newKeyPair(), { omitOwner: true, extra: [newKeyPair()] });
  assert.throws(() => crx.parseCrx3(file), /não é do dono/);
});

test('CRX3: arquivo que não é CRX3', () => {
  assert.throws(() => crx.parseCrx3(Buffer.from('PK\x03\x04 isto é um zip')), /não é uma extensão/);
  const { crx: file } = buildCrx(buildZip(simpleExtension()));
  const v2 = Buffer.from(file);
  v2.writeUInt32LE(2, 4);
  assert.throws(() => crx.parseCrx3(v2), /CRX3/);
  const huge = Buffer.from(file);
  huge.writeUInt32LE(0x7fffffff, 8);
  assert.throws(() => crx.parseCrx3(huge), /corrompido/);
});
