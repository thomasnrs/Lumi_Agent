// Compila o node-pty pro Electron (terminal com PTY REAL) com dois consertos:
// 1) o node-pty exige libs MSVC "Spectre-mitigated" (componente opcional que quase
//    ninguém tem) — desativamos a exigência nos .gyp antes de compilar;
// 2) NoDefaultCurrentDirectoryInExePath=1 (presente em alguns shells) quebra o
//    GetCommitHash.bat do winpty — limpamos a variável só pra este build.
// Rode de novo após qualquer `npm install` (ele restaura os .gyp originais).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = ['node_modules/node-pty/binding.gyp', 'node_modules/node-pty/deps/winpty/src/winpty.gyp'];
for (const rel of FILES) {
  const fp = path.join(ROOT, rel);
  try {
    const src = fs.readFileSync(fp, 'utf8');
    const out = src.replace(/'SpectreMitigation':\s*'Spectre'/g, "'SpectreMitigation': 'false'");
    if (out !== src) {
      fs.writeFileSync(fp, out);
      console.log('patch: exigência Spectre desativada em ' + rel);
    }
  } catch (e) {
    /* node-pty ausente — o electron-rebuild abaixo vai reclamar com contexto melhor */
  }
}

const env = { ...process.env };
delete env.NoDefaultCurrentDirectoryInExePath;
const r = spawnSync('npx', ['electron-rebuild', '-f', '-w', 'node-pty'], {
  stdio: 'inherit',
  cwd: ROOT,
  env,
  shell: process.platform === 'win32', // npx.cmd no Windows
});
process.exit(r.status == null ? 1 : r.status);
