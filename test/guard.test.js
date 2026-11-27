const test = require('node:test');
const assert = require('node:assert');
const {
  POPUP_INPUT_WINDOW_MS,
  DOWNLOAD_INPUT_WINDOW_MS,
  isUserInput,
  shouldAllowPopup,
  shouldAllowDownload,
} = require('../src/main/guard');

const NOW = 1_000_000;
const clicked = NOW - 200; // clique recente
const stale = NOW - POPUP_INPUT_WINDOW_MS - 1; // clique velho demais

test('pop-up comum: só com clique recente', () => {
  const url = 'https://anuncio.example.com/promo';
  assert.equal(shouldAllowPopup({ url, now: NOW, lastInputAt: clicked }), true);
  assert.equal(shouldAllowPopup({ url, now: NOW, lastInputAt: NOW - POPUP_INPUT_WINDOW_MS }), true);
  assert.equal(shouldAllowPopup({ url, now: NOW, lastInputAt: stale }), false);
  assert.equal(shouldAllowPopup({ url, now: NOW, lastInputAt: undefined }), false);
  assert.equal(shouldAllowPopup({ url, now: NOW, lastInputAt: 0 }), false);
});

test('login do Google passa mesmo sem clique', () => {
  for (const url of [
    'https://accounts.google.com/o/oauth2/auth?client_id=1',
    'https://accounts.youtube.com/accounts/SetSID',
  ]) {
    assert.equal(shouldAllowPopup({ url, now: NOW, lastInputAt: 0 }), true);
  }
  // só https e só esses dois endereços
  assert.equal(shouldAllowPopup({ url: 'http://accounts.google.com/', now: NOW, lastInputAt: 0 }), false);
  assert.equal(shouldAllowPopup({ url: 'https://accounts.google.com.evil.com/', now: NOW, lastInputAt: 0 }), false);
});

test('about:blank (login OAuth) só com clique', () => {
  assert.equal(shouldAllowPopup({ url: 'about:blank', now: NOW, lastInputAt: clicked }), true);
  assert.equal(shouldAllowPopup({ url: 'about:blank', now: NOW, lastInputAt: stale }), false);
  assert.equal(shouldAllowPopup({ url: '', now: NOW, lastInputAt: clicked }), true);
  assert.equal(shouldAllowPopup({ url: '', now: NOW, lastInputAt: 0 }), false);
  assert.equal(shouldAllowPopup({ url: 'about:srcdoc', now: NOW, lastInputAt: clicked }), false);
});

test('javascript:, file: e data: são sempre bloqueados', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/notepad.exe', 'data:text/html,<h1>oi</h1>', 'lixo sem formato']) {
    assert.equal(shouldAllowPopup({ url, now: NOW, lastInputAt: clicked }), false, url);
  }
});

test('download: programas são bloqueados mesmo com clique', () => {
  for (const filename of ['setup.exe', 'SETUP.EXE', 'foo.exe.', 'foo.exe ', 'a.Msi', 'x.ps1', 'x.js', 'x.lnk', 'x.jar', 'x.reg', 'C:\\temp\\x.bat']) {
    assert.equal(shouldAllowDownload({ filename, now: NOW, lastInputAt: NOW }), false, filename);
  }
});

test('download: o resto só com clique recente', () => {
  assert.equal(shouldAllowDownload({ filename: 'jogo.zip', now: NOW, lastInputAt: NOW - 500 }), true);
  assert.equal(shouldAllowDownload({ filename: 'jogo.zip', now: NOW, lastInputAt: NOW - DOWNLOAD_INPUT_WINDOW_MS }), true);
  assert.equal(shouldAllowDownload({ filename: 'jogo.zip', now: NOW, lastInputAt: NOW - DOWNLOAD_INPUT_WINDOW_MS - 1 }), false);
  assert.equal(shouldAllowDownload({ filename: 'jogo.zip', now: NOW, lastInputAt: 0 }), false);
  assert.equal(shouldAllowDownload({ filename: 'exe.zip', now: NOW, lastInputAt: NOW }), true);
  assert.equal(shouldAllowDownload({ filename: 'LEIA-ME', now: NOW, lastInputAt: NOW }), true);
});

test('isUserInput: ação real conta, movimento e rolagem não', () => {
  for (const type of ['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'char', 'gestureTap']) {
    assert.equal(isUserInput({ type }), true, type);
  }
  for (const type of ['mouseMove', 'mouseWheel', 'mouseEnter', 'keyUp', 'gestureScrollUpdate', 'touchMove']) {
    assert.equal(isUserInput({ type }), false, type);
  }
  assert.equal(isUserInput(null), false);
  assert.equal(isUserInput({}), false);
});
