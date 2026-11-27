// Servidor local da sonda do modo econômico (TAG-18): serve a página de teste e um WebSocket
// que manda 10 mensagens por segundo, cada uma com número e hora. Só escuta em 127.0.0.1, em porta
// livre sorteada (nunca a 3000 do IdleLive). Sem pacotes: o aperto de mão do WebSocket é feito à mão.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MSG_EVERY_MS = 100;

// Quadro de texto do WebSocket (servidor -> navegador, sem máscara). Mensagens pequenas (< 126 bytes).
const frame = (text) => {
  const body = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, body.length]), body]);
};

function start() {
  const page = fs.readFileSync(path.join(__dirname, 'page.html'));
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/page.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) return socket.destroy();
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    let seq = 0;
    const timer = setInterval(() => {
      if (!socket.destroyed) socket.write(frame(JSON.stringify({ seq: ++seq, ts: Date.now() })));
    }, MSG_EVERY_MS);
    const done = () => {
      clearInterval(timer);
      sockets.delete(socket);
    };
    socket.on('data', () => {}); // quadros do navegador (fechar) não importam
    socket.on('close', done);
    socket.on('error', done);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => {
          for (const s of sockets) s.destroy();
          server.close();
        },
      });
    });
  });
}

module.exports = { start, MSG_EVERY_MS };
