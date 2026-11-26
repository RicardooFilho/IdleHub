// Gerencia as contas: uma WebContentsView por conta, cada uma com sua própria
// sessão (cookies/login separados), mais o watchdog e os alertas.
const { WebContentsView, session } = require('electron');
const path = require('path');

const PROBE_TIMEOUT_MS = 15000;
const LOADING_GRACE_MS = 90000;
const MIN_RELOAD_GAP_MS = 60000;

const partitionFor = (gameId, accountId) => `persist:acc-${gameId}-${accountId}`;

// O Google recusa login em apps baseados em Chromium/Electron ("Esse navegador
// ou app pode não ser seguro"). Só nas páginas de login dele, o painel se
// apresenta como Firefox. Mesmo valor em src/preload/game.js.
const GOOGLE_LOGIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0';
const GOOGLE_LOGIN_URLS = ['https://accounts.google.com/*', 'https://accounts.youtube.com/*'];

function setupGoogleLogin(ses) {
  ses.webRequest.onBeforeSendHeaders({ urls: GOOGLE_LOGIN_URLS }, (details, cb) => {
    const h = details.requestHeaders;
    for (const k of Object.keys(h)) if (/^sec-ch-ua/i.test(k)) delete h[k];
    h['User-Agent'] = GOOGLE_LOGIN_UA;
    cb({ requestHeaders: h });
  });
}

