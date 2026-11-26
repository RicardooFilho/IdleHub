// Confere a sintaxe de todos os .js do IdleHub (node --check), sem rodar nada.
// A pasta idlelive/ tem o próprio (npm run test:idlelive).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'idlelive']);

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
};
walk(ROOT);

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`✗ ${path.relative(ROOT, file)}\n${err.stderr}`);
  }
}
console.log(`${files.length - failed} de ${files.length} arquivos sem erro de sintaxe`);
process.exit(failed ? 1 : 0);
