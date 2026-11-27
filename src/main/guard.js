// Política contra anúncios e downloads indesejados dentro dos jogos. Só funções
// puras (sem Electron), para testar sem abrir nada. Quem usa é src/main/accounts.js.

// Janelas novas só abrem até 1,5 s depois de uma ação real da pessoa.
const POPUP_INPUT_WINDOW_MS = 1500;
// Downloads têm um pouco mais de folga: o servidor pode demorar para responder.
const DOWNLOAD_INPUT_WINDOW_MS = 3000;

// Páginas de login do Google: o fluxo deles reabre janelas sem clique, então
// passam sempre (mesmos endereços de setupGoogleLogin em accounts.js).
const GOOGLE_LOGIN_HOSTS = new Set(['accounts.google.com', 'accounts.youtube.com']);

// Programas e scripts: nunca são baixados dentro de um jogo.
const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'msi', 'msix', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'vbe', 'js', 'jse',
  'wsf', 'hta', 'lnk', 'dll', 'cpl', 'jar', 'appx', 'reg',
]);

// Só ações reais da pessoa contam; movimento do mouse e rolagem, não.
const USER_INPUT_TYPES = new Set(['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'char', 'gestureTap']);

const isUserInput = (event) => !!event && USER_INPUT_TYPES.has(event.type);

const isRecent = (now, lastInputAt, windowMs) =>
  Number.isFinite(now) && Number.isFinite(lastInputAt) && now - lastInputAt <= windowMs;

function shouldAllowPopup({ url, now, lastInputAt } = {}) {
  let u = null;
  // window.open() sem endereço chega vazio; é o mesmo que about:blank.
  if (url === '' || url == null) u = { protocol: 'about:', href: 'about:blank', hostname: '' };
  else {
    try {
      u = new URL(String(url));
    } catch {
      return false;
    }
  }
  if (u.protocol === 'https:' && GOOGLE_LOGIN_HOSTS.has(u.hostname)) return true;
  const clicked = isRecent(now, lastInputAt, POPUP_INPUT_WINDOW_MS);
  // Muitos logins OAuth abrem about:blank e só depois navegam: passa se foi clique.
  if (u.protocol === 'about:') return u.href === 'about:blank' && clicked;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return clicked;
}

// Extensão do arquivo sem espaços/pontos no fim (o Windows ignora os dois).
function extensionOf(filename) {
  const base = String(filename || '').split(/[\\/]/).pop().replace(/[\s.]+$/, '');
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

const isDangerousFile = (filename) => DANGEROUS_EXTENSIONS.has(extensionOf(filename));

function shouldAllowDownload({ filename, now, lastInputAt } = {}) {
  if (isDangerousFile(filename)) return false;
  return isRecent(now, lastInputAt, DOWNLOAD_INPUT_WINDOW_MS);
}

module.exports = {
  POPUP_INPUT_WINDOW_MS,
  DOWNLOAD_INPUT_WINDOW_MS,
  isUserInput,
  isDangerousFile,
  shouldAllowPopup,
  shouldAllowDownload,
};
