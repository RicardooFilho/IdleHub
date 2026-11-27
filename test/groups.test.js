const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Pasta temporária ANTES de carregar a config: os testes nunca tocam nos dados reais.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-groups-'));
process.env.IDLEHUB_DATA = dir;
const config = require('../src/main/config');
const g = require('../src/main/groups');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// Dois jogos: p (contas 1 e 2) e l (conta 1). A conta p:2 começa dormindo.
const make = () => ({
  settings: { muteAll: true, tileBaseWidth: 1280 },
  games: [
    { id: 'p', accounts: [{ id: '1', sleeping: false }, { id: '2', sleeping: true }] },
    { id: 'l', accounts: [{ id: '1', sleeping: false }] },
  ],
  groups: [],
  profiles: [],
});

test('config antiga, sem grupos nem perfis, continua carregando', () => {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1, onboarded: true, settings: {}, games: [{ id: 'p', accounts: [] }] }));
  const c = config.load();
  assert.deepEqual(c.groups, []);
  assert.deepEqual(c.profiles, []);
  assert.equal(c.games.length, 1);
});

test('normalize completa configs antigas e tira contas que não existem mais', () => {
  const cfg = make();
  delete cfg.groups;
  delete cfg.profiles;
  assert.equal(g.normalize(cfg), true);
  assert.deepEqual(cfg.groups, []);

  cfg.groups = [{ id: 'a', name: 'Principais', color: '#ff0000', accountIds: ['p:1', 'x:9', 'p:1', 'l:1'] }];
  cfg.profiles = [{ id: 'b', name: 'Noite', awake: ['l:1', 'p:7'], layout: { tileBaseWidth: 99999 }, muted: 1 }];
  g.normalize(cfg);
  assert.deepEqual(cfg.groups[0].accountIds, ['p:1', 'l:1']);
  assert.deepEqual(cfg.profiles[0].awake, ['l:1']);
  assert.equal(cfg.profiles[0].layout.tileBaseWidth, 3840);
  assert.equal(cfg.profiles[0].muted, true);
  assert.equal(g.normalize(cfg), false, 'já limpo: nada muda');
});

test('sanitizeGroup: nome, cor e id padrão', () => {
  const known = new Set(['p:1']);
  const grp = g.sanitizeGroup({ name: '  ', color: 'vermelho', accountIds: ['p:1'] }, known);
  assert.equal(grp.name, 'Grupo');
  assert.equal(grp.color, g.COLORS[0]);
  assert.ok(grp.id);
  assert.equal(g.sanitizeGroup({ name: 'x'.repeat(100) }, known).name.length, 40);
  assert.equal(g.sanitizeGroup({ color: '#ABCDEF' }, known).color, '#abcdef');
});

test('trocar para um grupo: acorda as dele e dorme todas as outras', () => {
  const cfg = make();
  cfg.groups = [{ id: 'a', name: 'Só LoLdle e P2', color: '#fc5e03', accountIds: ['p:2', 'l:1'] }];
  const plan = g.planGroup(cfg, 'a');
  assert.deepEqual(plan.wake, ['p:2']);
  assert.deepEqual(plan.sleep, ['p:1']); // l:1 já está acordada e fica como está
  assert.equal(plan.name, 'Só LoLdle e P2');
});

test('grupo vazio, apagado ou só com contas removidas não dorme nada', () => {
  const cfg = make();
  cfg.groups = [{ id: 'a', name: 'Vazio', color: '#fc5e03', accountIds: ['x:1'] }];
  assert.ok(g.planGroup(cfg, 'a').error);
  assert.ok(g.planGroup(cfg, 'nao-existe').error);
  assert.equal(g.planGroup(cfg, 'a').sleep, undefined);
});

test('snapshotProfile guarda contas acordadas, tamanho-base e som', () => {
  const cfg = make();
  const p = g.snapshotProfile(cfg, '  Dia a dia ', 'abc');
  assert.equal(p.id, 'abc');
  assert.equal(p.name, 'Dia a dia');
  assert.deepEqual(p.awake, ['p:1', 'l:1']);
  assert.deepEqual(p.layout, { tileBaseWidth: 1280 });
  assert.equal(p.muted, true);
  assert.ok(g.snapshotProfile(cfg, 'novo').id, 'perfil novo ganha id');
});

test('aplicar perfil: só muda o que difere e devolve as configurações guardadas', () => {
  const cfg = make();
  cfg.profiles = [{ id: 'b', name: 'Tudo', awake: ['p:1', 'p:2', 'l:1', 'sumiu:1'], layout: { tileBaseWidth: 960 }, muted: false }];
  const plan = g.planProfile(cfg, 'b');
  assert.deepEqual(plan.wake, ['p:2']);
  assert.deepEqual(plan.sleep, []);
  assert.deepEqual(plan.settings, { muteAll: false, tileBaseWidth: 960 });
  assert.ok(g.planProfile(cfg, 'nao-existe').error);
});

test('perfil sem tamanho-base não mexe no tamanho; perfil com tudo dormindo é válido', () => {
  const cfg = make();
  cfg.profiles = [{ id: 'b', name: 'Nada', awake: [], layout: {}, muted: true }];
  const plan = g.planProfile(cfg, 'b');
  assert.deepEqual(plan.settings, { muteAll: true });
  assert.deepEqual(plan.sleep, ['p:1', 'l:1']);
});

test('a fila de acordar tem espaço entre as contas', () => {
  assert.ok(g.WAKE_GAP_MS >= 1000);
  assert.ok(g.COLORS.length >= 4 && g.COLORS.every((c) => /^#[0-9a-f]{6}$/i.test(c)));
});
