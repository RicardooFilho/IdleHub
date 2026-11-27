// Leitura de extensões do Chrome (arquivo .crx da Web Store): confere a assinatura, tira o
// cabeçalho e descompacta o zip. Só Node (crypto, zlib, fs), sem pacote novo e sem Electron,
// para dar para testar com node:test. Tudo que vem de fora é tratado como não confiável:
// tamanhos, nomes de arquivo e quantidade têm limite.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const LIMITS = {
  entries: 4000, // arquivos por extensão
  file: 40 * 1024 * 1024, // tamanho de cada arquivo, já descompactado
  total: 100 * 1024 * 1024, // tamanho de tudo, já descompactado
  crx: 60 * 1024 * 1024, // tamanho do .crx baixado
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// O ID de uma extensão é o começo do SHA-256 da chave pública, com os dígitos 0-f trocados por a-p.
const idFromHash16 = (hash16) =>
  [...Buffer.from(hash16).toString('hex')].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const idFromKey = (der) => idFromHash16(crypto.createHash('sha256').update(der).digest().subarray(0, 16));

// ---------- nomes de arquivo seguros ----------
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// Devolve o caminho relativo em barras normais, ou lança erro. Recusa o que sairia da pasta da
// extensão (.., caminho absoluto, letra de unidade) e nomes que o Windows não aceita.
function safeRelPath(name) {
  const s = String(name);
  if (!s || s.length > 240) throw new Error(`nome de arquivo inválido: ${s.slice(0, 60)}`);
  if (/[\\\u0000-\u001f<>:"|?*]/.test(s) || s.startsWith('/')) throw new Error(`nome de arquivo inválido: ${s.slice(0, 60)}`);
  for (const seg of s.split('/')) {
    if (!seg || seg === '.' || seg === '..' || /[. ]$/.test(seg) || RESERVED.test(seg)) throw new Error(`nome de arquivo inválido: ${s.slice(0, 60)}`);
  }
  return s;
}

// ---------- zip ----------
// Lê um zip inteiro na memória. Devolve [{ name, data }]. Sem zip64, sem senha, só "stored" e "deflate".
function readZip(buf, limits = LIMITS) {
  const min = Math.max(0, buf.length - 22 - 65535); // o comentário do zip pode ter até 64 KB
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('o arquivo da extensão não é um zip válido');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('zip grande demais (zip64 não é aceito)');
  if (count > limits.entries) throw new Error('a extensão tem arquivos demais');

  const out = [];
  const seen = new Set();
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip corrompido');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const next = 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += next;
    if (name.endsWith('/')) continue; // pasta
    if (flags & 1) throw new Error('zip com senha não é aceito');
    safeRelPath(name);
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw new Error(`arquivo repetido no zip: ${name}`); // o Windows não separa maiúsculas
    seen.add(lower);
    if (usize > limits.file) throw new Error(`arquivo grande demais: ${name}`);
    total += usize;
    if (total > limits.total) throw new Error('a extensão é grande demais');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('zip corrompido');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) throw new Error('zip corrompido');
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) }); // limite contra "bomba" de zip
    else throw new Error('zip com compressão não suportada');
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`arquivo corrompido: ${name}`);
    out.push({ name, data });
  }
  return out;
}

// Grava os arquivos numa pasta nova (sem sobrescrever nada de fora dela). `_metadata/` é da loja e não serve.
function writeFiles(files, dir) {
  const root = path.resolve(dir);
  for (const f of files) {
    if (f.name === '_metadata' || f.name.startsWith('_metadata/')) continue;
    const dest = path.resolve(root, ...f.name.split('/'));
    if (!dest.startsWith(root + path.sep)) throw new Error(`nome de arquivo inválido: ${f.name}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.data);
  }
}

// ---------- CRX3 ----------
// Protobuf mínimo: só os campos de tamanho variável (2) e números (0); o resto é pulado.
function readFields(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let r = 0;
    for (let shift = 0; shift <= 35; shift += 7) {
      if (i >= buf.length) throw new Error('cabeçalho do CRX corrompido');
      const b = buf[i++];
      r += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return r;
    }
    throw new Error('cabeçalho do CRX corrompido');
  };
  while (i < buf.length) {
    const tag = varint();
    const n = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 2) {
      const len = varint();
      if (i + len > buf.length) throw new Error('cabeçalho do CRX corrompido');
      out.push({ n, v: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 0) out.push({ n, v: varint() });
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error('cabeçalho do CRX corrompido');
  }
  return out;
}

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

// Lê e CONFERE um CRX3: toda assinatura do cabeçalho tem de bater com o zip, e uma das chaves tem de
// ser a do ID declarado. Devolve { id, key (DER em base64), zip }. Lança erro se algo não bater.
function parseCrx3(buf) {
  if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'Cr24') throw new Error('o arquivo baixado não é uma extensão do Chrome (.crx)');
  if (buf.readUInt32LE(4) !== 3) throw new Error('só extensões no formato CRX3 são aceitas');
  const hlen = buf.readUInt32LE(8);
  if (hlen > 1 << 20 || 12 + hlen > buf.length) throw new Error('cabeçalho do CRX corrompido');
  const header = readFields(buf.subarray(12, 12 + hlen));
  const zip = buf.subarray(12 + hlen);

  const signedData = header.find((f) => f.n === 10000)?.v;
  if (!signedData) throw new Error('a extensão não tem identificação assinada');
  const crxId = readFields(signedData).find((f) => f.n === 1)?.v;
  if (!crxId || crxId.length !== 16) throw new Error('a extensão não tem identificação válida');

  const payload = Buffer.concat([Buffer.from('CRX3 SignedData\0', 'latin1'), u32(signedData.length), signedData, zip]);
  const proofs = header.filter((f) => (f.n === 2 || f.n === 3) && Buffer.isBuffer(f.v));
  if (!proofs.length) throw new Error('a extensão não tem assinatura');

  let key = null;
  for (const proof of proofs) {
    const fields = readFields(proof.v);
    const pub = fields.find((f) => f.n === 1)?.v;
    const sig = fields.find((f) => f.n === 2)?.v;
    if (!pub || !sig) throw new Error('assinatura da extensão incompleta');
    let ok = false;
    try {
      ok = crypto.verify('sha256', payload, crypto.createPublicKey({ key: pub, format: 'der', type: 'spki' }), sig);
    } catch {}
    if (!ok) throw new Error('a assinatura da extensão não confere: o arquivo foi alterado ou está corrompido');
    if (crypto.createHash('sha256').update(pub).digest().subarray(0, 16).equals(crxId)) key = pub;
  }
  if (!key) throw new Error('a assinatura da extensão não é do dono dela (identificação não bate com a chave)');
  return { id: idFromHash16(crxId), key: key.toString('base64'), zip };
}

module.exports = { LIMITS, sha256, crc32, idFromKey, idFromHash16, safeRelPath, readZip, writeFiles, parseCrx3 };
