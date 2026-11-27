// Monta extensões de mentira para os testes: zip (com o crc32 do IdleHub) e CRX3 assinado com uma chave
// gerada na hora. Nada de internet e nada de extensão de terceiros.
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { crc32, idFromHash16 } = require('../../src/main/crx');

// files: [{ name, data: Buffer|string, store?: true }] -> Buffer do zip
function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const name = Buffer.from(f.name);
    const method = f.store ? 0 : 8;
    const body = method === 0 ? data : zlib.deflateRawSync(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(method, 8);
    h.writeUInt32LE(crc32(data), 14);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26);
    locals.push(h, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc32(data), 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const varint = (n) => {
  const out = [];
  while (n > 127) {
    out.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
};
const field = (n, buf) => Buffer.concat([varint(n * 8 + 2), varint(buf.length), buf]);

function newKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { publicKey, privateKey, der: publicKey.export({ type: 'spki', format: 'der' }) };
}

// Monta um CRX3 como o da Web Store. `kp` é o dono (o ID vem da chave dele); `extra` são chaves a mais (a da loja).
function buildCrx(zip, kp = newKeyPair(), { extra = [], tamper = false, omitOwner = false } = {}) {
  const crxId = crypto.createHash('sha256').update(kp.der).digest().subarray(0, 16);
  const signedData = field(1, crxId);
  const u = Buffer.alloc(4);
  u.writeUInt32LE(signedData.length);
  const payload = Buffer.concat([Buffer.from('CRX3 SignedData\0', 'latin1'), u, signedData, zip]);
  const proofs = (omitOwner ? extra : [kp, ...extra]).map((k) => {
    const sig = crypto.sign('sha256', payload, k.privateKey);
    return field(2, Buffer.concat([field(1, k.der), field(2, sig)]));
  });
  const header = Buffer.concat([...proofs, field(10000, signedData)]);
  const head = Buffer.alloc(12);
  head.write('Cr24', 0, 'latin1');
  head.writeUInt32LE(3, 4);
  head.writeUInt32LE(header.length, 8);
  const body = tamper ? Buffer.concat([zip.subarray(0, zip.length - 30), Buffer.from('x'.repeat(30))]) : zip;
  return { crx: Buffer.concat([head, header, body]), id: idFromHash16(crxId), key: kp.der.toString('base64') };
}

// Manifest MV3 simples que só mexe no site do jogo.
const manifest = (over = {}) => ({
  manifest_version: 3,
  name: 'Extensão de teste',
  version: '1.0.0',
  content_scripts: [{ matches: ['https://pokeidle.io/*'], js: ['content.js'], world: 'MAIN' }],
  ...over,
});

const simpleExtension = (over = {}, code = 'console.log("oi");') => [
  { name: 'manifest.json', data: JSON.stringify(manifest(over)) },
  { name: 'content.js', data: code },
];

module.exports = { buildZip, buildCrx, newKeyPair, manifest, simpleExtension };
