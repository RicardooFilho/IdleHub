// Análise de risco de uma extensão do Chrome ANTES de instalar (TAG-36) e comparação entre duas
// versões. Só funções puras (a leitura de arquivos fica em extensions.js), para testar com node:test.
// Regras vindas de docs/extensoes.md: só MV3; endereços só dos jogos do usuário; recusa as
// permissões que dão acesso à sessão da conta ou à rede inteira.

// Domínios de dois níveis comuns (com.br, co.uk…): neles o "site" tem 3 pedaços. Igual a optimize.js.
const SECOND_LEVEL = new Set(['com', 'co', 'org', 'net', 'gov', 'edu']);
const siteOf = (host) => {
  const parts = String(host).toLowerCase().split('.');
  const n = parts.length >= 3 && parts[parts.length - 1].length === 2 && SECOND_LEVEL.has(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-n).join('.');
};

// Permissões que o IdleHub RECUSA: veem ou mexem na sessão da conta ou na rede de fora do jogo.
const BLOCKED = {
  cookies: 'lê e muda os cookies (o login das contas)',
  webRequest: 'vê e mexe em todos os pedidos de rede da conta',
  webRequestBlocking: 'bloqueia e altera pedidos de rede da conta',
  debugger: 'controla a página por inteiro, como as ferramentas de desenvolvedor',
  nativeMessaging: 'conversa com programas do seu PC',
  proxy: 'muda o proxy da conta (proxy e VPN são proibidos pelos jogos)',
  vpnProvider: 'cria uma VPN (VPN é proibida pelos jogos)',
};

// Permissões que o IdleHub aceita, mas que o jogador precisa saber: nível 'high', 'medium' ou 'low'.
const PERMS = {
  scripting: ['medium', 'injeta código nas páginas das contas'],
  tabs: ['medium', 'vê o endereço e o título das abas da conta'],
  storage: ['low', 'guarda dados da própria extensão'],
  unlimitedStorage: ['low', 'guarda muitos dados da própria extensão'],
  alarms: ['low', 'faz tarefas em intervalos de tempo, mesmo sem a página aberta'],
  idle: ['low', 'sabe se você está parado'],
  offscreen: ['low', 'abre páginas escondidas'],
  declarativeNetRequest: ['medium', 'bloqueia ou redireciona pedidos de rede da conta'],
  declarativeNetRequestWithHostAccess: ['medium', 'bloqueia ou redireciona pedidos de rede da conta'],
  activeTab: ['low', 'acessa a aba quando você usa a extensão'],
  management: ['medium', 'vê e liga ou desliga outras extensões'],
  history: ['high', 'lê o histórico de páginas'],
  bookmarks: ['medium', 'lê e muda os favoritos'],
  browsingData: ['high', 'apaga dados de navegação'],
  clipboardRead: ['high', 'lê o que você copiou'],
  clipboardWrite: ['medium', 'escreve na área de transferência'],
  geolocation: ['medium', 'vê sua localização'],
  identity: ['high', 'acessa a conta Google do navegador'],
  privacy: ['medium', 'muda configurações de privacidade'],
  desktopCapture: ['high', 'grava a tela'],
  tabCapture: ['high', 'grava o conteúdo das abas'],
  pageCapture: ['high', 'salva as páginas'],
  topSites: ['medium', 'vê os sites mais visitados'],
  downloads: ['medium', 'baixa arquivos'],
  notifications: ['low', 'mostra notificações'],
  contextMenus: ['low', 'mexe no menu do botão direito'],
  webNavigation: ['medium', 'acompanha a navegação das páginas'],
  sidePanel: ['low', 'abre um painel lateral'],
  power: ['low', 'impede o PC de dormir'],
  system: ['medium', 'vê informações do PC'],
};

// O que o IdleHub (Electron 45) NÃO oferece às extensões: ela pode carregar, mas quebra ou não faz nada.
const UNSUPPORTED = ['notifications', 'contextMenus', 'downloads', 'sidePanel', 'webNavigation', 'power'];

// Extensões que já foram testadas dentro do IdleHub (docs/extensoes.md), pelo ID da Web Store.
const TESTED = { mhnplloljgchpfpcpbhmcokmnefodjnh: '/hunt for PokeIdle' };

const isHostPattern = (s) => s === '<all_urls>' || /^(\*|https?|wss?|ftp|file):\/\//i.test(s);

