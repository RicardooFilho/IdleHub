// Sonda do modo econômico (TAG-18): UM cenário por execução. Abre N contas de teste (WebContentsView com
// as MESMAS webPreferences, o MESMO preload e as MESMAS chaves do Chromium das contas reais), aplica um
// "modo" nas views e um "estado" na janela, espera, e mede por `ms` milissegundos:
//   - na página: setInterval, setTimeout, requestAnimationFrame, progresso por Date.now(), WebSocket;
//   - no processo: CPU e memória de cada processo (app.getAppMetrics), GPU incluída;
//   - opcional: o custo do capturePage em intervalos fixos.
// Quem monta os cenários é o run.js. Só abre páginas de teste locais, com pasta de dados temporária.
//
// Uso (pelo run.js): electron scripts/economy-probe/main.js   (cenário em IDLEHUB_ECON_CFG, JSON)
const { app, BaseWindow, BrowserWindow, WebContentsView, ipcMain, screen, sharedTexture } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = JSON.parse(process.env.IDLEHUB_ECON_CFG || '{}');
const {
  name = 'teste', port, mode = 'visible', win: winState = 'normal', accounts = 4,
  warmMs = 8000, settleMs = 8000, ms = 120000, fps = 30, capture = null, textureFps = 20, pulseMs = 100,
} = cfg;
const TEXTURE = mode === 'texture';

// Dados de teste: nunca %APPDATA%/IdleHub.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-econ-probe-'));
app.setPath('userData', tmp);
// As mesmas chaves de src/main/main.js: os jogos não podem parar com a janela escondida.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('fake-vsync-rate', process.env.IDLEHUB_PROBE_VSYNC || '64');
// Chaves extras só para experimentos: IDLEHUB_PROBE_SWITCHES="chave,chave=valor".
for (const s of String(process.env.IDLEHUB_PROBE_SWITCHES || '').split(',').filter(Boolean)) {
  const [k, v] = s.split('=');
  if (v === undefined) app.commandLine.appendSwitch(k);
  else app.commandLine.appendSwitch(k, v);
}

// O preload pergunta os scripts de usuário da conta com sendSync: sem resposta, a página nunca termina de abrir.
ipcMain.on('us:plan', (e) => {
  e.returnValue = [];
});

const emit = (r) => {
  const f = process.env.IDLEHUB_PROBE_OUT;
  const t = JSON.stringify(r);
  if (f) fs.writeFileSync(f, t);
  else console.log('REPORT ' + t);
};
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const withTimeout = (p, n) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), n))]);

const report = { name, cfg, electron: process.versions.electron, chrome: process.versions.chrome, events: [], views: [], procs: null, capture: null, exec: null };
const ev = (e) => report.events.push(e);

const CONTENT_W = 760;
const CONTENT_H = 480;

