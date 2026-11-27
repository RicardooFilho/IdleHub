const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { matchShortcut, attachShortcuts } = require('../src/main/shortcuts');

// Monta o `input` do before-input-event do Electron.
const key = (k, mods = {}) => ({ type: 'keyDown', key: k, control: false, shift: false, alt: false, meta: false, isAutoRepeat: false, ...mods });

test('Ctrl+1…9 vão para a conta de índice 0…8', () => {
  for (let n = 1; n <= 9; n++) {
    assert.deepStrictEqual(matchShortcut(key(String(n), { control: true })), { action: 'goto', index: n - 1 });
  }
});

test('Ctrl+0, número sem Ctrl e Ctrl+Shift+número não são atalho', () => {
  assert.strictEqual(matchShortcut(key('0', { control: true })), null);
  assert.strictEqual(matchShortcut(key('1')), null);
  assert.strictEqual(matchShortcut(key('1', { control: true, shift: true })), null);
});

test('Ctrl+Tab vai para a próxima e Ctrl+Shift+Tab para a anterior', () => {
  assert.deepStrictEqual(matchShortcut(key('Tab', { control: true })), { action: 'next' });
  assert.deepStrictEqual(matchShortcut(key('Tab', { control: true, shift: true })), { action: 'prev' });
  assert.strictEqual(matchShortcut(key('Tab')), null);
});

test('F5 recarrega, mas só sozinho', () => {
  assert.deepStrictEqual(matchShortcut(key('F5')), { action: 'reload' });
  assert.strictEqual(matchShortcut(key('F5', { control: true })), null);
  assert.strictEqual(matchShortcut(key('F5', { shift: true })), null);
});

test('Ctrl+M silencia, com ou sem Caps Lock', () => {
  assert.deepStrictEqual(matchShortcut(key('m', { control: true })), { action: 'mute' });
  assert.deepStrictEqual(matchShortcut(key('M', { control: true })), { action: 'mute' });
  assert.strictEqual(matchShortcut(key('m')), null);
  assert.strictEqual(matchShortcut(key('m', { control: true, shift: true })), null);
});

test('Alt e a tecla do Windows cancelam o atalho', () => {
  assert.strictEqual(matchShortcut(key('1', { control: true, alt: true })), null);
  assert.strictEqual(matchShortcut(key('F5', { alt: true })), null);
  assert.strictEqual(matchShortcut(key('Tab', { control: true, meta: true })), null);
});

test('só vale ao apertar a tecla (não ao soltar)', () => {
  assert.strictEqual(matchShortcut(key('F5', { type: 'keyUp' })), null);
  assert.strictEqual(matchShortcut(key('1', { control: true, type: 'keyUp' })), null);
});

test('segurar a tecla não repete conta, F5 nem som; trocar de conta repete', () => {
  assert.strictEqual(matchShortcut(key('1', { control: true, isAutoRepeat: true })), null);
  assert.strictEqual(matchShortcut(key('F5', { isAutoRepeat: true })), null);
  assert.strictEqual(matchShortcut(key('m', { control: true, isAutoRepeat: true })), null);
  assert.deepStrictEqual(matchShortcut(key('Tab', { control: true, isAutoRepeat: true })), { action: 'next' });
});

test('entrada estranha não quebra', () => {
  assert.strictEqual(matchShortcut(null), null);
  assert.strictEqual(matchShortcut({}), null);
  assert.strictEqual(matchShortcut({ type: 'keyDown' }), null);
});

test('attachShortcuts engole a tecla do atalho e deixa o resto passar', () => {
  const wc = new EventEmitter();
  const got = [];
  attachShortcuts(wc, (s) => got.push(s));

  let prevented = 0;
  const event = { preventDefault: () => prevented++ };
  wc.emit('before-input-event', event, key('F5'));
  wc.emit('before-input-event', event, key('a'));
  wc.emit('before-input-event', event, key('2', { control: true }));

  assert.strictEqual(prevented, 2);
  assert.deepStrictEqual(got, [{ action: 'reload' }, { action: 'goto', index: 1 }]);
});
