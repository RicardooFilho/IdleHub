// fetch mínimo sobre `net.request` do Electron, só para os scripts de usuário (userscript-store.js).
// Motivo: o `net.fetch` do Electron não aceita `redirect: 'manual'`, e aqui cada redirecionamento precisa ser
// conferido pelo chamador (o destino tem de estar no @connect ou entre os sites de scripts permitidos) ANTES de
// ser seguido. Aqui um redirecionamento volta como resposta 3xx com o `location`, e o pedido original é
// cancelado pelo próprio Electron (veja o comentário no evento `redirect`). Nunca envia
// os cookies do app (`credentials: 'omit'`). `net` entra por parâmetro para dar para testar sem Electron.
const MAX_BYTES = 12 * 1024 * 1024; // acima disso a resposta é cortada (os limites de verdade são do chamador)

function toResponse(status, statusText, rawHeaders, buf) {
  const map = new Map();
  for (const [k, v] of Object.entries(rawHeaders || {})) map.set(k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: statusText || '',
    headers: { get: (k) => map.get(String(k).toLowerCase()) ?? null, forEach: (fn) => map.forEach((v, k) => fn(v, k)) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  };
}

// Mesma forma do fetch: (url, { method, headers, body, signal }) -> Promise<resposta>.
const createManualFetch = (net) => (url, init = {}) =>
  new Promise((resolve, reject) => {
    const { method = 'GET', headers = {}, body, signal } = init;
    let done = false;
    let req;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const stop = () => {
      try {
        req.abort();
      } catch {}
    };
    function onAbort() {
      stop();
      finish(reject, new Error('abort'));
    }
    try {
      req = net.request({ url: String(url), method, redirect: 'manual', credentials: 'omit' });
    } catch (e) {
      return reject(e);
    }
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    for (const [k, v] of Object.entries(headers)) {
      try {
        req.setHeader(k, String(v));
      } catch {} // cabeçalho que o Chromium não deixa mudar: segue sem ele
    }
    // No modo manual o Electron cancela o pedido sozinho se `followRedirect()` não for chamado durante o evento
    // (conferido no app, com um servidor de teste: o destino do redirecionamento nunca recebe o pedido).
    req.on('redirect', (status, _method, location, rawHeaders) => {
      finish(resolve, toResponse(status, '', { ...rawHeaders, location }, Buffer.alloc(0)));
    });
    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) {
          stop();
          return finish(reject, new Error('A resposta é grande demais.'));
        }
        chunks.push(c);
      });
      res.on('end', () => finish(resolve, toResponse(res.statusCode, res.statusMessage, res.headers, Buffer.concat(chunks))));
      res.on('error', (e) => finish(reject, e));
    });
    req.on('error', (e) => finish(reject, e));
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });

module.exports = { createManualFetch, MAX_BYTES };
