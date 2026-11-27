const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, shell, dialog, protocol, net, powerMonitor } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const config = require('./config');
const { PRESETS, gameFromPreset, sanitizeGame, migrateSessionTaken, migrateReconnecting } = require('./games');
const { AccountManager } = require('./accounts');
const { IdleLive } = require('./idlelive');
const { PanelView } = require('./panel');
const { setupPower } = require('./power');
const { attachShortcuts } = require('./shortcuts');
const { createRemote } = require('./remote');
const { MetricsTracker } = require('./metrics');
const { createEventLog, summarize } = require('./events');
const { setupAway } = require('./away');

// Pasta de dados alternativa (útil para testar sem mexer na sua config real).
if (process.env.IDLEHUB_DATA) app.setPath('userData', process.env.IDLEHUB_DATA);

// Jogos precisam continuar rodando mesmo com a janela escondida/minimizada.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const APP_ID = 'com.idlehub.app';
// Em dev (npm start) não define o ID: assim a barra de tarefas usa o ícone da janela.
if (app.isPackaged) app.setAppUserModelId(APP_ID);
// User-agent de Chrome comum (alguns sites recusam o "Electron" no UA).
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/i, '')
  .replace(new RegExp(`\\s${escapeRe(app.getName())}\\/\\S+`, 'i'), '');

// Ícone: pixel art do IdleLive. .ico (vários tamanhos) para janela e bandeja; .png para notificações.
const ICON = path.join(__dirname, '../../build/icon.png');
const ICON_ICO = path.join(__dirname, '../../build/icon.ico');

