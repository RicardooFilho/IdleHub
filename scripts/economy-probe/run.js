// Driver da sonda do modo econômico (TAG-18): sobe o servidor local, roda main.js uma vez por cenário
// (modo x estado da janela) no Electron do projeto e mostra uma linha por cenário. Os relatórios
// completos vão para um arquivo .jsonl (um cenário por linha); com --resume pula os que já estão lá.
//
//   node scripts/economy-probe/run.js --modes=visible,hidden,removed --states=normal,minimized --ms=120000 --out=resultado.jsonl
//   node scripts/economy-probe/run.js --modes=hidden --states=normal --capture=5000,15000,30000 --accounts=4,8 --ms=120000
//
// Opções: --modes, --states, --accounts (lista), --capture (lista de intervalos em ms; vazio = sem captura),
//         --ms (tempo medindo), --warm, --settle, --fps (limite de FPS das contas, padrão 30), --stay-hidden=0|1,
//         --out, --resume, --tag (rótulo extra).
// Modos: visible, hidden (o de hoje), removed, zero, offscreen, hidden-throttle, removed-throttle,
//        garage, garage-nopulse (contas numa janela fora da tela, --pulse=ms) e texture (fora da tela, --texture-fps).
// Estados da janela: normal, minimized, occluded, tray.
// Precisa do Electron do projeto (npm install) ou de NODE_PATH apontando para um node_modules com ele.
// Janelas pequenas aparecem no canto da tela durante a medição (sem roubar o foco) e se fecham sozinhas.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('./server');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const list = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);
const modes = list(opt('modes', 'visible,hidden'));
const states = list(opt('states', 'normal'));
const accountsList = list(opt('accounts', '4')).map(Number);
const captureList = list(opt('capture', '')).map(Number);
const ms = Number(opt('ms', '120000'));
const warmMs = Number(opt('warm', '8000'));
const settleMs = Number(opt('settle', '8000'));
const fps = Number(opt('fps', '30'));
const textureFps = Number(opt('texture-fps', '20'));
const pulseMs = Number(opt('pulse', '100'));
const stayHidden = opt('stay-hidden', '1') !== '0';
const tag = opt('tag', '');
const out = opt('out', path.join(os.tmpdir(), `economy-probe-${Date.now()}.jsonl`));
const resume = args.includes('--resume');

const electronBin = require(require.resolve('electron', { paths: [path.join(__dirname, '..', '..'), process.env.NODE_PATH || '.'] }));

const scenarios = [];
for (const accounts of accountsList) {
  for (const mode of modes) {
    for (const win of states) {
      for (const interval of captureList.length ? captureList : [0]) {
        const capture = interval ? { intervalMs: interval, stayHidden } : null;
        const name = [tag, mode, win, `${accounts}c`, capture ? `cap${interval / 1000}s${stayHidden ? '' : '-show'}` : '', ms === 120000 ? '' : `${Math.round(ms / 1000)}s`].filter(Boolean).join('_');
        scenarios.push({ name, mode, win, accounts, ms, warmMs, settleMs, fps, capture, textureFps, pulseMs });
      }
    }
  }
}

const done = new Set();
if (resume && fs.existsSync(out)) {
  for (const l of fs.readFileSync(out, 'utf8').split('\n').filter(Boolean)) {
    try {
      done.add(JSON.parse(l).name);
    } catch (_) {}
  }
}

function runOne(sc, port) {
  return new Promise((resolve) => {
    // No Windows o Electron não liga o stdout ao terminal: o relatório vai para um arquivo.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-econ-run-'));
    const reportFile = path.join(tmp, 'report.json');
    const env = { ...process.env, IDLEHUB_PROBE_OUT: reportFile, IDLEHUB_ECON_CFG: JSON.stringify({ ...sc, port }) };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.IDLEHUB_DATA;
    const child = spawn(electronBin, [path.join(__dirname, 'main.js')], { env, stdio: 'ignore' });
    const kill = setTimeout(() => child.kill(), sc.warmMs + sc.settleMs + sc.ms + 150000);
    child.on('exit', (code) => {
      clearTimeout(kill);
      let rep = null;
      try {
        rep = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
      } catch (_) {
        rep = { name: sc.name, cfg: sc, crashed: code };
        try {
          rep.err = fs.readFileSync(reportFile + '.err', 'utf8');
        } catch (_e) {}
      }
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch (_) {}
      resolve(rep);
    });
  });
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-');

// Uma linha por cenário: razões em % do esperado (100 = igual ao relógio), a PIOR conta entre as N.
function summarize(r) {
  const v = (r.views || []).filter((x) => !x.error);
  if (!v.length) return `${r.name}: sem dados (${r.timeout ? 'tempo esgotado' : r.crashed !== undefined ? 'caiu ' + r.crashed : 'erro'})`;
  const min = (k) => Math.min(...v.map((x) => x[k]));
  const max = (k) => Math.max(...v.map((x) => x[k]));
  const p = r.procs?.byRole || {};
  const cpu = (k) => p[k]?.cpuAvg || 0;
  const total = Object.values(p).reduce((s, x) => s + x.cpuAvg, 0);
  const cap = r.capture ? ` | cap ${r.capture.ok}/${r.capture.n} ${f(r.capture.msAvg, 0)}ms` : '';
  return [
    r.name.padEnd(34),
    `int ${f(min('tickRatio') * 100)}%`, `tm ${f(min('tmRatio') * 100)}%`, `dt ${f(min('dtProgressRatio') * 100)}%`,
    `ws ${f(avg(v.map((x) => x.wsN / (x.elapsedMs / 1000))))}/s lag95 ${f(max('lagP95'), 0)}ms`, `fps ${f(avg(v.map((x) => x.fps)))}`,
    `CPU contas ${f(cpu('contas'))} gpu ${f(cpu('GPU'))} main ${f(cpu('Browser'))} total ${f(total)}`,
    `MB contas ${f(p.contas?.privMB || 0, 0)} gpu ${f(p.GPU?.privMB || 0, 0)}`,
  ].join(' | ') + cap;
}

(async () => {
  const srv = await start();
  console.log(`servidor de teste na porta ${srv.port}; ${scenarios.length} cenário(s); saída: ${out}`);
  for (const sc of scenarios) {
    if (done.has(sc.name)) {
      console.log(`pulei ${sc.name} (já está no arquivo)`);
      continue;
    }
    const rep = await runOne(sc, srv.port);
    fs.appendFileSync(out, JSON.stringify(rep) + '\n');
    console.log(summarize(rep));
  }
  srv.close();
})();
