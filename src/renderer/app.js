'use strict';
const api = window.idle;

const S = {
  config: null,
  presets: [],
  runtime: { accounts: {}, log: [] },
  totalMem: 0,
  view: loadView(), // panel | all | game | focus
  modal: null,
  version: '',
  dataPath: '',
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

const IDLELIVE_STATUS = {
  running: 'Rodando',
  starting: 'Abrindo…',
  'port-busy': 'Aberto fora do IdleHub',
  crashed: 'Parou, reabrindo…',
  stopped: 'Parado',
};

const STATUS = {
  ok: 'Rodando',
  loading: 'Carregando',
  unresponsive: 'Sem resposta',
  crashed: 'Travou',
  'logged-out': 'Deslogada',
  offline: 'Sem conexão',
  sleeping: 'Dormindo',
  'no-url': 'Sem link',
};
const ISSUES = new Set(['unresponsive', 'crashed', 'logged-out', 'offline']);

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clone = (o) => JSON.parse(JSON.stringify(o));
const fmtMem = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1).replace('.', ',') + ' GB' : Math.round(mb) + ' MB');
const fmtVal = (v) => (typeof v === 'number' ? v.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : v ? 'sim' : '—');
const keyOf = (g, a) => `${g.id}:${a.id}`;
const gameById = (id) => S.config.games.find((g) => g.id === id);

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
  let h = `<button class="rail-btn panel-btn ${v.kind === 'panel' ? 'active' : ''}" data-act="view-panel" title="Painel (IdleLive): pontos da Twitch e da Kick">
      <img src="icon.png" alt="" /><span class="count" data-panel-status hidden></span></button>
    <button class="rail-btn ${v.kind === 'all' ? 'active' : ''}" data-act="view-all" title="Todas as contas">▦</button>
    <div class="rail-sep"></div>`;
  for (const g of S.config.games) {
    const active = (v.kind === 'game' || v.kind === 'focus') && v.gameId === g.id;
    h += `<button class="rail-btn ${active ? 'active' : ''}" data-act="view-game" data-id="${g.id}" title="${esc(g.name)}" style="color:${g.color}">
      ${esc(g.short)}<span class="count" data-rail-count="${g.id}"></span></button>`;
  }
  h += `<button class="rail-btn ghost" data-act="add-game" title="Adicionar jogo">+</button>
    <div class="rail-spacer"></div>
    <button class="rail-btn icon" data-act="open-log" title="Atividade e alertas">🔔<span class="count" data-log-count hidden></span></button>
    <button class="rail-btn icon" data-act="open-settings" title="Configurações">⚙</button>`;
  $('#rail').innerHTML = h;
  updateRail();
}

function renderTop() {
  const v = S.view;
  let title = 'Todas as contas';
  let actions = '';
  if (v.kind === 'panel') {
    title = 'Painel';
    actions = `
      <button class="btn" data-act="panel-reload" title="Recarrega a página do painel">⟳ Recarregar página</button>
      <button class="btn" data-act="panel-browser" title="Abre o painel no navegador do PC">↗ Abrir no navegador</button>`;
  } else if (v.kind === 'all' || v.kind === 'game') {
    const gid = v.kind === 'game' ? v.gameId : '';
    if (v.kind === 'game') title = esc(gameById(gid).name);
    actions = `
      <button class="btn" data-act="game-wake" data-id="${gid}">☀ Acordar todas</button>
      <button class="btn" data-act="game-sleep" data-id="${gid}">💤 Dormir todas</button>
      <button class="btn" data-act="game-reload" data-id="${gid}">⟳ Recarregar todas</button>
      ${v.kind === 'game' ? `<button class="btn" data-act="edit-game" data-id="${gid}">✎ Editar jogo</button>` : ''}`;
  } else {
    const it = scope()[0];
    title = `<span style="color:${it.g.color}">${esc(it.g.name)}</span> · ${esc(it.a.name)}`;
    actions = `
      <button class="btn" data-act="back">← Voltar</button>
      <button class="btn" data-act="home" data-key="${it.key}" title="Volta para o link inicial do jogo">⌂ Início</button>
      <button class="btn" data-act="reload" data-key="${it.key}">⟳ Recarregar</button>
      <button class="btn" data-act="devtools" data-key="${it.key}" title="Abre as ferramentas do Chrome para achar seletores de alertas">🔍 Inspecionar</button>
      <button class="btn" data-act="sleep" data-key="${it.key}">💤 Dormir</button>`;
  }
  $('#top').innerHTML = `<h1>${title}</h1><div class="stats" id="stats"></div><div class="top-actions">${actions}</div>`;
  updateStats();
}

