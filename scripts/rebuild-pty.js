// Compila SÓ o node-pty pro Electron (terminal com PTY real).
// Usa a API do @electron/rebuild com onlyModules — o uiohook-napi NÃO é tocado
// (ele já vem com binário N-API pronto; recompilar à toa exigia headers X11 no
// Linux e travava com o app aberto no Windows).
// Consertos de ambiente aplicados antes do build:
//   1) exigência de libs MSVC "Spectre-mitigated" desativada nos .gyp (MSB8040);
//   2) NoDefaultCurrentDirectoryInExePath removida (quebra o GetCommitHash.bat).
// Rode de novo após `npm install` (que restaura os .gyp).
const fs = require('fs');
const path = require('path');

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
    /* node-pty ausente — o rebuild abaixo reclama com contexto melhor */
  }
}

delete process.env.NoDefaultCurrentDirectoryInExePath; // herda pros filhos do rebuild

const { rebuild } = require('@electron/rebuild');
const electronVersion = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;

if (/\s/.test(ROOT)) {
  console.warn('⚠ o caminho do projeto tem ESPAÇOS ("' + ROOT + '") — o node-gyp às vezes engasga com isso; se falhar, mova pra um caminho sem espaços.');
}

rebuild({ buildPath: ROOT, electronVersion, force: true, onlyModules: ['node-pty'] })
  .then(() => {
    console.log('✓ node-pty compilado pro Electron ' + electronVersion + ' — PTY real ativo no próximo boot.');
  })
  .catch((e) => {
    const msg = String((e && e.message) || e);
    console.error('✗ falhou: ' + msg);
    if (/EPERM/i.test(msg)) {
      console.error('O arquivo está em uso — FECHE a Lumi e rode de novo. (Se ela já está com o terminal PTY funcionando, você nem precisa recompilar.)');
    } else if (process.platform === 'linux') {
      console.error('Linux: garanta as ferramentas de build → sudo apt install -y build-essential python3 make g++');
    } else if (/MSB8040|Spectre/i.test(msg)) {
      console.error('Windows: rode de novo (o patch Spectre é aplicado antes do build) ou instale as libs Spectre no Visual Studio Installer.');
    } else if (/Visual Studio|MSBuild|msvs/i.test(msg)) {
      console.error('Windows: instale o Visual Studio Build Tools com a carga "Desktop development with C++".');
    }
    process.exit(1);
  });