// "https://*.pokeidle.io/app/*" -> { scheme, host, path }. null se não for um padrão válido.
function parsePattern(pat) {
  const m = /^(\*|https?|wss?|ftp|file):\/\/([^/]*)(\/.*)$/i.exec(String(pat));
  return m ? { scheme: m[1].toLowerCase(), host: m[2].toLowerCase(), path: m[3] } : null;
}

const hostOfPattern = (pat) => {
  if (pat === '<all_urls>') return '*';
  const p = parsePattern(pat);
  return p ? p.host.replace(/:\d+$/, '') : '';
};

// O padrão só vale para sites dos jogos do usuário? Curinga no site inteiro (*, <all_urls>, *.com) não vale.
function patternAllowed(pat, gameHosts) {
  const p = parsePattern(pat);
  if (!p || (p.scheme !== '*' && p.scheme !== 'http' && p.scheme !== 'https')) return false;
  const host = p.host.replace(/:\d+$/, '').replace(/^\*\./, '');
  if (!host || host.includes('*') || !host.includes('.')) return false;
  const sites = new Set((gameHosts || []).map(siteOf));
  return sites.has(siteOf(host));
}

// Caminho de arquivo dentro da extensão: sem .., sem barra no começo, sem letra de unidade.
const badPath = (p) => typeof p !== 'string' || !p || /^([a-z]:|[\\/])/i.test(p) || p.split(/[\\/]/).includes('..');

