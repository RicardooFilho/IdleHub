// Preload das páginas dos jogos. Não expõe nada para a página; só injeta,
// antes dos scripts do jogo:
//  1) "sempre visível": o jogo não pausa quando a conta está escondida;
//  2) limitador de FPS controlado pelo painel (economiza CPU/GPU);
//  3) sem chave de acesso (passkey): evita a janela do Windows Hello pedindo
//     chave de segurança no login do Google; o site cai no login com senha;
//  4) no login do Google, se apresenta como Firefox (o Google bloqueia apps);
//  5) anota quando os WebSockets do jogo abrem, recebem dados e fecham (só horários);
//  6) roda os scripts de usuário que a pessoa ligou nesta conta (veja o fim do arquivo).
const { webFrame, ipcRenderer, contextBridge } = require('electron');

function patch() {
  if (window.__idleHub) return;
  window.__idleHub = true;

  try {
    const blocked = () => Promise.reject(new DOMException('Chave de acesso desativada no IdleHub', 'NotAllowedError'));
    const C = window.CredentialsContainer && CredentialsContainer.prototype;
    if (C) {
      const get = C.get;
      const create = C.create;
      C.get = function (o) {
        return o && o.publicKey ? blocked() : get.call(this, o);
      };
      C.create = function (o) {
        return o && o.publicKey ? blocked() : create.call(this, o);
      };
    }
    delete window.PublicKeyCredential;
    if ('PublicKeyCredential' in window) window.PublicKeyCredential = undefined;
  } catch (e) {}

  // Login do Google: a página também se vê como Firefox (combina com o
  // cabeçalho trocado em src/main/accounts.js).
  if (/(^|\.)accounts\.(google|youtube)\.com$/.test(location.hostname)) {
    try {
      const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0';
      const def = (k, v) => Object.defineProperty(Navigator.prototype, k, { configurable: true, get: () => v });
      def('userAgent', ua);
      def('appVersion', '5.0 (Windows)');
      def('vendor', '');
      def('platform', 'Win32');
      def('userAgentData', undefined);
    } catch (e) {}
  }

  try {
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'visible' });
    Document.prototype.hasFocus = function () {
      return true;
    };
  } catch (e) {}
  document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);

  let fps = 0;
  let lastFrame = -1e9;
  let frameT = -1;
  let seq = 0;
  const ids = new Map();
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);

  window.requestAnimationFrame = function (cb) {
    const id = ++seq;
    const tick = (t) => {
      if (!fps || t === frameT || t - lastFrame >= 1000 / fps - 2) {
        if (t !== frameT) {
          frameT = t;
          lastFrame = t;
        }
        ids.delete(id);
        cb(t);
      } else {
        ids.set(id, raf(tick));
      }
    };
    ids.set(id, raf(tick));
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    const real = ids.get(id);
    if (real !== undefined) {
      caf(real);
      ids.delete(id);
    }
  };
  window.__idleHubSetFps = (n) => {
    fps = Math.max(0, Number(n) || 0);
  };

  // Conexão do jogo: só conta QUANDO os WebSockets abrem, recebem mensagem e fecham.
  // Não lê o conteúdo das mensagens nem mexe nelas (os ouvintes só anotam a hora).
  // O IdleHub lê o resultado de vez em quando (watchdog, connection.js).
  try {
    const NativeWS = window.WebSocket;
    const now = performance.now.bind(performance);
    const net = { open: 0, ever: false, msg: -1, opened: -1, closed: -1 };
    const age = (t) => (t < 0 ? -1 : Math.round(now() - t));
    const track = (ws) => {
      let isOpen = false;
      ws.addEventListener('open', () => {
        isOpen = true;
        net.open++;
        net.ever = true;
        net.opened = now();
      });
      ws.addEventListener('message', () => {
        net.msg = now();
      });
      ws.addEventListener('close', () => {
        if (!isOpen) return; // nunca chegou a abrir (falha ao conectar)
        isOpen = false;
        net.open = Math.max(0, net.open - 1);
        net.closed = now();
      });
    };
    if (NativeWS) {
      // Proxy mantém WebSocket.OPEN, instanceof e o resto do jeito que o jogo espera.
      window.WebSocket = new Proxy(NativeWS, {
        construct(target, args, newTarget) {
          const ws = Reflect.construct(target, args, newTarget);
          try {
            track(ws);
          } catch (e) {}
          return ws;
        },
      });
    }
    Object.defineProperty(window, '__idleHubNet', {
      configurable: true,
      value: () => ({ open: net.open, ever: net.ever, msg: age(net.msg), opened: age(net.opened), closed: age(net.closed) }),
    });
  } catch (e) {}
}

webFrame.executeJavaScript(`(${patch.toString()})()`).catch(() => {});

// 6) scripts de usuário (TAG-35, src/main/userscripts.js). O processo principal diz quais scripts rodam NESTA
//    página da conta (a lista já vem conferida: conta, site do jogo e hash do arquivo). Scripts com GM_* rodam
//    num mundo isolado próprio, com uma ponte estreita (`idleHubGM`) que só existe lá dentro, nunca na página;
//    os com `@grant none` rodam no mundo da página, como pede a regra deles. A página não enxerga nada disso.
function runUserScripts() {
  if (/(^|\.)accounts\.(google|youtube)\.com$/.test(location.hostname)) return; // login do Google: nada de scripts, nem o pedido
  let plan;
  try {
    plan = ipcRenderer.sendSync('us:plan');
  } catch (e) {
    return;
  }
  if (!Array.isArray(plan) || !plan.length) return;
  const report = (id) => (e) => {
    try {
      ipcRenderer.send('us:error', id, String((e && e.message) || e));
    } catch (x) {}
  };
  // Cada script tem a própria ponte: o mundo dele só consegue falar em nome dele.
  const bridgeOf = (id) => ({
    set: (n, v) => ipcRenderer.send('us:set', id, String(n), String(v)),
    del: (n) => ipcRenderer.send('us:del', id, String(n)),
    xhr: (reqId, req) => ipcRenderer.invoke('us:xhr', id, String(reqId), req),
    abort: (reqId) => ipcRenderer.send('us:abort', id, String(reqId)),
    notify: (o) => ipcRenderer.send('us:notify', id, o),
  });
  const run = (s) => {
    try {
      let p;
      if (s.mode === 'isolated') {
        contextBridge.exposeInIsolatedWorld(s.world, 'idleHubGM', bridgeOf(s.id));
        try {
          webFrame.setIsolatedWorldInfo(s.world, { name: 'IdleHub: ' + s.name });
        } catch (e) {}
        p = webFrame.executeJavaScriptInIsolatedWorld(s.world, [{ code: s.code }]);
      } else {
        p = webFrame.executeJavaScript(s.code);
      }
      p.catch(report(s.id));
    } catch (e) {
      report(s.id)(e);
    }
  };
  const start = plan.filter((s) => s.runAt === 'document-start');
  const end = plan.filter((s) => s.runAt === 'document-end' || s.runAt === 'document-body');
  const idle = plan.filter((s) => s.runAt !== 'document-start' && s.runAt !== 'document-end' && s.runAt !== 'document-body');
  start.forEach(run);
  const afterParse = () => {
    end.forEach(run);
    setTimeout(() => idle.forEach(run), 0);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', afterParse, { once: true });
  else afterParse();
}
try {
  runUserScripts();
} catch (e) {}
