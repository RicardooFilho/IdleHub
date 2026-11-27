// Interface do IdleHub: barra de jogos, mosaico de contas, Painel (IdleLive) e janelas.
// Segue o DESIGN.md. As contas dos jogos são desenhadas pelo app POR CIMA desta página, nos espaços
// [data-live]; por isso, com uma janela aberta, as contas são escondidas (sendLayout manda lista vazia).
const api = window.idle;

const S = {
  config: null,
  presets: [],
  runtime: { accounts: {}, log: [] },
  totalMem: 0,
  totalCpu: 0,
  perf: null, // histórico de CPU e memória (IPC metrics:history), só carregado com a janela Desempenho aberta
  perfAt: 0,
  view: loadView(), // panel | all | game | focus
  modal: null, // { kind: 'onboard' | 'game' | 'settings' | 'log' | 'away', draft }
  awayPending: null, // resumo de "Enquanto você estava fora" esperando a janela aberta fechar
  asking: false,
  version: '',
  openAtLogin: false,
  seenLog: 0,
  idlelive: { status: 'stopped', logs: [] },
};

// Lembra a última tela (Painel, Todas ou um jogo) entre aberturas do app.
function loadView() {
  try {
    const v = JSON.parse(localStorage.getItem('view'));
    if (v && ['panel', 'all', 'game'].includes(v.kind)) return v;
  } catch {}
  return { kind: 'panel' };
}
function saveView() {
  const v = S.view.kind === 'focus' ? S.view.back : S.view;
  try {
    localStorage.setItem('view', JSON.stringify({ kind: v?.kind || 'panel', gameId: v?.gameId }));
  } catch {}
}

const STATUS = {
  ok: 'Rodando',
  loading: 'Carregando',
  unresponsive: 'Sem resposta',
  crashed: 'Travou',
  'logged-out': 'Deslogada',
  'session-taken': 'Aberta em outro lugar',
  reconnecting: 'Reconectando…',
  'no-internet': 'Sem internet',
  'server-down': 'Jogo fora do ar',
  challenge: 'Verificação',
  attention: 'Precisa de atenção',
  sleeping: 'Dormindo',
  'no-url': 'Sem link',
};
const ISSUES = new Set(['unresponsive', 'crashed', 'logged-out', 'no-internet', 'server-down', 'challenge', 'attention', 'session-taken', 'reconnecting']);
const IDLELIVE_STATUS = {
  running: 'Rodando',
  starting: 'Abrindo…',
  'port-busy': 'Aberto fora do IdleHub',
  crashed: 'Parou, abrindo de novo…',
  stopped: 'Parado',
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clone = (o) => JSON.parse(JSON.stringify(o));
const fmt = (n) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const fmtMem = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1).replace('.', ',') + ' GB' : Math.round(mb) + ' MB');
// CPU em % do PC inteiro (como o Gerenciador de Tarefas): uma casa decimal só abaixo de 10%.
const fmtCpu = (n) => (n < 10 ? (Math.round(n * 10) / 10).toFixed(1).replace('.', ',') : Math.round(n)) + '%';
const keyOf = (g, a) => `${g.id}:${a.id}`;
const gameById = (id) => S.config.games.find((g) => g.id === id);
const icon = (name, label = '') => `<wa-icon name="${name}"${label ? ` label="${esc(label)}"` : ''}></wa-icon>`;
// Botão só com ícone: label (leitor de tela) + title (dica), como pede o DESIGN.md.
const iconBtn = (action, name, title, extra = '') =>
  `<wa-button appearance="plain" size="s" data-action="${action}" title="${esc(title)}" ${extra}>${icon(name, title)}</wa-button>`;

function rtOf(key, a) {
  return S.runtime.accounts[key] || { status: a?.sleeping ? 'sleeping' : 'loading', live: false, mem: 0, values: {}, trig: {} };
}

function tileMode(g, a, r) {
  if (a.sleeping || r.status === 'sleeping') return 'sleep';
  if (!g.url) return 'nourl';
  return 'live';
}

function scope() {
  const out = [];
  const v = S.view;
  if (v.kind === 'panel') return out;
  for (const g of S.config.games) {
    if (v.kind === 'game' && g.id !== v.gameId) continue;
    for (const a of g.accounts) {
      const key = keyOf(g, a);
      if (v.kind === 'focus' && key !== v.key) continue;
      out.push({ g, a, key });
    }
  }
  return out;
}

// ---------------------------------------------------------------- respostas e confirmações

// type: 'error' (vermelho) ou 'info' (deu certo, dicas).
function toast(msg, type = 'error') {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('info', type === 'info');
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 4000);
}

// Confirmação própria, no lugar do confirm() do navegador. Responde true só no botão de confirmar.
// danger = ícone de aviso (não dá para desfazer). ok = verbo da ação ("Remover", não "OK").
let askDone = null;
function ask({ title, text, ok = 'Confirmar', danger = false }) {
  askDone?.(false);
  const d = $('#ask-dialog');
  $('#ask-title').textContent = title;
  $('#ask-text').textContent = text;
  $('#ask-icon').name = danger ? 'triangle-exclamation' : 'circle-question';
  $('#ask-yes').textContent = ok;
  S.asking = true;
  scheduleLayout();
  d.open = true;
  return new Promise((resolve) => {
    askDone = (answer) => {
      askDone = null;
      d.open = false;
      resolve(answer);
    };
  });
}
$('#ask-yes').addEventListener('click', () => askDone?.(true));
$('#ask-dialog').addEventListener('wa-hide', (e) => e.target === e.currentTarget && askDone?.(false));
$('#ask-dialog').addEventListener('wa-after-hide', (e) => {
  if (e.target !== e.currentTarget) return;
  S.asking = false;
  scheduleLayout();
});

// ---------------------------------------------------------------- render
function render() {
  if (S.view.kind === 'game' && !gameById(S.view.gameId)) S.view = { kind: 'all' };
  if (S.view.kind === 'focus' && !scope().length) S.view = { kind: 'all' };
  saveView();
  renderRail();
  renderTop();
  renderContent();
  renderModal();
}

function renderRail() {
  const v = S.view;
  let h = `
    <button class="rail-btn ${v.kind === 'panel' ? 'active' : ''}" data-action="view-panel" title="Painel: pontos da Twitch e da Kick (IdleLive)">
      <img src="icon.png" alt="Painel" /><wa-badge class="count" variant="danger" pill data-panel-status hidden>!</wa-badge></button>
    <button class="rail-btn ${v.kind === 'all' ? 'active' : ''}" data-action="view-all" title="Todas as contas">${icon('table-cells-large', 'Todas as contas')}</button>
    <div class="rail-sep"></div>`;
  for (const g of S.config.games) {
    const active = (v.kind === 'game' || v.kind === 'focus') && v.gameId === g.id;
    // A cor do jogo vem da configuração dele (escolhida pelo jogador).
    h += `<button class="rail-btn ${active ? 'active' : ''}" data-action="view-game" data-id="${g.id}" title="${esc(g.name)}" style="color:${g.color}">
      ${esc(g.short)}<wa-badge class="count" pill data-rail-count="${g.id}"></wa-badge></button>`;
  }
  h += `<button class="rail-btn add" data-action="add-game" title="Adicionar jogo">${icon('plus', 'Adicionar jogo')}</button>
    <div class="rail-spacer"></div>
    <button class="rail-btn" data-action="open-perf" title="Desempenho: CPU e memória de cada conta">${icon('gauge-high', 'Desempenho')}</button>
    <button class="rail-btn" data-action="open-log" title="Atividade: recargas, logouts e alertas">${icon('bell', 'Atividade')}<wa-badge class="count" variant="danger" pill data-log-count hidden></wa-badge></button>
    <button class="rail-btn" data-action="open-settings" title="Configurações">${icon('gear', 'Configurações')}</button>`;
  $('#rail').innerHTML = h;
  updateRail();
}

