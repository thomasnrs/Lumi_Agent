// Gera build/icon.ico (256x256, quadrado) a partir do icone.png da raiz.
// Usa jimp (puro JS) para redimensionar e png-to-ico para empacotar.
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const _pti = require('png-to-ico');
const pngToIco = _pti.default || _pti;

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'icone.png');
const OUT_DIR = path.join(ROOT, 'build');
const OUT_ICO = path.join(OUT_DIR, 'icon.ico');
const OUT_PNG = path.join(OUT_DIR, 'icon.png');

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const img = await Jimp.read(SRC);
  // recorta a margem transparente (deixa a figura preencher) e ajusta p/ quadrado
  if (typeof img.autocrop === 'function') img.autocrop({ tolerance: 0.0, cropOnlyFrames: false });
  // png 512 (Linux/empacotador) + 256 (base do .ico do Windows)
  const img512 = img.clone().contain(512, 512);
  fs.writeFileSync(OUT_PNG, await img512.getBufferAsync(Jimp.MIME_PNG));
  img.contain(256, 256);
  const png = await img.getBufferAsync(Jimp.MIME_PNG);
  const ico = await pngToIco(png);
  fs.writeFileSync(OUT_ICO, ico);
  console.log('OK -> build/icon.ico (', ico.length, 'bytes ) + build/icon.png (512, Linux)');
})().catch((e) => {
  console.error('Falha ao gerar o ícone:', e);
  process.exit(1);
});
