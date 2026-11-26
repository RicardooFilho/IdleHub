// Roda o IdleLive (pasta idlelive/, o painel de pontos da Twitch e da Kick) num
// processo separado: se ele cair, os jogos continuam rodando e ele volta sozinho.
//
// Usa a porta 3000, a mesma do IdleLive avulso. Assim o favorito "Enviar para o
// IdleLive" continua valendo e as duas versões nunca rodam juntas com os mesmos
// tokens (o refresh token da Twitch só vale uma vez).
const { app, utilityProcess } = require('electron');
const fs = require('fs');
const net = require('net');
const path = require('path');

// IDLEHUB_IDLELIVE_PORT existe só para testar sem fechar o IdleLive avulso.
const PORT = Number(process.env.IDLEHUB_IDLELIVE_PORT) || 3000;
const RESTART_CODE = 75; // "Reiniciar servidor" do painel
const RETRY_BUSY_MS = 10000;
// Arquivos de dados do IdleLive (contas, tokens, canais, histórico). Nunca vão para o git.
const DATA_FILES = ['config.json', 'kick.json', 'points.json', 'lolidle.json', 'stats.json', 'votes.json', 'eventos.jsonl'];

// Empacotado, a pasta fica fora do .asar (asarUnpack), porque o IdleLive lê e grava arquivos nela.
const ROOT = path.join(__dirname, '..', '..', 'idlelive').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

class IdleLive {
  constructor({ onChange = () => {}, onReady = () => {} } = {}) {
    this.onChange = onChange;
    this.onReady = onReady;
    this.proc = null;
    this.status = 'stopped'; // stopped | starting | running | port-busy | crashed
    this.logs = [];
    this.failures = 0;
    this.timer = null;
    this.stopping = false;
  }

  get url() {
    return `http://127.0.0.1:${PORT}`;
  }

  get port() {
    return PORT;
  }

  dataDir() {
    return process.env.IDLEHUB_IDLELIVE_DATA || path.join(app.getPath('userData'), 'idlelive');
  }

  hasData() {
    return ['points.json', 'kick.json', 'lolidle.json'].some((f) => fs.existsSync(path.join(this.dataDir(), f)));
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    if (s === 'running') {
      this.failures = 0;
      this.onReady();
    }
    this.onChange();
  }

  pushLog(chunk) {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.logs.push(line);
      if (/Painel em http/.test(line)) this.setStatus('running');
    }
    if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
    this.onChange();
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), ms);
  }

  async start() {
    clearTimeout(this.timer);
    if (this.proc || this.stopping) return;
    // Logo depois de reiniciar, o processo antigo ainda pode estar soltando a porta: espera um pouco antes
    // de concluir que é outro IdleLive aberto.
    let free = await portFree(PORT);
    for (let i = 0; !free && i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      free = await portFree(PORT);
    }
    if (this.proc || this.stopping) return;
    if (!free) {
      // Normalmente é o IdleLive avulso (janela preta do iniciar.bat) aberto. Tenta de novo sozinho.
      this.setStatus('port-busy');
      return this.schedule(RETRY_BUSY_MS);
    }
    fs.mkdirSync(this.dataDir(), { recursive: true });
    this.setStatus('starting');
    const proc = utilityProcess.fork(path.join(ROOT, 'server.js'), [], {
      cwd: ROOT,
      stdio: 'pipe',
      serviceName: 'IdleLive',
      env: {
        ...process.env,
        PORT: String(PORT),
        IDLELIVE_DATA_DIR: this.dataDir(),
        IDLELIVE_EMBEDDED: '1',
      },
    });
    this.proc = proc;
    proc.stdout?.on('data', (d) => this.pushLog(d));
    proc.stderr?.on('data', (d) => this.pushLog(d));
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.stopping) return this.setStatus('stopped');
      if (code === RESTART_CODE) return this.start();
      this.failures++;
      this.pushLog(`IdleLive fechou (código ${code}). Abrindo de novo…`);
      this.setStatus('crashed');
      this.schedule(Math.min(60000, 3000 * 2 ** (this.failures - 1)));
    });
  }

  stop() {
    clearTimeout(this.timer);
    const proc = this.proc;
    if (!proc) {
      this.setStatus('stopped');
      return Promise.resolve();
    }
    this.stopping = true;
    return new Promise((resolve) => {
      const done = () => {
        this.stopping = false;
        resolve();
      };
      proc.once('exit', done);
      proc.kill();
      setTimeout(done, 5000);
    });
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  // Copia os dados de uma pasta do IdleLive avulso (contas, tokens, canais, histórico).
  // O avulso precisa estar fechado: os dois renovando o mesmo token derrubariam as contas.
  async importFrom(folder) {
    const found = DATA_FILES.filter((f) => fs.existsSync(path.join(folder, f)));
    if (!found.length) return { ok: false, error: 'Essa pasta não tem dados do IdleLive (points.json, kick.json…).' };
    await this.stop();
    if (!(await portFree(PORT))) {
      await this.start();
      return { ok: false, error: 'O IdleLive avulso ainda está aberto. Feche a janela preta dele e tente de novo.' };
    }
    const dir = this.dataDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const f of DATA_FILES) {
      const dest = path.join(dir, f);
      // Guarda o que já existia, por segurança.
      if (fs.existsSync(dest)) fs.renameSync(dest, `${dest}.antes-da-importacao-${stamp}`);
    }
    for (const f of found) fs.copyFileSync(path.join(folder, f), path.join(dir, f));
    this.logs = [];
    await this.start();
    return { ok: true, files: found };
  }

  snapshot() {
    return { status: this.status, url: this.url, port: PORT, hasData: this.hasData(), logs: this.logs.slice(-30) };
  }
}

module.exports = { IdleLive, DATA_FILES };
