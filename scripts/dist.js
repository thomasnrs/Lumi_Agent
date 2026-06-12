// Build de PRODUÇÃO: minifica o renderer, OFUSCA main.js + preload.js (proteção),
// empacota com electron-builder (instalador NSIS) e RESTAURA o código original.
// O fonte do repositório nunca fica ofuscado — só o que vai dentro do instalador.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');
const JO = require('javascript-obfuscator');
const builder = require('electron-builder');

const ROOT = path.join(__dirname, '..');
const RENDERER_ENTRY = path.join(ROOT, 'src', 'renderer', 'main.js');
const RENDERER_OUT = path.join(ROOT, 'src', 'renderer', 'renderer.bundle.js');
const PROTECT = [path.join(ROOT, 'src', 'main', 'main.js'), path.join(ROOT, 'src', 'main', 'preload.js')];

// opções conservadoras: escondem strings/lógica sem quebrar require/contextBridge/IPC
const OBFUSCATE_OPTS = {
  compact: true,
  controlFlowFlattening: false, // desligado p/ não arriscar timing/estabilidade
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false, // NÃO renomeia nomes de topo (evita quebrar referências)
  renameProperties: false, // NÃO renomeia chaves (preserva window.api.*, IPC, etc.)
  selfDefending: false,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.8,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
};

function renderer(minify) {
  esbuild.buildSync({
    entryPoints: [RENDERER_ENTRY],
    bundle: true,
    outfile: RENDERER_OUT,
    format: 'iife',
    platform: 'browser',
    minify: !!minify,
  });
}

// roda o obfuscator silenciando o anúncio "Pro" (puro marketing do pacote)
function obfuscate(code) {
  const orig = { log: console.log, info: console.info, warn: console.warn };
  console.log = console.info = console.warn = () => {};
  try {
    return JO.obfuscate(code, OBFUSCATE_OPTS).getObfuscatedCode();
  } finally {
    Object.assign(console, orig);
  }
}

// RECUPERAÇÃO: se sobrou .bak de uma execução interrompida (ex.: OneDrive travou o
// restore), recupera o fonte antes de começar — assim nunca se perde o código original.
PROTECT.forEach((f) => {
  const bak = f + '.bak';
  try {
    if (fs.existsSync(bak)) fs.copyFileSync(bak, f);
  } catch (e) {
    /* ok */
  }
});
const originals = PROTECT.map((f) => fs.readFileSync(f, 'utf8'));
// grava backups antes de mexer (segurança contra lock do OneDrive no restore)
PROTECT.forEach((f, i) => {
  try {
    fs.writeFileSync(f + '.bak', originals[i]);
  } catch (e) {
    /* ok */
  }
});
function restore() {
  PROTECT.forEach((f, i) => {
    for (let t = 0; t < 3; t++) {
      try {
        fs.writeFileSync(f, originals[i]);
        break;
      } catch (e) {
        /* OneDrive pode travar; tenta de novo */
      }
    }
  });
  // só apaga o .bak quando confirmar que o fonte voltou igual ao original
  PROTECT.forEach((f, i) => {
    try {
      if (fs.readFileSync(f, 'utf8') === originals[i]) fs.unlinkSync(f + '.bak');
    } catch (e) {
      /* mantém o .bak para a próxima execução recuperar */
    }
  });
}

// alvo: Windows (padrão) ou Linux com `npm run dist -- --linux`
const LINUX_TARGET = process.argv.includes('--linux');

(async () => {
  try {
    if (LINUX_TARGET && process.platform === 'win32') {
      console.warn('⚠ Buildar Linux a partir do Windows costuma falhar nos módulos nativos (uiohook/nut.js).');
      console.warn('  Recomendado: rodar este comando dentro do WSL2 ou numa máquina/CI Linux.');
    }
    if (!fs.existsSync(path.join(ROOT, 'build', 'icon.ico')) || (LINUX_TARGET && !fs.existsSync(path.join(ROOT, 'build', 'icon.png')))) {
      console.log('==> Gerando ícones (build/icon.ico + icon.png)...');
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-icon.js')], { stdio: 'inherit', cwd: ROOT });
    }

    console.log('==> Minificando o renderer...');
    renderer(true);

    console.log('==> Ofuscando main.js + preload.js...');
    PROTECT.forEach((f, i) => {
      const obf = obfuscate(originals[i]);
      // eslint-disable-next-line no-new, no-new-func
      new Function(obf); // valida que continua JS válido (não executa)
      fs.writeFileSync(f, obf);
      console.log('    ok ' + path.basename(f) + ' (' + originals[i].length + ' -> ' + obf.length + ' bytes)');
    });

    // no CI (tag + GH_TOKEN) publica direto nos GitHub Releases — alimenta o auto-update
    const PUBLISH = process.env.GH_TOKEN || process.env.GITHUB_TOKEN ? 'always' : 'never';
    console.log('==> Empacotando (electron-builder, ' + (LINUX_TARGET ? 'AppImage+deb Linux' : 'instalador NSIS') + ', publish: ' + PUBLISH + ')...');
    await builder.build({
      targets: LINUX_TARGET
        ? builder.Platform.LINUX.createTarget(['AppImage', 'deb'], builder.Arch.x64)
        : builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64),
      projectDir: ROOT,
      publish: PUBLISH,
    });

    console.log('\n✅ Pronto! Pacote em: release/');
  } catch (e) {
    console.error('\n❌ Falha no build:', (e && e.message) || e);
    process.exitCode = 1;
  } finally {
    console.log('==> Restaurando o código original (dev) + rebuild do renderer...');
    restore();
    try {
      renderer(false);
    } catch (e) {
      /* ok */
    }
  }
})();