// A interface abre por idlehub://app/… em vez de file://: assim ela pode buscar os ícones e a fonte
// que vêm junto com o app (o Chromium não deixa uma página file:// usar fetch). Só estas pastas são servidas.
const APP_ROOT = path.join(__dirname, '..', '..');
const UI_ALLOWED = [
  'src/renderer/',
  'node_modules/@awesome.me/webawesome/dist-cdn/',
  'node_modules/@fortawesome/fontawesome-free/svgs/',
  'node_modules/@fontsource/montserrat/',
];
protocol.registerSchemesAsPrivileged([{ scheme: 'idlehub', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function serveUi() {
  protocol.handle('idlehub', (req) => {
    const rel = path.posix.normalize(decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, ''));
    if (rel.startsWith('..') || !UI_ALLOWED.some((p) => rel.startsWith(p))) return new Response('Não encontrado', { status: 404 });
    return net.fetch(pathToFileURL(path.join(APP_ROOT, rel)).toString());
  });
}

let cfg;
let win = null;
let tray = null;
let mgr = null;
let idlelive = null;
let panel = null;
let remote = null;
const tracker = new MetricsTracker(); // histórico de CPU e memória (metrics.js)
let events = null;
let away = null;
let quitting = false;
let trayHintShown = false;
let emitQueued = false;

const saveConfig = () => config.save(cfg);

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// phone=false: avisos só do app (ex.: "continua rodando") não vão para o Discord e afins.
function notify(title, body, key, { phone = true } = {}) {
  if (phone) remote?.sendAll({ title, body }); // não espera e não lança; vale mesmo com notifyWindows desligado
  if (!cfg.settings.notifyWindows || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON });
  n.on('click', () => {
    showWindow();
    if (key) win.webContents.send('focus-account', key);
  });
  n.show();
}

// Atalhos de teclado: a interface decide o que fazer (ela sabe a ordem das contas e qual está aberta).
function sendShortcut(shortcut) {
  if (win && !win.isDestroyed()) win.webContents.send('shortcut', shortcut);
}

// Resumo do que aconteceu com as contas entre from e to (para o cartão "Enquanto você estava fora" e afins).
function summaryFor(from, to) {
  return summarize(events.all(), from, to, { accounts: mgr.accountStates() });
}

// A pessoa voltou depois de horas: manda o resumo para a interface (ela mostra quando a janela abrir).
function onBack({ from, to }) {
  if (win && !win.isDestroyed()) win.webContents.send('away-summary', summaryFor(from, to));
}

function emitState() {
  emitQueued = false;
  if (!win || win.isDestroyed()) return;
  const metrics = app.getAppMetrics();
  mgr.updateMetrics(metrics, tracker);
  const totalMem = Math.round(metrics.reduce((s, m) => s + (m.memory?.workingSetSize || 0), 0) / 1024);
  const snap = mgr.snapshot();
  win.webContents.send('state', { runtime: snap, totalMem, totalCpu: tracker.latest.app.cpu, idlelive: idlelive.snapshot() });
  updateTrayMenu();
  if (process.env.IDLEHUB_DEBUG) {
    const line = Object.entries(snap.accounts).map(([k, a]) => `${k.split(':')[1]}=${a.status}/${a.mem}MB`).join(' ');
    console.log(`[state] idlelive=${idlelive.status} total=${totalMem}MB ${line}`);
  }
}

function scheduleEmit() {
  if (emitQueued) return;
  emitQueued = true;
  setTimeout(emitState, 150);
}

function updateTrayMenu() {
  if (!tray) return;
  const snap = mgr.snapshot().accounts;
  const all = Object.values(snap);
  const running = all.filter((a) => a.live).length;
  tray.setToolTip(`IdleHub — ${running}/${all.length} contas rodando`);
}

function createTray() {
  const img = nativeImage.createFromPath(ICON_ICO);
  tray = new Tray(img);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir painel', click: showWindow },
      { type: 'separator' },
      { label: 'Acordar todas as contas', click: () => mgr.gameAction(null, 'wake-all') },
      { label: 'Dormir todas as contas', click: () => mgr.gameAction(null, 'sleep-all') },
      { type: 'separator' },
      { label: 'Sair', click: () => { quitting = true; app.quit(); } },
    ])
  );
  tray.on('click', showWindow);
  updateTrayMenu();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    icon: ICON_ICO,
    title: 'IdleHub',
    webPreferences: {
      preload: path.join(__dirname, '../preload/ui.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  attachShortcuts(win.webContents, sendShortcut); // F5 também não deve recarregar a página da interface
  win.loadURL('idlehub://app/src/renderer/index.html');
  if (process.env.IDLEHUB_DEBUG) {
    win.webContents.on('console-message', (e) => console.log(`[ui] ${e.level}: ${e.message} (${e.sourceId}:${e.lineNumber})`));
    // Teste: IDLEHUB_UI_EVAL roda um trecho na interface depois de abrir (ex.: clicar num botão antes do print).
    if (process.env.IDLEHUB_UI_EVAL) win.webContents.once('did-finish-load', () => setTimeout(() => win.webContents.executeJavaScript(process.env.IDLEHUB_UI_EVAL).catch((err) => console.log(`[ui-eval] ${err.message}`)), 3000));
  }
  win.once('ready-to-show', () => {
    if (!cfg.settings.startMinimized || !cfg.onboarded) win.show();
  });
  win.on('close', (e) => {
    if (!quitting && cfg.settings.closeToTray) {
      e.preventDefault();
      win.hide();
      if (!trayHintShown) {
        trayHintShown = true;
        notify('IdleHub continua rodando', 'As contas seguem ativas. Use o ícone perto do relógio para abrir ou sair.', undefined, { phone: false });
      }
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Teste visual: IDLEHUB_SCREENSHOT=arquivo.png salva um print da interface.
  if (process.env.IDLEHUB_SCREENSHOT) {
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      require('fs').writeFileSync(process.env.IDLEHUB_SCREENSHOT, img.toPNG());
      console.log('screenshot ok');
    }, Number(process.env.IDLEHUB_SCREENSHOT_DELAY || 5000));
  }
}

function registerIpc() {
  ipcMain.handle('state:get', () => ({
    config: cfg,
    presets: PRESETS,
    runtime: mgr.snapshot(),
    version: app.getVersion(),
    dataPath: app.getPath('userData'),
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    idlelive: idlelive.snapshot(),
  }));

  // A página do IdleLive vem com a chave "__panel"; o resto são contas dos jogos.
  ipcMain.on('layout:set', (_e, tiles) => {
    const list = Array.isArray(tiles) ? tiles : [];
    panel.setRect(list.find((t) => t.key === '__panel') || null);
    mgr.setLayout(list.filter((t) => t.key !== '__panel'));
  });

  // Histórico da última hora: só quando a janela Desempenho está aberta (não vai junto com cada "state").
  ipcMain.handle('metrics:history', () => tracker.history());

  ipcMain.handle('idlelive:action', async (_e, action) => {
    if (action === 'reload-page') panel.reload();
    if (action === 'open-browser') shell.openExternal(`http://localhost:${idlelive.snapshot().port}`);
    if (action === 'restart') await idlelive.restart();
    return idlelive.snapshot();
  });

  ipcMain.handle('idlelive:import', async () => {
    const pick = await dialog.showOpenDialog(win, {
      title: 'Escolha a pasta do IdleLive (onde fica o iniciar.bat)',
      properties: ['openDirectory'],
    });
    if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true };
    const confirm = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Importar', 'Cancelar'],
      defaultId: 0,
      cancelId: 1,
      title: 'Importar dados do IdleLive',
      message: 'Trazer as contas, canais e histórico do IdleLive para o IdleHub?',
      detail:
        'Feche antes a janela preta do IdleLive. Depois de importar, use só o IdleHub: as duas versões com as mesmas contas fazem a Twitch pedir para vincular de novo.\n\nSe o IdleHub já tiver dados do IdleLive, eles ficam guardados numa cópia.',
    });
    if (confirm.response !== 0) return { ok: false, canceled: true };
    const result = await idlelive.importFrom(pick.filePaths[0]);
    panel.reload();
    // O IdleLive avulso pode estar no início do Windows: ligando o PC, ele pegaria a porta 3000 antes do IdleHub.
    const link = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Painel de Lives.lnk');
    if (result.ok && require('fs').existsSync(link)) {
      const off = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Tirar e abrir o IdleHub com o Windows', 'Deixar como está'],
        defaultId: 0,
        cancelId: 1,
        title: 'IdleLive no início do Windows',
        message: 'O IdleLive avulso abre junto com o Windows.',
        detail: 'Assim ele ocuparia o lugar do painel do IdleHub toda vez que o PC ligar. Recomendo tirar ele do início do Windows e deixar o IdleHub abrir no lugar.',
      });
      if (off.response === 0) {
        require('fs').rmSync(link, { force: true });
        app.setLoginItemSettings({ openAtLogin: true });
        result.autostartMoved = true;
      }
    }
    return result;
  });
  ipcMain.handle('account:action', (_e, key, action) => mgr.action(String(key), String(action)));
  ipcMain.handle('game:action', (_e, gameId, action) => mgr.gameAction(gameId || null, String(action)));

  ipcMain.handle('config:onboard', (_e, selections) => {
    for (const sel of selections || []) {
      const p = PRESETS.find((x) => x.preset === sel.preset);
      if (!p) continue;
      cfg.games.push(sanitizeGame(gameFromPreset(p, { url: sel.url, accounts: Number(sel.accounts) || 1 })));
    }
    cfg.onboarded = true;
    saveConfig();
    mgr.sync();
    return cfg;
  });

  ipcMain.handle('game:save', (_e, raw) => {
    const game = sanitizeGame(raw);
    const idx = cfg.games.findIndex((g) => g.id === game.id);
    if (idx >= 0) {
      const removed = cfg.games[idx].accounts.filter((a) => !game.accounts.some((b) => b.id === a.id));
      cfg.games[idx] = game;
      removed.forEach((a) => mgr.forget(game.id, a.id));
    } else {
      cfg.games.push(game);
    }
    saveConfig();
    mgr.sync();
    return cfg;
  });

  ipcMain.handle('game:delete', (_e, id) => {
    const g = cfg.games.find((x) => x.id === id);
    if (!g) return cfg;
    cfg.games = cfg.games.filter((x) => x.id !== id);
    saveConfig();
    mgr.sync();
    g.accounts.forEach((a) => mgr.forget(g.id, a.id));
    return cfg;
  });

  ipcMain.handle('settings:save', (_e, s) => {
    const d = config.DEFAULT_SETTINGS;
    const num = (v, def, min, max) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
    };
    cfg.settings = {
      ...cfg.settings,
      watchdogIntervalSec: num(s.watchdogIntervalSec, d.watchdogIntervalSec, 10, 600),
      reloadAfterFailures: num(s.reloadAfterFailures, d.reloadAfterFailures, 1, 10),
      memoryLimitMB: num(s.memoryLimitMB, d.memoryLimitMB, 0, 16000),
      optimizeEveryHours: num(s.optimizeEveryHours, d.optimizeEveryHours, 0, 168),
      backgroundFps: num(s.backgroundFps, d.backgroundFps, 0, 144),
      mosaicFps: num(s.mosaicFps, d.mosaicFps, 0, 144),
      tileBaseWidth: num(s.tileBaseWidth, d.tileBaseWidth, 480, 3840),
      muteAll: !!s.muteAll,
      closeToTray: !!s.closeToTray,
      notifyWindows: !!s.notifyWindows,
      notifyDiscord: !!s.notifyDiscord,
      notifyTelegram: !!s.notifyTelegram,
      startMinimized: !!s.startMinimized,
      awaySummaryHours: num(s.awaySummaryHours, d.awaySummaryHours, 0, 72),
    };
    app.setLoginItemSettings({ openAtLogin: !!s.openAtLogin });
    saveConfig();
    mgr.startWatchdog();
    for (const rt of mgr.rt.values()) {
      rt.fps = undefined;
      rt.muted = undefined;
    }
    mgr.applyLayout();
    return cfg;
  });

  // Avisos fora do PC. O link/token nunca volta para a interface: ela só fica sabendo se está configurado.
  ipcMain.handle('remote:status', () => remote.status());
  ipcMain.handle('remote:set', async (_e, id, value) => {
    const r = await remote.connect(String(id), String(value ?? ''));
    if (!r.ok) return r;
    // Salvou o link: já liga o canal (o interruptor fica em config.json; só o link é segredo).
    cfg.settings[remote.channelOf(String(id)).settingKey] = true;
    saveConfig();
    return { ok: true, settings: cfg.settings, status: remote.status() };
  });
  ipcMain.handle('remote:clear', (_e, id) => {
    const r = remote.clear(String(id));
    if (!r.ok) return r;
    cfg.settings[remote.channelOf(String(id)).settingKey] = false;
    saveConfig();
    return { ok: true, settings: cfg.settings, status: remote.status() };
  });
  // Achou a conversa do Telegram (agora ou durante o teste): já liga o canal, como ao salvar o token.
  const withStatus = async (id, run) => {
    const key = String(id);
    const before = !!remote.status().channels[key]?.detail?.chat;
    const r = await run(key);
    const status = remote.status();
    const ch = remote.channelOf(key);
    if (ch && !before && status.channels[key]?.detail?.chat) {
      cfg.settings[ch.settingKey] = true;
      saveConfig();
    }
    return { ...r, settings: cfg.settings, status };
  };
  ipcMain.handle('remote:test', (_e, id) => withStatus(id, (k) => remote.test(k)));
  // Telegram: acha a conversa depois que a pessoa mandou /start para o bot.
  ipcMain.handle('remote:find', (_e, id) => withStatus(id, (k) => remote.findChat(k)));

  ipcMain.handle('events:summary', (_e, from, to) => {
    const t = Date.now();
    const a = Number(from);
    const b = Number(to);
    return summaryFor(Number.isFinite(a) ? a : t - 24 * 3600 * 1000, Number.isFinite(b) ? b : t);
  });

  ipcMain.handle('open:data', () => shell.openPath(app.getPath('userData')));
}