// Roda DENTRO da página do jogo. Precisa ser autocontida.
function probeInPage(a) {
  const body = document.body;
  const text = body ? body.innerText || '' : '';
  const blank =
    !body || (text.trim().length === 0 && !document.querySelector('canvas,img,video,iframe,svg'));
  const low = text.toLowerCase();
  const href = location.href.toLowerCase();
  const loggedOut =
    a.lo.url.some((p) => p && href.includes(p.toLowerCase())) ||
    a.lo.text.some((p) => p && low.includes(p.toLowerCase()));

  const parseNum = (s) => {
    const m = String(s).match(/-?\d[\d.,\s]*\s*[kmbtKMBT]?/);
    if (!m) return null;
    let tok = m[0].trim();
    let mult = 1;
    const suf = tok.slice(-1).toLowerCase();
    if ('kmbt'.includes(suf)) {
      mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[suf];
      tok = tok.slice(0, -1).trim();
    }
    tok = tok.replace(/\s/g, '');
    const dots = (tok.match(/\./g) || []).length;
    const commas = (tok.match(/,/g) || []).length;
    if (dots && commas) {
      const dec = tok.lastIndexOf('.') > tok.lastIndexOf(',') ? '.' : ',';
      tok = tok.split(dec === '.' ? ',' : '.').join('').replace(',', '.');
    } else if (dots + commas > 0) {
      const sep = dots ? '.' : ',';
      const parts = tok.split(sep);
      const thousands = parts.length > 2 || (parts[1].length === 3 && mult === 1);
      tok = thousands ? parts.join('') : parts.join('.');
    }
    const n = parseFloat(tok);
    return Number.isFinite(n) ? n * mult : null;
  };

  const watchers = a.w.map((w) => {
    let src = text;
    if (w.selector) {
      let el = null;
      try {
        el = document.querySelector(w.selector);
      } catch {}
      if (!el) return { id: w.id, found: false };
      src = el.innerText || el.textContent || el.value || '';
    }
    if (w.kind === 'text') {
      const needle = (w.pattern || '').toLowerCase();
      if (!needle) return { id: w.id, found: false };
      return { id: w.id, found: true, value: src.toLowerCase().includes(needle) };
    }
    let s = src;
    if (w.pattern) {
      try {
        const m = src.match(new RegExp(w.pattern, 'i'));
        s = m ? (m[1] ?? m[0]) : null;
      } catch {
        s = null;
      }
    } else if (!w.selector) {
      return { id: w.id, found: false };
    }
    const v = s == null ? null : parseNum(s);
    return { id: w.id, found: v != null, value: v };
  });

  return { url: location.href, blank, loggedOut, watchers };
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

function fmtNum(v) {
  if (typeof v === 'boolean') return v ? 'sim' : 'não';
  if (typeof v !== 'number') return String(v);
  return v.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

class AccountManager {
  constructor({ win, getConfig, saveConfig, notify, onChange }) {
    this.win = win;
    this.getConfig = getConfig;
    this.saveConfig = saveConfig;
    this.notify = notify;
    this.onChange = onChange;
    this.rt = new Map(); // key -> runtime
    this.layout = [];
    this.logs = [];
    this.timer = null;
    this.ticking = false;
  }

  // ---------- helpers ----------
  find(key) {
    const [gid, aid] = key.split(':');
    const g = this.getConfig().games.find((x) => x.id === gid);
    const a = g?.accounts.find((x) => x.id === aid);
    return { g, a };
  }

  label(rt) {
    const { g, a } = this.find(rt.key);
    return g && a ? `${g.name} · ${a.name}` : rt.key;
  }

  log(rt, text, level = 'info') {
    this.logs.push({ t: Date.now(), key: rt?.key || null, who: rt ? this.label(rt) : 'Painel', text, level });
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
    rt && (rt.lastEvent = text);
    this.onChange();
  }

  alert(rt, text) {
    this.log(rt, text, 'alert');
    this.notify(this.label(rt), text, rt.key);
  }

  // ---------- ciclo de vida das views ----------
  sync() {
    const cfg = this.getConfig();
    const want = new Map();
    for (const g of cfg.games) for (const a of g.accounts) want.set(`${g.id}:${a.id}`, { g, a });

    for (const [key, rt] of this.rt) {
      if (!want.has(key)) {
        this.destroyView(rt);
        this.rt.delete(key);
      }
    }
    for (const [key, { g, a }] of want) {
      let rt = this.rt.get(key);
      if (!rt) {
        rt = {
          key, view: null, status: 'sleeping', fails: 0, blank: 0, mem: 0, reloads: 0,
          lastReload: 0, values: {}, trig: {}, baseUrl: null, zoom: null, fps: undefined,
          muted: undefined, visible: false, mode: 'hidden', loadStart: 0, loggedOutNotified: false,
          lastEvent: '', title: '',
        };
        this.rt.set(key, rt);
      }
      if (a.sleeping) {
        if (rt.view) this.destroyView(rt);
        rt.status = 'sleeping';
      } else if (!rt.view) {
        this.createView(rt, g);
      } else if (rt.baseUrl !== g.url) {
        rt.baseUrl = g.url;
        if (g.url) rt.view.webContents.loadURL(g.url).catch(() => {});
        else rt.status = 'no-url';
      }
    }
    this.applyLayout();
    this.onChange();
  }

  createView(rt, g) {
    const [gid, aid] = rt.key.split(':');
    const webPreferences = {
      partition: partitionFor(gid, aid),
      preload: path.join(__dirname, '../preload/game.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    };
    const view = new WebContentsView({ webPreferences });
    setupGoogleLogin(view.webContents.session);
    view.setBackgroundColor('#0f1117');
    view.setVisible(false);
    this.win.contentView.addChildView(view);
    rt.view = view;
    rt.visible = false;
    rt.zoom = null;
    rt.fps = undefined;
    rt.muted = undefined;
    rt.fails = 0;
    rt.blank = 0;
    rt.baseUrl = g.url;

    const wc = view.webContents;
    wc.setWindowOpenHandler(() => ({
      action: 'allow',
      // Pop-ups (ex.: login com Google) usam a mesma sessão e o mesmo preload da conta.
      overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences },
    }));
    wc.on('did-start-loading', () => {
      rt.status = 'loading';
      rt.loadStart = Date.now();
      this.onChange();
    });
    wc.on('did-stop-loading', () => {
      if (rt.status === 'loading') rt.status = 'ok';
      rt.fps = undefined;
      rt.zoom = null;
      this.applyLayout();
      this.onChange();
    });
    wc.on('page-title-updated', (_e, title) => {
      rt.title = title;
    });
    wc.on('did-fail-load', (_e, code, desc, _url, isMain) => {
      if (!isMain || code === -3) return; // -3 = navegação cancelada
      rt.status = 'offline';
      this.log(rt, `Falha ao carregar (${desc}). Tentando de novo em 20 s.`, 'warn');
      clearTimeout(rt.retryTimer);
      rt.retryTimer = setTimeout(() => {
        if (rt.view && rt.status === 'offline' && rt.baseUrl) rt.view.webContents.loadURL(rt.baseUrl).catch(() => {});
      }, 20000);
    });
    wc.on('render-process-gone', (_e, details) => {
      rt.status = 'crashed';
      this.log(rt, `A página caiu (${details.reason}).`, 'warn');
      setTimeout(() => this.reload(rt, 'a página tinha travado'), 3000);
    });
    wc.on('unresponsive', () => {
      rt.status = 'unresponsive';
      this.onChange();
    });
    wc.on('responsive', () => {
      if (rt.status === 'unresponsive') rt.status = 'ok';
      this.onChange();
    });

    if (g.url) {
      rt.status = 'loading';
      rt.loadStart = Date.now();
      wc.loadURL(g.url).catch(() => {});
    } else {
      rt.status = 'no-url';
    }
    this.applyLayout();
  }

  destroyView(rt) {
    clearTimeout(rt.retryTimer);
    if (!rt.view) return;
    const view = rt.view;
    rt.view = null;
    rt.visible = false;
    rt.mem = 0;
    try {
      this.win.contentView.removeChildView(view);
    } catch {}
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    } catch {}
  }

  // Conta removida de vez: também apaga o login salvo dela.
  async forget(gameId, accountId) {
    try {
      await session.fromPartition(partitionFor(gameId, accountId)).clearStorageData();
    } catch {}
  }

  // ---------- layout (posição das contas na janela) ----------
  setLayout(tiles) {
    this.layout = Array.isArray(tiles) ? tiles : [];
    this.applyLayout();
  }

  applyLayout() {
    const s = this.getConfig().settings;
    const vis = new Map(this.layout.map((t) => [t.key, t]));
    for (const rt of this.rt.values()) {
      if (!rt.view) continue;
      const wc = rt.view.webContents;
      if (wc.isDestroyed()) continue;
      const t = vis.get(rt.key);
      if (t) {
        rt.view.setBounds({
          x: Math.round(t.x),
          y: Math.round(t.y),
          width: Math.max(1, Math.round(t.w)),
          height: Math.max(1, Math.round(t.h)),
        });
        if (rt.zoom !== t.zoom) {
          rt.zoom = t.zoom;
          wc.setZoomFactor(t.zoom);
        }
        if (!rt.visible) {
          rt.view.setVisible(true);
          rt.visible = true;
        }
        rt.mode = t.focus ? 'focus' : 'mosaic';
      } else {
        if (rt.visible) {
          rt.view.setVisible(false);
          rt.visible = false;
        }
        rt.mode = 'hidden';
      }
      const fps = rt.mode === 'focus' ? 0 : rt.mode === 'mosaic' ? s.mosaicFps : s.backgroundFps;
      if (rt.fps !== fps) {
        rt.fps = fps;
        wc.executeJavaScript(`window.__idleHubSetFps && window.__idleHubSetFps(${Number(fps) || 0})`, true).catch(() => {});
      }
      const muted = s.muteAll || rt.mode !== 'focus';
      if (rt.muted !== muted) {
        rt.muted = muted;
        wc.setAudioMuted(muted);
      }
    }
  }

  // ---------- ações ----------
  setSleeping(key, sleeping) {
    const { a } = this.find(key);
    if (!a) return;
    a.sleeping = sleeping;
    this.saveConfig();
    this.sync();
  }

  action(key, act) {
    const rt = this.rt.get(key);
    if (!rt) return;
    const { g } = this.find(key);
    switch (act) {
      case 'sleep':
        return this.setSleeping(key, true);
      case 'wake':
        return this.setSleeping(key, false);
      case 'reload':
        rt.lastReload = 0;
        return this.reload(rt, null);
      case 'home':
        if (rt.view && g?.url) rt.view.webContents.loadURL(g.url).catch(() => {});
        return;
      case 'devtools':
        if (rt.view) rt.view.webContents.openDevTools({ mode: 'detach' });
        return;
    }
  }

  gameAction(gameId, act) {
    const cfg = this.getConfig();
    const games = gameId ? cfg.games.filter((g) => g.id === gameId) : cfg.games;
    for (const g of games) {
      for (const a of g.accounts) {
        const key = `${g.id}:${a.id}`;
        if (act === 'sleep-all') a.sleeping = true;
        else if (act === 'wake-all') a.sleeping = false;
        else if (act === 'reload-all') this.action(key, 'reload');
      }
    }
    if (act !== 'reload-all') {
      this.saveConfig();
      this.sync();
    }
  }

  reload(rt, reason) {
    const now = Date.now();
    if (now - rt.lastReload < MIN_RELOAD_GAP_MS) return;
    rt.lastReload = now;
    rt.fails = 0;
    rt.blank = 0;
    const { g, a } = this.find(rt.key);
    if (!g || !a || a.sleeping) return;
    if (reason) {
      rt.reloads++;
      this.alert(rt, `Recarreguei a conta: ${reason}.`);
    }
    const wc = rt.view?.webContents;
    if (!wc || wc.isDestroyed() || wc.isCrashed()) {
      this.destroyView(rt);
      this.createView(rt, g);
    } else if (g.url) {
      wc.loadURL(g.url).catch(() => {});
    }
  }

  // ---------- watchdog + alertas ----------
  startWatchdog() {
    clearInterval(this.timer);
    const sec = Math.max(10, Number(this.getConfig().settings.watchdogIntervalSec) || 30);
    this.timer = setInterval(() => this.tick(), sec * 1000);
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await Promise.all([...this.rt.values()].map((rt) => this.check(rt).catch(() => {})));
    } finally {
      this.ticking = false;
      this.onChange();
    }
  }

  async check(rt) {
    const { g, a } = this.find(rt.key);
    if (!g || !a || !rt.view || !g.url) return;
    const wc = rt.view.webContents;
    if (wc.isDestroyed()) return;
    const s = this.getConfig().settings;

    if (rt.status === 'loading') {
      if (Date.now() - rt.loadStart < LOADING_GRACE_MS) return;
      return this.reload(rt, 'ficou carregando por tempo demais');
    }
    if (rt.status === 'offline' || rt.status === 'crashed') return;

    const args = {
      lo: { url: g.loggedOut?.urlIncludes || [], text: g.loggedOut?.textIncludes || [] },
      w: (g.watchers || []).filter((w) => w.enabled),
    };
    let res = null;
    try {
      res = await withTimeout(wc.executeJavaScript(`(${probeInPage.toString()})(${JSON.stringify(args)})`, true), PROBE_TIMEOUT_MS);
    } catch {
      res = null;
    }
    if (!rt.view || rt.view.webContents !== wc) return; // conta dormiu/recriada no meio

    if (!res) {
      rt.fails++;
      rt.status = 'unresponsive';
      if (rt.fails >= (Number(s.reloadAfterFailures) || 2)) this.reload(rt, 'parou de responder');
      return;
    }
    rt.fails = 0;

    if (res.blank) {
      rt.blank++;
      if (rt.blank >= 2) return this.reload(rt, 'tela em branco');
    } else rt.blank = 0;

    if (res.loggedOut) {
      rt.status = 'logged-out';
      if (!rt.loggedOutNotified) {
        rt.loggedOutNotified = true;
        this.alert(rt, 'A conta saiu do login. Entre de novo nela.');
      }
    } else {
      rt.loggedOutNotified = false;
      rt.status = 'ok';
    }

    for (const w of args.w) {
      const r = res.watchers.find((x) => x.id === w.id);
      if (!r || !r.found) {
        rt.values[w.id] = null;
        rt.trig[w.id] = false;
        continue;
      }
      const v = r.value;
      const prev = rt.values[w.id];
      rt.values[w.id] = v;
      let hit = false;
      if (w.kind === 'text') hit = !!v;
      else {
        const n = Number(w.value);
        hit =
          w.op === '>=' ? v >= n :
          w.op === '<=' ? v <= n :
          w.op === '>' ? v > n :
          w.op === '<' ? v < n :
          w.op === '=' ? v === n :
          w.op === 'change' ? prev != null && v !== prev : false;
      }
      const was = !!rt.trig[w.id];
      rt.trig[w.id] = hit;
      if (hit && (!was || w.op === 'change')) {
        this.alert(rt, w.kind === 'text' ? `${w.name}` : `${w.name}: ${fmtNum(v)}`);
      }
    }

    const limit = Number(s.memoryLimitMB) || 0;
    if (limit > 0 && rt.mem > limit) this.reload(rt, `passou de ${limit} MB de memória (${rt.mem} MB)`);
  }

  updateMetrics(metrics) {
    const byPid = new Map(metrics.map((m) => [m.pid, m]));
    for (const rt of this.rt.values()) {
      const wc = rt.view?.webContents;
      if (!wc || wc.isDestroyed()) {
        rt.mem = 0;
        continue;
      }
      const m = byPid.get(wc.getOSProcessId());
      rt.mem = m ? Math.round(m.memory.workingSetSize / 1024) : 0;
    }
  }

  snapshot() {
    const accounts = {};
    for (const rt of this.rt.values()) {
      accounts[rt.key] = {
        status: rt.status,
        live: !!rt.view,
        mem: rt.mem,
        values: rt.values,
        trig: rt.trig,
        reloads: rt.reloads,
        lastEvent: rt.lastEvent,
        title: rt.title,
      };
    }
    return { accounts, log: this.logs.slice(-150) };
  }

  shutdown() {
    clearInterval(this.timer);
    for (const rt of this.rt.values()) this.destroyView(rt);
  }
}

// probeInPage sai também para os testes (test/probe.test.js).
module.exports = { AccountManager, probeInPage };