function bestCols(n, W, H) {
  const gap = 10;
  const head = 30;
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
  const list = scope();
  if (!S.config.games.length || !list.length) {
    c.style.gridTemplateColumns = '1fr';
    c.style.gridTemplateRows = '1fr';
    c.innerHTML = `<div class="empty"><h2>Nenhuma conta por aqui</h2>
      <div>Adicione um jogo para começar.</div>
      <button class="btn primary" data-act="add-game">+ Adicionar jogo</button></div>`;
    scheduleLayout();
    return;
  }
  const focus = S.view.kind === 'focus';
  const cols = focus ? 1 : bestCols(list.length, c.clientWidth - 20, c.clientHeight - 20);
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
    c.innerHTML = `<div class="panel-host" data-panel data-mode="live"></div>`;
  } else {
    const msg = {
      starting: ['⏳', 'Abrindo o painel…', ''],
      'port-busy': [
        '🪟',
        'O IdleLive já está aberto fora do IdleHub',
        'Feche a janela preta do IdleLive (iniciar.bat). O painel abre aqui sozinho em alguns segundos. Os dois juntos não podem rodar: as contas cairiam.',
      ],
      crashed: ['⚠️', 'O painel parou. Abrindo de novo…', ''],
      stopped: ['⏸', 'Painel parado', ''],
    }[mode] || ['⏳', 'Abrindo o painel…', ''];
    const logs = S.idlelive.logs?.slice(-6) || [];
    c.innerHTML = `<div class="empty" data-panel-mode="${esc(mode)}">
      <div style="font-size:34px">${msg[0]}</div><h2>${esc(msg[1])}</h2>
      ${msg[2] ? `<div style="max-width:520px">${esc(msg[2])}</div>` : ''}
      ${mode === 'crashed' && logs.length ? `<pre class="panel-log">${esc(logs.join('\n'))}</pre>` : ''}
      ${mode === 'crashed' || mode === 'stopped' ? `<button class="btn" data-act="panel-restart">⟳ Abrir de novo</button>` : ''}
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
    body = `<div class="tile-body"><div class="tile-placeholder"><div class="big">💤</div><div>Conta dormindo, sem gastar memória.</div>
      <button class="btn" data-act="wake">☀ Acordar</button></div></div>`;
  else
    body = `<div class="tile-body"><div class="tile-placeholder"><div class="big">🔗</div><div>Falta o link do ${esc(g.name)}.</div>
      <button class="btn primary" data-act="edit-game" data-id="${g.id}">Adicionar link</button></div></div>`;

  return `<div class="tile" data-key="${key}" data-mode="${mode}">
    <div class="tile-head" title="Clique duas vezes para expandir">
      <span class="dot" data-dot></span>
      ${showBadge ? `<span class="badge" style="background:${g.color}">${esc(g.short)}</span>` : ''}
      <span class="tile-name">${esc(a.name)}</span>
      <span class="tile-status" data-status></span>
      <span class="vals" data-vals></span>
      <span class="mem" data-mem></span>
      ${
        focus
          ? ''
          : `<div class="tile-actions">
        <button class="ic" data-act="focus" title="Expandir">⤢</button>
        <button class="ic" data-act="reload" title="Recarregar">⟳</button>
        ${mode === 'sleep' ? `<button class="ic" data-act="wake" title="Acordar">☀</button>` : `<button class="ic" data-act="sleep" title="Dormir (libera memória)">💤</button>`}
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
  if (S.modal?.kind === 'log') renderModal();
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
    $('[data-mem]', el).textContent = r.mem ? fmtMem(r.mem) : '';
    const ws = (g.watchers || []).filter((w) => w.enabled);
    $('[data-vals]', el).innerHTML = ws
      .map((w) => {
        const v = r.values?.[w.id];
        const hit = !!r.trig?.[w.id];
        if (w.kind === 'text') return hit ? `<span class="val hit">⚑ ${esc(w.name)}</span>` : '';
        if (v == null) return '';
        return `<span class="val ${hit ? 'hit' : ''}" title="${esc(w.name)}">${esc(w.name)} ${fmtVal(v)}</span>`;
      })
      .join('');
    el.classList.toggle('alerting', Object.values(r.trig || {}).some(Boolean));
  }
  return needRender;
}

function updateStats() {
  const el = $('#stats');
  if (!el) return;
  if (S.view.kind === 'panel') return updatePanelStats(el);
  const list = scope();
  let running = 0, sleeping = 0, issues = 0, mem = 0;
  for (const { a, key } of list) {
    const r = rtOf(key, a);
    if (a.sleeping) sleeping++;
    else if (r.live) running++;
    if (ISSUES.has(r.status)) issues++;
    mem += r.mem || 0;
  }
  el.innerHTML = `
    <span class="chip"><b>${running}</b> rodando</span>
    <span class="chip"><b>${sleeping}</b> dormindo</span>
    ${issues ? `<span class="chip" style="border-color:var(--warn)"><b style="color:var(--warn)">${issues}</b> com problema</span>` : ''}
    <span class="chip" title="Memória das contas mostradas · total do painel">RAM <b>${fmtMem(mem)}</b> · painel ${fmtMem(S.totalMem)}</span>`;
}

// No Painel: status do IdleLive e quantas contas dos jogos seguem rodando por trás.
function updatePanelStats(el) {
  let running = 0, total = 0;
  for (const g of S.config.games)
    for (const a of g.accounts) {
      total++;
      if (!a.sleeping && rtOf(keyOf(g, a), a).live) running++;
    }
  const st = S.idlelive.status;
  const color = st === 'running' ? 'var(--ok)' : st === 'port-busy' || st === 'crashed' ? 'var(--warn)' : 'var(--muted)';
  el.innerHTML = `
    <span class="chip">IdleLive <b style="color:${color}">${esc(IDLELIVE_STATUS[st] || st)}</b></span>
    ${total ? `<span class="chip" title="As contas dos jogos continuam rodando enquanto você vê o painel">🎮 <b>${running}</b>/${total} contas rodando em segundo plano</span>` : ''}
    <span class="chip">RAM do app <b>${fmtMem(S.totalMem)}</b></span>`;
}

function updateRail() {
  const ps = $('[data-panel-status]');
  if (ps) {
    const bad = S.idlelive.status === 'port-busy' || S.idlelive.status === 'crashed';
    ps.hidden = !bad;
    ps.textContent = '!';
    ps.classList.toggle('alert', bad);
  }
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
    el.classList.toggle('alert', issues > 0);
  }
  const alerts = S.runtime.log.filter((l) => l.level !== 'info' && l.t > S.seenLog).length;
  const lc = $('[data-log-count]');
  if (lc) {
    lc.hidden = !alerts;
    lc.textContent = alerts > 99 ? '99+' : alerts;
    lc.classList.add('alert');
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
  if (S.modal) return api.setLayout([]);
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

// ---------------------------------------------------------------- modais
function openModal(kind, draft) {
  S.modal = { kind, draft };
  renderModal();
}
function closeModal() {
  S.modal = null;
  renderModal();
}

function renderModal() {
  const root = $('#modal-root');
  const m = S.modal;
  if (!m) {
    root.innerHTML = '';
    scheduleLayout();
    return;
  }
  const scroll = $('.modal .body', root)?.scrollTop || 0;
  const html =
    m.kind === 'onboard' ? onboardHtml(m.draft) :
    m.kind === 'game' ? gameHtml(m.draft) :
    m.kind === 'settings' ? settingsHtml(m.draft) :
    m.kind === 'log' ? logHtml() : '';
  root.innerHTML = `<div class="backdrop"><div class="modal">${html}</div></div>`;
  const body = $('.modal .body', root);
  if (body) body.scrollTop = scroll;
  scheduleLayout();
}

// ----- boas-vindas
function onboardDraft() {
  return S.presets.map((p) => ({ preset: p.preset, name: p.name, short: p.short, color: p.color, on: true, accounts: p.suggestedAccounts, url: p.url }));
}

function onboardHtml(d) {
  return `
    <header><h2>Bem-vindo ao IdleHub 👋</h2>
      <p>Escolha seus jogos e quantas contas de cada. Dá para mudar tudo depois.</p></header>
    <div class="body">
      ${d
        .map(
          (p, i) => `
        <label class="pick ${p.on ? '' : 'off'}" data-i="${i}">
          <input type="checkbox" data-f="on" ${p.on ? 'checked' : ''} />
          <span style="display:flex;gap:8px;align-items:center"><span class="badge" style="background:${p.color}">${esc(p.short)}</span><b>${esc(p.name)}</b></span>
          <span class="field"><span>Contas</span><input class="input" type="number" min="1" max="12" data-f="accounts" value="${p.accounts}" /></span>
          <span class="field"><span>Link do jogo</span><input class="input" data-f="url" value="${esc(p.url)}" placeholder="Cole o link (ex.: https://...)" /></span>
        </label>`
        )
        .join('')}
      <p class="hint">Cada conta abre separada, com o próprio login. Na primeira vez, expanda cada conta (⤢) e entre nela; depois o painel lembra.</p>
      <p class="hint">Qualquer outro jogo de navegador pode ser adicionado pelo botão <b>+</b> na barra lateral.</p>
    </div>
    <footer><button class="btn primary" data-act="onboard-done">Criar meu painel</button></footer>`;
}

function collectOnboard() {
  for (const row of $$('.pick')) {
    const p = S.modal.draft[Number(row.dataset.i)];
    p.on = $('[data-f="on"]', row).checked;
    p.accounts = Math.max(1, Math.min(12, Number($('[data-f="accounts"]', row).value) || 1));
    p.url = $('[data-f="url"]', row).value.trim();
  }
}

// ----- jogo (novo/editar)
function blankGame() {
  return {
    id: '', preset: null, name: '', short: '', color: '#8b5cf6', url: '',
    accounts: [{ id: '', name: 'Conta 1', sleeping: false }],
    loggedOut: { urlIncludes: ['login'], textIncludes: [] },
    watchers: [],
  };
}

function gameHtml(d) {
  const isNew = !d.id;
  const presetBtns = isNew
    ? `<div class="section-title">Começar de um modelo</div><div class="row">
        ${S.presets.map((p) => `<button class="btn" data-act="preset-fill" data-preset="${p.preset}"><span class="badge" style="background:${p.color}">${esc(p.short)}</span>${esc(p.name)}</button>`).join('')}
       </div>`
    : '';
  const ops = [['>=', '≥'], ['<=', '≤'], ['>', '>'], ['<', '<'], ['=', '='], ['change', 'mudou']];
  return `
    <header><h2>${isNew ? 'Adicionar jogo' : 'Editar ' + esc(d.name)}</h2>
      <p>Qualquer jogo idle de navegador funciona: basta o link.</p></header>
    <div class="body">
      ${presetBtns}
      <div class="section-title">Jogo</div>
      <div class="row">
        <label class="field" style="flex:2"><span>Nome</span><input class="input" data-f="name" value="${esc(d.name)}" placeholder="Ex.: PokeIdle" /></label>
        <label class="field" style="flex:0 0 90px;min-width:90px"><span>Sigla</span><input class="input" data-f="short" maxlength="4" value="${esc(d.short)}" placeholder="PK" /></label>
        <label class="field" style="flex:0 0 60px;min-width:60px"><span>Cor</span><input class="input" type="color" data-f="color" value="${esc(d.color)}" /></label>
      </div>
      <div class="row" style="margin-top:10px">
        <label class="field"><span>Link do jogo</span><input class="input" data-f="url" value="${esc(d.url)}" placeholder="https://..." /></label>
      </div>

      <div class="section-title">Contas (${d.accounts.length}/12)</div>
      ${d.accounts
        .map(
          (a, i) => `<div class="list-row acc-row" data-i="${i}">
          <input class="input" data-f="acc-name" value="${esc(a.name)}" style="max-width:280px" />
          <button class="ic" data-act="acc-del" data-i="${i}" title="Remover conta">✕</button></div>`
        )
        .join('')}
      ${d.accounts.length < 12 ? `<button class="btn small" data-act="acc-add">+ Conta</button>` : ''}

      <div class="section-title">Detectar quando a conta sai do login</div>
      <div class="row">
        <label class="field"><span>O link contém (separe por vírgula)</span><input class="input" data-f="lo-url" value="${esc(d.loggedOut.urlIncludes.join(', '))}" placeholder="login, signin" /></label>
        <label class="field"><span>A página mostra o texto</span><input class="input" data-f="lo-text" value="${esc(d.loggedOut.textIncludes.join(', '))}" placeholder="Entrar, Faça login" /></label>
      </div>

      <div class="section-title">Alertas</div>
      <p class="hint"><b>Texto</b>: avisa quando a palavra aparecer na página (ex.: <code>shiny</code>).
        <b>Número</b>: lê um valor e avisa pela condição. Use um <b>seletor CSS</b> (botão 🔍 Inspecionar numa conta expandida → clique direito no valor → Copy selector)
        e/ou uma <b>regex</b> com um grupo, ex.: <code>Ouro:\\s*([\\d.,]+[kKmM]?)</code>.</p>
      ${
        d.watchers.length
          ? `<div class="watch-row watch-head"><span></span><span>Nome</span><span>Tipo</span><span>Seletor CSS (opcional)</span><span>Texto / regex</span><span>Condição</span><span>Valor</span><span></span></div>`
          : ''
      }
      ${d.watchers
        .map(
          (w, i) => `<div class="watch-row" data-i="${i}">
          <input type="checkbox" data-f="w-enabled" ${w.enabled ? 'checked' : ''} title="Ligado" />
          <input class="input" data-f="w-name" value="${esc(w.name)}" placeholder="Nome" />
          <select class="input" data-f="w-kind"><option value="text" ${w.kind === 'text' ? 'selected' : ''}>Texto</option><option value="number" ${w.kind === 'number' ? 'selected' : ''}>Número</option></select>
          <input class="input" data-f="w-selector" value="${esc(w.selector)}" placeholder="#gold" />
          <input class="input" data-f="w-pattern" value="${esc(w.pattern)}" placeholder="${w.kind === 'text' ? 'shiny' : 'regex (opcional)'}" />
          <select class="input" data-f="w-op" ${w.kind === 'text' ? 'disabled' : ''}>${ops.map(([v, l]) => `<option value="${v}" ${w.op === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <input class="input" type="number" data-f="w-value" value="${esc(w.value)}" ${w.kind === 'text' || w.op === 'change' ? 'disabled' : ''} />
          <button class="ic" data-act="w-del" data-i="${i}" title="Remover alerta">✕</button>
        </div>`
        )
        .join('')}
      <button class="btn small" data-act="w-add">+ Alerta</button>
      <div style="height:12px"></div>
    </div>
    <footer>
      ${isNew ? '' : `<button class="btn danger left" data-act="game-delete">Excluir jogo</button>`}
      <button class="btn" data-act="modal-close">Cancelar</button>
      <button class="btn primary" data-act="game-save">${isNew ? 'Adicionar' : 'Salvar'}</button>
    </footer>`;
}

function collectGame() {
  const d = S.modal.draft;
  const v = (f) => $(`[data-f="${f}"]`)?.value ?? '';
  d.name = v('name').trim();
  d.short = v('short').trim();
  d.color = v('color');
  d.url = v('url').trim();
  d.loggedOut = {
    urlIncludes: v('lo-url').split(',').map((s) => s.trim()).filter(Boolean),
    textIncludes: v('lo-text').split(',').map((s) => s.trim()).filter(Boolean),
  };
  for (const row of $$('.acc-row')) d.accounts[Number(row.dataset.i)].name = $('[data-f="acc-name"]', row).value;
  for (const row of $$('.watch-row[data-i]')) {
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
function settingsHtml(d) {
  const num = (f, label, hint, min, max) =>
    `<label class="field"><span>${label}</span><input class="input" type="number" min="${min}" max="${max}" data-f="${f}" value="${esc(d[f])}" />${hint ? `<span class="hint" style="margin:0">${hint}</span>` : ''}</label>`;
  const chk = (f, label) => `<label class="check"><input type="checkbox" data-f="${f}" ${d[f] ? 'checked' : ''} /> ${label}</label>`;
  return `
    <header><h2>Configurações</h2><p>Valem para todos os jogos.</p></header>
    <div class="body">
      <div class="section-title">Watchdog</div>
      <div class="row">
        ${num('watchdogIntervalSec', 'Verificar cada conta a cada (s)', '', 10, 600)}
        ${num('reloadAfterFailures', 'Recarregar após quantas falhas seguidas', '', 1, 10)}
        ${num('memoryLimitMB', 'Recarregar se a conta passar de (MB)', '0 = sem limite', 0, 16000)}
      </div>
      <div class="section-title">Desempenho</div>
      <div class="row">
        ${num('backgroundFps', 'FPS das contas escondidas', '0 = sem limite. Menos FPS = menos CPU/GPU.', 0, 144)}
        ${num('mosaicFps', 'FPS das contas no mosaico', '0 = sem limite. A conta expandida não tem limite.', 0, 144)}
        ${num('tileBaseWidth', 'Largura de referência do jogo (px)', 'O mosaico encolhe o jogo a partir dela.', 480, 3840)}
      </div>
      <div class="section-title">Comportamento</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${chk('muteAll', 'Deixar todas as contas sem som (desmarcado: só a conta expandida toca som)')}
        ${chk('notifyWindows', 'Mostrar notificações do Windows')}
        ${chk('closeToTray', 'Ao fechar a janela, continuar rodando perto do relógio')}
        ${chk('openAtLogin', 'Abrir junto com o Windows')}
        ${chk('startMinimized', 'Começar minimizado (só o ícone perto do relógio)')}
      </div>
      <div class="section-title">Painel (IdleLive)</div>
      <p class="hint">Já usava o IdleLive avulso (iniciar.bat)? Traga as contas da Twitch e da Kick, os canais e o histórico.
        Feche a janela preta do IdleLive antes e, depois de importar, use só o IdleHub.</p>
      <button class="btn small" data-act="idlelive-import">📥 Importar dados do IdleLive…</button>
      <div class="section-title">Sobre</div>
      <p class="hint">IdleHub v${esc(S.version)} · Seus dados ficam só neste PC.
        <button class="btn small" data-act="open-data">Abrir pasta de dados</button></p>
    </div>
    <footer><button class="btn" data-act="modal-close">Cancelar</button><button class="btn primary" data-act="settings-save">Salvar</button></footer>`;
}

function collectSettings() {
  const d = S.modal.draft;
  for (const el of $$('.modal [data-f]')) d[el.dataset.f] = el.type === 'checkbox' ? el.checked : Number(el.value);
}

// ----- atividade
function logHtml() {
  const items = [...S.runtime.log].reverse();
  const t = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `
    <header><h2>Atividade</h2><p>Recargas automáticas, logouts e alertas desta sessão.</p></header>
    <div class="body"><div class="log">
      ${
        items.length
          ? items.map((l) => `<div class="log-item ${l.level}"><span class="t">${t(l.t)}</span><span class="who">${esc(l.who)}</span><span class="msg">${esc(l.text)}</span></div>`).join('')
          : '<p class="hint">Nada aconteceu ainda. 😴</p>'
      }
    </div></div>
    <footer><button class="btn primary" data-act="modal-close">Fechar</button></footer>`;
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
      const r = await api.idleliveImport();
      if (r.canceled) return;
      if (!r.ok) return alert(r.error);
      alert(`Pronto! Importei: ${r.files.join(', ')}.\n\nO painel está abrindo com as suas contas.`);
      if (r.autostartMoved) S.openAtLogin = true;
      S.modal = null;
      S.view = { kind: 'panel' };
      return render();
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
    case 'home':
    case 'devtools':
    case 'sleep':
    case 'wake':
      await api.accountAction(key, act);
      if (act === 'sleep' || act === 'wake') await refreshConfig();
      if (act === 'sleep' && S.view.kind === 'focus') S.view = S.view.back || { kind: 'all' };
      return render();
    case 'game-wake':
    case 'game-sleep':
    case 'game-reload':
      await api.gameAction(id || null, { 'game-wake': 'wake-all', 'game-sleep': 'sleep-all', 'game-reload': 'reload-all' }[act]);
      await refreshConfig();
      return render();
    case 'add-game':
      return openModal('game', blankGame());
    case 'edit-game':
      return openModal('game', clone(gameById(id)));
    case 'open-settings':
      return openModal('settings', { ...clone(S.config.settings), openAtLogin: S.openAtLogin });
    case 'open-log':
      S.seenLog = Date.now();
      updateRail();
      return openModal('log');
    case 'open-data':
      return api.openData();
    case 'modal-close':
      if (S.modal?.kind === 'log') S.seenLog = Date.now();
      closeModal();
      return updateRail();

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
        loggedOut: clone(p.loggedOut), watchers: clone(p.watchers),
        accounts: Array.from({ length: p.suggestedAccounts }, (_, i) => ({ id: '', name: `Conta ${i + 1}`, sleeping: false })),
      });
      return renderModal();
    }
    case 'acc-add':
      collectGame();
      S.modal.draft.accounts.push({ id: '', name: `Conta ${S.modal.draft.accounts.length + 1}`, sleeping: false });
      return renderModal();
    case 'acc-del': {
      collectGame();
      const d = S.modal.draft;
      const a = d.accounts[Number(el.dataset.i)];
      if (d.accounts.length <= 1) return alert('O jogo precisa de pelo menos uma conta.');
      if (a.id && !confirm(`Remover "${a.name}"? O login salvo dessa conta será apagado ao salvar.`)) return;
      d.accounts.splice(Number(el.dataset.i), 1);
      return renderModal();
    }
    case 'w-add':
      collectGame();
      S.modal.draft.watchers.push({ id: '', name: 'Novo alerta', kind: 'text', selector: '', pattern: '', op: '>=', value: 0, enabled: true });
      return renderModal();
    case 'w-del':
      collectGame();
      S.modal.draft.watchers.splice(Number(el.dataset.i), 1);
      return renderModal();
    case 'game-save': {
      collectGame();
      const d = S.modal.draft;
      if (!d.name) return alert('Dê um nome para o jogo.');
      const isNew = !d.id;
      S.config = await api.saveGame(d);
      S.modal = null;
      if (isNew) S.view = { kind: 'game', gameId: S.config.games[S.config.games.length - 1].id };
      return render();
    }
    case 'game-delete': {
      const d = S.modal.draft;
      if (!confirm(`Excluir "${d.name}" e todas as contas dele? Os logins salvos serão apagados.`)) return;
      S.config = await api.deleteGame(d.id);
      S.modal = null;
      S.view = { kind: 'all' };
      return render();
    }
    case 'settings-save': {
      collectSettings();
      S.openAtLogin = !!S.modal.draft.openAtLogin;
      S.config = await api.saveSettings(S.modal.draft);
      S.modal = null;
      return render();
    }
  }
}

function focusAccount(key) {
  if (!key) return;
  const back = S.view.kind === 'focus' ? S.view.back : S.view;
  S.view = { kind: 'focus', key, gameId: key.split(':')[0], back };
  S.modal = null;
  render();
}

async function refreshConfig() {
  const st = await api.getState();
  S.config = st.config;
  S.runtime = st.runtime;
}

// ---------------------------------------------------------------- init
async function init() {
  const st = await api.getState();
  Object.assign(S, { config: st.config, presets: st.presets, runtime: st.runtime, version: st.version, dataPath: st.dataPath, openAtLogin: st.openAtLogin });
  if (st.idlelive) S.idlelive = st.idlelive;
  if (!S.config.onboarded) S.modal = { kind: 'onboard', draft: onboardDraft() };
  render();

  api.onState((d) => {
    S.runtime = d.runtime;
    S.totalMem = d.totalMem;
    if (d.idlelive) S.idlelive = d.idlelive;
    updateRuntime();
  });
  api.onFocusAccount(focusAccount);

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el) onAction(el.dataset.act, el);
  });
  document.addEventListener('dblclick', (e) => {
    const head = e.target.closest('.tile-head');
    if (head && !e.target.closest('button') && S.view.kind !== 'focus') focusAccount(head.closest('[data-key]').dataset.key);
  });
  document.addEventListener('change', (e) => {
    // alterna campos dependentes no modal de jogo / boas-vindas
    if (S.modal?.kind === 'game' && /^w-(kind|op)$/.test(e.target.dataset.f || '')) {
      collectGame();
      renderModal();
    }
    if (S.modal?.kind === 'onboard' && e.target.dataset.f === 'on') e.target.closest('.pick').classList.toggle('off', !e.target.checked);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (S.modal && S.modal.kind !== 'onboard') onAction('modal-close', document.body);
    else if (!S.modal && S.view.kind === 'focus') onAction('back', document.body);
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
