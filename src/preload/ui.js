const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('idle', {
  getState: () => ipcRenderer.invoke('state:get'),
  setLayout: (tiles) => ipcRenderer.send('layout:set', tiles),
  accountAction: (key, action) => ipcRenderer.invoke('account:action', key, action),
  gameAction: (gameId, action) => ipcRenderer.invoke('game:action', gameId, action),
  onboard: (selections) => ipcRenderer.invoke('config:onboard', selections),
  saveGame: (game) => ipcRenderer.invoke('game:save', game),
  deleteGame: (id) => ipcRenderer.invoke('game:delete', id),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  openData: () => ipcRenderer.invoke('open:data'),
  idleliveAction: (action) => ipcRenderer.invoke('idlelive:action', action),
  idleliveImport: () => ipcRenderer.invoke('idlelive:import'),
  onState: (cb) => ipcRenderer.on('state', (_e, d) => cb(d)),
  onShortcut: (cb) => ipcRenderer.on('shortcut', (_e, s) => cb(s)),
  onFocusAccount: (cb) => ipcRenderer.on('focus-account', (_e, k) => cb(k)),
});