function renderTop() {
  const v = S.view;
  let title = 'Todas as contas';
  let actions = '';
  const btn = (action, name, text, attrs = '') =>
    `<wa-button size="s" variant="brand" appearance="outlined" data-action="${action}" ${attrs}>${icon(name).replace('<wa-icon', '<wa-icon slot="start"')}${text}</wa-button>`;
  if (v.kind === 'panel') {
    title = 'Painel';
    actions = `
      ${btn('panel-reload', 'rotate-right', 'Recarregar página')}
      <wa-button size="s" appearance="plain" data-action="panel-browser">Abrir no navegador<wa-icon slot="end" name="arrow-up-right-from-square"></wa-icon></wa-button>`;
  } else if (v.kind === 'all' || v.kind === 'game') {
    const gid = v.kind === 'game' ? v.gameId : '';
    if (v.kind === 'game') title = esc(gameById(gid).name);
    actions = `
      ${btn('game-wake', 'sun', 'Acordar todas', `data-id="${gid}"`)}
      ${btn('game-sleep', 'moon', 'Dormir todas', `data-id="${gid}"`)}
      ${btn('game-reload', 'rotate-right', 'Recarregar todas', `data-id="${gid}"`)}
      ${btn('game-optimize', 'broom', 'Otimizar todas', `data-id="${gid}" title="Reabre cada conta num processo novo para liberar memória, uma por vez"`)}
      ${v.kind === 'game' ? `<wa-button size="s" appearance="plain" data-action="edit-game" data-id="${gid}"><wa-icon slot="start" name="pen"></wa-icon>Editar jogo</wa-button>` : ''}`;
  } else {
    const it = scope()[0];
    title = `<span class="game-badge" style="background:${it.g.color}">${esc(it.g.short)}</span>${esc(it.a.name)}`;
    actions = `
      <wa-button size="s" appearance="plain" data-action="back"><wa-icon slot="start" name="arrow-left"></wa-icon>Voltar</wa-button>
      ${btn('home', 'house', 'Início', `data-key="${it.key}" title="Volta para o link inicial do jogo"`)}
      ${btn('reload', 'rotate-right', 'Recarregar', `data-key="${it.key}"`)}
      ${btn('optimize', 'broom', 'Otimizar (liberar memória)', `data-key="${it.key}" title="Reabre a conta num processo novo, no mesmo login e na mesma página"`)}
      ${btn('devtools', 'magnifying-glass', 'Inspecionar', `data-key="${it.key}" title="Abre as ferramentas do Chrome para achar o seletor de um alerta"`)}
      ${btn('sleep', 'moon', 'Dormir', `data-key="${it.key}"`)}`;
  }
  $('#top').innerHTML = `<h1>${title}</h1><div class="stats" id="stats"></div><div class="top-actions">${actions}</div>`;
  updateStats();
}

function bestCols(n, W, H) {
  const gap = 12;
  const head = 36;
  let best = 1;
  let bestW = -1;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tw = (W - (cols - 1) * gap) / cols;
    const th = (H - (rows - 1) * gap) / rows - head;
    const w = Math.min(tw, (th * 16) / 9);
    if (w > bestW) {
      bestW = w;
      best = cols;
    }
  }
  return best;
}

function renderContent() {
  const c = $('#content');
  if (S.view.kind === 'panel') return renderPanel(c);
  delete c.dataset.panelMode;
  const list = scope();
  if (!S.config.games.length || !list.length) {
    c.style.gridTemplateColumns = '1fr';
    c.style.gridTemplateRows = '1fr';
    c.innerHTML = `<div class="empty">${icon('gamepad')}<h2>Nenhuma conta por aqui</h2>
      <p>Adicione um jogo no botão <b>+</b> da barra lateral.</p>
      <wa-button variant="brand" data-action="add-game"><wa-icon slot="start" name="plus"></wa-icon>Adicionar jogo</wa-button></div>`;
    scheduleLayout();
    return;
  }
  const focus = S.view.kind === 'focus';
  const cs = getComputedStyle(c);
  const W = c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const H = c.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const cols = focus ? 1 : bestCols(list.length, W, H);
  const rows = Math.ceil(list.length / cols);
  c.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  c.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  c.innerHTML = list.map(tileHtml).join('');
  refreshTiles();
  scheduleLayout();
}

// Painel = página do IdleLive. Ela só aparece com o servidor rodando; antes disso, um aviso.
function panelMode() {
  return S.idlelive.status === 'running' ? 'live' : S.idlelive.status;
}

function renderPanel(c) {
  c.style.gridTemplateColumns = '1fr';
  c.style.gridTemplateRows = '1fr';
  const mode = panelMode();
  if (mode === 'live') {
    c.innerHTML = `<div class="panel-host" data-panel></div>`;
  } else {
    const msg = {
      starting: ['hourglass-half', 'Abrindo o Painel…', ''],
      'port-busy': [
        'window-restore',
        'O IdleLive já está aberto fora do IdleHub',
        'Feche a janela preta do IdleLive (iniciar.bat). O Painel abre aqui sozinho em alguns segundos. Os dois juntos não podem rodar: as contas da Twitch cairiam.',
      ],
      crashed: ['triangle-exclamation', 'O Painel parou. Abrindo de novo…', ''],
      stopped: ['power-off', 'O Painel está parado', 'Clique em Abrir de novo para ligar.'],
    }[mode] || ['hourglass-half', 'Abrindo o Painel…', ''];
    const logs = S.idlelive.logs?.slice(-6) || [];
    c.innerHTML = `<div class="empty">${icon(msg[0])}<h2>${esc(msg[1])}</h2>
      ${msg[2] ? `<p>${esc(msg[2])}</p>` : ''}
      ${mode === 'crashed' && logs.length ? `<pre class="panel-log">${esc(logs.join('\n'))}</pre>` : ''}
      ${mode === 'crashed' || mode === 'stopped' ? `<wa-button variant="brand" appearance="outlined" data-action="panel-restart"><wa-icon slot="start" name="rotate-right"></wa-icon>Abrir de novo</wa-button>` : ''}
    </div>`;
  }
  c.dataset.panelMode = mode;
  scheduleLayout();
}

function tileHtml({ g, a, key }) {
  const r = rtOf(key, a);
  const mode = tileMode(g, a, r);
  const focus = S.view.kind === 'focus';
  const showBadge = S.view.kind !== 'game';
  let body;
  if (mode === 'live') body = `<div class="tile-body" data-live="${key}"></div>`;
  else if (mode === 'sleep')
    body = `<div class="tile-body"><div class="empty">${icon('moon')}<h2>Conta dormindo</h2><p>Não gasta memória. O login continua salvo.</p>
      <wa-button size="s" variant="brand" appearance="outlined" data-action="wake"><wa-icon slot="start" name="sun"></wa-icon>Acordar</wa-button></div></div>`;
  else
    body = `<div class="tile-body"><div class="empty">${icon('link')}<h2>Falta o link do ${esc(g.name)}</h2>
      <wa-button size="s" variant="brand" data-action="edit-game" data-id="${g.id}"><wa-icon slot="start" name="plus"></wa-icon>Adicionar link</wa-button></div></div>`;

  return `<div class="tile" data-key="${key}" data-mode="${mode}">
    <div class="tile-head" title="Clique duas vezes para expandir">
      <span class="dot" data-dot></span>
      ${showBadge ? `<span class="game-badge" style="background:${g.color}">${esc(g.short)}</span>` : ''}
      <span class="tile-name">${esc(a.name)}</span>
      <span class="tile-status" data-status></span>
      <span class="vals" data-vals></span>
      <span class="meta num tile-mem" data-mem></span>
      ${
        focus
          ? ''
          : `<div class="tile-actions">
        ${iconBtn('focus', 'expand', 'Expandir')}
        ${iconBtn('reload', 'rotate-right', 'Recarregar')}
        ${mode === 'sleep' ? '' : iconBtn('optimize', 'broom', 'Otimizar (liberar memória)')}
        ${mode === 'sleep' ? iconBtn('wake', 'sun', 'Acordar') : iconBtn('sleep', 'moon', 'Dormir (libera memória)')}
      </div>`
      }
    </div>
    ${body}
  </div>`;
}

// ---------------------------------------------------------------- atualização ao vivo
function updateRuntime() {
  if (S.view.kind === 'panel') {
    if ($('#content').dataset.panelMode !== panelMode()) renderContent();
  } else if (refreshTiles()) renderContent();
  updateStats();
  updateRail();
  if (S.modal?.kind === 'log') renderModalBody();
  else if (S.modal?.kind === 'perf') refreshPerf();
}

// Atualiza bolinha, status, memória e valores de cada conta. Retorna true se
// alguma conta mudou de modo (dormindo/rodando) e o mosaico precisa ser refeito.
function refreshTiles() {
  let needRender = false;
  for (const el of $$('.tile[data-key]')) {
    const key = el.dataset.key;
    const [gid, aid] = key.split(':');
    const g = gameById(gid);
    const a = g?.accounts.find((x) => x.id === aid);
    if (!g || !a) continue;
    const r = rtOf(key, a);
    if (tileMode(g, a, r) !== el.dataset.mode) {
      needRender = true;
      break;
    }
    const st = a.sleeping ? 'sleeping' : r.status;
    $('[data-dot]', el).className = `dot ${st}`;
    const stEl = $('[data-status]', el);
    stEl.textContent = st === 'ok' ? '' : STATUS[st] || st;
    stEl.title = r.lastEvent || '';
    const memEl = $('[data-mem]', el);
    const memText = r.mem ? `CPU ${fmtCpu(r.cpu || 0)} · ${fmtMem(r.mem)}` : '';
    if (memEl.textContent !== memText) memEl.textContent = memText;
    memEl.title = r.heavy ? 'Conta pesada: usa muita CPU ou memória. Veja os detalhes em Desempenho.' : 'CPU (% do PC inteiro) · memória';
    memEl.classList.toggle('heavy', !!r.heavy);
    const ws = (g.watchers || []).filter((w) => w.enabled);
    const vals = ws
      .map((w) => {
        const v = r.values?.[w.id];
        const hit = !!r.trig?.[w.id];
        if (w.kind === 'text') return hit ? `<wa-badge variant="warning" pill>${esc(w.name)}</wa-badge>` : '';
        if (v == null) return '';
        return `<wa-badge class="num" variant="${hit ? 'warning' : 'neutral'}" appearance="${hit ? 'accent' : 'outlined'}" pill title="${esc(w.name)}">${esc(w.name)} ${fmt(v)}</wa-badge>`;
      })
      .join('');
    const valsEl = $('[data-vals]', el);
    if (valsEl._html !== vals) valsEl.innerHTML = valsEl._html = vals;
    el.classList.toggle('alerting', Object.values(r.trig || {}).some(Boolean));
  }
  return needRender;
}

