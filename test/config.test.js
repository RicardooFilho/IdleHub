const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Pasta temporária ANTES de carregar o módulo: os testes nunca tocam na config real.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-config-'));
process.env.IDLEHUB_DATA = dir;
const config = require('../src/main/config');
const file = path.join(dir, 'config.json');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('sem arquivo, começa vazio e com as configurações padrão', () => {
  fs.rmSync(file, { force: true });
  const c = config.load();
  assert.equal(c.onboarded, false);
  assert.deepEqual(c.games, []);
  assert.deepEqual(c.settings, config.DEFAULT_SETTINGS);
});

test('salva e lê de volta, completando configurações novas', () => {
  config.save({ version: 1, onboarded: true, settings: { muteAll: false }, games: [{ id: 'a' }] });
  const c = config.load();
  assert.equal(c.onboarded, true);
  assert.equal(c.settings.muteAll, false);
  assert.equal(c.settings.backgroundFps, config.DEFAULT_SETTINGS.backgroundFps);
  assert.equal(c.games.length, 1);
});

test('aceita arquivo com BOM (gravado pelo PowerShell)', () => {
  fs.writeFileSync(file, '﻿' + JSON.stringify({ onboarded: true, games: [] }));
  assert.equal(config.load().onboarded, true);
});

test('arquivo quebrado vira config vazia em vez de travar o app', () => {
  fs.writeFileSync(file, '{ quebrado');
  assert.equal(config.load().onboarded, false);
});

test('FPS padrão das contas escondidas não deixa o jogo lento', () => {
  // Jogos que contam o progresso por quadro andariam mais devagar com FPS muito baixo.
  assert.ok(config.DEFAULT_SETTINGS.backgroundFps >= 30);
  assert.ok(config.DEFAULT_SETTINGS.mosaicFps >= 30);
});

test('a conta expandida tem limite de FPS, mas fica fluida', () => {
  // 0 (sem limite) faz a conta desenhar na taxa do monitor (240 Hz = um núcleo inteiro).
  assert.ok(config.DEFAULT_SETTINGS.focusFps >= 30);
  assert.ok(config.DEFAULT_SETTINGS.focusFps <= 60);
});

test('config antiga ganha o limite da conta expandida', () => {
  config.save({ version: 1, onboarded: true, settings: { mosaicFps: 20 }, games: [] });
  const c = config.load();
  assert.equal(c.settings.mosaicFps, 20);
  assert.equal(c.settings.focusFps, config.DEFAULT_SETTINGS.focusFps);
});