// ---------- análise do manifest ----------
// `gameHosts`: endereços (hostnames) dos jogos configurados. Devolve o que bloqueia (errors), o que
// merece atenção (warnings) e as listas que a tela de risco mostra.
function analyzeManifest(manifest, { gameHosts = [], files = null } = {}) {
  const errors = [];
  const warnings = [];
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  if (!m.name || !m.version) errors.push('O manifest da extensão não tem nome ou versão.');
  if (m.manifest_version !== 3) errors.push('Só extensões do Chrome no formato novo (Manifest V3) funcionam. Esta usa o formato antigo.');

  const perms = [];
  const optional = [];
  const hostsAll = [];
  const hostsOptional = [];
  for (const [src, list] of [['permissions', m.permissions], ['optional_permissions', m.optional_permissions]]) {
    for (const p of Array.isArray(list) ? list : []) {
      if (typeof p !== 'string') continue;
      if (isHostPattern(p)) (src === 'permissions' ? hostsAll : hostsOptional).push(p); // MV2 mistura endereços nas permissões
      else (src === 'permissions' ? perms : optional).push(p);
    }
  }
  const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  hostsAll.push(...asList(m.host_permissions));
  hostsOptional.push(...asList(m.optional_host_permissions));

  const scriptHosts = [];
  const scriptFiles = [];
  for (const cs of Array.isArray(m.content_scripts) ? m.content_scripts : []) {
    scriptHosts.push(...asList(cs?.matches));
    scriptFiles.push(...asList(cs?.js), ...asList(cs?.css));
  }

  for (const p of [...perms, ...optional]) if (BLOCKED[p]) errors.push(`Pede a permissão "${p}": ${BLOCKED[p]}. O IdleHub não instala extensões assim.`);
  if (!gameHosts.length && (scriptHosts.length || hostsAll.length)) errors.push('Adicione primeiro o jogo no IdleHub: a extensão só pode agir nos sites dos seus jogos.');
  const outside = [...new Set([...scriptHosts, ...hostsAll].filter((h) => !patternAllowed(h, gameHosts)))];
  if (gameHosts.length && outside.length) {
    errors.push(`Quer acessar sites que não são dos seus jogos (${outside.slice(0, 4).join(', ')}${outside.length > 4 ? '…' : ''}). Isso incluiria até o login do Google. O IdleHub só instala extensões que ficam no site do jogo.`);
  }
  for (const h of hostsOptional) if (!patternAllowed(h, gameHosts)) warnings.push(`Pode pedir acesso depois a outros sites (${h}).`);

  // Caminhos dos arquivos citados no manifest: sem "..", e têm de existir quando a lista de arquivos é conhecida.
  const refs = [...scriptFiles, m.background?.service_worker, m.action?.default_popup, m.options_page, m.options_ui?.page].filter(Boolean);
  for (const r of refs) if (badPath(r)) errors.push(`O manifest cita um caminho de arquivo inválido (${String(r).slice(0, 60)}).`);
  if (files) {
    const have = new Set(files);
    for (const r of [...scriptFiles, m.background?.service_worker].filter((x) => x && !badPath(x))) {
      if (!have.has(String(r).replace(/^\.\//, ''))) errors.push(`O manifest cita o arquivo "${r}", que não está na extensão.`);
    }
  }

  const permissions = perms.map((name) => ({ name, level: PERMS[name]?.[0] || 'low', label: PERMS[name]?.[1] || 'permissão sem descrição' }));
  if (m.background?.service_worker) permissions.unshift({ name: 'service_worker', level: 'medium', label: 'roda em segundo plano o tempo todo, mesmo sem você usar a conta' });
  if (m.devtools_page) warnings.push('Mexe nas ferramentas de desenvolvedor.');
  if (m.externally_connectable?.matches) warnings.push('Aceita mensagens de sites de fora.');

  return {
    errors, warnings, permissions,
    scriptHosts: [...new Set(scriptHosts)],
    hostPermissions: [...new Set(hostsAll)],
    optionalPermissions: optional,
    usesServiceWorker: !!m.background?.service_worker,
  };
}

// ---------- compatibilidade ----------
// level: 'tested' (testada no IdleHub), 'ok' (nada de estranho), 'limited' (parte só funciona por popup/opções),
// 'incompatible' (usa o que o IdleHub não tem).
function compatibility(manifest, id) {
  const m = manifest || {};
  const perms = [...(Array.isArray(m.permissions) ? m.permissions : []), ...(Array.isArray(m.optional_permissions) ? m.optional_permissions : [])];
  const missing = UNSUPPORTED.filter((p) => perms.includes(p));
  const notes = [];
  if (missing.length) notes.push(`Usa recursos que o IdleHub ainda não tem (${missing.join(', ')}). Ela pode quebrar ou não fazer nada.`);
  if (m.commands && Object.keys(m.commands).length) notes.push('Usa atalhos de teclado de extensão, que não funcionam no IdleHub.');
  const popup = !!m.action?.default_popup || !!m.browser_action?.default_popup;
  const options = !!m.options_page || !!m.options_ui?.page;
  if (popup) notes.push('Tem uma janelinha no ícone (popup). O IdleHub não mostra ícone nem popup de extensão.');
  if (options) notes.push('Tem página de opções, que não abre no IdleHub.');
  const onlyPopup = popup && !(m.content_scripts || []).length && !m.background?.service_worker;
  if (onlyPopup) notes.push('Só funciona pelo popup: aqui ela não vai fazer nada.');
  let level = 'ok';
  if (missing.length || (m.commands && Object.keys(m.commands).length)) level = 'incompatible';
  else if (onlyPopup || popup || options) level = 'limited';
  else if (TESTED[id]) level = 'tested';
  return { level, notes };
}

// ---------- análise do código ----------
const NOISE_HOSTS = /(^|\.)(w3\.org|schema\.org|mozilla\.org|reactjs\.org|nodejs\.org|fb\.me|example\.com|localhost\.localdomain)$/i;
const hostRe = /\b(?:https?|wss?):\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?/gi;
const count = (text, re) => (text.match(re) || []).length;

// Procura no código (texto de cada .js/.html) sinais de rede e de automação. É só um aviso, não uma
// prova: código minificado ou montado na hora (texto + texto) escapa, e uma ferramenta honesta também clica.
function scanCode(files) {
  const hosts = new Set();
  const net = { fetch: 0, xhr: 0, websocket: 0, beacon: 0 };
  const auto = { click: 0, dispatch: 0, eval: 0, newFunction: 0 };
  for (const f of files) {
    const t = f.text;
    for (const mm of t.matchAll(hostRe)) if (!NOISE_HOSTS.test(mm[1])) hosts.add(mm[1].toLowerCase());
    net.fetch += count(t, /\bfetch\s*\(/g);
    net.xhr += count(t, /\bXMLHttpRequest\b/g);
    net.websocket += count(t, /\bnew\s+WebSocket\s*\(/g);
    net.beacon += count(t, /\bsendBeacon\s*\(/g);
    auto.click += count(t, /\.click\s*\(/g);
    auto.dispatch += count(t, /\bdispatchEvent\s*\(/g);
    auto.eval += count(t, /\beval\s*\(/g);
    auto.newFunction += count(t, /\bnew\s+Function\s*\(/g);
  }
  return { hosts: [...hosts].sort(), net, auto };
}

// ---------- resumo para a tela de risco ----------
// `code` vem de scanCode. Devolve tudo que a tela precisa, em texto simples.
function buildSummary({ manifest, id, analysis, code, gameHosts = [] }) {
  const sites = new Set(gameHosts.map(siteOf));
  const codeHosts = (code?.hosts || []).filter((h) => !sites.has(siteOf(h)));
  const automation = [];
  const a = code?.auto || {};
  if (a.click) automation.push({ name: 'click', label: `Clica em botões da página por código (${a.click} ${a.click === 1 ? 'ponto' : 'pontos'} no código)` });
  if (a.dispatch) automation.push({ name: 'dispatch', label: `Simula cliques e teclas (${a.dispatch} ${a.dispatch === 1 ? 'ponto' : 'pontos'} no código)` });
  if (a.eval || a.newFunction) automation.push({ name: 'eval', label: 'Roda texto como código (eval ou new Function): dá para esconder o que ela faz' });
  const n = code?.net || {};
  const network = [];
  if (n.fetch || n.xhr) network.push('Faz pedidos de rede (fetch ou XMLHttpRequest)');
  if (n.websocket) network.push('Abre conexões em tempo real (WebSocket)');
  if (n.beacon) network.push('Envia dados em segundo plano (sendBeacon)');

  const hasHigh = analysis.permissions.some((p) => p.level === 'high');
  const hasMedium = analysis.permissions.some((p) => p.level === 'medium');
  let risk = 'low';
  if (hasHigh || codeHosts.length || a.eval || a.newFunction) risk = 'high';
  else if (hasMedium || automation.length || network.length) risk = 'medium';

  return {
    id,
    name: String(manifest.name || '').slice(0, 80),
    version: String(manifest.version || '').slice(0, 30),
    description: String(manifest.description || '').slice(0, 300),
    risk,
    errors: analysis.errors,
    warnings: analysis.warnings,
    permissions: analysis.permissions,
    scriptSites: analysis.scriptHosts,
    hostSites: analysis.hostPermissions,
    codeSites: codeHosts.slice(0, 15),
    network,
    automation,
    compat: compatibility(manifest, id),
    blocked: analysis.errors.length > 0,
  };
}

// ---------- comparação entre versões ----------
// `oldFiles`/`newFiles`: Map caminho -> sha256 do conteúdo. Mostra o que mudou e se pede nova confirmação.
function diffVersions(oldSum, newSum, oldFiles, newFiles) {
  const names = (list, key = 'name') => new Set(list.map((x) => (typeof x === 'string' ? x : x[key])));
  const added = (a, b) => [...b].filter((x) => !a.has(x));
  const oldPerms = names(oldSum.permissions);
  const newPerms = names(newSum.permissions);
  const oldSites = new Set([...oldSum.scriptSites, ...oldSum.hostSites]);
  const newSites = new Set([...newSum.scriptSites, ...newSum.hostSites]);
  const oldCode = new Set(oldSum.codeSites);
  const newCode = new Set(newSum.codeSites);
  const oldAuto = names(oldSum.automation);
  const newAuto = names(newSum.automation);

  const fileNew = [...newFiles.keys()].filter((f) => !oldFiles.has(f));
  const fileGone = [...oldFiles.keys()].filter((f) => !newFiles.has(f));
  const fileChanged = [...newFiles.keys()].filter((f) => oldFiles.has(f) && oldFiles.get(f) !== newFiles.get(f));

  const d = {
    from: oldSum.version,
    to: newSum.version,
    newPermissions: added(oldPerms, newPerms),
    removedPermissions: added(newPerms, oldPerms),
    newSites: added(oldSites, newSites),
    newCodeSites: added(oldCode, newCode),
    newAutomation: added(oldAuto, newAuto),
    files: { added: fileNew, removed: fileGone, changed: fileChanged },
    riskFrom: oldSum.risk,
    riskTo: newSum.risk,
  };
  // Qualquer coisa que dê à extensão mais alcance exige o "sim" explícito da pessoa.
  d.needsConfirm = !!(d.newPermissions.length || d.newSites.length || d.newCodeSites.length || d.newAutomation.length);
  d.blocked = newSum.blocked;
  return d;
}

module.exports = {
  BLOCKED, PERMS, UNSUPPORTED, TESTED, siteOf, parsePattern, hostOfPattern, patternAllowed,
  analyzeManifest, compatibility, scanCode, buildSummary, diffVersions,
};
