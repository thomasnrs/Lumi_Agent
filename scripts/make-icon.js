// Gera o conjunto de ícones OFICIAL da Lumi (a marca ✦) — tudo renderizado em código,
// sem depender de arquivo de arte: quadrado arredondado com gradiente indigo→violeta
// + faísca de 4 pontas (a mesma geometria do assets/brand/lumi.svg).
//
// Saídas:
//   build/icon.ico            (Windows: app + instalador; 16/24/32/48/64/128/256)
//   build/icon.png            (Linux: AppImage/deb; 512)
//   assets/brand/lumi-mark.png(512 — bandeja/janelas em runtime e usos gerais)
//
// O icone.png da raiz (mascote) NÃO é tocado — é arte de divulgação.
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const _pti = require('png-to-ico');
const pngToIco = _pti.default || _pti;

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build');
const BRAND_DIR = path.join(ROOT, 'assets', 'brand');

// ---- geometria da marca (coordenadas normalizadas 0..1, casadas com o lumi.svg) ----
const MARGIN = 0.02; // respiro até a borda do canvas
const RADIUS = 0.215; // raio dos cantos do quadrado
const GRAD_A = [110, 139, 255]; // #6e8bff (indigo claro, casa com o --accent)
const GRAD_B = [138, 63, 252]; // #8a3ffc (violeta)
const GLOW = { x: 0.38, y: 0.34, r: 0.6, a: 0.16 }; // luz suave no alto
const STAR1 = { x: 0.47, y: 0.53, r: 0.3 }; // faísca principal
const STAR2 = { x: 0.74, y: 0.26, r: 0.115, alpha: 0.95 }; // faísca companheira

// quadrado arredondado: distância até o retângulo interno dos centros dos cantos
function insideRoundedRect(u, v) {
  const half = 0.5 - MARGIN - RADIUS;
  const dx = Math.max(Math.abs(u - 0.5) - half, 0);
  const dy = Math.max(Math.abs(v - 0.5) - half, 0);
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}
// faísca ✦: |x|^½ + |y|^½ ≤ r^½ — exatamente a curva "Q pelo centro" do SVG
function insideStar(u, v, s) {
  return Math.sqrt(Math.abs(u - s.x)) + Math.sqrt(Math.abs(v - s.y)) <= Math.sqrt(s.r);
}

function renderMark(size) {
  const SS = 4; // 4x4 subamostras por pixel = bordas lisas
  const data = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (px + (sx + 0.5) / SS) / size;
          const v = (py + (sy + 0.5) / SS) / size;
          if (!insideRoundedRect(u, v)) continue;
          // gradiente na diagonal + brilho radial
          const t = (u + v) / 2;
          let cr = GRAD_A[0] + (GRAD_B[0] - GRAD_A[0]) * t;
          let cg = GRAD_A[1] + (GRAD_B[1] - GRAD_A[1]) * t;
          let cb = GRAD_A[2] + (GRAD_B[2] - GRAD_A[2]) * t;
          const gd = Math.hypot(u - GLOW.x, v - GLOW.y);
          const ga = GLOW.a * Math.max(0, 1 - gd / GLOW.r);
          cr += (255 - cr) * ga;
          cg += (255 - cg) * ga;
          cb += (255 - cb) * ga;
          // faíscas por cima
          if (insideStar(u, v, STAR1)) {
            cr = cg = cb = 255;
          } else if (insideStar(u, v, STAR2)) {
            cr += (255 - cr) * STAR2.alpha;
            cg += (255 - cg) * STAR2.alpha;
            cb += (255 - cb) * STAR2.alpha;
          }
          r += cr;
          g += cg;
          b += cb;
          a += 255;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      const cov = a / (n * 255); // cobertura do pixel (anti-alias da borda)
      data[i] = cov ? Math.round(r / (n * cov)) : 0;
      data[i + 1] = cov ? Math.round(g / (n * cov)) : 0;
      data[i + 2] = cov ? Math.round(b / (n * cov)) : 0;
      data[i + 3] = Math.round(a / n);
    }
  }
  return new Jimp({ data, width: size, height: size });
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(BRAND_DIR, { recursive: true });
  const png = async (size) => renderMark(size).getBufferAsync(Jimp.MIME_PNG);

  const png512 = await png(512);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png512);
  fs.writeFileSync(path.join(BRAND_DIR, 'lumi-mark.png'), png512);

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const ico = await pngToIco(await Promise.all(icoSizes.map(png)));
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);

  console.log('OK -> build/icon.ico (' + icoSizes.join('/') + ') + build/icon.png (512) + assets/brand/lumi-mark.png');
})().catch((e) => {
  console.error('Falha ao gerar os ícones:', e);
  process.exit(1);
});