const chip = (html, attrs = '') => `<wa-badge variant="neutral" appearance="outlined" pill ${attrs}>${html}</wa-badge>`;

function updateStats() {
  const el = $('#stats');
  if (!el) return;
  let html;
  if (S.view.kind === 'panel') html = panelStats();
  else {
    let running = 0, sleeping = 0, issues = 0, mem = 0, heavy = 0;
    for (const { a, key } of scope()) {
      const r = rtOf(key, a);
      if (a.sleeping) sleeping++;
      else if (r.live) running++;
      if (ISSUES.has(r.status)) issues++;
      mem += r.mem || 0;
      if (r.heavy) heavy++;
    }
    html = `${chip(`<b class="num">${running}</b>&nbsp;rodando`)}${chip(`<b class="num">${sleeping}</b>&nbsp;dormindo`)}
      ${issues ? `<wa-badge variant="warning" pill><b class="num">${issues}</b>&nbsp;com problema</wa-badge>` : ''}
      ${heavy ? `<wa-badge variant="warning" pill title="Contas usando muita CPU ou memória"><b class="num">${heavy}</b>&nbsp;${heavy === 1 ? 'pesada' : 'pesadas'}</wa-badge>` : ''}
      ${chip(`RAM&nbsp;<b class="num">${fmtMem(mem)}</b>&nbsp;· app ${fmtMem(S.totalMem)}&nbsp;· CPU ${fmtCpu(S.totalCpu)}`, 'title="Memória das contas mostradas · memória do app · CPU do app inteiro (% do PC)"')}`;
  }
  if (el._html !== html) el.innerHTML = el._html = html;
}

// No Painel: status do IdleLive e quantas contas dos jogos seguem rodando por trás.
function panelStats() {
  let running = 0, total = 0;
  for (const g of S.config.games)
    for (const a of g.accounts) {
      total++;
      if (!a.sleeping && rtOf(keyOf(g, a), a).live) running++;
    }
  const st = S.idlelive.status;
  const variant = st === 'running' ? 'success' : st === 'port-busy' || st === 'crashed' ? 'warning' : 'neutral';
  return `<wa-badge variant="${variant}" pill>IdleLive: ${esc(IDLELIVE_STATUS[st] || st)}</wa-badge>
    ${total ? chip(`${icon('gamepad')}&nbsp;<b class="num">${running}/${total}</b>&nbsp;contas rodando em segundo plano`, 'title="As contas dos jogos continuam rodando enquanto você usa o Painel"') : ''}
    ${chip(`RAM do app&nbsp;<b class="num">${fmtMem(S.totalMem)}</b>`)}`;
}

function updateRail() {
  const ps = $('[data-panel-status]');
  if (ps) ps.hidden = !(S.idlelive.status === 'port-busy' || S.idlelive.status === 'crashed');
  for (const g of S.config.games) {
    const el = $(`[data-rail-count="${g.id}"]`);
    if (!el) continue;
    let live = 0, issues = 0;
    for (const a of g.accounts) {
      const r = rtOf(keyOf(g, a), a);
      if (!a.sleeping && r.live) live++;
      if (ISSUES.has(r.status)) issues++;
    }
    el.textContent = issues || `${live}/${g.accounts.length}`;
    el.variant = issues ? 'danger' : 'neutral';
  }
  const alerts = S.runtime.log.filter((l) => l.level !== 'info' && l.t > S.seenLog).length;
  const lc = $('[data-log-count]');
  if (lc) {
    lc.hidden = !alerts;
    lc.textContent = alerts > 99 ? '99+' : alerts;
  }
}

// ---------------------------------------------------------------- posição das contas
let layoutQueued = false;
function scheduleLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    sendLayout();
  });
}

function sendLayout() {
  // Janela aberta: as contas (desenhadas por cima da página) se escondem para não cobrir a janela.
  if (S.modal || S.asking) return api.setLayout([]);
  const base = S.config.settings.tileBaseWidth || 1280;
  const focus = S.view.kind === 'focus';
  const tiles = $$('[data-live]').map((el) => {
    const r = el.getBoundingClientRect();
    const zoom = focus ? 1 : Math.max(0.25, Math.min(1, r.width / base));
    return { key: el.dataset.live, x: r.left, y: r.top, w: r.width, h: r.height, zoom: Math.round(zoom * 100) / 100, focus };
  });
  const host = $('[data-panel]');
  if (host) {
    const r = host.getBoundingClientRect();
    tiles.push({ key: '__panel', x: r.left, y: r.top, w: r.width, h: r.height });
  }
  api.setLayout(tiles);
}

// ---------------------------------------------------------------- janelas
const dlg = () => $('#dialog');

function openModal(kind, draft) {
  S.modal = { kind, draft };
  renderModal();
}

function closeModal() {
  if (S.modal?.kind === 'log') S.seenLog = Date.now();
  S.modal = null;
  dlg().open = false;
  updateRail();
}

const MODAL_TITLES = {
  onboard: 'Bem-vindo ao IdleHub',
  settings: 'Configurações',
  log: 'Atividade',
  perf: 'Desempenho',
  away: 'Enquanto você estava fora',
};

function renderModal() {
  const d = dlg();
  if (!S.modal) {
    d.open = false;
    scheduleLayout();
    return;
  }
  const m = S.modal;
  d.label = m.kind === 'game' ? (m.draft.id ? `Editar ${m.draft.name}` : 'Adicionar jogo') : MODAL_TITLES[m.kind];
  // As boas-vindas só fecham pelo botão: sem jogos, o app fica vazio.
  d.toggleAttribute('light-dismiss', m.kind !== 'onboard');
  d.toggleAttribute('without-header', false);
  renderModalBody();
  scheduleLayout();
  d.open = true;
}

function renderModalBody() {
  const m = S.modal;
  const html =
    m.kind === 'onboard' ? onboardHtml(m.draft) :
    m.kind === 'game' ? gameHtml(m.draft) :
    m.kind === 'settings' ? settingsHtml(m.draft) :
    m.kind === 'log' ? logHtml() :
    m.kind === 'perf' ? perfHtml(m.draft) :
    m.kind === 'away' ? awayHtml(m.draft) : '';
  const d = dlg();
  if (d._html === html) return;
  // Trocar o conteúdo zera a rolagem da janela: guarda e devolve (a lista de Desempenho se atualiza sozinha).
  const body = d.shadowRoot?.querySelector('[part~="body"]');
  const top = body?.scrollTop || 0;
  d.innerHTML = d._html = html;
  if (body && top) body.scrollTop = top;
}

dlg().addEventListener('wa-hide', (e) => {
  if (e.target !== e.currentTarget) return; // menus e seletores lá dentro também disparam wa-hide
  if (S.modal?.kind === 'onboard') return e.preventDefault();
  if (S.modal?.kind === 'log') S.seenLog = Date.now();
  S.modal = null;
  updateRail();
});
dlg().addEventListener('wa-after-hide', (e) => {
  if (e.target !== e.currentTarget) return;
  scheduleLayout();
  showAwayPending();
});

// ----- boas-vindas
function onboardDraft() {
  return S.presets.map((p) => ({ preset: p.preset, name: p.name, short: p.short, color: p.color, on: true, accounts: p.suggestedAccounts, url: p.url }));
}

function onboardHtml(d) {
  return `<div class="form">
      <p class="meta">Escolha seus jogos e quantas contas de cada. Dá para mudar tudo depois.</p>
      <div class="form-block">
      ${d
        .map(
          (p, i) => `
        <div class="pick ${p.on ? '' : 'off'}" data-i="${i}">
          <wa-checkbox data-f="on" ${p.on ? 'checked' : ''} title="Usar este jogo"></wa-checkbox>
          <span class="pick-name"><span class="game-badge" style="background:${p.color}">${esc(p.short)}</span>${esc(p.name)}</span>
          <wa-input size="s" type="number" min="1" max="12" label="Contas" data-f="accounts" value="${p.accounts}"></wa-input>
          <wa-input size="s" label="Link do jogo" data-f="url" value="${esc(p.url)}" placeholder="https://…"></wa-input>
        </div>`
        )
        .join('')}
      </div>
      <wa-callout variant="neutral" size="s"><wa-icon slot="icon" name="circle-info"></wa-icon>
        Cada conta abre separada, com o próprio login. Na primeira vez, expanda cada conta e entre nela; depois o IdleHub lembra.
        Outros jogos de navegador entram pelo botão <b>+</b> da barra lateral.</wa-callout>
    </div>
    <wa-button slot="footer" variant="brand" data-action="onboard-done">Criar meu painel</wa-button>`;
}

