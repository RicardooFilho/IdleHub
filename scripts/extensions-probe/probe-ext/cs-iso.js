// Content script em world ISOLATED: testa o que a extensão enxerga e a mensagem para o SW.
const out = (k, v) => console.log('PROBE ' + JSON.stringify({ where: 'cs-iso', k, v }));
out('chrome.keys', typeof chrome === 'undefined' ? 'SEM chrome' : Object.keys(chrome).sort());
out('runtime.id', chrome.runtime && chrome.runtime.id);
out('window.__probeMain visível no mundo isolado', typeof window.__probeMain);
chrome.runtime.onMessage.addListener((m) => out('onMessage (cs) recebeu do SW', JSON.stringify(m)));
(async () => {
  try { out('sendMessage->SW', JSON.stringify(await chrome.runtime.sendMessage({ hello: 'cs' }))); } catch (e) { out('sendMessage->SW', 'ERRO: ' + e.message); }
  try { await chrome.storage.local.set({ b: 2 }); out('storage.local (cs)', (await chrome.storage.local.get('b')).b); } catch (e) { out('storage.local (cs)', 'ERRO: ' + e.message); }
  try { const r = await fetch(chrome.runtime.getURL('war.txt')); out('fetch getURL(war.txt)', r.status); } catch (e) { out('fetch getURL(war.txt)', 'ERRO: ' + e.message); }
  try { const p = chrome.runtime.connect({ name: 'p' }); out('runtime.connect', p ? 'porta criada' : 'sem porta'); } catch (e) { out('runtime.connect', 'ERRO: ' + e.message); }
})();
