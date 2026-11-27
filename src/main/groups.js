// Grupos de contas e perfis de arrumação. Só funções puras, sem Electron, para dar para testar com node:test.
// Uma conta é identificada pela chave "idDoJogo:idDaConta" (a mesma de accounts.js e da interface).
// Grupo: contas de qualquer jogo, com nome e cor. Perfil: quais contas ficam acordadas, o tamanho-base do
// jogo no mosaico e se tudo fica mudo. Dormir é a única coisa que se faz com as contas: nada de limitar tempo.
const { newId } = require('./games');

const NAME_MAX = 40;
const MAX_GROUPS = 30;
const MAX_PROFILES = 30;
// Espaço entre uma conta e a próxima ao acordar várias, para o PC não carregar todas juntas.
const WAKE_GAP_MS = 3000;
// Paleta pequena para o seletor de cor dos grupos (a primeira é o padrão).
const COLORS = ['#fc5e03', '#e5484d', '#f5a524', '#30a46c', '#00a2c7', '#3e63dd', '#8e4ec6', '#d6409f'];
const BASE_WIDTH = { min: 480, max: 3840 }; // mesmos limites de tileBaseWidth nas Configurações

const str = (v, max = NAME_MAX) => String(v ?? '').trim().slice(0, max);

const accountKeys = (cfg) => (cfg.games || []).flatMap((g) => (g.accounts || []).map((a) => `${g.id}:${a.id}`));

// Mantém só chaves de contas que existem, sem repetir e na ordem recebida.
const validKeys = (list, known) => [...new Set((Array.isArray(list) ? list : []).map(String))].filter((k) => known.has(k));

const sanitizeGroup = (raw, known) => ({
  id: str(raw?.id, 40) || newId(),
  name: str(raw?.name) || 'Grupo',
  color: /^#[0-9a-f]{6}$/i.test(raw?.color) ? raw.color.toLowerCase() : COLORS[0],
  accountIds: validKeys(raw?.accountIds, known),
});

const sanitizeProfile = (raw, known) => {
  const w = Number(raw?.layout?.tileBaseWidth);
  return {
    id: str(raw?.id, 40) || newId(),
    name: str(raw?.name) || 'Perfil',
    awake: validKeys(raw?.awake, known),
    layout: Number.isFinite(w) ? { tileBaseWidth: Math.round(Math.min(BASE_WIDTH.max, Math.max(BASE_WIDTH.min, w))) } : {},
    muted: !!raw?.muted,
  };
};

// Completa e limpa grupos e perfis da config (configs antigas não têm nenhum). Devolve true se mudou algo.
// Roda ao abrir o app e quando jogos ou contas mudam: conta apagada some dos grupos e dos perfis.
const normalize = (cfg) => {
  const known = new Set(accountKeys(cfg));
  const before = JSON.stringify([cfg.groups, cfg.profiles]);
  cfg.groups = (Array.isArray(cfg.groups) ? cfg.groups : []).slice(0, MAX_GROUPS).map((g) => sanitizeGroup(g, known));
  cfg.profiles = (Array.isArray(cfg.profiles) ? cfg.profiles : []).slice(0, MAX_PROFILES).map((p) => sanitizeProfile(p, known));
  return JSON.stringify([cfg.groups, cfg.profiles]) !== before;
};

// O que mudar para que fiquem acordadas só as contas de `awake`: quem está dormindo e deve acordar,
// e quem está acordado e deve dormir. Quem já está como deve ficar não entra (não recarrega à toa).
const planAwake = (cfg, awake) => {
  const want = new Set(awake);
  const wake = [];
  const sleep = [];
  for (const g of cfg.games || []) {
    for (const a of g.accounts || []) {
      const key = `${g.id}:${a.id}`;
      if (want.has(key) && a.sleeping) wake.push(key);
      else if (!want.has(key) && !a.sleeping) sleep.push(key);
    }
  }
  return { wake, sleep };
};

// "Trocar para este grupo": acorda as contas do grupo e dorme todas as outras.
// Grupo sem nenhuma conta válida não faz nada (senão o app inteiro dormiria sem querer).
const planGroup = (cfg, groupId) => {
  const group = (cfg.groups || []).find((g) => g.id === groupId);
  if (!group) return { error: 'Esse grupo não existe mais.' };
  const known = new Set(accountKeys(cfg));
  const keys = validKeys(group.accountIds, known);
  if (!keys.length) return { error: 'Esse grupo não tem contas. Edite o grupo e escolha as contas.' };
  return { name: group.name, ...planAwake(cfg, keys) };
};

// Aplica um perfil: contas acordadas como foram salvas, e o resto dorme. Também devolve o que mudar
// nas configurações (som e tamanho-base do jogo), só o que o perfil guardou.
const planProfile = (cfg, profileId) => {
  const profile = (cfg.profiles || []).find((p) => p.id === profileId);
  if (!profile) return { error: 'Esse perfil não existe mais.' };
  const known = new Set(accountKeys(cfg));
  const settings = { muteAll: !!profile.muted };
  if (profile.layout?.tileBaseWidth) settings.tileBaseWidth = profile.layout.tileBaseWidth;
  return { name: profile.name, ...planAwake(cfg, validKeys(profile.awake, known)), settings };
};

// Guarda a arrumação de agora (contas acordadas, tamanho-base e som) como um perfil.
const snapshotProfile = (cfg, name, id) =>
  sanitizeProfile(
    {
      id,
      name,
      awake: accountKeys(cfg).filter((key) => {
        const [gid, aid] = key.split(':');
        return !cfg.games.find((g) => g.id === gid).accounts.find((a) => a.id === aid).sleeping;
      }),
      layout: { tileBaseWidth: cfg.settings?.tileBaseWidth },
      muted: cfg.settings?.muteAll,
    },
    new Set(accountKeys(cfg))
  );

module.exports = {
  COLORS, WAKE_GAP_MS, MAX_GROUPS, MAX_PROFILES, accountKeys, sanitizeGroup, sanitizeProfile, normalize, planAwake, planGroup, planProfile, snapshotProfile,
};