function collectOnboard() {
  for (const row of $$('.pick')) {
    const p = S.modal.draft[Number(row.dataset.i)];
    p.on = $('[data-f="on"]', row).checked;
    p.accounts = Math.max(1, Math.min(12, Number($('[data-f="accounts"]', row).value) || 1));
    p.url = String($('[data-f="url"]', row).value || '').trim();
  }
}

// ----- jogo (novo/editar)
function blankGame() {
  return {
    id: '', preset: null, name: '', short: '', color: '#fc5e03', url: '',
    accounts: [{ id: '', name: 'Conta 1', sleeping: false }],
    loggedOut: { urlIncludes: ['login'], textIncludes: [] },
    sessionTaken: { textIncludes: [] },
    reconnecting: { textIncludes: [] },
    watchers: [],
  };
}

const OPS = [['>=', '≥'], ['<=', '≤'], ['>', '>'], ['<', '<'], ['=', '='], ['change', 'mudou']];

function gameHtml(d) {
  const isNew = !d.id;
  return `<div class="form">
      ${
        isNew
          ? `<div class="form-block"><span class="form-label">Começar de um modelo</span><div class="presets">
        ${S.presets.map((p) => `<wa-button size="s" appearance="outlined" variant="brand" data-action="preset-fill" data-preset="${p.preset}"><span class="game-badge" slot="start" style="background:${p.color}">${esc(p.short)}</span>${esc(p.name)}</wa-button>`).join('')}
       </div></div>`
          : ''
      }
      <div class="form-block">
        <span class="form-label">Jogo</span>
        <div class="form-row">
          <wa-input label="Nome" data-f="name" value="${esc(d.name)}" placeholder="Ex.: PokeIdle"></wa-input>
          <wa-input class="narrow" label="Sigla" data-f="short" maxlength="4" value="${esc(d.short)}" placeholder="PK"></wa-input>
          <wa-color-picker class="narrow" label="Cor" data-f="color" value="${esc(d.color)}"></wa-color-picker>
        </div>
        <wa-input label="Link do jogo" data-f="url" value="${esc(d.url)}" placeholder="https://…" hint="Qualquer jogo idle de navegador funciona: basta o link."></wa-input>
      </div>

      <div class="form-block">
        <span class="form-label">Contas (${d.accounts.length}/12)</span>
        ${d.accounts
          .map(
            (a, i) => `<div class="acc-row" data-i="${i}">
            <wa-input size="s" data-f="acc-name" value="${esc(a.name)}" aria-label="Nome da conta"></wa-input>
            ${iconBtn('acc-del', 'trash', 'Remover conta', `data-i="${i}"`)}</div>`
          )
          .join('')}
        ${d.accounts.length < 12 ? `<div><wa-button size="s" variant="brand" appearance="outlined" data-action="acc-add"><wa-icon slot="start" name="plus"></wa-icon>Adicionar conta</wa-button></div>` : ''}
      </div>

      <div class="form-block">
        <span class="form-label">Saber quando a conta sai do login</span>
        <div class="form-row">
          <wa-input size="s" label="O link contém" hint="Separe por vírgula. Ex.: login, signin" data-f="lo-url" value="${esc(d.loggedOut.urlIncludes.join(', '))}"></wa-input>
          <wa-input size="s" label="A página mostra o texto" hint="Ex.: Entrar, Faça login" data-f="lo-text" value="${esc(d.loggedOut.textIncludes.join(', '))}"></wa-input>
        </div>
      </div>

      <div class="form-block">
        <span class="form-label">Saber quando a conta é aberta em outro lugar</span>
        <div class="form-row">
          <wa-input size="s" label="Textos de conta aberta em outro lugar (separados por vírgula)" hint="Ex.: aberta em outro lugar, aberto em outra aba. Quando a página mostra um deles, o IdleHub pausa a conta por 10 minutos em vez de recarregar." data-f="st-text" value="${esc((d.sessionTaken?.textIncludes || []).join(', '))}"></wa-input>
        </div>
      </div>

      <div class="form-block">
        <span class="form-label">Saber quando o jogo fica preso em "Reconectando…"</span>
        <div class="form-row">
          <wa-input size="s" label="Textos de reconectando (separados por vírgula)" hint="Ex.: reconectando, connection lost. Se a página mostrar um deles por mais de 3 minutos seguidos, o IdleHub recarrega a conta." data-f="rc-text" value="${esc((d.reconnecting?.textIncludes || []).join(', '))}"></wa-input>
        </div>
      </div>

      <div class="form-block">
        <span class="form-label">Alertas</span>
        <p class="meta"><b>Texto</b>: avisa quando a palavra aparece na página (ex.: <code>shiny</code>).
          <b>Número</b>: lê um valor e avisa pela condição. Para achar o valor, expanda uma conta, clique em <b>Inspecionar</b>,
          clique com o botão direito no valor → <b>Copy selector</b>, e cole em Seletor CSS. Também dá para usar uma regex com um grupo,
          ex.: <code>Ouro:\\s*([\\d.,]+[kKmM]?)</code>.</p>
        ${
          d.watchers.length
            ? `<div class="watch-row watch-head"><span></span><span>Nome</span><span>Tipo</span><span>Seletor CSS (opcional)</span><span>Texto ou regex</span><span>Condição</span><span>Valor</span><span></span></div>`
            : ''
        }
        ${d.watchers
          .map(
            (w, i) => `<div class="watch-row" data-i="${i}">
            <wa-checkbox data-f="w-enabled" ${w.enabled ? 'checked' : ''} title="Ligado"></wa-checkbox>
            <wa-input size="s" data-f="w-name" value="${esc(w.name)}" aria-label="Nome"></wa-input>
            <wa-select size="s" data-f="w-kind" value="${w.kind}" aria-label="Tipo"><wa-option value="text">Texto</wa-option><wa-option value="number">Número</wa-option></wa-select>
            <wa-input size="s" data-f="w-selector" value="${esc(w.selector)}" placeholder="#gold" aria-label="Seletor CSS"></wa-input>
            <wa-input size="s" data-f="w-pattern" value="${esc(w.pattern)}" placeholder="${w.kind === 'text' ? 'shiny' : 'regex (opcional)'}" aria-label="Texto ou regex"></wa-input>
            <wa-select size="s" data-f="w-op" value="${w.op}" aria-label="Condição" ${w.kind === 'text' ? 'disabled' : ''}>${OPS.map(([v, l]) => `<wa-option value="${v}">${l}</wa-option>`).join('')}</wa-select>
            <wa-input size="s" type="number" data-f="w-value" value="${esc(w.value)}" aria-label="Valor" ${w.kind === 'text' || w.op === 'change' ? 'disabled' : ''}></wa-input>
            ${iconBtn('w-del', 'trash', 'Remover alerta', `data-i="${i}"`)}
          </div>`
          )
          .join('')}
        <div><wa-button size="s" variant="brand" appearance="outlined" data-action="w-add"><wa-icon slot="start" name="plus"></wa-icon>Adicionar alerta</wa-button></div>
      </div>
    </div>
    ${isNew ? '' : `<wa-button slot="footer" appearance="plain" data-action="game-delete" style="margin-right:auto"><wa-icon slot="start" name="trash"></wa-icon>Excluir jogo</wa-button>`}
    <wa-button slot="footer" appearance="plain" data-dialog="close">Cancelar</wa-button>
    <wa-button slot="footer" variant="brand" data-action="game-save">${isNew ? 'Adicionar jogo' : 'Salvar'}</wa-button>`;
}

function collectGame() {
  const d = S.modal.draft;
  const v = (f) => String($(`#dialog [data-f="${f}"]`)?.value ?? '');
  d.name = v('name').trim();
  d.short = v('short').trim();
  d.color = v('color') || d.color;
  d.url = v('url').trim();
  d.loggedOut = {
    urlIncludes: v('lo-url').split(',').map((s) => s.trim()).filter(Boolean),
    textIncludes: v('lo-text').split(',').map((s) => s.trim()).filter(Boolean),
  };
  d.sessionTaken = { textIncludes: v('st-text').split(',').map((s) => s.trim()).filter(Boolean) };
  d.reconnecting = { textIncludes: v('rc-text').split(',').map((s) => s.trim()).filter(Boolean) };
  for (const row of $$('#dialog .acc-row')) d.accounts[Number(row.dataset.i)].name = $('[data-f="acc-name"]', row).value;
  for (const row of $$('#dialog .watch-row[data-i]')) {
    const w = d.watchers[Number(row.dataset.i)];
    const f = (n) => $(`[data-f="${n}"]`, row);
    w.enabled = f('w-enabled').checked;
    w.name = f('w-name').value;
    w.kind = f('w-kind').value;
    w.selector = f('w-selector').value;
    w.pattern = f('w-pattern').value;
    w.op = f('w-op').value;
    w.value = Number(f('w-value').value) || 0;
  }
}

