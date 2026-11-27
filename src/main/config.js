// Configuração local de cada usuário. Fica em %APPDATA%/IdleHub/config.json
// e nunca sai do PC da pessoa.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  watchdogIntervalSec: 30, // de quanto em quanto tempo cada conta é verificada
  reloadAfterFailures: 2, // verificações seguidas sem resposta antes de recarregar
  memoryLimitMB: 1500, // otimiza a conta (reabre num processo novo) se passar disso (0 = sem limite)
  optimizeEveryHours: 0, // otimiza cada conta a cada tantas horas (0 = desligado)
  // FPS só limita a animação; os temporizadores do jogo rodam em 100% mesmo escondido.
  // 30 é seguro também para jogos que contam o progresso por quadro desenhado.
  backgroundFps: 30, // FPS das contas escondidas (0 = sem limite)
  mosaicFps: 30, // FPS das contas visíveis no mosaico (0 = sem limite)
  muteAll: true, // true = tudo mudo; false = só a conta expandida toca som
  closeToTray: true,
  notifyWindows: true,
  notifyTelegram: false, // idem: o token do bot e a conversa ficam criptografados em secrets.json
  notifyDiscord: false, // só o liga/desliga: o link do webhook fica criptografado em secrets.json (remote.js)
  tileBaseWidth: 1280, // largura "real" do jogo; o mosaico encolhe a partir dela
  startMinimized: false,
  dailySummary: false, // manda o resumo das últimas 24 h no horário abaixo (no app e nos canais Discord/Telegram ligados)
  dailySummaryTime: '21:00', // HH:MM, hora do PC
  awaySummaryHours: 2, // ao voltar de uma ausência de pelo menos tantas horas, mostra o resumo do que aconteceu (0 = desligado)
};

// IDLEHUB_DATA: pasta de dados de teste (o main.js também usa) e o que os testes usam, fora do Electron.
function file() {
  return path.join(process.env.IDLEHUB_DATA || app.getPath('userData'), 'config.json');
}

function empty() {
  return { version: 1, onboarded: false, settings: { ...DEFAULT_SETTINGS }, games: [] };
}

function load() {
  try {
    const c = JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^﻿/, ''));
    c.settings = { ...DEFAULT_SETTINGS, ...(c.settings || {}) };
    c.games = Array.isArray(c.games) ? c.games : [];
    return c;
  } catch {
    return empty();
  }
}

function save(c) {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, f);
}

module.exports = { load, save, DEFAULT_SETTINGS };
