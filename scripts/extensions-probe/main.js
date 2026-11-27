// Sonda de extensões (TAG-37): carrega UMA extensão descompactada numa sessão temporária do
// Electron, abre o site do jogo numa janela ESCONDIDA e grava um relatório JSON (veja docs/extensoes.md).
// Não faz login, não clica em nada e não toca nos dados reais (usa uma pasta temporária).
//
// Uso (pelo run.js):  electron scripts/extensions-probe/main.js <pasta-da-extensao|none> <ms>   (URL em IDLEHUB_PROBE_URL)
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A URL vem por variável de ambiente: o Electron no Windows encerra se um argumento parece uma URL.
const [extDir, msArg = '20000'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const url = process.env.IDLEHUB_PROBE_URL || 'https://pokeidle.io/';
const ms = Number(msArg) || 20000;

// Dados de teste: nunca %APPDATA%/IdleHub.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-ext-probe-'));
app.setPath('userData', tmp);
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const report = {
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  ext: extDir === 'none' ? null : extDir,
  load: null,
  events: [],
  sw: [],
  page: { console: [], errors: [], contexts: [] },
  probe: [],
  signature: null,
};
const ev = (e) => report.events.push(e);
// O Electron no Windows não liga o stdout ao terminal: o relatório vai para um arquivo (IDLEHUB_PROBE_OUT).
const emit = (r) => { const f = process.env.IDLEHUB_PROBE_OUT; const t = JSON.stringify(r); if (f) fs.writeFileSync(f, t); else console.log('REPORT ' + t); };

// Assinatura da página: o que apareceu nela (para comparar com a execução sem extensão).
const SIGNATURE = `(() => {
  const own = Object.getOwnPropertyNames(window).filter((k) => !/^on/.test(k)).sort();
  const ids = [...document.querySelectorAll('[id]')].map((e) => e.id).sort();
  const hosts = [...document.querySelectorAll('*')].filter((e) => e.shadowRoot).map((e) => e.tagName.toLowerCase() + '#' + e.id);
  const custom = [...new Set([...document.querySelectorAll('*')].map((e) => e.tagName.toLowerCase()).filter((t) => t.includes('-')))].sort();
  const scripts = [...document.scripts].map((s) => s.src || ('inline:' + s.textContent.length)).sort();
  return { title: document.title, url: location.href, hidden: document.hidden, nodes: document.querySelectorAll('*').length, own, ids, hosts, custom, scripts,
    ws: Function.prototype.toString.call(window.WebSocket).slice(0, 60), fetchNative: /native code/.test(Function.prototype.toString.call(window.fetch)),
    bodyText: (document.body && document.body.innerText || '').slice(0, 300) };
})()`;

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:ext-probe');
  ses.serviceWorkers.on('running-status-changed', (d) => ev({ sw: 'status', ...d }));
  ses.serviceWorkers.on('console-message', (_e, d) => {
    report.sw.push({ level: d.level, msg: String(d.message).slice(0, 600), src: d.sourceUrl && d.sourceUrl.slice(-60) });
  });
  ses.extensions.on('extension-loaded', (_e, x) => ev({ loaded: x.name, id: x.id, mv: x.manifest && x.manifest.manifest_version }));
  ses.extensions.on('extension-ready', (_e, x) => ev({ ready: x.name }));
  ses.extensions.on('extension-unloaded', (_e, x) => ev({ unloaded: x.name }));

  // Opcional: testa o complemento electron-chrome-extensions (IDLEHUB_PROBE_ECE = caminho do módulo).
  // Ele tem de ser criado ANTES de carregar a extensão.
  let ece = null;
  if (process.env.IDLEHUB_PROBE_ECE) {
    try {
      const { ElectronChromeExtensions } = require(process.env.IDLEHUB_PROBE_ECE);
      ece = new ElectronChromeExtensions({
        session: ses,
        // Janelas/abas pedidas pela extensão nascem escondidas (nada aparece na tela).
        createTab: async (d) => {
          const w = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true } });
          if (d.url) w.loadURL(d.url).catch(() => {});
          ev({ ece: 'createTab', url: d.url });
          return [w.webContents, w];
        },
        createWindow: async (d) => { ev({ ece: 'createWindow' }); return new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true } }); },
      });
      ev({ ece: 'ok' });
    } catch (e) { ev({ ece: 'ERRO ' + String(e && e.message || e) }); }
  }

  if (extDir !== 'none') {
    try {
      const x = await ses.extensions.loadExtension(path.resolve(extDir));
      report.load = { ok: true, id: x.id, name: x.name, version: x.version, mv: x.manifest.manifest_version, url: x.url };
    } catch (e) {
      report.load = { ok: false, error: String(e && e.message || e) };
    }
  }

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      session: ses,
      preload: path.join(__dirname, '..', '..', 'src', 'preload', 'game.js'), // o mesmo preload das contas
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const wc = win.webContents;
  if (ece) ece.addTab(wc, win);
  wc.on('console-message', (e) => {
    const msg = String(e.message || '');
    if (msg.startsWith('PROBE ')) {
      try { report.probe.push(JSON.parse(msg.slice(6))); } catch (_) { report.probe.push({ raw: msg.slice(0, 300) }); }
    } else if (report.page.console.length < 80) {
      report.page.console.push({ level: e.level, msg: msg.slice(0, 300) });
    }
  });
  wc.on('did-fail-load', (_e, code, desc, u) => ev({ failLoad: code, desc, u }));
  wc.on('render-process-gone', (_e, d) => ev({ gone: d.reason }));
  try {
    wc.debugger.attach('1.3');
    wc.debugger.on('message', (_e, method, p) => {
      if (method === 'Runtime.executionContextCreated') {
        const c = p.context;
        report.page.contexts.push({ name: c.name, origin: c.origin, aux: c.auxData && c.auxData.type });
      } else if (method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails;
        report.page.errors.push(String((d.exception && d.exception.description) || d.text).slice(0, 300));
      }
    });
    wc.debugger.sendCommand('Runtime.enable').catch((e) => ev({ debugger: String(e.message) })); // sem await: antes da 1ª página pode não responder
  } catch (e) { ev({ debugger: String(e.message) }); }

  const t0 = Date.now();
  try { await wc.loadURL(url); } catch (e) { ev({ loadURL: String(e.message) }); }
  ev({ loadedMs: Date.now() - t0 });
  await new Promise((r) => setTimeout(r, ms));
  try { report.signature = await wc.executeJavaScript(SIGNATURE); } catch (e) { report.signature = { error: String(e.message) }; }
  try {
    report.swRunning = Object.keys(ses.serviceWorkers.getAllRunning() || {}).length;
    report.extensions = ses.extensions.getAllExtensions().map((x) => ({ name: x.name, id: x.id }));
  } catch (e) { ev({ swList: String(e.message) }); }

  emit(report);
  app.exit(0);
});

setTimeout(() => { emit({ ...report, timeout: true }); app.exit(2); }, ms + 60000).unref();

// Se algo quebrar na largada, deixa o motivo no arquivo do relatório (não há terminal).
process.on('uncaughtException', (e) => {
  try { fs.writeFileSync((process.env.IDLEHUB_PROBE_OUT || 'probe-crash') + '.err', String(e && e.stack || e)); } catch (_) {}
  app.exit(3);
});