// ----- configurações
// Atalhos de teclado (só leitura). Quem os trata é src/main/shortcuts.js; a interface só reage (onShortcut).
const SHORTCUTS = [
  [['Ctrl', '1…9'], 'Ir para a conta 1 a 9 da tela (a ordem do mosaico)'],
  [['Ctrl', 'Tab'], 'Ir para a próxima conta'],
  [['Ctrl', 'Shift', 'Tab'], 'Ir para a conta anterior'],
  [['F5'], 'Recarregar a conta aberta (a que está expandida ou onde você está jogando)'],
  [['Ctrl', 'M'], 'Deixar todas as contas sem som (ou liberar o som)'],
  [['Esc'], 'Voltar da conta expandida'],
];

function shortcutsHtml() {
  const keys = (list) => list.map((k) => `<kbd>${esc(k)}</kbd>`).join('<span class="plus">+</span>');
  return `<div class="form-block">
        <span class="form-label">Atalhos de teclado</span>
        <div class="shortcuts">${SHORTCUTS.map(([k, text]) => `<span class="keys">${keys(k)}</span><span>${esc(text)}</span>`).join('')}</div>
        <p class="meta">Funcionam com a janela do IdleHub em foco, até dentro dos jogos e do Painel. Não funcionam com uma janela aberta.</p>
      </div>`;
}

function settingsHtml(d) {
  const num = (f, label, hint, min, max) =>
    `<wa-input size="s" type="number" min="${min}" max="${max}" label="${esc(label)}" ${hint ? `hint="${esc(hint)}"` : ''} data-f="${f}" value="${esc(d[f])}"></wa-input>`;
  const sw = (f, label, hint = '') => `<wa-switch data-f="${f}" ${d[f] ? 'checked' : ''} ${hint ? `hint="${esc(hint)}"` : ''}>${esc(label)}</wa-switch>`;
  return `<div class="form">
      <div class="form-block">
        <span class="form-label">Watchdog</span>
        <div class="form-row">
          ${num('watchdogIntervalSec', 'Verificar cada conta a cada (s)', '', 10, 600)}
          ${num('reloadAfterFailures', 'Recarregar após quantas falhas seguidas', '', 1, 10)}
          ${num('memoryLimitMB', 'Otimizar se a conta passar de (MB)', '0 = sem limite. Reabre a conta num processo novo.', 0, 16000)}
          ${num('optimizeEveryHours', 'Otimizar cada conta a cada (horas)', '0 = desligado. Libera memória sem perder o login.', 0, 168)}
        </div>
      </div>
      <div class="form-block">
        <span class="form-label">Desempenho</span>
        <div class="form-row">
          ${num('backgroundFps', 'FPS das contas escondidas', '0 = sem limite. Só limita a animação: o jogo segue rodando.', 0, 144)}
          ${num('mosaicFps', 'FPS das contas no mosaico', '0 = sem limite. A conta expandida não tem limite.', 0, 144)}
          ${num('tileBaseWidth', 'Largura de referência do jogo (px)', 'O mosaico encolhe o jogo a partir dela.', 480, 3840)}
        </div>
      </div>
      <div class="form-block">
        <span class="form-label">Comportamento</span>
        ${sw('muteAll', 'Deixar todas as contas sem som', 'Desligado: só a conta expandida toca som.')}
        ${sw('notifyWindows', 'Mostrar notificações do Windows')}
        ${sw('closeToTray', 'Continuar rodando ao fechar a janela', 'O IdleHub fica no ícone perto do relógio.')}
        ${sw('openAtLogin', 'Abrir junto com o Windows')}
        ${sw('startMinimized', 'Começar minimizado', 'Só o ícone perto do relógio.')}
        <div class="form-row">
          ${num('awaySummaryHours', 'Mostrar o resumo ao voltar depois de (horas)', 'Se você ficar parado esse tempo, o IdleHub mostra o que aconteceu com as contas quando você voltar. 0 = desligado.', 0, 72)}
        </div>
      </div>
      ${shortcutsHtml()}
      ${remoteHtml(d)}
      <div class="form-block">
        <span class="form-label">Painel (IdleLive)</span>
        <p class="meta">Já usava o IdleLive avulso (iniciar.bat)? Traga as contas da Twitch e da Kick, os canais e o histórico.
          Feche a janela preta do IdleLive antes e, depois de importar, use só o IdleHub.</p>
        <div><wa-button size="s" variant="brand" appearance="outlined" data-action="idlelive-import"><wa-icon slot="start" name="file-import"></wa-icon>Importar dados do IdleLive</wa-button></div>
      </div>
      <div class="form-block">
        <span class="form-label">Sobre</span>
        <p class="meta">IdleHub v${esc(S.version)}. Seus dados ficam só neste PC.</p>
        <div><wa-button size="s" appearance="plain" data-action="open-data"><wa-icon slot="start" name="folder-open"></wa-icon>Abrir pasta de dados</wa-button></div>
      </div>
    </div>
    <wa-button slot="footer" appearance="plain" data-dialog="close">Cancelar</wa-button>
    <wa-button slot="footer" variant="brand" data-action="settings-save">Salvar</wa-button>`;
}

// Avisos fora do PC. O link do webhook e o token do bot ficam criptografados no app e nunca voltam para esta tela:
// aqui só se sabe se está salvo (S.remote vem do remote:status).
function remoteHtml(d) {
  return discordHtml(d) + telegramHtml(d);
}

function discordHtml(d) {
  const dc = S.remote?.channels?.discord || {};
  const noCrypto = S.remote && !S.remote.encryption;
  return `<div class="form-block">
        <span class="form-label">Avisos no celular</span>
        <p class="meta">Receba no celular os mesmos avisos do Windows: conta que caiu, alerta que disparou, sem internet. Escolha o Discord ou o Telegram (ou os dois).
          Não precisa de servidor: o IdleHub fala direto com eles. Aqui é o <b>Discord</b>.</p>
        <wa-callout variant="neutral" size="small">
          <wa-icon slot="icon" name="circle-info"></wa-icon>
          Como pegar o link: no Discord, abra o canal e vá em <b>Configurações do canal → Integrações → Webhooks → Novo webhook</b>, depois clique em <b>Copiar URL do webhook</b> e cole abaixo.
          Quem tem esse link pode escrever no seu canal, então não mostre para ninguém. O IdleHub guarda o link criptografado neste PC.
        </wa-callout>
        ${noCrypto ? `<wa-callout variant="warning" size="small"><wa-icon slot="icon" name="triangle-exclamation"></wa-icon>Este Windows não deixa o IdleHub guardar o link com segurança, então esse recurso não funciona aqui.</wa-callout>` : ''}
        <wa-input size="s" type="password" label="Link do webhook do Discord" data-remote-input="discord" autocomplete="off"
          placeholder="${dc.configured ? 'Link salvo (escondido). Cole outro para trocar.' : 'https://discord.com/api/webhooks/…'}"
          hint="${dc.configured ? 'Configurado.' : 'Ainda não configurado.'}"></wa-input>
        <div class="form-row">
          <wa-button size="s" variant="brand" data-action="remote-save" data-channel="discord" ${noCrypto ? 'disabled' : ''}><wa-icon slot="start" name="floppy-disk"></wa-icon>Salvar link</wa-button>
          <wa-button size="s" variant="brand" appearance="outlined" data-action="remote-test" data-channel="discord" ${dc.configured ? '' : 'disabled'}><wa-icon slot="start" name="paper-plane"></wa-icon>Enviar teste</wa-button>
          <wa-button size="s" appearance="plain" data-action="remote-clear" data-channel="discord" ${dc.configured ? '' : 'disabled'}><wa-icon slot="start" name="trash"></wa-icon>Remover link</wa-button>
        </div>
        <wa-switch data-f="notifyDiscord" ${d.notifyDiscord && dc.configured ? 'checked' : ''} ${dc.configured ? '' : 'disabled'} hint="Vale também com as notificações do Windows desligadas.">Mandar os avisos para o Discord</wa-switch>
      </div>`;
}

