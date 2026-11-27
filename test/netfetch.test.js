// O fetch dos scripts de usuário (src/main/netfetch.js), com um `net.request` falso no lugar do Electron.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createManualFetch } = require('../src/main/netfetch');

// net.request falso: `script(req)` decide o que o "servidor" faz.
function fakeNet(script) {
  const made = [];
  return {
    made,
    request(opts) {
      const req = new EventEmitter();
      Object.assign(req, { opts, headers: {}, written: [], aborted: false, ended: false });
      req.setHeader = (k, v) => {
        if (/^forbidden$/i.test(k)) throw new Error('Cabeçalho não permitido');
        req.headers[k] = v;
      };
      req.write = (b) => req.written.push(b);
      req.abort = () => (req.aborted = true);
      req.end = () => {
        req.ended = true;
        setImmediate(() => script(req));
      };
      made.push(req);
      return req;
    },
  };
}

const respond = (req, { status = 200, message = 'OK', headers = {}, chunks = [] }) => {
  const res = new EventEmitter();
  Object.assign(res, { statusCode: status, statusMessage: message, headers });
  req.emit('response', res);
  for (const c of chunks) res.emit('data', Buffer.from(c));
  res.emit('end');
};

test('pede sem cookies e sem seguir redirecionamento, e devolve a resposta no formato do fetch', async () => {
  const net = fakeNet((req) => respond(req, { headers: { 'Content-Type': 'text/plain', 'Set-Cookie': ['a=1', 'b=2'] }, chunks: ['ol', 'á'] }));
  const res = await createManualFetch(net)('https://exemplo.com/x', { method: 'POST', headers: { 'X-A': '1', Forbidden: 'x' }, body: 'corpo' });
  const req = net.made[0];
  assert.deepEqual([req.opts.redirect, req.opts.credentials, req.opts.method, req.opts.url], ['manual', 'omit', 'POST', 'https://exemplo.com/x']);
  assert.deepEqual(req.headers, { 'X-A': '1' }, 'cabeçalho recusado pelo Chromium é ignorado');
  assert.deepEqual(req.written, ['corpo']);
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('CONTENT-TYPE'), 'text/plain');
  assert.equal(res.headers.get('set-cookie'), 'a=1, b=2');
  assert.equal(res.headers.get('nao-existe'), null);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'olá');
});

test('redirecionamento volta como 3xx com o location; ninguém chama followRedirect (o Electron cancela)', async () => {
  const net = fakeNet((req) => req.emit('redirect', 302, 'GET', 'https://outro.com/y', { 'x-a': ['1'] }));
  const res = await createManualFetch(net)('https://exemplo.com/x');
  assert.equal(res.status, 302);
  assert.equal(res.ok, false);
  assert.equal(res.headers.get('location'), 'https://outro.com/y');
  assert.equal(net.made[0].followed, undefined, 'não segue sozinho');
  assert.equal(net.made[0].aborted, false, 'quem cancela é o Electron, por ninguém ter chamado followRedirect()');
});

test('erro de rede e cancelamento viram erro; sem corpo no GET', async () => {
  const bad = fakeNet((req) => req.emit('error', new Error('net::ERR_FAILED')));
  await assert.rejects(createManualFetch(bad)('https://exemplo.com/'), /ERR_FAILED/);
  assert.deepEqual(bad.made[0].written, []);

  const slow = fakeNet(() => {});
  const ctl = new AbortController();
  const p = createManualFetch(slow)('https://exemplo.com/', { signal: ctl.signal });
  await new Promise((r) => setImmediate(r));
  ctl.abort();
  await assert.rejects(p, /abort/);
  assert.equal(slow.made[0].aborted, true);

  const already = new AbortController();
  already.abort();
  await assert.rejects(createManualFetch(fakeNet(() => {}))('https://exemplo.com/', { signal: already.signal }), /abort/);
});

test('resposta enorme é cortada', async () => {
  const net = fakeNet((req) => {
    const res = new EventEmitter();
    Object.assign(res, { statusCode: 200, headers: {} });
    req.emit('response', res);
    res.emit('data', Buffer.alloc(13 * 1024 * 1024));
  });
  await assert.rejects(createManualFetch(net)('https://exemplo.com/'), /grande demais/);
  assert.equal(net.made[0].aborted, true);
});

test('URL inválida para o net.request vira erro, não trava', async () => {
  const net = { request: () => { throw new TypeError('Invalid URL'); } };
  await assert.rejects(createManualFetch(net)('lixo'), /Invalid URL/);
});