app.whenReady().then(async () => {
  const wa = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    show: false, useContentSize: true, width: CONTENT_W, height: CONTENT_H, resizable: false, title: 'IdleHub (medição do modo econômico)',
    x: wa.x + wa.width - CONTENT_W - 40, y: wa.y + wa.height - CONTENT_H - 70,
    backgroundColor: '#0f1117',
    // Modo "textura": a janela é a "interface" que recebe e pinta os quadros das contas.
    ...(TEXTURE ? { webPreferences: { preload: path.join(__dirname, 'host-preload.js'), sandbox: true, contextIsolation: true } } : {}),
  });
  if (TEXTURE) await win.loadURL('data:text/html,<body style="margin:0;background:%230f1117;overflow:hidden"></body>');
  let cover = null;
  let garage = null;
  const extraWins = [];

  // Mosaico: até 4 contas em 2x2; 8 em 4x2.
  const cols = accounts > 4 ? 4 : 2;
  const rows = Math.ceil(accounts / cols);
  const tw = Math.floor(CONTENT_W / cols);
  const th = Math.floor(CONTENT_H / rows);
  const tile = (i) => ({ x: (i % cols) * tw, y: Math.floor(i / cols) * th, width: tw, height: th });

  const views = [];
  for (let i = 0; i < accounts; i++) {
    // Igual a createView() em src/main/accounts.js (uma sessão separada por conta).
    const webPreferences = {
      partition: `persist:econ-${i}`,
      preload: path.join(__dirname, '../../src/preload/game.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    };
    if (TEXTURE) {
      // Conta desenhada fora da tela: o app escolhe quantos quadros ela gera (setFrameRate) e
      // manda cada quadro (textura da GPU, sem copiar pixels) para a janela pintar.
      const t = tile(i);
      const host = new BrowserWindow({ show: false, frame: false, width: t.width, height: t.height, webPreferences: { ...webPreferences, offscreen: { useSharedTexture: true } } });
      extraWins.push(host);
      const wc = host.webContents;
      wc.setFrameRate(textureFps);
      let busy = false;
      wc.on('paint', (e) => {
        const tex = e.texture;
        if (!tex) return;
        if (busy || win.isDestroyed()) return tex.release();
        busy = true;
        let imported;
        try {
          imported = sharedTexture.importSharedTexture({ textureInfo: tex.textureInfo, allReferencesReleased: () => tex.release() });
        } catch (err) {
          tex.release();
          busy = false;
          return ev({ importFail: String(err.message).slice(0, 120) });
        }
        sharedTexture.sendSharedTexture({ frame: win.webContents.mainFrame, importedSharedTexture: imported }, i)
          .catch((err) => ev({ sendFail: String(err.message).slice(0, 120) }))
          .finally(() => {
            imported.release();
            busy = false;
          });
      });
      wc.on('render-process-gone', (_e, d) => ev({ gone: i, reason: d.reason }));
      views.push({ i, view: null, host, wc, bounds: t, pid: 0 });
      continue;
    }
    const view = new WebContentsView({ webPreferences });
    view.setBackgroundColor('#0f1117');
    view.setBounds(tile(i));
    view.setVisible(true);
    win.contentView.addChildView(view);
    view.webContents.on('render-process-gone', (_e, d) => ev({ gone: i, reason: d.reason }));
    views.push({ i, view, wc: view.webContents, bounds: tile(i), pid: 0 });
  }
  win.showInactive();
  if (TEXTURE) {
    const tiles = views.map((v) => ({ i: v.i, ...v.bounds }));
    await win.webContents.executeJavaScript(`window.postMessage(${JSON.stringify({ type: 'tiles', tiles })}, '*')`);
  }

  // "Garagem": janela de verdade, mostrada mas posicionada fora de todos os monitores, onde ficam as contas
  // escondidas. Uma página de 1x1 muda de cor a cada `pulseMs` para a janela continuar gerando quadros.
  const makeGarage = (withPulse) => {
    const right = Math.max(...screen.getAllDisplays().map((d) => d.bounds.x + d.bounds.width));
    garage = new BaseWindow({ x: right + 200, y: 0, width: CONTENT_W, height: CONTENT_H, show: false, frame: false, focusable: false, skipTaskbar: true, backgroundColor: '#0f1117' });
    garage.showInactive();
    if (withPulse) {
      const pulse = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
      pulse.setBounds({ x: 0, y: 0, width: 1, height: 1 });
      garage.contentView.addChildView(pulse);
      pulse.webContents.loadURL(`data:text/html,${encodeURIComponent(`<body style="margin:0"><script>let k=0;setInterval(()=>{document.body.style.background=(k++%2)?'#0f1118':'#0f1117'},${pulseMs})</script>`)}`);
    }
    report.garageBounds = garage.getBounds();
  };

  await Promise.all(
    views.map((v) => new Promise((resolve) => {
      v.wc.once('did-finish-load', resolve);
      v.wc.loadURL(`http://127.0.0.1:${port}/page.html`).catch((e) => ev({ loadFail: String(e.message) }));
    }))
  );
  for (const v of views) {
    v.pid = v.wc.getOSProcessId();
    // O app faz o mesmo (applyLayout): manda o limite de FPS pela própria página.
    await v.wc.executeJavaScript(`window.__idleHubSetFps && window.__idleHubSetFps(${Number(fps) || 0})`, true).catch(() => {});
  }
  report.pids = views.map((v) => v.pid);
  report.distinctPids = new Set(report.pids).size;
  await sleep(warmMs);

  // ---------- aplica o modo nas views ----------
  const applyMode = () => {
    for (const v of views) {
      switch (mode) {
        case 'visible':
        case 'texture':
          break;
        case 'garage':
        case 'garage-nopulse':
          if (!garage) makeGarage(mode === 'garage');
          win.contentView.removeChildView(v.view);
          garage.contentView.addChildView(v.view);
          v.view.setVisible(false);
          break;
        case 'hidden': // o que o app faz hoje com conta fora da tela (accounts.js: applyLayout)
          v.view.setVisible(false);
          break;
        case 'removed': // tira a view da árvore da janela
          win.contentView.removeChildView(v.view);
          break;
        case 'zero':
          v.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
          break;
        case 'offscreen':
          v.view.setBounds({ x: -20000, y: -20000, width: v.bounds.width, height: v.bounds.height });
          break;
        case 'hidden-throttle': // escondida + deixa o Chromium reduzir o trabalho (muda a regra de ouro; só para medir)
          v.view.setVisible(false);
          v.wc.setBackgroundThrottling(true);
          break;
        case 'removed-throttle':
          win.contentView.removeChildView(v.view);
          v.wc.setBackgroundThrottling(true);
          break;
        default:
          throw new Error(`modo desconhecido: ${mode}`);
      }
    }
  };

  // ---------- aplica o estado na janela ----------
  const applyWinState = async () => {
    switch (winState) {
      case 'normal':
        break;
      case 'minimized':
        win.minimize();
        break;
      case 'occluded': {
        // Janela opaca por cima, cobrindo tudo (o Windows calcula a oclusão sozinho).
        const b = win.getBounds();
        cover = new BrowserWindow({
          show: false, frame: false, focusable: false, alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#222222',
          x: b.x - 30, y: b.y - 30, width: b.width + 60, height: b.height + 60,
        });
        cover.loadURL('data:text/html,<body style="background:%23222;color:%23999;font:14px sans-serif">Medição do IdleHub: esta janela fecha sozinha.</body>');
        cover.showInactive();
        break;
      }
      case 'tray': // "fechar para a bandeja": a janela é escondida (win.hide())
        win.hide();
        break;
      case 'tray-min': // bandeja feita com a janela minimizada e fora da barra de tarefas
        win.setSkipTaskbar(true);
        win.minimize();
        break;
      default:
        throw new Error(`estado desconhecido: ${winState}`);
    }
    await sleep(1500);
  };

  applyMode();
  await applyWinState();
  report.winState = { visible: win.isVisible(), minimized: win.isMinimized() };
  await sleep(settleMs);

  // ---------- começa a medir ----------
  for (const v of views) await withTimeout(v.wc.executeJavaScript('window.__probe.reset()', true), 15000).catch((e) => ev({ resetFail: v.i, e: e.message }));

  const procSamples = [];
  const procRoles = new Map(); // pid -> papel
  views.forEach((v) => procRoles.set(v.pid, `conta${v.i}`));
  const sample = () => {
    const t = Date.now();
    const list = app.getAppMetrics().map((p) => ({
      pid: p.pid, type: p.type, name: p.name || '', role: procRoles.get(p.pid) || p.type,
      cpu: p.cpu.percentCPUUsage, ws: p.memory.workingSetSize, priv: p.memory.privateBytes || 0,
    }));
    procSamples.push({ t, list });
  };
  sample(); // a primeira leitura só marca o ponto zero do cálculo de CPU
  procSamples.length = 0;
  const sampler = setInterval(sample, 5000);

  // capturePage em intervalos fixos, uma conta de cada vez (espalhadas no intervalo).
  const cap = { n: 0, ok: 0, empty: 0, changed: 0, ms: [], resizeMs: [], bytes: 0, sizes: new Set(), errors: [], last: new Map() };
  const capTimers = [];
  let capOn = false;
  const hash = (buf) => {
    let h = 2166136261;
    for (let i = 0; i < buf.length; i += 97) h = Math.imul(h ^ buf[i], 16777619);
    return h >>> 0;
  };
  if (capture) {
    capOn = true;
    const widthPx = capture.width || 320;
    views.forEach((v, idx) => {
      const run = async () => {
        if (!capOn) return;
        const t0 = process.hrtime.bigint();
        try {
          const img = await withTimeout(v.wc.capturePage(undefined, { stayHidden: capture.stayHidden !== false }), 20000);
          const t1 = process.hrtime.bigint();
          cap.n++;
          cap.ms.push(Number(t1 - t0) / 1e6);
          if (img.isEmpty()) {
            cap.empty++;
          } else {
            const r0 = process.hrtime.bigint();
            const small = img.resize({ width: widthPx, quality: 'good' });
            cap.resizeMs.push(Number(process.hrtime.bigint() - r0) / 1e6);
            const bmp = small.toBitmap();
            cap.bytes = bmp.length;
            const s = small.getSize();
            cap.sizes.add(`${s.width}x${s.height}`);
            const h = hash(bmp);
            if (cap.last.has(v.i) && cap.last.get(v.i) !== h) cap.changed++;
            cap.last.set(v.i, h);
            cap.ok++;
          }
        } catch (e) {
          cap.n++;
          cap.errors.push(String(e.message).slice(0, 120));
        }
      };
      setTimeout(() => {
        if (!capOn) return;
        run();
        capTimers.push(setInterval(run, capture.intervalMs));
      }, Math.round((idx * capture.intervalMs) / views.length));
    });
  }

  await sleep(ms);
  capOn = false;
  capTimers.forEach(clearInterval);
  clearInterval(sampler);
  sample(); // última leitura (cobre o resto do intervalo)

  // ---------- compatível com o watchdog? executeJavaScript responde e quanto demora ----------
  const execMs = [];
  for (const v of views) {
    const t0 = process.hrtime.bigint();
    try {
      await withTimeout(v.wc.executeJavaScript('document.body.innerText.length', true), 15000);
      execMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    } catch (e) {
      execMs.push(-1);
    }
  }
  report.exec = execMs;

  // ---------- lê o que a página contou ----------
  for (const v of views) {
    try {
      report.views.push({ i: v.i, pid: v.pid, ...(await withTimeout(v.wc.executeJavaScript('window.__probe.read()', true), 20000)) });
    } catch (e) {
      report.views.push({ i: v.i, pid: v.pid, error: String(e.message) });
    }
  }

  // Resumo dos processos: média da CPU por papel e memória do último ponto.
  const byRole = {};
  const nSamples = procSamples.length;
  for (const s of procSamples) {
    const seen = {};
    for (const p of s.list) {
      const key = /^conta/.test(p.role) ? 'contas' : p.role; // todas as contas juntas
      seen[key] = seen[key] || { cpu: 0, ws: 0, priv: 0 };
      seen[key].cpu += p.cpu;
      seen[key].ws += p.ws;
      seen[key].priv += p.priv;
    }
    for (const [k, x] of Object.entries(seen)) {
      const r = (byRole[k] = byRole[k] || { cpu: 0, ws: 0, priv: 0, n: 0 });
      r.cpu += x.cpu;
      r.ws += x.ws;
      r.priv += x.priv;
      r.n++;
    }
  }
  report.procs = {
    samples: nSamples,
    byRole: Object.fromEntries(Object.entries(byRole).map(([k, r]) => [k, { cpuAvg: r.cpu / Math.max(1, nSamples), wsMB: r.ws / r.n / 1024, privMB: r.priv / r.n / 1024 }])),
  };

  if (capture) {
    const sorted = [...cap.ms].sort((a, b) => a - b);
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    report.capture = {
      n: cap.n, ok: cap.ok, empty: cap.empty, changed: cap.changed, errors: cap.errors.slice(0, 5),
      msAvg: avg(cap.ms), msP95: sorted[Math.floor(sorted.length * 0.95)] || 0, msMax: sorted[sorted.length - 1] || 0,
      resizeMsAvg: avg(cap.resizeMs), bytesEach: cap.bytes, sizes: [...cap.sizes],
    };
  }
  report.mainMemMB = process.memoryUsage().rss / 1048576;
  if (TEXTURE) report.texture = { fps: textureFps, drawn: Number(await win.webContents.executeJavaScript('document.documentElement.dataset.drawn || 0').catch(() => -1)) };

  emit(report);
  if (cover) cover.destroy();
  if (garage) garage.destroy();
  for (const w of extraWins) if (!w.isDestroyed()) w.destroy();
  win.destroy();
  app.exit(0);
});

setTimeout(() => {
  emit({ ...report, timeout: true });
  app.exit(2);
}, warmMs + settleMs + ms + 120000).unref();

// Se algo quebrar na largada, deixa o motivo num arquivo (no Windows o Electron não liga o terminal).
process.on('uncaughtException', (e) => {
  try {
    fs.writeFileSync((process.env.IDLEHUB_PROBE_OUT || 'econ-probe-crash') + '.err', String((e && e.stack) || e));
  } catch (_) {}
  app.exit(3);
});
