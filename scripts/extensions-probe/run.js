// Driver do teste de extensões (TAG-37). Roda main.js no Electron do projeto: uma vez sem
// extensão (controle) e uma vez por pasta de extensão, e mostra o que mudou na página.
//
//   node scripts/extensions-probe/run.js [--ms=20000] [--url=https://pokeidle.io/] <pasta> [<pasta>...]
//   node scripts/extensions-probe/run.js probe          (usa a extensão-sonda deste repositório)
//
// Opcional: IDLEHUB_PROBE_ECE=<pasta do módulo electron-chrome-extensions> testa também esse complemento
// (instale-o numa pasta temporária, fora do repositório; o IdleHub não depende dele).
// Precisa do Electron do projeto (npm install) ou de NODE_PATH apontando para um node_modules com ele.
//
// As pastas devem ser extensões JÁ DESCOMPACTADAS, baixadas numa pasta fora do repositório.
// Tudo roda com janela escondida e dados temporários; nada de login, nada de contas reais.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const opt = (name, def) => (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || def;
const ms = opt('ms', '20000');
const url = opt('url', 'https://pokeidle.io/');
const dirs = args.filter((a) => !a.startsWith('--')).map((a) => (a === 'probe' ? path.join(__dirname, 'probe-ext') : a));

const electronBin = require(require.resolve('electron', { paths: [path.join(__dirname, '..', '..'), process.env.NODE_PATH || '.'] }));

function run(extDir) {
  // No Windows o Electron não liga o stdout ao terminal: relatório e log do Chromium vão para arquivos.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-probe-run-'));
  const reportFile = path.join(tmp, 'report.json');
  const logFile = path.join(tmp, 'chromium.log');
  const env = { ...process.env, IDLEHUB_PROBE_OUT: reportFile, IDLEHUB_PROBE_URL: url };
  delete env.ELECTRON_RUN_AS_NODE; // senão o Electron roda como Node puro
  spawnSync(electronBin, [path.join(__dirname, 'main.js'), `--enable-logging=file`, `--log-file=${logFile}`, extDir, ms], {
    encoding: 'utf8',
    timeout: Number(ms) + 90000,
    env,
  });
  // Avisos do Chromium sobre a extensão (API não suportada, chave desconhecida...) vão para o log.
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const warns = log.split(/\r?\n/).filter((l) => /xtension|manifest|ermission|chrome\./i.test(l) && !/DevTools listening/.test(l)).map((l) => l.slice(0, 400)).slice(0, 40);
  const r = fs.existsSync(reportFile) ? { ...JSON.parse(fs.readFileSync(reportFile, 'utf8')), warns } : { error: 'sem relatório', log: log.slice(-1500), warns };
  fs.rmSync(tmp, { recursive: true, force: true });
  return r;
}

const diff = (a, b) => b.filter((x) => !a.includes(x));
const out = { control: run('none'), results: {} };
for (const d of dirs) {
  const r = run(d);
  const c = out.control.signature || {};
  const s = r.signature || {};
  r.diff = s.own && c.own ? {
    newWindowKeys: diff(c.own, s.own),
    newIds: diff(c.ids || [], s.ids || []),
    newHosts: diff(c.hosts || [], s.hosts || []),
    newCustomTags: diff(c.custom || [], s.custom || []),
    newScripts: diff(c.scripts || [], s.scripts || []),
    nodesDelta: s.nodes - c.nodes,
    wsPatched: s.ws !== c.ws,
  } : null;
  out.results[path.basename(d) === 'extension' ? d : path.basename(d)] = r;
}
const file = opt('out', '');
if (file) fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