function telegramHtml(d) {
  const tg = S.remote?.channels?.telegram || {};
  const noCrypto = S.remote && !S.remote.encryption;
  const bot = tg.detail?.bot ? `@${esc(tg.detail.bot)}` : 'o bot';
  const hint = !tg.configured
    ? 'Ainda não configurado.'
    : tg.detail?.chat
      ? `Conectado a ${bot}${tg.detail.chatName ? ` (conversa com ${esc(tg.detail.chatName)})` : ''}.`
      : `Token salvo (${bot}). Falta achar a conversa: abra o bot no Telegram, mande /start e clique em Procurar conversa.`;
  return `<div class="form-block">
        <span class="form-label">Avisos no Telegram</span>
        <p class="meta">Os mesmos avisos numa conversa sua com um bot do Telegram, que só você usa.</p>
        <wa-callout variant="neutral" size="small">
          <wa-icon slot="icon" name="circle-info"></wa-icon>
          <b>1.</b> No Telegram, abra o <b>@BotFather</b>, mande <b>/newbot</b> e escolha um nome para o bot.
          <b>2.</b> Copie o <b>token</b> que ele mostrar, cole abaixo e clique em <b>Salvar token</b>.
          <b>3.</b> Abra o seu bot no Telegram, mande <b>/start</b> e clique em <b>Procurar conversa</b>.
          Quem tem o token controla o bot, então não mostre para ninguém. O IdleHub guarda o token criptografado neste PC.
        </wa-callout>
        ${noCrypto ? `<wa-callout variant="warning" size="small"><wa-icon slot="icon" name="triangle-exclamation"></wa-icon>Este Windows não deixa o IdleHub guardar o token com segurança, então esse recurso não funciona aqui.</wa-callout>` : ''}
        <wa-input size="s" type="password" label="Token do bot do Telegram" data-remote-input="telegram" autocomplete="off"
          placeholder="${tg.configured ? 'Token salvo (escondido). Cole outro para trocar.' : '123456789:AAH…'}"
          hint="${hint}"></wa-input>
        <div class="form-row">
          <wa-button size="s" variant="brand" data-action="remote-save" data-channel="telegram" ${noCrypto ? 'disabled' : ''}><wa-icon slot="start" name="floppy-disk"></wa-icon>Salvar token</wa-button>
          <wa-button size="s" variant="brand" appearance="outlined" data-action="remote-find" ${tg.configured ? '' : 'disabled'}><wa-icon slot="start" name="magnifying-glass"></wa-icon>Procurar conversa</wa-button>
          <wa-button size="s" variant="brand" appearance="outlined" data-action="remote-test" data-channel="telegram" ${tg.configured ? '' : 'disabled'}><wa-icon slot="start" name="paper-plane"></wa-icon>Enviar teste</wa-button>
          <wa-button size="s" appearance="plain" data-action="remote-clear" data-channel="telegram" ${tg.configured ? '' : 'disabled'}><wa-icon slot="start" name="trash"></wa-icon>Remover token</wa-button>
        </div>
        <wa-switch data-f="notifyTelegram" ${d.notifyTelegram && tg.detail?.chat ? 'checked' : ''} ${tg.detail?.chat ? '' : 'disabled'} hint="Vale também com as notificações do Windows desligadas.">Mandar os avisos para o Telegram</wa-switch>
      </div>`;
}

function collectSettings() {
  const d = S.modal.draft;
  for (const el of $$('#dialog [data-f]')) d[el.dataset.f] = el.localName === 'wa-switch' ? el.checked : Number(el.value);
}

