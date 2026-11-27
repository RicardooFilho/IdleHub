// Service worker da sonda: testa cada API e escreve o resultado no console (o harness lê).
const out = (k, v) => console.log('PROBE ' + JSON.stringify({ where: 'sw', k, v }));
const t = async (k, fn) => {
  try {
    const v = await Promise.race([Promise.resolve().then(fn), new Promise((r) => setTimeout(() => r('TIMEOUT'), 3000))]);
    out(k, v === undefined ? 'ok' : v);
  } catch (e) {
    out(k, 'ERRO: ' + (e && e.message));
  }
};
out('chrome.keys', Object.keys(chrome).sort());
const NS = ['action', 'alarms', 'commands', 'contextMenus', 'cookies', 'declarativeNetRequest', 'downloads', 'idle', 'notifications', 'offscreen', 'permissions', 'scripting', 'sidePanel', 'storage', 'tabs', 'webNavigation', 'webRequest', 'windows', 'runtime', 'extension', 'management', 'system', 'i18n', 'identity'];
out('namespaces', Object.fromEntries(NS.map((n) => [n, typeof chrome[n] === 'undefined' ? 'AUSENTE' : Object.keys(chrome[n]).length + ' membros'])));
if (chrome.alarms && chrome.alarms.onAlarm) chrome.alarms.onAlarm.addListener((a) => out('alarms.onAlarm', 'disparou ' + a.name));
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  out('runtime.onMessage', { msg, tabId: sender.tab && sender.tab.id, url: sender.url, frameId: sender.frameId });
  if (sender.tab) {
    t('scripting.executeScript(MAIN)', async () => {
      const r = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: 'MAIN', func: () => { window.__probeScripting = 1; return document.title; } });
      return r && r[0] && r[0].result;
    });
    t('tabs.sendMessage', async () => chrome.tabs.sendMessage(sender.tab.id, { ping: 1 }));
    t('tabs.get', async () => (await chrome.tabs.get(sender.tab.id)).url);
  }
  reply({ pong: true });
});
(async () => {
  await t('storage.local set/get', async () => { await chrome.storage.local.set({ a: 1 }); return (await chrome.storage.local.get('a')).a; });
  await t('storage.sync', async () => { await chrome.storage.sync.set({ a: 1 }); return (await chrome.storage.sync.get('a')).a; });
  await t('storage.session', async () => { await chrome.storage.session.set({ a: 1 }); return (await chrome.storage.session.get('a')).a; });
  await t('alarms.create', async () => { chrome.alarms.create('t1', { delayInMinutes: 0.02 }); chrome.alarms.create('t2', { delayInMinutes: 1 }); return 'criados t1 (1 s) e t2 (60 s) — t2 testa se o SW acorda depois de ociosidade'; });
  await t('notifications.create', async () => chrome.notifications.create('n1', { type: 'basic', iconUrl: 'war.txt', title: 'x', message: 'y' }));
  await t('action.setBadgeText', async () => chrome.action.setBadgeText({ text: '1' }));
  await t('contextMenus.create', async () => chrome.contextMenus.create({ id: 'c1', title: 'x' }));
  await t('cookies.getAll', async () => (await chrome.cookies.getAll({ domain: 'pokeidle.io' })).length);
  await t('windows.getAll', async () => (await chrome.windows.getAll()).length);
  await t('tabs.query({})', async () => (await chrome.tabs.query({})).length);
  await t('tabs.create', async () => { const x = await chrome.tabs.create({ url: 'about:blank' }); return !!x; });
  await t('declarativeNetRequest.getDynamicRules', async () => (await chrome.declarativeNetRequest.getDynamicRules()).length);
  await t('offscreen.createDocument', async () => chrome.offscreen.createDocument({ url: 'options.html', reasons: ['DOM_PARSER'], justification: 'teste' }));
  await t('idle.queryState', async () => chrome.idle.queryState(60));
  await t('downloads.search', async () => (await chrome.downloads.search({})).length);
  await t('permissions.getAll', async () => JSON.stringify(await chrome.permissions.getAll()));
  await t('commands.getAll', async () => (await chrome.commands.getAll()).length);
  await t('runtime.getContexts', async () => (await chrome.runtime.getContexts({})).length);
  await t('fetch(pokeidle.io) do SW', async () => (await fetch('https://pokeidle.io/', { method: 'GET' })).status);
  await t('fetch(example.com) do SW sem host_permission', async () => (await fetch('https://example.com/')).status);
  await t('runtime.getPlatformInfo', async () => (await chrome.runtime.getPlatformInfo()).os);
  await t('i18n.getUILanguage', async () => chrome.i18n.getUILanguage());
  await t('sidePanel.setOptions', async () => chrome.sidePanel.setOptions({ enabled: true }));
})();