function checkUpdates() {
  // Só existe quando o "publish" (GitHub Releases) estiver configurado no package.json.
  if (!app.isPackaged || !require('fs').existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.on('error', () => {});
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 6 * 60 * 60 * 1000);
  } catch {}
}

// "LoL Idle" virou "LoLdle", o mesmo nome do Painel (IdleLive). Só troca se o nome não foi mudado à mão.
function migrateConfig() {
  let changed = false;
  for (const g of cfg.games) {
    if (g.preset === 'lolidle' && g.name === 'LoL Idle') {
      g.name = 'LoLdle';
      changed = true;
    }
    if (migrateSessionTaken(g)) changed = true;
    if (migrateReconnecting(g)) changed = true;
  }
  if (changed) saveConfig();
}

function start() {
  cfg = config.load();
  migrateConfig();
  serveUi();
  createWindow();
  remote = createRemote({ getSettings: () => cfg.settings });
  events = createEventLog({ dir: app.getPath('userData') });
  events.add({ type: 'app-start' });
  mgr = new AccountManager({ win, getConfig: () => cfg, saveConfig, notify, onChange: scheduleEmit, onShortcut: sendShortcut, events });
  idlelive = new IdleLive({ onChange: scheduleEmit, onReady: () => panel?.onServerReady() });
  panel = new PanelView({ win, idlelive, onShortcut: sendShortcut });
  registerIpc();
  idlelive.start();
  mgr.sync();
  mgr.startWatchdog();
  setupPower({ powerMonitor, mgr, net, events });
  away = setupAway({ powerMonitor, getHours: () => cfg.settings.awaySummaryHours, onBack });
  // Teste (com IDLEHUB_DEBUG): IDLEHUB_AWAY_DEMO=3 mostra o cartão como se a pessoa tivesse voltado após 3 h.
  if (process.env.IDLEHUB_DEBUG && process.env.IDLEHUB_AWAY_DEMO) {
    win.webContents.once('did-finish-load', () => setTimeout(() => onBack({ from: Date.now() - Number(process.env.IDLEHUB_AWAY_DEMO) * 3600 * 1000, to: Date.now() }), 3000));
  }
  createTray();
  setInterval(emitState, 3000);
  checkUpdates();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(start);
  app.on('before-quit', () => {
    quitting = true;
    away?.dispose();
    events?.add({ type: 'app-stop' });
    events?.close(); // grava o que faltava antes de fechar
    mgr?.shutdown();
    idlelive?.stop();
  });
  app.on('window-all-closed', () => app.quit());
}