// ----- enquanto você estava fora
// Quem monta o resumo é o processo principal (summarize() em src/main/events.js); aqui só se desenha.
function fmtDur(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'menos de 1 min';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
const clock = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

// Chegou numa hora ruim (configurações abertas, por exemplo)? Espera a janela fechar.
function showAway(summary) {
  S.awayPending = summary;
  showAwayPending();
}

function showAwayPending() {
  if (!S.awayPending || S.asking || !S.config) return;
  if (S.modal && S.modal.kind !== 'log' && S.modal.kind !== 'away') return;
  const summary = S.awayPending;
  S.awayPending = null;
  openModal('away', summary);
}

function awayHtml(s) {
  const t = s.totals;
  const sameDay = new Date(s.from).toDateString() === new Date(s.to).toDateString();
  const since = sameDay ? `das ${clock(s.from)} às ${clock(s.to)}` : `desde ${new Date(s.from).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
  const calm = !t.drops && !t.alerts && !s.needsAttention.length;
  const tile = (ic, value, label, warn = false) =>
    `<div class="away-stat ${warn ? 'warn' : ''}">${icon(ic)}<span class="away-num num">${value}</span><span class="meta">${esc(label)}</span></div>`;
  const stats = [
    tile('rotate-right', t.drops ? `${fmt(t.resolved)} de ${fmt(t.drops)}` : '0', t.drops ? 'quedas resolvidas' : 'quedas', t.unresolved > 0),
    tile('bell', fmt(t.alerts), t.alerts === 1 ? 'alerta disparou' : 'alertas dispararam', t.alerts > 0),
    tile('hourglass-half', t.runningMs ? fmtDur(t.runningMs) : '—', t.accounts > 1 ? `rodando, somando ${fmt(t.accounts)} contas` : 'rodando'),
  ];
  if (s.offline.count) stats.push(tile('wifi', fmtDur(s.offline.ms), s.offline.count === 1 ? 'sem internet' : `sem internet (${fmt(s.offline.count)} vezes)`, true));

  const name = (r) => esc(r.game ? `${r.game} · ${r.who}` : r.who);
  const attention = s.needsAttention.length
    ? `<div class="form-block"><span class="form-label">Precisam da sua atenção agora</span>
        <div class="away-list">${s.needsAttention
          .map((a) => `<div class="away-row"><span class="who">${name(a)}</span><span class="msg">${esc(STATUS[a.status] || a.status)}</span></div>`)
          .join('')}</div></div>`
    : '';
  const busy = s.byAccount.filter((r) => r.drops || r.alerts);
  const detail = busy.length
    ? `<div class="form-block"><span class="form-label">O que aconteceu</span>
        <div class="away-list">${busy
          .map((r) => {
            const bits = [];
            if (r.drops) bits.push(`${plural(r.drops, 'queda', 'quedas')}${r.unresolved ? (r.unresolved === r.drops ? ' (sem resolver)' : ` (${r.unresolved} sem resolver)`) : r.drops === 1 ? ' (resolvida)' : ' (resolvidas)'}`);
            if (r.alerts) bits.push(`${plural(r.alerts, 'alerta', 'alertas')}${r.alertNames.length ? `: ${r.alertNames.slice(0, 3).map((n) => `${n.name}${n.count > 1 ? ` ×${n.count}` : ''}`).join(', ')}` : ''}`);
            return `<div class="away-row"><span class="who">${name(r)}</span><span class="msg">${esc(bits.join(' · '))}</span></div>`;
          })
          .join('')}</div></div>`
    : '';
  return `<div class="form">
      <p class="meta" style="margin:0">Você ficou fora por ${esc(fmtDur(s.durationMs))} (${esc(since)}).</p>
      ${calm ? `<wa-callout variant="success" size="small"><wa-icon slot="icon" name="circle-check"></wa-icon>Tudo certo: nenhuma conta caiu nem pediu atenção nesse tempo.</wa-callout>` : ''}
      <div class="away-stats">${stats.join('')}</div>
      ${attention}${detail}
    </div>
    <wa-button slot="footer" appearance="plain" data-action="open-log"><wa-icon slot="start" name="bell"></wa-icon>Ver atividade</wa-button>
    <wa-button slot="footer" variant="brand" data-dialog="close">Fechar</wa-button>`;
}

// ----- atividade
function logHtml() {
  const items = [...S.runtime.log].reverse();
  const t = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `<p class="meta" style="margin:0 0 var(--wa-space-s)">Recargas automáticas, logouts e alertas desde que o IdleHub abriu.</p>
    ${
      items.length
        ? `<div class="log">${items.map((l) => `<div class="log-item ${l.level}"><span class="meta num">${t(l.t)}</span><span class="who">${esc(l.who)}</span><span class="msg">${esc(l.text)}</span></div>`).join('')}</div>`
        : `<div class="empty">${icon('bell')}<p>Nada aconteceu ainda. Quando uma conta for recarregada ou um alerta disparar, aparece aqui.</p></div>`
    }
    <wa-button slot="footer" variant="brand" data-dialog="close">Fechar</wa-button>`;
}

// ----- desempenho (CPU e memória)
// O histórico só vem do app com a janela aberta, no máximo a cada 5 s (o "state" não carrega isso).
async function refreshPerf() {
  if (Date.now() - S.perfAt < 5000) return;
  S.perfAt = Date.now();
  const h = await api.metricsHistory();
  if (S.modal?.kind !== 'perf') return;
  S.perf = h;
  renderModalBody();
}

// Teto "redondo" (1, 2, 5 × 10^n) acima do maior valor, para o gráfico não pular a cada ponto novo.
function niceMax(v, floor) {
  const x = Math.max(v * 1.1, floor);
  const p = 10 ** Math.floor(Math.log10(x));
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= x);
}

// Gráfico de linha feito à mão em SVG. idx: 1 = CPU, 2 = memória nos pontos [t, cpu, mem].
// Os textos ficam em HTML (o SVG estica); a linha usa vector-effect para não engrossar ao esticar.
function lineChart(points, idx, h, { title, floor, fmtV }) {
  const W = 600, H = 120;
  const vals = points.map((p) => p[idx]);
  const peak = vals.length ? Math.max(...vals) : 0;
  const cur = vals.length ? vals[vals.length - 1] : 0;
  const head = `<div class="chart-head"><span class="form-label">${title}</span><span class="meta num">agora <b>${fmtV(cur)}</b> · pico ${fmtV(peak)}</span></div>`;
  if (points.length < 2) return `<div class="chart">${head}<p class="meta chart-empty">Ainda sem dados: o gráfico enche a cada ${Math.round(h.sampleMs / 1000)} segundos.</p></div>`;
  const max = niceMax(peak, floor);
  const t0 = h.now - h.historyMs;
  const xy = points.map((p) => [Math.max(0, ((p[0] - t0) / h.historyMs) * W), H - (p[idx] / max) * H]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const area = `${line}L${xy[xy.length - 1][0].toFixed(1)},${H}L${xy[0][0].toFixed(1)},${H}Z`;
  const grid = [0.25, 0.5, 0.75].map((f) => `<line class="chart-grid" x1="0" x2="${W}" y1="${H * f}" y2="${H * f}"/>`).join('');
  return `<div class="chart">${head}
    <div class="chart-plot">
      <span class="chart-y meta num" style="top:0">${fmtV(max)}</span><span class="chart-y meta num" style="bottom:0">0</span>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(title)} na última hora">${grid}<path class="chart-area" d="${area}"/><path class="chart-line" d="${line}"/></svg>
    </div>
    <div class="chart-x meta"><span>há 60 min</span><span>há 30 min</span><span>agora</span></div></div>`;
}

function perfHtml(d) {
  const h = S.perf;
  if (!h) return `<div class="empty">${icon('gauge-high')}<p>Carregando…</p></div>`;
  const cur = h.current;
  const limit = Number(S.config.settings.memoryLimitMB) || 0;
  const memHeavy = limit > 0 ? Math.round(limit * 0.8) : 1024;
  const cpuHeavy = Math.max(1, Math.round(80 / (h.cores || 1)));

  const cells = (v, live = true) =>
    live ? `<span class="num">${fmtCpu(v.cpu)}</span><span class="num">${fmtMem(v.mem)}</span>` : '<span class="meta num">—</span><span class="meta num">—</span>';
  const row = ({ sel, name, v, live = true, heavy = false, sub = false, note = '' }) =>
    `<button class="perf-row ${sub ? 'sub' : ''} ${heavy ? 'heavy' : ''}" data-action="perf-select" data-sel="${esc(sel)}" aria-pressed="${sel === d.sel}">
      <span class="perf-name">${name}${heavy ? '<wa-badge variant="warning" pill>Pesada</wa-badge>' : ''}${note ? `<span class="meta">${esc(note)}</span>` : ''}</span>${cells(v, live)}</button>`;

  const labels = { '@app': 'App inteiro', '@other': 'Janela, Painel e outros processos' };
  let rows = row({ sel: '@app', name: '<b>App inteiro</b>', v: cur.app });
  for (const g of S.config.games) {
    const badge = `<span class="game-badge" style="background:${g.color}">${esc(g.short)}</span>`;
    labels[`@game:${g.id}`] = g.name;
    rows += row({ sel: `@game:${g.id}`, name: `${badge}<b>${esc(g.name)}</b>`, v: cur.games[g.id] || { cpu: 0, mem: 0 } });
    for (const a of g.accounts) {
      const key = keyOf(g, a);
      const r = rtOf(key, a);
      labels[key] = `${g.name} · ${a.name}`;
      const live = !a.sleeping && !!r.live;
      const note = live ? '' : a.sleeping ? 'dormindo' : STATUS[r.status] || '';
      rows += row({ sel: key, name: esc(a.name), v: cur.accounts[key] || { cpu: 0, mem: 0 }, live, heavy: !!r.heavy, sub: true, note });
    }
  }
  rows += row({ sel: '@other', name: esc(labels['@other']), v: cur.other });

  const sel = labels[d.sel] ? d.sel : '@app';
  const pts = h.series[sel] || [];
  return `<div class="form">
    <div class="perf-table">
      <div class="perf-row perf-head"><span class="form-label">Quem</span><span class="form-label">CPU</span><span class="form-label">Memória</span></div>
      ${rows}
    </div>
    <div class="form-block">
      <span class="form-label">Última hora · ${esc(labels[sel])}</span>
      ${lineChart(pts, 1, h, { title: 'CPU (% do PC)', floor: 5, fmtV: fmtCpu })}
      ${lineChart(pts, 2, h, { title: 'Memória', floor: 256, fmtV: fmtMem })}
    </div>
    <wa-callout variant="neutral" size="s"><wa-icon slot="icon" name="circle-info"></wa-icon>
      A CPU é a parte do PC inteiro que a conta usa (como no Gerenciador de Tarefas). Clique numa linha para ver o gráfico dela.
      Uma conta aparece como <b>Pesada</b> (em amarelo) quando passa de <b>${fmt(memHeavy)} MB</b> de memória
      ${limit > 0 ? '(80% do limite das Configurações)' : '(sem limite nas Configurações)'} ou quando usa em média
      <b>${cpuHeavy}% do PC</b> (quase um núcleo cheio) por um minuto. O histórico se apaga ao fechar o IdleHub.</wa-callout>
  </div>
  <wa-button slot="footer" variant="brand" data-dialog="close">Fechar</wa-button>`;
}

// ---------------------------------------------------------------- ações
async function onAction(act, el) {
  const key = el.dataset.key || el.closest('[data-key]')?.dataset.key;
  const id = el.dataset.id;
  switch (act) {
    case 'view-panel':
      S.view = { kind: 'panel' };
      return render();
    case 'panel-reload':
      return api.idleliveAction('reload-page');
    case 'panel-browser':
      return api.idleliveAction('open-browser');
    case 'panel-restart':
      S.idlelive = await api.idleliveAction('restart');
      return render();
    case 'idlelive-import': {
      el.loading = true;
      const r = await api.idleliveImport();
      el.loading = false;
      if (r.canceled) return;
      if (!r.ok) return toast(r.error);
      if (r.autostartMoved) S.openAtLogin = true;
      closeModal();
      S.view = { kind: 'panel' };
      render();
      return toast(`Pronto! Importei ${r.files.length} arquivos. O Painel está abrindo com as suas contas.`, 'info');
    }
    case 'view-all':
      S.view = { kind: 'all' };
      return render();
    case 'view-game':
      S.view = { kind: 'game', gameId: id };
      return render();
    case 'focus':
      return focusAccount(key);
    case 'back':
      S.view = S.view.back || { kind: 'all' };
      return render();
    case 'reload':
    case 'optimize':
    case 'home':
    case 'devtools':
    case 'sleep':
    case 'wake':
      await api.accountAction(key, act);
      if (act === 'optimize') toast('Otimizando a conta…', 'info');
      if (act === 'sleep' || act === 'wake') await refreshConfig();
      if (act === 'sleep' && S.view.kind === 'focus') S.view = S.view.back || { kind: 'all' };
      return render();
    case 'game-wake':
    case 'game-sleep':
    case 'game-reload':
    case 'game-optimize':
      el.loading = true;
      await api.gameAction(id || null, { 'game-wake': 'wake-all', 'game-sleep': 'sleep-all', 'game-reload': 'reload-all', 'game-optimize': 'optimize-all' }[act]);
      if (act === 'game-optimize') toast('Otimizando as contas, uma por vez…', 'info');
      await refreshConfig();
      return render();
    case 'add-game':
      return openModal('game', blankGame());
    case 'edit-game':
      return openModal('game', clone(gameById(id)));
    case 'open-settings':
      S.remote = await api.remoteStatus();
      return openModal('settings', { ...clone(S.config.settings), openAtLogin: S.openAtLogin });
    case 'remote-save': {
      const tg = el.dataset.channel === 'telegram';
      const ch = tg ? 'telegram' : 'discord';
      const input = $(`#dialog [data-remote-input="${ch}"]`);
      if (!input?.value.trim()) {
        input?.focus();
        return toast(tg ? 'Cole o token do bot do Telegram.' : 'Cole o link do webhook do Discord.');
      }
      collectSettings();
      el.loading = true;
      const r = await api.remoteSet(ch, input.value);
      el.loading = false;
      if (!r.ok) return toast(r.error);
      S.remote = r.status;
      S.config.settings = r.settings;
      S.modal.draft[tg ? 'notifyTelegram' : 'notifyDiscord'] = true;
      renderModalBody();
      return toast(tg ? 'Token salvo. Agora abra o bot no Telegram, mande /start e clique em Procurar conversa.' : 'Link salvo. Clique em Enviar teste para conferir.', 'info');
    }
    case 'remote-find': {
      collectSettings();
      el.loading = true;
      const r = await api.remoteFind('telegram');
      el.loading = false;
      if (!r.ok) return toast(r.error);
      S.remote = r.status;
      S.config.settings = r.settings;
      S.modal.draft.notifyTelegram = !!r.settings.notifyTelegram;
      renderModalBody();
      return toast('Conversa encontrada! Clique em Enviar teste para conferir.', 'info');
    }
    case 'remote-test': {
      const tg = el.dataset.channel === 'telegram';
      collectSettings();
      el.loading = true;
      const r = await api.remoteTest(tg ? 'telegram' : 'discord');
      el.loading = false;
      if (tg && r.status) {
        S.remote = r.status; // o teste pode ter achado a conversa sozinho
        S.config.settings = r.settings;
        S.modal.draft.notifyTelegram = !!r.settings.notifyTelegram;
        renderModalBody();
      }
      return r.ok ? toast(`Teste enviado! Veja ${tg ? 'a conversa com o bot no Telegram' : 'o canal no Discord'}.`, 'info') : toast(r.error);
    }
    case 'remote-clear': {
      const tg = el.dataset.channel === 'telegram';
      if (!(await ask({
        title: tg ? 'Remover o token do Telegram?' : 'Remover o link do Discord?',
        text: tg
          ? 'Os avisos deixam de ir para o Telegram. Para voltar, é só colar o token de novo (ou criar outro bot no @BotFather).'
          : 'Os avisos deixam de ir para o Discord. Para voltar, é só colar o link de novo (ou criar outro webhook).',
        ok: 'Remover',
        danger: true,
      }))) return;
      collectSettings();
      const r = await api.remoteClear(tg ? 'telegram' : 'discord');
      if (!r.ok) return toast(r.error);
      S.remote = r.status;
      S.config.settings = r.settings;
      S.modal.draft[tg ? 'notifyTelegram' : 'notifyDiscord'] = false;
      renderModalBody();
      return toast(tg ? 'Token removido.' : 'Link removido.', 'info');
    }
    case 'open-log':
      S.seenLog = Date.now();
      updateRail();
      return openModal('log');
    case 'open-perf':
      S.perf = await api.metricsHistory();
      S.perfAt = Date.now();
      return openModal('perf', { sel: '@app' });
    case 'perf-select':
      S.modal.draft.sel = el.dataset.sel;
      return renderModalBody();
    case 'open-data':
      return api.openData();

    case 'onboard-done': {
      collectOnboard();
      const sel = S.modal.draft.filter((p) => p.on);
      S.config = await api.onboard(sel);
      S.modal = null;
      S.view = { kind: 'all' };
      return render();
    }

    case 'preset-fill': {
      collectGame();
      const p = S.presets.find((x) => x.preset === el.dataset.preset);
      const d = S.modal.draft;
      Object.assign(d, {
        preset: p.preset, name: p.name, short: p.short, color: p.color, url: p.url || d.url,
        loggedOut: clone(p.loggedOut), sessionTaken: clone(p.sessionTaken), reconnecting: clone(p.reconnecting), watchers: clone(p.watchers),
        accounts: Array.from({ length: p.suggestedAccounts }, (_, i) => ({ id: '', name: `Conta ${i + 1}`, sleeping: false })),
      });
      return renderModalBody();
    }
    case 'acc-add':
      collectGame();
      S.modal.draft.accounts.push({ id: '', name: `Conta ${S.modal.draft.accounts.length + 1}`, sleeping: false });
      return renderModalBody();
    case 'acc-del': {
      collectGame();
      const d = S.modal.draft;
      const i = Number(el.dataset.i);
      const a = d.accounts[i];
      if (d.accounts.length <= 1) return toast('O jogo precisa de pelo menos uma conta.');
      if (a.id && !(await ask({ title: `Remover ${a.name}?`, text: 'O login salvo dessa conta é apagado quando você salvar o jogo. Dá para adicionar a conta de novo, mas vai ser preciso entrar nela outra vez.', ok: 'Remover', danger: true }))) return;
      d.accounts.splice(i, 1);
      return renderModalBody();
    }
    case 'w-add':
      collectGame();
      S.modal.draft.watchers.push({ id: '', name: 'Novo alerta', kind: 'text', selector: '', pattern: '', op: '>=', value: 0, enabled: true });
      return renderModalBody();
    case 'w-del':
      collectGame();
      S.modal.draft.watchers.splice(Number(el.dataset.i), 1);
      return renderModalBody();
    case 'game-save': {
      collectGame();
      const d = S.modal.draft;
      if (!d.name) {
        const input = $('#dialog [data-f="name"]');
        input?.focus();
        return toast('Dê um nome para o jogo.');
      }
      const isNew = !d.id;
      el.loading = true;
      S.config = await api.saveGame(d);
      closeModal();
      if (isNew) S.view = { kind: 'game', gameId: S.config.games[S.config.games.length - 1].id };
      render();
      return toast(isNew ? `${d.name} adicionado.` : 'Jogo salvo.', 'info');
    }
    case 'game-delete': {
      const d = S.modal.draft;
      if (!(await ask({ title: `Excluir ${d.name}?`, text: 'Todas as contas dele saem do IdleHub e os logins salvos são apagados. Não dá para desfazer.', ok: 'Excluir', danger: true }))) return;
      S.config = await api.deleteGame(d.id);
      closeModal();
      S.view = { kind: 'all' };
      return render();
    }
    case 'settings-save': {
      collectSettings();
      S.openAtLogin = !!S.modal.draft.openAtLogin;
      S.config = await api.saveSettings(S.modal.draft);
      closeModal();
      render();
      return toast('Configurações salvas.', 'info');
    }
  }
}

