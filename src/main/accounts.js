// Gerencia as contas: uma WebContentsView por conta, cada uma com sua própria
// sessão (cookies/login separados), mais o watchdog e os alertas.
const { WebContentsView, session } = require('electron');
const path = require('path');
const { attachShortcuts } = require('./shortcuts');
const { normalizeCpu } = require('./metrics');
const { isUserInput, isDangerousFile, shouldAllowPopup, shouldAllowDownload } = require('./guard');
const {
  CHALLENGE_NOTIFY_MS, backoffMs, recordFailure, tooManyFailures, reconnectingTooLong, classifyPage, checkInternet,
} = require('./recovery');
const { AUTO_GAP_MS, ALL_GAP_MS, sameSite, pickReturnUrl, staggerDelays, autoOptimizeReason } = require('./optimize');
const { WAKE_GAP_MS } = require('./groups');
const {
  RELOAD_GAP_MS, createConnection, noteHttp, noteSockets, restartDropWait, connectionState, silentAfterMs,
  shouldNotifySilence, countsAsActivity, fmtIdle,
} = require('./connection');
const { ISSUE_TYPES } = require('./events');
const { GAME_TAB, initialTabs, selectTab, closeTab, pruneTabs } = require('./subpages');
const { PICK_CODE, PICK_CANCEL_CODE } = require('./selector');

const PROBE_TIMEOUT_MS = 15000;
const LOADING_GRACE_MS = 90000;
const MIN_RELOAD_GAP_MS = 60000;
// Conta aberta em outro lugar: o watchdog fica longe dela por esse tempo, para
// não derrubar a outra sessão recarregando por cima.
const SESSION_TAKEN_PAUSE_MS = 10 * 60 * 1000;
const BLOCKED_LOG_GAP_MS = 60000; // aviso de janela bloqueada: no máximo 1 por minuto por conta

