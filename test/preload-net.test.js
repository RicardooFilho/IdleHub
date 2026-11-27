// O gancho de WebSocket do preload (src/preload/game.js) só pode anotar horários, sem mexer no jogo.
// O código roda na página do jogo; aqui ele roda numa página falsa dentro de um vm.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class FakeWebSocket {
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.listeners = {};
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  emit(type, data) {
    (this.listeners[type] || []).forEach((fn) => fn({ data }));
  }
}

function loadPage() {
  let code = '';
  const src = fs.readFileSync(path.join(__dirname, '../src/preload/game.js'), 'utf8');
  const fakeRequire = (name) => {
    assert.equal(name, 'electron');
    return { webFrame: { executeJavaScript: (c) => ((code = c), Promise.resolve()) } };
  };
  new Function('require', src)(fakeRequire); // o preload entrega o código que vai para a página

  let clock = 1000;
  const win = { WebSocket: FakeWebSocket, performance: { now: () => clock }, requestAnimationFrame() {}, cancelAnimationFrame() {} };
  win.window = win;
  win.document = { addEventListener() {} };
  win.location = { hostname: 'jogo.com' };
  win.Document = function Document() {};
  win.Navigator = function Navigator() {};
  vm.runInNewContext(code, win);
  return { win, tick: (ms) => (clock += ms) };
}

test('sem WebSocket aberto, o gancho informa zeros e idades "nunca"', () => {
  const { win } = loadPage();
  assert.deepEqual({ ...win.__idleHubNet() }, { open: 0, ever: false, msg: -1, opened: -1, closed: -1 });
});

test('anota abertura, mensagem e fechamento, só com horários', () => {
  const { win, tick } = loadPage();
  const ws = new win.WebSocket('wss://jogo.com/ws');
  tick(100);
  ws.emit('open');
  tick(500);
  ws.emit('message', 'conteúdo secreto');
  tick(200);
  assert.deepEqual({ ...win.__idleHubNet() }, { open: 1, ever: true, msg: 200, opened: 700, closed: -1 });
  ws.emit('close');
  assert.deepEqual({ ...win.__idleHubNet() }, { open: 0, ever: true, msg: 200, opened: 700, closed: 0 });
  assert.ok(!JSON.stringify(win.__idleHubNet()).includes('secreto'));
});

test('socket que nunca abriu e falhou não conta como fechamento', () => {
  const { win } = loadPage();
  const ws = new win.WebSocket('wss://jogo.com/ws');
  ws.emit('close');
  assert.deepEqual({ ...win.__idleHubNet() }, { open: 0, ever: false, msg: -1, opened: -1, closed: -1 });
});

test('o jogo continua usando o WebSocket normalmente', () => {
  const { win } = loadPage();
  const ws = new win.WebSocket('wss://jogo.com/ws');
  assert.equal(ws.url, 'wss://jogo.com/ws');
  assert.ok(ws instanceof FakeWebSocket);
  assert.equal(win.WebSocket.OPEN, 1);
  assert.ok(!Object.keys(win).includes('__idleHubNet'), 'o gancho não aparece em Object.keys');
});