function focusAccount(key) {
  if (!key) return;
  const back = S.view.kind === 'focus' ? S.view.back : S.view;
  S.view = { kind: 'focus', key, gameId: key.split(':')[0], back };
  if (S.modal) closeModal();
  render();
}

// ---------------------------------------------------------------- atalhos de teclado
// Contas que valem para Ctrl+1…9 e Ctrl+Tab: as do jogo aberto ou, nas outras telas, todas (na ordem do mosaico).
function shortcutAccounts() {
  const base = S.view.kind === 'focus' ? S.view.back : S.view;
  const gid = base?.kind === 'game' ? base.gameId : null;
  const out = [];
  for (const g of S.config.games) {
    if (gid && g.id !== gid) continue;
    for (const a of g.accounts) out.push({ g, a, key: keyOf(g, a) });
  }
  return out;
}

async function onShortcut(s) {
  // Janela ou confirmação aberta: as contas estão escondidas e o jogador está no meio de outra coisa.
  if (S.modal || S.asking || !S.config) return;
  if (s.action === 'goto' || s.action === 'next' || s.action === 'prev') {
    const list = shortcutAccounts();
    if (!list.length) return;
    let i;
    if (s.action === 'goto') i = s.index;
    else {
      const cur = S.view.kind === 'focus' ? list.findIndex((x) => x.key === S.view.key) : -1;
      i = s.action === 'next' ? cur + 1 : cur < 0 ? list.length - 1 : cur - 1;
      i = (i + list.length) % list.length;
    }
    if (list[i] && !(S.view.kind === 'focus' && S.view.key === list[i].key)) focusAccount(list[i].key);
  } else if (s.action === 'reload') {
    // Vindo de dentro de uma conta, recarrega essa; senão, a que está expandida.
    const key = s.from || (S.view.kind === 'focus' ? S.view.key : null);
    const [gid, aid] = (key || '').split(':');
    const a = gameById(gid)?.accounts.find((x) => x.id === aid);
    if (!a || a.sleeping) return;
    await api.accountAction(key, 'reload');
    toast(`${a.name} recarregando…`, 'info');
  } else if (s.action === 'mute') {
    const st = { ...S.config.settings, openAtLogin: S.openAtLogin };
    st.muteAll = !st.muteAll;
    S.config = await api.saveSettings(st);
    toast(st.muteAll ? 'Todas as contas sem som.' : 'Som liberado: só a conta expandida toca.', 'info');
  }
}

async function refreshConfig() {
  const st = await api.getState();
  S.config = st.config;
  S.runtime = st.runtime;
}

// ---------------------------------------------------------------- início
async function init() {
  const st = await api.getState();
  Object.assign(S, { config: st.config, presets: st.presets, runtime: st.runtime, version: st.version, openAtLogin: st.openAtLogin });
  if (st.idlelive) S.idlelive = st.idlelive;
  // Espera a janela (já na página) ficar pronta, para as boas-vindas abrirem. O carregador do Web Awesome
  // só busca um componente quando ele aparece na página, então não dá para esperar os que ainda não foram desenhados.
  await Promise.race([customElements.whenDefined('wa-dialog'), new Promise((r) => setTimeout(r, 2000))]);
  if (!S.config.onboarded) S.modal = { kind: 'onboard', draft: onboardDraft() };
  render();

  api.onState((d) => {
    S.runtime = d.runtime;
    S.totalMem = d.totalMem;
    S.totalCpu = d.totalCpu || 0;
    if (d.idlelive) S.idlelive = d.idlelive;
    updateRuntime();
  });
  api.onFocusAccount(focusAccount);
  api.onShortcut(onShortcut);
  api.onAwaySummary(showAway);

  // Um ouvinte só para todos os botões (data-action), como pede o DESIGN.md.
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el && !el.disabled) onAction(el.dataset.action, el);
  });
  document.addEventListener('dblclick', (e) => {
    const head = e.target.closest('.tile-head');
    if (head && !e.target.closest('wa-button') && S.view.kind !== 'focus') focusAccount(head.closest('[data-key]').dataset.key);
  });
  document.addEventListener('change', (e) => {
    const f = e.target.dataset?.f || '';
    // Tipo/condição do alerta liga e desliga os campos ao lado.
    if (S.modal?.kind === 'game' && /^w-(kind|op)$/.test(f)) {
      collectGame();
      renderModalBody();
    }
    if (S.modal?.kind === 'onboard' && f === 'on') e.target.closest('.pick').classList.toggle('off', !e.target.checked);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !S.modal && !S.asking && S.view.kind === 'focus') onAction('back', document.body);
  });

  let resizeTimer;
  new ResizeObserver(() => {
    scheduleLayout();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderContent();
      updateRuntime();
    }, 120);
  }).observe($('#content'));
}

init();