// Quem recebe o último clique/tecla de cada página (conta ou pop-up), para o
// controle de janelas e downloads. E as sessões que já escutam downloads.
const inputOf = new WeakMap();
const downloadGuarded = new WeakSet();
const connectionGuarded = new WeakSet(); // sessões que já escutam os pedidos do jogo (connection.js)

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
  const sessionTaken = (a.st || []).some((p) => p && low.includes(p.toLowerCase()));
  const reconnecting = (a.rc || []).some((p) => p && low.includes(p.toLowerCase()));

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

  // title e o começo do texto servem para reconhecer telas do Cloudflare e erros 52x (recovery.js).
  // Conexão do jogo (preload/game.js): só horários dos WebSockets, nada do conteúdo.
  let net = null;
  try {
    if (typeof window !== 'undefined' && typeof window.__idleHubNet === 'function') net = window.__idleHubNet();
  } catch {}

  return { url: location.href, blank, loggedOut, sessionTaken, reconnecting, watchers, title: document.title || '', head: text.slice(0, 1500), len: text.length, net };
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
  constructor({ win, getConfig, saveConfig, notify, onChange, onShortcut, events, extensions, userscripts }) {
    this.win = win;
    this.getConfig = getConfig;
    this.saveConfig = saveConfig;
    this.notify = notify;
    this.onChange = onChange;
    this.onShortcut = onShortcut || (() => {});
    this.events = events || { add() {} }; // registro de eventos (events.js): alimenta os resumos
    this.extensions = extensions || null; // extensões do Chrome por conta (extensions.js)
    this.userscripts = userscripts || null; // scripts de usuário por conta (userscript-store.js)
    this.rt = new Map(); // key -> runtime
    this.layout = [];
    this.logs = [];
    this.timer = null;
    this.ticking = false;
    this.internetDown = false; // um aviso só para o app inteiro, não um por conta
    this.nextOptimizeAt = 0; // otimização automática: uma por vez, com espaço entre elas
    this.nextConnReloadAt = 0; // recarga por conexão caída: uma por vez, com espaço entre elas
    this.optimizeTimers = new Set(); // fila do "Otimizar todas"
    this.wakeTimers = new Set(); // fila de contas acordando ao trocar de grupo ou perfil
    this.picking = null; // "Escolher na tela": { key, wc, finish } da conta em que a pessoa está clicando
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
    this.logs.push({ t: Date.now(), key: rt?.key || null, who: rt ? this.label(rt) : 'IdleHub', text, level });
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
    rt && (rt.lastEvent = text);
    this.onChange();
  }

  // Registro estruturado (events.js), ao lado do log de texto. Sem links nem texto de página: só o tipo e um detalhe curto.
  record(rt, type, detail) {
    const { g, a } = rt ? this.find(rt.key) : {};
    if (rt && ISSUE_TYPES.has(type)) rt.openIssue = true; // 'recovered' fecha quando a conta voltar a ficar ok
    this.events.add({ key: rt?.key || null, game: g?.name, who: a?.name, type, detail });
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
        if (rt.view) this.record(rt, 'live-stop');
        this.destroyView(rt);
        this.dropExtensions(key);
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
          pausedUntil: 0, sessionTakenNotified: false,
          lastEvent: '', title: '', failures: [], gaveUp: false, retryAttempt: 0, retryTimer: null,
          crashTimer: null, downNotified: false, challengeSince: 0, challengeNotified: false, reconnectingSince: 0,
          createdAt: 0, // quando o processo da conta nasceu (dormir/acordar e otimizar zeram)
          tabs: initialTabs(), // subpáginas (subpages.js): qual aba aparece e quais já foram abertas
          subs: new Map(), // id da subpágina -> { id, url, view, visible, zoom, muted, lastInputAt }
          net: createConnection(), conn: null, silentNotified: false, // conexão com o servidor do jogo (connection.js)
        };
        this.rt.set(key, rt);
      }
      if (a.sleeping) {
        if (rt.view) this.record(rt, 'live-stop');
        if (rt.view) {
          this.destroyView(rt);
          this.dropExtensions(key); // conta dormindo não gasta memória: nem as extensões dela ficam rodando
        }
        this.resetRecovery(rt); // dormir e acordar zera as quedas
        rt.status = 'sleeping';
      } else if (!rt.view) {
        this.createView(rt, g);
        this.record(rt, 'live-start');
      } else if (rt.baseUrl !== g.url) {
        rt.baseUrl = g.url;
        if (g.url) rt.view.webContents.loadURL(g.url).catch(() => {});
        else rt.status = 'no-url';
      }
      if (rt.view) this.syncSubs(rt, a);
    }
    this.applyLayout();
    this.onChange();
  }

  // `startUrl`: página em que a conta abre (ao otimizar, a que ela estava). Sem ela, o link do jogo.
  createView(rt, g, startUrl) {
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
    rt.createdAt = Date.now();
    rt.challengeSince = 0;
    rt.challengeNotified = false;
    this.resetConnection(rt);

    const wc = view.webContents;
    attachShortcuts(wc, (s) => this.onShortcut({ ...s, from: rt.key })); // o foco dentro do jogo não chega na interface
    this.guardWindows(rt, wc, rt, webPreferences);
    this.guardDownloads(wc.session, rt.key);
    this.guardConnection(wc.session, rt.key);
    // Página nova = conexões novas: a contagem recomeça (a recarga não pode herdar a "queda" da página anterior).
    wc.on('did-start-navigation', (details) => {
      if (details?.isMainFrame && !details.isSameDocument) this.resetConnection(rt);
    });
    wc.on('did-start-loading', () => {
      if (this.picking?.wc === wc) this.cancelPick('reload'); // a página nova não tem mais o modo de escolha
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
      // Conta pausada (aberta em outro lugar): só tenta de novo quando a pausa acabar.
      if (rt.pausedUntil > Date.now()) {
        rt.status = 'server-down'; // fora do "ok" até lá; o check() não mexe em conta pausada
        this.log(rt, `Falha ao carregar (${desc}). A conta está pausada: tento de novo quando a pausa acabar.`, 'warn');
        clearTimeout(rt.retryTimer);
        rt.retryTimer = setTimeout(() => {
          rt.retryTimer = null;
          this.loadFailed(rt);
        }, rt.pausedUntil - Date.now());
        return;
      }
      this.loadFailed(rt);
    });
    wc.on('render-process-gone', (_e, details) => {
      rt.status = 'crashed';
      this.record(rt, 'crash', details.reason);
      // Conta pausada (aberta em outro lugar): só recarrega depois da pausa.
      const wait = Math.max(3000, rt.pausedUntil - Date.now());
      this.log(rt, wait > 3000 ? `A página caiu (${details.reason}). A conta está pausada: recarrego quando a pausa acabar.` : `A página caiu (${details.reason}).`, 'warn');
      clearTimeout(rt.crashTimer);
      rt.crashTimer = setTimeout(() => this.autoReload(rt, 'a página tinha travado'), wait);
    });
    wc.on('unresponsive', () => {
      rt.status = 'unresponsive';
      this.onChange();
    });
    wc.on('responsive', () => {
      if (rt.status === 'unresponsive') rt.status = 'ok';
      this.onChange();
    });

    const start = () => {
      if (rt.view !== view || wc.isDestroyed()) return; // dormiu ou foi removida enquanto as extensões carregavam
      if (g.url) {
        rt.status = 'loading';
        rt.loadStart = Date.now();
        wc.loadURL(startUrl || g.url).catch(() => {});
      } else {
        rt.status = 'no-url';
      }
      this.applyLayout();
    };
    // Extensões só valem na próxima página: carregam na sessão ANTES da primeira navegação. Conta sem extensão
    // não espera nada (caminho de sempre).
    if (this.hasExtensions(rt.key, wc.session)) {
      if (g.url) rt.status = 'loading';
      rt.loadStart = Date.now();
      this.syncExtensions(rt, wc.session).then(start, start);
    } else {
      start();
    }
    this.applyLayout();
  }

  dropExtensions(key) {
    if (!this.extensions) return;
    try {
      const [gid, aid] = key.split(':');
      const ses = session.fromPartition(partitionFor(gid, aid));
      for (const x of ses.extensions.getAllExtensions()) ses.extensions.removeExtension(x.id);
    } catch {}
  }

  hasExtensions(key, ses) {
    return !!this.extensions && (this.extensions.forAccount(key).loads.length > 0 || ses.extensions.getAllExtensions().length > 0);
  }

  // Deixa na sessão da conta só as extensões ligadas para ela (carrega as novas, troca as que mudaram de
  // versão e descarrega as desligadas). Só o IdleHub põe extensões nessas sessões.
  async syncExtensions(rt, ses) {
    const { loads, problems } = this.extensions.forAccount(rt.key);
    const want = new Map(loads.map((x) => [x.id, x]));
    for (const p of problems) this.log(rt, `Não carreguei a extensão ${p.name}: os arquivos dela foram alterados depois de instalada. Reinstale pela tela Extensões.`, 'warn');
    for (const cur of ses.extensions.getAllExtensions()) {
      const x = want.get(cur.id);
      if (!x || path.resolve(cur.path) !== path.resolve(x.dir)) ses.extensions.removeExtension(cur.id);
    }
    for (const x of loads) {
      if (ses.extensions.getExtension(x.id)) continue;
      try {
        await ses.extensions.loadExtension(x.dir, { allowFileAccess: false });
      } catch (e) {
        this.log(rt, `Não consegui carregar a extensão ${x.name}: ${e.message}`, 'warn');
      }
    }
  }

  // Ligou ou desligou extensões numas contas: ajusta a sessão e recarrega só essas contas (a página
  // precisa ser recarregada para a extensão entrar ou sair). Conta dormindo pega na próxima vez que acordar.
  async applyExtensions(keys) {
    for (const key of keys) {
      const rt = this.rt.get(key);
      if (!rt?.view) continue;
      try {
        await this.syncExtensions(rt, rt.view.webContents.session);
      } catch {}
      if (this.rt.get(key)?.view) this.action(key, 'reload');
    }
  }

  // Qual conta é dona desta página (o jogo ou uma subpágina)? null para pop-ups e qualquer outra janela.
  keyOfWebContents(wc) {
    for (const rt of this.rt.values()) {
      if (rt.view?.webContents === wc) return rt.key;
      for (const sub of rt.subs.values()) if (sub.view.webContents === wc) return rt.key;
    }
    return null;
  }

  // Ligou ou desligou scripts de usuário numas contas: recarrega só essas (o script entra ou sai na página nova).
  applyUserscripts(keys) {
    for (const key of keys) {
      this.userscripts?.stop(key);
      if (this.rt.get(key)?.view) this.action(key, 'reload');
    }
  }

  // Só abre janela nova o que a pessoa clicou (anúncios que abrem sozinhos são
  // barrados). Vale também dentro dos pop-ups que foram permitidos. `owner`
  // guarda o último clique da página (a própria conta ou o pop-up).
  guardWindows(rt, wc, owner, webPreferences) {
    inputOf.set(wc, owner);
    wc.on('input-event', (_e, input) => {
      if (isUserInput(input)) owner.lastInputAt = Date.now();
    });
    wc.setWindowOpenHandler(({ url }) => {
      const now = Date.now();
      if (shouldAllowPopup({ url, now, lastInputAt: owner.lastInputAt })) {
        return {
          action: 'allow',
          // Pop-ups (ex.: login com Google) usam a mesma sessão e o mesmo preload da conta.
          overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences },
        };
      }
      if (!rt.blockedLogAt || now - rt.blockedLogAt >= BLOCKED_LOG_GAP_MS) {
        rt.blockedLogAt = now;
        this.log(rt, 'Bloqueei uma janela que o jogo tentou abrir sozinho (provável anúncio).', 'info');
      }
      return { action: 'deny' };
    });
    wc.on('did-create-window', (win) => {
      // O pop-up nasce de um clique; herda o último para o que ele abrir logo em seguida.
      this.guardWindows(rt, win.webContents, { lastInputAt: owner.lastInputAt }, webPreferences);
    });
  }

  // Downloads só com clique; programas (.exe e parecidos) nunca. Uma vez por
  // sessão: a sessão da conta é a mesma quando ela dorme e acorda.
  guardDownloads(ses, key) {
    if (downloadGuarded.has(ses)) return;
    downloadGuarded.add(ses);
    ses.on('will-download', (e, item, wc) => {
      const rt = this.rt.get(key);
      const filename = item.getFilename();
      const lastInputAt = Math.max(rt?.lastInputAt || 0, inputOf.get(wc)?.lastInputAt || 0);
      if (shouldAllowDownload({ filename, now: Date.now(), lastInputAt })) return; // segue o padrão: janela de "salvar como"
      e.preventDefault();
      item.cancel();
      if (!rt) return;
      if (isDangerousFile(filename)) {
        this.alert(rt, `Bloqueei o download de um programa (${filename}). O IdleHub nunca baixa programas dentro dos jogos.`);
      } else {
        this.log(rt, `Bloqueei um download que o jogo tentou fazer sozinho (${filename}).`, 'info');
      }
    });
  }

  resetConnection(rt) {
    rt.net = createConnection();
    rt.conn = null;
    rt.silentNotified = false;
  }

  // Anota (só o horário) cada resposta de pedido XHR/fetch do site do jogo. Fica na sessão da conta,
  // que é a mesma quando ela dorme e acorda. Não lê o endereço nem o conteúdo: só compara o site.
  guardConnection(ses, key) {
    if (connectionGuarded.has(ses)) return;
    connectionGuarded.add(ses);
    ses.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, (d) => {
      if (!countsAsActivity(d)) return;
      const rt = this.rt.get(key);
      if (!rt?.view) return;
      try {
        if (d.webContentsId !== rt.view.webContents.id || !sameSite(d.url, rt.baseUrl)) return;
      } catch {
        return;
      }
      noteHttp(rt.net, Date.now());
    });
  }

  destroyView(rt) {
    if (this.picking?.key === rt.key) this.cancelPick('closed');
    clearTimeout(rt.retryTimer);
    clearTimeout(rt.crashTimer);
    rt.retryTimer = rt.crashTimer = null;
    this.destroySubs(rt); // dormir, otimizar e fechar a conta também fecham as subpáginas
    this.userscripts?.stop(rt.key); // e cancelam os pedidos de rede dos scripts de usuário
    if (!rt.view) return;
    const view = rt.view;
    rt.view = null;
    rt.visible = false;
    rt.mem = 0;
    rt.createdAt = 0;
    rt.pausedUntil = 0;
    rt.sessionTakenNotified = false;
    rt.reconnectingSince = 0;
    this.resetConnection(rt);
    try {
      this.win.contentView.removeChildView(view);
    } catch {}
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    } catch {}
  }

  // ---------- subpáginas ----------
  // Cada subpágina é uma view própria na MESMA sessão da conta (mesmo login), criada só no primeiro
  // clique. Fica por cima do jogo, no mesmo espaço: o jogo continua desenhado e rodando por baixo
  // (nada de esconder ou parar), então o tempo dele não muda.
  createSub(rt, cfg) {
    const [gid, aid] = rt.key.split(':');
    const webPreferences = {
      partition: partitionFor(gid, aid),
      // Mesmo preload do jogo: dá o login do Google e o login sem chave de acesso. O limitador de FPS
      // só age se alguém o ligar, e nada disso expõe algo para a página.
      preload: path.join(__dirname, '../preload/game.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    };
    const view = new WebContentsView({ webPreferences });
    view.setBackgroundColor('#0f1117');
    view.setVisible(false);
    this.win.contentView.addChildView(view);
    const sub = { id: cfg.id, url: cfg.url, view, visible: false, zoom: null, muted: undefined, lastInputAt: 0 };
    rt.subs.set(cfg.id, sub);

    const wc = view.webContents;
    attachShortcuts(wc, (s) => this.onShortcut({ ...s, from: rt.key }));
    this.guardWindows(rt, wc, sub, webPreferences);
    this.guardDownloads(wc.session, rt.key);
    wc.on('did-stop-loading', () => {
      sub.zoom = null;
      this.applyLayout();
    });
    wc.on('render-process-gone', () => {
      this.destroySub(rt, cfg.id); // subpágina que travou fecha; o jogo segue
      this.applyLayout();
      this.onChange();
    });
    wc.loadURL(cfg.url).catch(() => {});
  }

  destroySub(rt, id) {
    const sub = rt.subs.get(id);
    rt.subs.delete(id);
    rt.tabs = closeTab(rt.tabs, id);
    if (!sub) return;
    try {
      this.win.contentView.removeChildView(sub.view);
    } catch {}
    try {
      if (!sub.view.webContents.isDestroyed()) sub.view.webContents.close();
    } catch {}
  }

  destroySubs(rt) {
    for (const id of [...rt.subs.keys()]) this.destroySub(rt, id);
    rt.tabs = initialTabs();
  }

  // Subpáginas tiradas da conta, ou com o link trocado, fecham.
  syncSubs(rt, a) {
    const list = a.subpages || [];
    for (const [id, sub] of rt.subs) {
      const cfg = list.find((s) => s.id === id);
      if (!cfg || cfg.url !== sub.url) this.destroySub(rt, id);
    }
    rt.tabs = pruneTabs(rt.tabs, list);
  }

  tabState(rt) {
    return { tab: rt.tabs.active, openTabs: rt.tabs.open };
  }

  // Aba do jogo ou de uma subpágina (cria a view na primeira vez). Devolve o estado das abas.
  selectTab(key, id) {
    const rt = this.rt.get(key);
    const { a } = this.find(key);
    if (!rt?.view || !a) return null;
    const list = a.subpages || [];
    rt.tabs = selectTab(rt.tabs, id, list);
    const cfg = rt.tabs.active === GAME_TAB ? null : list.find((s) => s.id === rt.tabs.active);
    if (cfg && !rt.subs.has(cfg.id)) this.createSub(rt, cfg);
    this.applyLayout();
    this.onChange();
    return this.tabState(rt);
  }

  // Fecha a view da subpágina (devolve a memória); a aba continua lá e abre de novo no próximo clique.
  closeSub(key, id) {
    const rt = this.rt.get(key);
    if (!rt) return null;
    this.destroySub(rt, id);
    this.applyLayout();
    this.onChange();
    return this.tabState(rt);
  }

  reloadSub(key, id) {
    const wc = this.rt.get(key)?.subs.get(id)?.view.webContents;
    if (wc && !wc.isDestroyed()) wc.reload();
  }

  // ---------- escolher na tela (criar alerta clicando no valor) ----------
  // Liga o modo de escolha na página da conta e espera o clique. Resolve com
  // { ok: true, selector, fragile, text, number } | { ok: false, cancelled?, error? }.
  // O código roda na página só enquanto a pessoa escolhe e se remove sozinho (selector.js).
  pick(key) {
    const rt = this.rt.get(key);
    const wc = rt?.view?.webContents;
    if (!wc || wc.isDestroyed()) return Promise.resolve({ ok: false, error: 'closed' });
    if (rt.tabs && rt.tabs.active !== GAME_TAB) this.selectTab(key, GAME_TAB); // uma subpágina na frente cobriria o jogo
    this.cancelPick('replaced');
    return new Promise((resolve) => {
      const p = { key, wc, finish: resolve };
      this.picking = p;
      wc.executeJavaScript(PICK_CODE, true).then(
        async (res) => {
          if (this.picking !== p) return; // cancelada: quem cancelou já respondeu
          this.picking = null;
          if (!res || res.cancelled) return resolve({ ok: false, cancelled: true });
          if (!res.ok || typeof res.selector !== 'string' || !res.selector) return resolve({ ok: false, error: 'no-selector' });
          const text = String(res.text || '').slice(0, 80);
          resolve({ ok: true, selector: res.selector.slice(0, 300), fragile: !!res.fragile, text, number: await this.readNumber(wc, res.selector) });
        },
        () => {
          if (this.picking !== p) return;
          this.picking = null;
          resolve({ ok: false, cancelled: true });
        }
      );
    });
  }

  cancelPick(reason = 'cancelled') {
    const p = this.picking;
    if (!p) return;
    this.picking = null;
    try {
      if (!p.wc.isDestroyed()) p.wc.executeJavaScript(PICK_CANCEL_CODE, true).catch(() => {});
    } catch {}
    p.finish({ ok: false, cancelled: true, reason });
  }

  // O número que o alerta leria agora nesse seletor: o mesmo código do watchdog, para a prévia bater com o alerta.
  async readNumber(wc, selector) {
    try {
      const args = { lo: { url: [], text: [] }, st: [], rc: [], w: [{ id: 'pick', kind: 'number', selector, pattern: '' }] };
      const res = await withTimeout(wc.executeJavaScript(`(${probeInPage.toString()})(${JSON.stringify(args)})`, true), PROBE_TIMEOUT_MS);
      const r = res?.watchers?.[0];
      return r?.found && typeof r.value === 'number' ? r.value : null;
    } catch {
      return null;
    }
  }

  // ---------- login do cofre (loginfill.js) ----------
  // A página que a pessoa está vendo agora (o jogo ou a subpágina da frente), para o "Preencher login".
  frontPage(key) {
    const rt = this.rt.get(key);
    if (!rt?.view) return null;
    const front = rt.tabs.active !== GAME_TAB ? rt.subs.get(rt.tabs.active) : null;
    const wc = (front?.view || rt.view).webContents;
    if (wc.isDestroyed()) return null;
    return { wc, url: wc.getURL(), gameUrl: this.find(key).g?.url || '' };
  }

  // Só o fato (sem usuário, senha ou endereço) fica na Atividade.
  loginFilled(key) {
    const rt = this.rt.get(key);
    if (rt) this.log(rt, 'Preenchi o login do cofre (você pediu). Nada foi enviado.');
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
      const fps = rt.mode === 'focus' ? s.focusFps : rt.mode === 'mosaic' ? s.mosaicFps : s.backgroundFps;
      if (rt.fps !== fps) {
        rt.fps = fps;
        wc.executeJavaScript(`window.__idleHubSetFps && window.__idleHubSetFps(${Number(fps) || 0})`, true).catch(() => {});
      }
      // Subpágina na frente: só ela toca. O jogo segue rodando por baixo, no mesmo lugar.
      const front = t && rt.tabs.active !== GAME_TAB ? rt.subs.get(rt.tabs.active) : null;
      const muted = s.muteAll || rt.mode !== 'focus' || !!front;
      if (rt.muted !== muted) {
        rt.muted = muted;
        wc.setAudioMuted(muted);
      }
      for (const sub of rt.subs.values()) this.layoutSub(rt, sub, sub === front ? t : null, s);
    }
  }

  // `t`: o espaço da conta, se esta subpágina é a que aparece; senão fica escondida (continua carregada).
  layoutSub(rt, sub, t, s) {
    const wc = sub.view.webContents;
    if (wc.isDestroyed()) return;
    if (t) {
      sub.view.setBounds({ x: Math.round(t.x), y: Math.round(t.y), width: Math.max(1, Math.round(t.w)), height: Math.max(1, Math.round(t.h)) });
      if (sub.zoom !== t.zoom) {
        sub.zoom = t.zoom;
        wc.setZoomFactor(t.zoom);
      }
      if (!sub.visible) {
        this.win.contentView.addChildView(sub.view); // de novo = vai para o topo, acima do jogo
        sub.view.setVisible(true);
        sub.visible = true;
      }
    } else if (sub.visible) {
      sub.view.setVisible(false);
      sub.visible = false;
    }
    const muted = !t || s.muteAll || rt.mode !== 'focus';
    if (sub.muted !== muted) {
      sub.muted = muted;
      wc.setAudioMuted(muted);
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

  // Grupo ou perfil: as contas de `sleep` dormem já (libera memória) e as de `wake` acordam uma por vez,
  // com espaço entre elas, para o PC não carregar tudo junto. Uma troca nova cancela a fila da anterior.
  applyArrangement({ wake, sleep }, label) {
    this.cancelWakeQueue();
    for (const key of sleep) {
      const { a } = this.find(key);
      if (a) a.sleeping = true;
    }
    this.log(null, `${label}: ${wake.length} acordando, ${sleep.length} dormindo`);
    this.saveConfig();
    this.sync();
    staggerDelays(wake.length, WAKE_GAP_MS).forEach((delay, i) => {
      const timer = setTimeout(() => {
        this.wakeTimers.delete(timer);
        this.setSleeping(wake[i], false);
      }, delay);
      this.wakeTimers.add(timer);
    });
  }

  cancelWakeQueue() {
    for (const t of this.wakeTimers) clearTimeout(t);
    this.wakeTimers.clear();
  }

  // Chaves das contas dormindo: a interface compara com o que ela tem e se atualiza (a bandeja também acorda e dorme).
  sleepingKeys() {
    return this.getConfig().games.flatMap((g) => g.accounts.filter((a) => a.sleeping).map((a) => `${g.id}:${a.id}`));
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
        this.resetRecovery(rt); // recarregar à mão zera as quedas
        return this.reload(rt, null);
      case 'optimize':
        this.resetRecovery(rt); // otimizar à mão é escolha da pessoa, como recarregar
        return this.optimize(rt, 'a pedido seu');
      case 'home':
        this.resetRecovery(rt);
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
    const optimizeKeys = [];
    for (const g of games) {
      for (const a of g.accounts) {
        const key = `${g.id}:${a.id}`;
        if (act === 'sleep-all') a.sleeping = true;
        else if (act === 'wake-all') a.sleeping = false;
        else if (act === 'reload-all') this.action(key, 'reload');
        else if (act === 'optimize-all' && !a.sleeping && this.rt.get(key)?.view) optimizeKeys.push(key);
      }
    }
    if (act === 'optimize-all') this.optimizeAll(optimizeKeys);
    else if (act !== 'reload-all') {
      this.saveConfig();
      this.sync();
    }
  }

  // Otimiza uma conta por vez, com espaço entre elas, para o PC não travar.
  optimizeAll(keys) {
    staggerDelays(keys.length, ALL_GAP_MS).forEach((delay, i) => {
      const timer = setTimeout(() => {
        this.optimizeTimers.delete(timer);
        const rt = this.rt.get(keys[i]);
        if (!rt?.view) return; // dormiu ou foi removida enquanto esperava
        this.resetRecovery(rt);
        this.optimize(rt, 'a pedido seu');
      }, delay);
      this.optimizeTimers.add(timer);
    });
  }

  // Fecha a conta e abre de novo num processo novo (a sessão guarda o login) e volta
  // na página em que ela estava. Devolve mais memória que recarregar, porque o
  // processo antigo some de vez. Não conta como queda e não passa pelo intervalo
  // mínimo de recarga.
  optimize(rt, reason) {
    const { g, a } = this.find(rt.key);
    if (!g?.url || !a || a.sleeping || !rt.view) return;
    const wc = rt.view.webContents;
    let current = '';
    try {
      if (!wc.isDestroyed()) current = wc.getURL();
    } catch {}
    const url = pickReturnUrl(current, g.url, g.loggedOut?.urlIncludes);
    const before = rt.mem;
    const pidBefore = process.env.IDLEHUB_DEBUG && !wc.isDestroyed() ? wc.getOSProcessId() : 0;
    this.destroyView(rt);
    this.createView(rt, g, url);
    if (process.env.IDLEHUB_DEBUG) {
      rt.view.webContents.once('did-stop-loading', () =>
        console.log(`[optimize] ${rt.key}: processo ${pidBefore} -> ${rt.view?.webContents.getOSProcessId()}`));
    }
    this.log(rt, `Otimizei a conta (${reason}): reabri num processo novo${before ? ` (estava com ${before} MB)` : ''}.`);
  }

  // Otimização do watchdog: confere a internet antes (reabrir sem rede só mostra erro).
  async autoOptimize(rt, reason) {
    const view = rt.view;
    if (!(await this.internetUp()) || rt.view !== view) return;
    this.optimize(rt, reason);
  }

  reload(rt, reason) {
    const now = Date.now();
    if (now - rt.lastReload < MIN_RELOAD_GAP_MS) return;
    if (reason && this.countFailure(rt, now)) return; // recarga automática: passou do limite de quedas
    rt.lastReload = now;
    rt.fails = 0;
    rt.blank = 0;
    const { g, a } = this.find(rt.key);
    if (!g || !a || a.sleeping) return;
    if (reason) {
      rt.reloads++;
      this.record(rt, 'reload', reason);
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

  // Contas ligadas (com página). Contas dormindo ficam de fora.
  liveKeys() {
    return [...this.rt.values()].filter((rt) => rt.view).map((rt) => rt.key);
  }

  // Volta da suspensão (power.js): ignora o intervalo mínimo e não conta como queda
  // nem manda notificação, só entra na Atividade.
  reloadForResume(key, reason) {
    const rt = this.rt.get(key);
    const { g, a } = this.find(key);
    if (!rt || !g || !a || a.sleeping) return;
    if (rt.pausedUntil > Date.now()) return; // aberta em outro lugar: não derruba a outra sessão
    rt.lastReload = 0;
    this.reload(rt, null);
    this.log(rt, `Recarreguei a conta: ${reason}.`);
  }

  // ---------- recuperação (sem loops; regras em recovery.js) ----------
  resetRecovery(rt) {
    clearTimeout(rt.retryTimer);
    rt.retryTimer = null;
    rt.failures = [];
    rt.gaveUp = false;
    rt.retryAttempt = 0;
    rt.downNotified = false;
    rt.challengeSince = 0;
    rt.challengeNotified = false;
    rt.reconnectingSince = 0;
    rt.pausedUntil = 0; // recarregar à mão é escolha da pessoa: tira a pausa de "aberta em outro lugar"
    rt.sessionTakenNotified = false;
  }

  // Conta mais uma queda. Devolve true (e desiste) se passou do limite.
  countFailure(rt, now) {
    rt.failures = recordFailure(rt.failures, now);
    if (!tooManyFailures(rt.failures, now)) return false;
    clearTimeout(rt.retryTimer);
    rt.retryTimer = null;
    rt.status = 'attention';
    if (!rt.gaveUp) {
      rt.gaveUp = true;
      this.record(rt, 'gave-up');
      this.alert(rt, 'Esta conta caiu várias vezes seguidas e parei de recarregar. Precisa da sua atenção.');
    }
    return true;
  }

  // Toda recarga automática passa por aqui: sem internet não adianta recarregar.
  async autoReload(rt, reason) {
    if (rt.gaveUp) {
      rt.status = 'attention';
      return;
    }
    const view = rt.view;
    const up = await this.internetUp();
    if (rt.view !== view) return; // conta dormiu ou foi recriada no meio
    if (!up) {
      rt.status = 'no-internet';
      return this.onChange();
    }
    this.reload(rt, reason);
  }

  // Testa a internet e avisa UMA vez (para o app todo) quando cai e quando volta.
  async internetUp() {
    const up = await checkInternet();
    if (!up && !this.internetDown) {
      this.internetDown = true;
      const text = 'A internet do PC caiu. As contas voltam sozinhas quando ela voltar.';
      this.record(null, 'offline');
      this.log(null, text, 'alert');
      this.notify('IdleHub', text);
    } else if (up && this.internetDown) {
      this.internetDown = false;
      this.record(null, 'online');
      this.log(null, 'A internet voltou. Recarregando as contas que estavam sem ela.');
      this.resumeAfterInternet();
    }
    return up;
  }

  // Recarrega as contas que esperavam a internet, uma por vez para não pesar.
  resumeAfterInternet() {
    let i = 0;
    const now = Date.now();
    // Os sockets caíram junto com a internet: o jogo ganha tempo para reconectar antes de contar como "caiu".
    for (const rt of this.rt.values()) restartDropWait(rt.net, now);
    for (const rt of this.rt.values()) {
      if (rt.status !== 'no-internet') continue;
      clearTimeout(rt.retryTimer);
      rt.retryTimer = setTimeout(() => {
        rt.retryTimer = null;
        if (rt.status === 'no-internet') this.reopen(rt);
      }, i++ * 1500);
    }
  }

  // Carrega a página de novo (ou refaz a conta, se o processo dela morreu).
  reopen(rt) {
    const { g, a } = this.find(rt.key);
    if (!g?.url || !a || a.sleeping) return;
    const wc = rt.view?.webContents;
    if (!wc || wc.isDestroyed() || wc.isCrashed()) {
      this.destroyView(rt);
      this.createView(rt, g);
    } else {
      wc.loadURL(g.url).catch(() => {});
    }
  }

  // A página não carregou: ou a internet caiu, ou o jogo está fora do ar.
  async loadFailed(rt) {
    const view = rt.view;
    rt.status = 'server-down'; // provisório, para o did-stop-loading e o watchdog não acharem que está ok
    const up = await this.internetUp();
    if (rt.view !== view) return;
    if (!up) {
      rt.status = 'no-internet';
      return this.onChange();
    }
    this.serverDown(rt);
  }

  // Jogo fora do ar (erro 52x ou falha de carga com internet): tenta de novo com espera crescente.
  // Fora do contador de quedas: a culpa não é da conta, e o limite de 5 em 10 min desistiria
  // antes de a espera chegar a 10 e 15 min.
  serverDown(rt) {
    rt.status = 'server-down';
    if (!rt.downNotified) {
      rt.downNotified = true;
      this.record(rt, 'server-down');
      this.alert(rt, 'O jogo está fora do ar, não é o IdleHub. Tento de novo sozinho.');
    }
    this.onChange();
    if (rt.retryTimer) return;
    rt.retryTimer = setTimeout(async () => {
      rt.retryTimer = null;
      if (rt.status !== 'server-down' || !rt.view) return;
      rt.retryAttempt++;
      if (!(await this.internetUp())) {
        if (rt.status === 'server-down') rt.status = 'no-internet';
        return this.onChange();
      }
      if (rt.status === 'server-down') this.reopen(rt);
    }, backoffMs(rt.retryAttempt));
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
      if (this.internetDown) await this.internetUp(); // quando volta, recarrega as contas
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

    // Pausada por "aberta em outro lugar": não recarrega por nada até acabar.
    if (rt.pausedUntil > Date.now()) return;

    if (rt.gaveUp) {
      rt.status = 'attention';
      return;
    }
    if (rt.status === 'loading') {
      if (Date.now() - rt.loadStart < LOADING_GRACE_MS) return;
      return this.autoReload(rt, 'ficou carregando por tempo demais');
    }
    // Travou: tenta de novo a cada rodada se a primeira recarga foi barrada pela pausa mínima.
    if (rt.status === 'crashed') return this.autoReload(rt, 'a página tinha travado');
    // Esses esperam o próprio temporizador (a página aberta pode ser a de erro do Chromium).
    if (rt.status === 'no-internet' || rt.status === 'server-down') return;

    const args = {
      lo: { url: g.loggedOut?.urlIncludes || [], text: g.loggedOut?.textIncludes || [] },
      st: g.sessionTaken?.textIncludes || [],
      rc: g.reconnecting?.textIncludes || [],
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
      if (rt.fails >= (Number(s.reloadAfterFailures) || 2)) this.autoReload(rt, 'parou de responder');
      return;
    }
    rt.fails = 0;

    // Vem antes de "em branco" e "deslogada": a tela de aviso do jogo não é nenhuma das duas.
    if (res.sessionTaken) {
      rt.blank = 0;
      rt.status = 'session-taken';
      rt.pausedUntil = Date.now() + SESSION_TAKEN_PAUSE_MS; // texto ainda lá: renova a pausa
      if (!rt.sessionTakenNotified) {
        rt.sessionTakenNotified = true;
        this.record(rt, 'session-taken');
        this.alert(rt, 'A conta foi aberta em outro lugar. Pausei o watchdog dela por 10 minutos para não derrubar a outra sessão.');
      }
      return;
    }
    rt.sessionTakenNotified = false;
    rt.pausedUntil = 0;

    const kind = classifyPage({ title: res.title, text: res.head, length: res.len });
    if (kind === 'cloudflare') {
      // Não recarrega: a verificação costuma passar sozinha. Se demorar, a pessoa resolve na conta.
      rt.status = 'challenge';
      rt.challengeSince ||= Date.now();
      if (!rt.challengeNotified && Date.now() - rt.challengeSince >= CHALLENGE_NOTIFY_MS) {
        rt.challengeNotified = true;
        this.record(rt, 'challenge');
        this.alert(rt, 'O site pediu uma verificação. Abra a conta e clique na caixa.');
      }
      return;
    }
    rt.challengeSince = 0;
    rt.challengeNotified = false;
    if (kind) return this.serverDown(rt);
    // Página normal de novo: a espera e o aviso de "fora do ar" recomeçam do zero.
    rt.retryAttempt = 0;
    rt.downNotified = false;

    // Vem depois da sessão tomada e dos erros do site, e antes de "em branco" e "deslogada".
    // Não recarrega de cara: o jogo costuma reconectar sozinho. Só se passar do limite,
    // e aí pelo autoReload, que conta a queda e respeita internet e pausa mínima.
    if (res.reconnecting) {
      rt.blank = 0;
      rt.status = 'reconnecting';
      rt.reconnectingSince ||= Date.now();
      if (reconnectingTooLong(rt.reconnectingSince, Date.now())) {
        rt.reconnectingSince = 0; // a nova página começa a contar do zero
        return this.autoReload(rt, 'ficou reconectando');
      }
      return;
    }
    rt.reconnectingSince = 0;

    if (res.blank) {
      rt.blank++;
      if (rt.blank >= 2) return this.autoReload(rt, 'tela em branco');
    } else rt.blank = 0;

    if (res.loggedOut) {
      rt.status = 'logged-out';
      if (!rt.loggedOutNotified) {
        rt.loggedOutNotified = true;
        this.record(rt, 'logged-out');
        this.alert(rt, 'A conta saiu do login. Entre de novo nela.');
      }
    } else {
      rt.loggedOutNotified = false;
      rt.status = 'ok';
      if (rt.openIssue) {
        rt.openIssue = false;
        this.record(rt, 'recovered');
      }
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
        this.record(rt, 'alert', w.name);
        this.alert(rt, w.kind === 'text' ? `${w.name}` : `${w.name}: ${fmtNum(v)}`);
      }
    }

    // Conexão com o servidor do jogo (só em conta funcionando bem): avisa se ficou sem dados e
    // recarrega se a conexão caiu e não voltou. Passa pelo autoReload (sem internet não recarrega,
    // conta a queda e desiste no limite).
    if (rt.status === 'ok') {
      const reload = this.checkConnection(rt, res.net, s);
      if (reload) return this.autoReload(rt, 'a conexão com o servidor caiu');
    }

    // Conta funcionando bem: por memória ou por tempo, reabre num processo novo (otimizar.js).
    // Recarregar só a página não devolve a memória; por isso o limite agora otimiza.
    // Só uma por vez no app todo (nextOptimizeAt), para não reabrir todas juntas.
    if (rt.status !== 'ok') return;
    const now = Date.now();
    const why = autoOptimizeReason({
      now, createdAt: rt.createdAt, everyHours: s.optimizeEveryHours, mem: rt.mem, limitMB: s.memoryLimitMB,
      nextAllowedAt: this.nextOptimizeAt,
    });
    if (!why) return;
    this.nextOptimizeAt = now + AUTO_GAP_MS;
    return this.autoOptimize(rt, why);
  }

  // Atualiza rt.conn (o que aparece na tela) e avisa se ficou sem dados. Devolve true se é hora de recarregar.
  checkConnection(rt, snap, s) {
    const now = Date.now();
    noteSockets(rt.net, snap, now);
    if (this.internetDown) {
      rt.conn = null; // sem internet é outro problema (e outro aviso): não acusa o jogo
      return false;
    }
    const c = connectionState(rt.net, now, { silentAfterMs: silentAfterMs(s.connectionNotifyMin) });
    rt.conn = c.state === 'unknown' ? null : { state: c.state, idle: fmtIdle(c.idleMs) };
    if (shouldNotifySilence({ state: c.state, minutes: s.connectionNotifyMin, notified: rt.silentNotified })) {
      rt.silentNotified = true;
      this.record(rt, 'alert', 'Sem dados do servidor');
      this.alert(rt, `O jogo está sem receber dados do servidor há ${fmtIdle(c.idleMs)}.`);
    } else if (c.state === 'connected' && rt.silentNotified) {
      rt.silentNotified = false;
      this.log(rt, 'O jogo voltou a receber dados do servidor.');
    }
    if (!c.reload || now < this.nextConnReloadAt) return false;
    this.nextConnReloadAt = now + RELOAD_GAP_MS;
    return true;
  }

  // tracker (metrics.js): guarda o histórico e diz se a conta está pesada. Só números, nada caro.
  updateMetrics(metrics, tracker) {
    const byPid = new Map(metrics.map((m) => [m.pid, m]));
    for (const rt of this.rt.values()) {
      const wc = rt.view?.webContents;
      if (!wc || wc.isDestroyed()) {
        rt.mem = 0;
        rt.cpu = 0;
        continue;
      }
      const pid = wc.getOSProcessId();
      const m = byPid.get(pid);
      rt.mem = m ? Math.round(m.memory.workingSetSize / 1024) : 0;
      rt.cpu = m ? normalizeCpu(m.cpu?.percentUsage) : 0;
      // Subpáginas abertas pesam na conta (cada processo conta uma vez só).
      const seen = new Set([pid]);
      for (const sub of rt.subs.values()) {
        if (sub.view.webContents.isDestroyed()) continue;
        const sp = sub.view.webContents.getOSProcessId();
        const sm = seen.has(sp) ? null : byPid.get(sp);
        seen.add(sp);
        if (!sm) continue;
        rt.mem += Math.round(sm.memory.workingSetSize / 1024);
        rt.cpu += normalizeCpu(sm.cpu?.percentUsage);
      }
    }
    if (!tracker) return;
    const accounts = [...this.rt.values()].map((rt) => ({ key: rt.key, gameId: rt.key.split(':')[0], cpu: rt.cpu || 0, mem: rt.mem }));
    tracker.ingest({ accounts, processes: metrics });
    const limit = Number(this.getConfig().settings.memoryLimitMB) || 0;
    for (const rt of this.rt.values()) rt.heavy = !!rt.view && tracker.heavy(rt.key, rt.mem, limit);
  }

  snapshot() {
    const accounts = {};
    for (const rt of this.rt.values()) {
      accounts[rt.key] = {
        status: rt.status,
        live: !!rt.view,
        mem: rt.mem,
        cpu: rt.cpu || 0,
        heavy: !!rt.heavy,
        values: rt.values,
        trig: rt.trig,
        reloads: rt.reloads,
        lastEvent: rt.lastEvent,
        title: rt.title,
        ...this.tabState(rt),
        conn: rt.conn,
      };
    }
    return { accounts, log: this.logs.slice(-150) };
  }

  // Estado de agora de cada conta ligada, no formato que o summarize() de events.js espera.
  accountStates() {
    const out = {};
    for (const rt of this.rt.values()) {
      if (!rt.view) continue;
      const { g, a } = this.find(rt.key);
      out[rt.key] = { game: g?.name || '', who: a?.name || rt.key, status: rt.status };
    }
    return out;
  }

  shutdown() {
    clearInterval(this.timer);
    for (const t of this.optimizeTimers) clearTimeout(t);
    this.optimizeTimers.clear();
    this.cancelWakeQueue();
    for (const rt of this.rt.values()) this.destroyView(rt);
  }
}

// probeInPage sai também para os testes (test/probe.test.js).
module.exports = { AccountManager, probeInPage };
