// Mostra a página do IdleLive (http://127.0.0.1:3000) dentro da janela do IdleHub.
// Enquanto ela aparece, as contas dos jogos só ficam escondidas: continuam rodando.
const { WebContentsView, shell } = require('electron');

class PanelView {
  constructor({ win, idlelive }) {
    this.win = win;
    this.idlelive = idlelive;
    this.view = null;
    this.loaded = false;
    this.visible = false;
  }

  isPanelUrl(url) {
    try {
      const u = new URL(url);
      return ['127.0.0.1', 'localhost'].includes(u.hostname) && Number(u.port) === this.idlelive.port;
    } catch {
      return false;
    }
  }

  ensure() {
    if (this.view) return;
    const view = new WebContentsView({
      webPreferences: { partition: 'persist:idlelive-panel', sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    view.setBackgroundColor('#1b1d22');
    view.setVisible(false);
    this.win.contentView.addChildView(view);
    const wc = view.webContents;
    // Links de fora (Twitch, Kick, Hub…) abrem no navegador do PC.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      if (this.isPanelUrl(url)) return;
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    });
    wc.on('did-fail-load', (_e, code, _desc, _url, isMain) => {
      if (isMain && code !== -3) this.loaded = false;
    });
    this.view = view;
  }

  // rect = área da página na janela, ou null para esconder.
  setRect(rect) {
    if (!rect || this.idlelive.status !== 'running') return this.hide();
    this.ensure();
    this.view.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(1, Math.round(rect.w)),
      height: Math.max(1, Math.round(rect.h)),
    });
    if (!this.loaded) {
      this.loaded = true;
      this.view.webContents.loadURL(this.idlelive.url).catch(() => (this.loaded = false));
    }
    if (!this.visible) {
      this.view.setVisible(true);
      this.visible = true;
    }
  }

  hide() {
    if (this.view && this.visible) this.view.setVisible(false);
    this.visible = false;
  }

  reload() {
    if (!this.view) return;
    this.loaded = true;
    this.view.webContents.loadURL(this.idlelive.url).catch(() => (this.loaded = false));
  }

  // Servidor voltou depois de cair ou de ficar com a porta ocupada: recarrega se a página tinha falhado.
  onServerReady() {
    if (this.view && !this.loaded && this.visible) this.reload();
  }
}

module.exports = { PanelView };
