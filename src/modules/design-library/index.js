'use strict';

const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');

const REQUIRED_COLORS = ['canvas', 'surface', 'elevated', 'text', 'muted', 'border', 'primary', 'secondary', 'danger'];

function getPreset(id) {
  const key = String(id || '').trim().toLowerCase();
  return catalog.find((preset) => preset.id === key) || null;
}

function listPresets(filters) {
  const opts = filters || {};
  const query = String(opts.query || '').trim().toLowerCase();
  const tags = (Array.isArray(opts.tags) ? opts.tags : []).map((tag) => String(tag).toLowerCase());
  return catalog
    .filter((preset) => !opts.mode || preset.mode === opts.mode)
    .filter((preset) => !tags.length || tags.every((tag) => preset.tags.includes(tag)))
    .filter((preset) => {
      if (!query) return true;
      return [preset.name, preset.summary, ...preset.tags, ...preset.suitableFor].join(' ').toLowerCase().includes(query);
    })
    .map((preset) => ({
      id: preset.id,
      name: preset.name,
      version: preset.version,
      mode: preset.mode,
      summary: preset.summary,
      tags: [...preset.tags],
      suitableFor: [...preset.suitableFor],
      colors: { ...preset.colors },
      typography: { ...preset.typography },
      preview: { ...preset.preview },
    }));
}

function validatePreset(preset) {
  const errors = [];
  if (!preset || typeof preset !== 'object') return ['preset ausente'];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(preset.id || ''))) errors.push('id inválido');
  for (const key of ['name', 'summary', 'mode', 'direction', 'colors', 'typography', 'geometry', 'layout', 'components', 'motion', 'avoid', 'preview']) {
    if (preset[key] == null) errors.push(`campo obrigatório ausente: ${key}`);
  }
  for (const key of REQUIRED_COLORS) {
    if (!preset.colors || !/^#[0-9a-f]{6}$/i.test(String(preset.colors[key] || ''))) errors.push(`cor inválida: ${key}`);
  }
  for (const key of ['direction', 'layout', 'components', 'motion', 'avoid']) {
    if (!Array.isArray(preset[key]) || preset[key].length < 2) errors.push(`seção insuficiente: ${key}`);
  }
  return errors;
}

function bulletList(items) {
  return (items || []).map((item) => `- ${item}`).join('\n');
}

function colorTable(colors) {
  const labels = {
    canvas: 'Canvas / fundo da página',
    surface: 'Superfície',
    elevated: 'Superfície elevada',
    text: 'Texto principal',
    muted: 'Texto secundário',
    border: 'Bordas e divisores',
    primary: 'Ação primária',
    secondary: 'Acento secundário',
    danger: 'Erro / ação destrutiva',
  };
  return REQUIRED_COLORS.map((key) => `| \`--color-${key}\` | \`${colors[key]}\` | ${labels[key]} |`).join('\n');
}

function generateDesignMarkdown(id, options) {
  const preset = typeof id === 'object' ? id : getPreset(id);
  if (!preset) throw new Error(`preset de design não encontrado: ${id}`);
  const errors = validatePreset(preset);
  if (errors.length) throw new Error(`preset inválido (${preset.id}): ${errors.join('; ')}`);
  const opts = options || {};
  const project = String(opts.projectName || '').trim();
  const projectLine = project ? `\nProjeto: **${project}**  ` : '';
  return `---
lumi_design_preset: ${preset.id}
lumi_design_version: ${preset.version}
mode: ${preset.mode}
---

# DESIGN.md — ${preset.name}
${projectLine}
> Fonte de verdade visual deste projeto. Leia este arquivo antes de criar, editar ou revisar qualquer interface.

## 1. Intenção do sistema

${preset.summary}

${bulletList(preset.direction)}

### Adequado para

${bulletList(preset.suitableFor)}

## 2. Tokens de cor

| Token | Valor | Função |
|---|---:|---|
${colorTable(preset.colors)}

Regras:

- Use os tokens por função semântica; não espalhe valores hexadecimais arbitrários pelos componentes.
- A cor primária é reservada para ação, seleção e foco. A secundária não compete com ela.
- Estados de sucesso, alerta e informação devem ser derivados com contraste WCAG AA e acompanhados por texto ou ícone.
- Texto normal deve atingir contraste mínimo de 4.5:1; texto grande, 3:1.

## 3. Tipografia

- Display: **${preset.typography.display}**, peso ${preset.typography.displayWeight}; fallback: system-ui, sans-serif.
- Corpo: **${preset.typography.body}**, peso ${preset.typography.bodyWeight}; fallback: system-ui, sans-serif.
- Código e dados: **${preset.typography.mono}**, fallback: ui-monospace, monospace.
- Tracking de títulos: \`${preset.typography.tracking}\`.
- Escala sugerida: 12, 14, 16, 18, 24, 32, 48 e 72px; use \`clamp()\` nos títulos responsivos.
- Corpo com line-height entre 1.5 e 1.65 e linhas de leitura entre 45 e 75 caracteres.
- Carregue no máximo duas famílias remotas; prefira fontes já existentes no projeto e use \`font-display: swap\`.

## 4. Geometria, espaço e profundidade

- Unidade base de espaçamento: **4px**. Escala: 4, 8, 12, 16, 24, 32, 48, 64, 96.
- Raio de cards: \`${preset.geometry.radius}\`.
- Raio de controles: \`${preset.geometry.controlRadius}\`.
- Borda padrão: \`${preset.geometry.border} solid var(--color-border)\`.
- Sombra elevada: \`${preset.geometry.shadow}\`.
- Densidade: **${preset.geometry.density}**.
- Elementos aninhados usam raio interno menor ou igual ao raio externo menos o padding.

## 5. Layout e composição

${bulletList(preset.layout)}

Regras globais:

- Mobile first; valide em 320, 375, 768, 1024, 1280 e 1536px.
- Use grid para estrutura bidimensional e flex apenas para alinhamento em um eixo.
- Touch targets têm no mínimo 44×44px.
- Seções devem ter um único foco visual e hierarquia reconhecível em três segundos.

## 6. Componentes

${bulletList(preset.components)}

Todo componente interativo deve possuir estados de repouso, hover, active, focus-visible, disabled, loading e erro quando aplicável. Labels não podem depender apenas de placeholder, cor ou tooltip.

## 7. Movimento

${bulletList(preset.motion)}

- Interações: 150–300ms. Entradas: 300–500ms.
- Prefira \`transform\` e \`opacity\`; evite animar propriedades que causam layout shift.
- Implemente \`@media (prefers-reduced-motion: reduce)\` e remova movimento não essencial.

## 8. Acessibilidade e conteúdo

- HTML semântico, ordem de foco lógica, foco sempre visível e navegação completa por teclado.
- Imagens informativas exigem \`alt\`; imagens decorativas usam \`alt=""\`.
- Erros de formulário explicam como corrigir o problema e são associados ao campo.
- Nunca comunique estado apenas por cor. Combine cor, texto, forma ou ícone.
- Respeite zoom de 200%, preferências de movimento e áreas seguras em dispositivos móveis.

## 9. Evitar

${bulletList(preset.avoid)}

Também evite páginas genéricas de framework, paredes de cards idênticos, decoração sem função, espaçamento inconsistente e novos tokens criados sem necessidade.

## 10. Contrato para agentes de código

1. Antes de alterar UI, leia este arquivo e inspecione os estilos/componentes já existentes.
2. Preserve comportamento, conteúdo e arquitetura que não façam parte do pedido.
3. Reutilize tokens e componentes existentes antes de criar novos.
4. Se o pedido explícito do usuário conflitar com este documento, o pedido do usuário vence; registre a decisão e mantenha o restante consistente.
5. Ao introduzir um padrão novo, atualize este DESIGN.md ou explique por que a exceção é local.
6. Verifique responsividade, contraste, foco, loading, vazio, erro e redução de movimento antes de concluir.

## 11. Personalizações do projeto

Registre abaixo mudanças deliberadas feitas neste preset. Esta seção pertence ao projeto e não deve ser apagada ao evoluir a interface.

- Nenhuma personalização registrada ainda.
`;
}

function xml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}

function safeColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : fallback;
}

function previewScene(preset) {
  const c = preset.colors;
  const type = preset.preview.composition;
  const card = (x, y, w, h, fill, extra) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${parseInt(preset.geometry.radius, 10) || 0}" fill="${fill}" stroke="${c.border}"${extra || ''}/>`;
  if (type === 'dashboard') {
    return `${card(44, 168, 872, 366, c.surface)}<rect x="44" y="168" width="174" height="366" rx="${parseInt(preset.geometry.radius, 10) || 0}" fill="${c.elevated}"/>
      <circle cx="78" cy="207" r="10" fill="${c.primary}"/><text x="102" y="212" class="lumi-ds-label">CONTROL</text>
      ${[0, 1, 2, 3].map((i) => `<rect x="72" y="${258 + i * 48}" width="112" height="8" rx="4" fill="${i === 0 ? c.primary : c.muted}" opacity="${i === 0 ? 1 : .38}"/>`).join('')}
      <text x="252" y="216" class="lumi-ds-label">PERFORMANCE OVERVIEW</text><text x="252" y="274" class="lumi-ds-metric">84.2</text><text x="386" y="272" class="lumi-ds-body">reliability score</text>
      ${card(252, 316, 190, 168, c.elevated)}${card(460, 316, 190, 168, c.elevated)}${card(668, 316, 214, 168, c.elevated)}
      <path d="M276 442 L304 414 L332 430 L362 368 L414 390" fill="none" stroke="${c.primary}" stroke-width="4"/>
      <circle cx="518" cy="394" r="42" fill="none" stroke="${c.border}" stroke-width="12"/><path d="M518 352 A42 42 0 0 1 558 406" fill="none" stroke="${c.secondary}" stroke-width="12" stroke-linecap="round"/>
      ${[0, 1, 2, 3].map((i) => `<rect x="694" y="${360 + i * 27}" width="${116 + i * 12}" height="10" rx="5" fill="${i === 3 ? c.primary : c.border}"/>`).join('')}`;
  }
  if (type === 'editorial' || type === 'editorial-minimal') {
    return `${card(54, 184, 852, 344, c.surface)}
      <rect x="82" y="214" width="360" height="12" fill="${c.primary}" opacity=".9"/>
      <text x="82" y="294" class="lumi-ds-hero lumi-ds-serif">${xml(preset.preview.headline)}</text>
      <text x="82" y="342" class="lumi-ds-body">A durable visual language for thoughtful digital products.</text>
      <line x1="82" y1="390" x2="878" y2="390" stroke="${c.border}"/>
      <text x="82" y="434" class="lumi-ds-label">01 — FOUNDATION</text><text x="382" y="434" class="lumi-ds-label">02 — SYSTEM</text>
      <rect x="698" y="420" width="180" height="62" rx="${type === 'editorial-minimal' ? 8 : 31}" fill="${c.primary}"/><text x="788" y="457" text-anchor="middle" class="lumi-ds-button">Explore</text>`;
  }
  if (type === 'terminal') {
    return `${card(44, 174, 872, 358, c.surface)}<rect x="44" y="174" width="190" height="358" fill="${c.elevated}"/>
      <text x="70" y="220" class="lumi-ds-label">OPERATIONS</text>${[0, 1, 2, 3, 4].map((i) => `<rect x="70" y="${248 + i * 44}" width="130" height="8" fill="${i === 1 ? c.primary : c.muted}" opacity="${i === 1 ? 1 : .45}"/>`).join('')}
      <text x="270" y="226" class="lumi-ds-label">LIVE OVERVIEW</text><text x="270" y="282" class="lumi-ds-metric">98.7%</text>
      ${card(270, 318, 190, 164, c.elevated)}${card(480, 318, 190, 164, c.elevated)}${card(690, 318, 190, 164, c.elevated)}
      <path d="M290 438 L324 412 L358 424 L394 365 L438 388" fill="none" stroke="${c.primary}" stroke-width="5"/>`;
  }
  if (type === 'notebook') {
    return `<pattern id="rules" width="20" height="28" patternUnits="userSpaceOnUse"><line x1="0" y1="27" x2="20" y2="27" stroke="${c.border}" opacity=".55"/></pattern><rect x="54" y="174" width="852" height="358" rx="6" fill="${c.surface}"/><rect x="54" y="174" width="852" height="358" fill="url(#rules)"/><line x1="146" y1="174" x2="146" y2="532" stroke="${c.secondary}" stroke-width="2"/>
      <text x="178" y="254" class="lumi-ds-hero lumi-ds-serif">${xml(preset.preview.headline)}</text><text x="178" y="310" class="lumi-ds-body">Notes, tasks and ideas aligned to one calm rhythm.</text>
      <rect x="178" y="358" width="24" height="24" fill="none" stroke="${c.primary}" stroke-width="2"/><path d="M184 370 l7 7 16 -19" fill="none" stroke="${c.primary}" stroke-width="3"/><text x="220" y="376" class="lumi-ds-body">Turn observations into decisions</text>`;
  }
  if (type === 'retro') {
    return `<rect x="44" y="166" width="872" height="374" fill="${c.canvas}"/>
      <rect x="92" y="204" width="480" height="284" fill="${c.surface}" stroke="${c.text}" stroke-width="2"/><rect x="98" y="210" width="468" height="32" fill="${c.primary}"/><text x="112" y="232" class="lumi-ds-button">PROJECT_EXPLORER.EXE</text>
      <rect x="116" y="270" width="420" height="146" fill="${c.elevated}" stroke="${c.border}" stroke-width="2"/><text x="136" y="318" class="lumi-ds-hero lumi-ds-retro">${xml(preset.preview.headline)}</text>
      <rect x="688" y="220" width="132" height="118" fill="${c.surface}" stroke="${c.text}" stroke-width="2"/><rect x="700" y="232" width="36" height="36" fill="${c.secondary}"/><rect x="748" y="232" width="36" height="36" fill="${c.primary}"/>`;
  }
  if (type === 'studio') {
    return `<defs><radialGradient id="g1"><stop offset="0" stop-color="${c.secondary}"/><stop offset="1" stop-color="${c.primary}"/></radialGradient></defs>
      <circle cx="744" cy="346" r="184" fill="url(#g1)" opacity=".9"/><circle cx="744" cy="346" r="104" fill="${c.canvas}" opacity=".72"/>
      <text x="54" y="246" class="lumi-ds-hero lumi-ds-display">${xml(preset.preview.headline)}</text><text x="58" y="302" class="lumi-ds-body">Selected work across identity, motion and digital culture.</text>
      <rect x="58" y="354" width="194" height="52" rx="26" fill="${c.primary}"/><text x="155" y="386" text-anchor="middle" class="lumi-ds-button">View projects</text>`;
  }
  if (type === 'pixel') {
    return `<rect x="44" y="174" width="872" height="358" fill="${c.surface}" stroke="${c.border}" stroke-width="2"/>
      ${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${532 + i * 42}" y="${230 + (i % 3) * 38}" width="42" height="42" fill="${i % 2 ? c.primary : c.secondary}"/>`).join('')}
      <rect x="574" y="356" width="252" height="100" fill="${c.primary}"/><rect x="616" y="314" width="42" height="42" fill="${c.primary}"/>
      <text x="82" y="272" class="lumi-ds-hero lumi-ds-pixel">${xml(preset.preview.headline)}</text><text x="82" y="342" class="lumi-ds-body">Maps, lore and communities in one living atlas.</text>`;
  }
  if (type === 'schematic') {
    return `<pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="${c.border}" opacity=".55"/></pattern><rect x="44" y="174" width="872" height="358" fill="url(#grid)"/>
      <text x="70" y="238" class="lumi-ds-hero lumi-ds-display">${xml(preset.preview.headline)}</text>
      ${card(90, 308, 184, 92, c.surface)}${card(390, 278, 184, 92, c.surface)}${card(690, 334, 184, 92, c.surface)}
      <path d="M274 354 C330 354 330 324 390 324 M574 324 C634 324 634 380 690 380" fill="none" stroke="${c.primary}" stroke-width="3"/><circle cx="390" cy="324" r="6" fill="${c.primary}"/>`;
  }
  if (type === 'finance') {
    return `${card(44, 174, 872, 358, c.surface)}<rect x="44" y="174" width="872" height="86" rx="${parseInt(preset.geometry.radius, 10) || 0}" fill="${c.primary}"/>
      <text x="72" y="226" class="lumi-ds-button">${xml(preset.preview.headline)}</text><text x="888" y="226" text-anchor="end" class="lumi-ds-button">Q3 / 2026</text>
      <text x="72" y="318" class="lumi-ds-label">PORTFOLIO IMPACT</text><text x="72" y="382" class="lumi-ds-metric">+28%</text><text x="72" y="420" class="lumi-ds-body">year over year</text>
      ${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${380 + i * 72}" y="${452 - [58, 94, 72, 132, 108, 166][i]}" width="38" height="${[58, 94, 72, 132, 108, 166][i]}" rx="5" fill="${i === 5 ? c.secondary : c.primary}" opacity="${i === 5 ? 1 : .78}"/>`).join('')}
      <line x1="352" y1="452" x2="862" y2="452" stroke="${c.border}"/>`;
  }
  if (type === 'portfolio') {
    return `<text x="44" y="268" class="lumi-ds-hero lumi-ds-mega">${xml(preset.preview.headline)}</text><line x1="44" y1="316" x2="916" y2="316" stroke="${c.text}"/>
      <rect x="44" y="350" width="526" height="164" fill="${c.text}"/><rect x="592" y="350" width="324" height="164" fill="${c.secondary}"/><text x="612" y="482" class="lumi-ds-label lumi-ds-dark">PROJECT / 2026</text>`;
  }
  const isDark = type === 'airy-dark';
  const bold = type === 'finance-bold';
  return `${bold ? `<rect x="44" y="174" width="872" height="358" rx="${parseInt(preset.geometry.radius, 10) || 0}" fill="${c.primary}"/>` : ''}
    <text x="72" y="${bold ? 266 : 252}" class="lumi-ds-hero ${bold ? 'lumi-ds-mega' : 'lumi-ds-display'}">${xml(preset.preview.headline)}</text>
    <text x="74" y="${bold ? 326 : 310}" class="lumi-ds-body">A coherent system for every screen and every state.</text>
    ${card(74, 370, 246, 126, bold ? c.surface : c.elevated)}${card(338, 350, 246, 146, bold ? c.surface : c.elevated)}${card(602, 390, 246, 106, bold ? c.surface : c.elevated)}
    <circle cx="806" cy="224" r="72" fill="${isDark ? c.primary : c.secondary}" opacity=".28"/>`;
}

function renderPreviewSvg(id) {
  const preset = typeof id === 'object' ? id : getPreset(id);
  if (!preset) throw new Error(`preset de design não encontrado: ${id}`);
  const c = Object.fromEntries(Object.entries(preset.colors).map(([key, value]) => [key, safeColor(value, '#888888')]));
  const normalized = { ...preset, colors: c };
  const scope = `lumi-design-${preset.id}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600" role="img" data-lumi-design="${xml(preset.id)}" aria-labelledby="${scope}-title ${scope}-desc">
  <title id="${scope}-title">Preview do preset ${xml(preset.name)}</title><desc id="${scope}-desc">${xml(preset.summary)}</desc>
  <style>
    svg[data-lumi-design="${xml(preset.id)}"] .lumi-ds-label{display:inline;font:600 12px ${xml(preset.typography.mono)},ui-monospace,monospace;letter-spacing:.12em;fill:${c.muted}}
    svg[data-lumi-design="${xml(preset.id)}"] .lumi-ds-label.lumi-ds-dark{fill:${c.text}}
    svg[data-lumi-design="${xml(preset.id)}"] .lumi-ds-body{display:inline;font:400 16px ${xml(preset.typography.body)},system-ui,sans-serif;fill:${c.muted}}
    svg[data-lumi-design="${xml(preset.id)}"] .lumi-ds-hero{display:inline;font:700 38px ${xml(preset.typography.display)},system-ui,sans-serif;letter-spacing:-.04em;fill:${c.text}}
    svg[data-lumi-design="${xml(preset.id)}"] .lumi-ds-hero.lumi-ds-mega{font-size:56px}svg[data-lumi-design="${xml(preset.id)}"] .lumi-ds-hero.lumi-ds-pixel{font-size:28px;letter-spacing:-.02em}svg[data-lumi-design="${xml(preset.id)}"] .lumi-ds-hero.lumi-ds-retro{font-size:27px}svg[data-lumi-design="${xml(preset.id)}"] .lumi-ds-hero.lumi-ds-serif{font-weight:600}
    svg[data-lumi-design="${xml(preset.id)}"] .lumi-ds-metric{display:inline;font:700 54px ${xml(preset.typography.mono)},ui-monospace,monospace;fill:${c.text}}
    svg[data-lumi-design="${xml(preset.id)}"] .lumi-ds-button{display:inline;font:700 13px ${xml(preset.typography.body)},system-ui,sans-serif;fill:${c.elevated}}
  </style>
  <rect width="960" height="600" fill="${c.canvas}"/><circle cx="870" cy="40" r="210" fill="${c.primary}" opacity=".08"/>
  <text x="44" y="62" class="lumi-ds-label">${xml(preset.preview.eyebrow)}</text><text x="916" y="62" text-anchor="end" class="lumi-ds-label">${xml(preset.name.toUpperCase())}</text>
  <line x1="44" y1="92" x2="916" y2="92" stroke="${c.border}"/>
  ${previewScene(normalized)}
  <circle cx="54" cy="568" r="7" fill="${c.primary}"/><circle cx="76" cy="568" r="7" fill="${c.secondary}"/><text x="916" y="572" text-anchor="end" class="lumi-ds-label">LUMI DESIGN LIBRARY</text>
</svg>`;
}

function previewDataUrl(id) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderPreviewSvg(id))}`;
}

function renderGalleryHtml() {
  const payload = Object.fromEntries(catalog.map((preset) => [preset.id, generateDesignMarkdown(preset)]));
  const safePayload = JSON.stringify(payload).replace(/</g, '\\u003c');
  const cards = catalog.map((preset) => {
    const search = [preset.name, preset.summary, ...preset.tags, ...preset.suitableFor].join(' ').toLowerCase();
    return `<article class="design-card" data-mode="${preset.mode}" data-search="${xml(search)}">
      <div class="preview">${renderPreviewSvg(preset)}</div>
      <div class="card-copy"><div class="card-title"><h2>${xml(preset.name)}</h2><span>${preset.mode}</span></div>
      <p>${xml(preset.summary)}</p><div class="tags">${preset.tags.slice(0, 4).map((tag) => `<span>${xml(tag)}</span>`).join('')}</div>
      <button type="button" data-download="${preset.id}">Exportar DESIGN.md <b>↗</b></button></div></article>`;
  }).join('\n');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Lumi Design Atlas</title><style>
  :root{color-scheme:dark;--bg:#090a0e;--panel:#111319;--line:#252933;--text:#f3f5f8;--muted:#929aa8;--accent:#8c6bff;--ease:cubic-bezier(.16,1,.3,1)}
  *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 75% -10%,rgba(140,107,255,.16),transparent 34%),var(--bg);color:var(--text);font:400 15px/1.55 Inter,system-ui,sans-serif}
  body:before{content:"";position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);background-size:32px 32px;mask-image:linear-gradient(to bottom,#000,transparent 72%)}
  .shell{width:min(1480px,calc(100% - 40px));margin:auto;padding:72px 0 96px}.eyebrow{display:flex;align-items:center;gap:12px;color:#b7a9ff;font:650 11px/1 ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase}.eyebrow:before{content:"";width:30px;height:1px;background:currentColor}
  header{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(280px,.7fr);gap:56px;align-items:end;margin:34px 0 56px}h1{max-width:930px;margin:0;font-size:clamp(48px,7vw,104px);line-height:.9;letter-spacing:-.065em}header p{margin:0 0 8px;color:var(--muted);font-size:17px;max-width:470px}
  .toolbar{position:sticky;top:14px;z-index:5;display:flex;gap:10px;align-items:center;padding:10px;margin-bottom:28px;border:1px solid var(--line);border-radius:18px;background:rgba(15,17,23,.82);box-shadow:0 20px 70px rgba(0,0,0,.32);backdrop-filter:blur(20px)}
  .search{flex:1;min-width:160px;border:0;outline:0;background:transparent;color:var(--text);padding:10px 13px;font:inherit}.search::placeholder{color:#707887}.filters{display:flex;gap:6px}.filter{border:1px solid transparent;border-radius:10px;background:transparent;color:var(--muted);padding:9px 13px;cursor:pointer;transition:180ms}.filter:hover{color:var(--text);background:#191c24}.filter.active{color:#fff;background:#242033;border-color:#40385d}
  .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}.design-card{overflow:hidden;border:1px solid var(--line);border-radius:22px;background:linear-gradient(145deg,rgba(255,255,255,.035),transparent 35%),var(--panel);transition:transform 260ms var(--ease),border-color 260ms,box-shadow 260ms}.design-card:hover{transform:translateY(-5px);border-color:#44495a;box-shadow:0 28px 80px rgba(0,0,0,.28)}
  .preview{overflow:hidden;aspect-ratio:16/10;border-bottom:1px solid var(--line);background:#0b0c11}.preview svg{display:block;width:100%;height:100%}.card-copy{padding:24px}.card-title{display:flex;align-items:center;justify-content:space-between;gap:16px}.card-title h2{margin:0;font-size:24px;letter-spacing:-.035em}.card-title>span,.tags span{border:1px solid var(--line);border-radius:999px;color:#aeb6c3;font:600 10px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;padding:7px 9px}.card-copy p{min-height:48px;margin:13px 0 20px;color:var(--muted)}.tags{display:flex;flex-wrap:wrap;gap:7px}.tags span{padding:6px 8px;color:#858e9d}
  button[data-download]{display:flex;justify-content:space-between;align-items:center;width:100%;margin-top:24px;border:1px solid #373c49;border-radius:12px;background:#181b22;color:#eef0f5;padding:13px 15px;font:650 13px/1 inherit;cursor:pointer;transition:180ms}button[data-download]:hover{border-color:#6f5ad2;background:#211d31}button b{color:#ad9cff;font-size:16px}.empty{display:none;grid-column:1/-1;padding:100px 20px;text-align:center;color:var(--muted)}
  footer{display:flex;justify-content:space-between;gap:24px;margin-top:56px;padding-top:24px;border-top:1px solid var(--line);color:#747d8c;font-size:12px}button:focus-visible,input:focus-visible{outline:2px solid #aa98ff;outline-offset:2px}
  @media(max-width:860px){.shell{width:min(100% - 24px,680px);padding-top:42px}header{grid-template-columns:1fr;gap:24px}.grid{grid-template-columns:1fr}.toolbar{align-items:stretch;flex-direction:column}.filters{overflow:auto}.filter{flex:none}h1{font-size:clamp(46px,15vw,72px)}}
  @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
  </style></head><body><main class="shell"><div class="eyebrow">Lumi experimental module · ${catalog.length} systems</div><header><h1>Escolha uma direção. Construa com consistência.</h1><p>Presets autorais que viram documentação técnica para humanos, Claude Code, Codex e qualquer agente de desenvolvimento.</p></header>
  <div class="toolbar"><input class="search" type="search" aria-label="Buscar estilos" placeholder="Buscar: fintech, editorial, dark, SaaS…"><div class="filters" aria-label="Filtrar por modo"><button class="filter active" data-mode="all">Todos</button><button class="filter" data-mode="dark">Dark</button><button class="filter" data-mode="light">Light</button></div></div>
  <section class="grid">${cards}<div class="empty">Nenhum sistema combina com esta busca.</div></section><footer><span>Lumi Design Library · módulo desacoplado</span><span>Previews e especificações gerados localmente</span></footer></main>
  <script>const docs=${safePayload};let mode='all';const q=document.querySelector('.search'),cards=[...document.querySelectorAll('.design-card')],empty=document.querySelector('.empty');function apply(){const query=q.value.trim().toLowerCase();let shown=0;for(const card of cards){const visible=(mode==='all'||card.dataset.mode===mode)&&(!query||card.dataset.search.includes(query));card.hidden=!visible;if(visible)shown++}empty.style.display=shown?'none':'block'}q.addEventListener('input',apply);document.querySelectorAll('.filter').forEach(btn=>btn.addEventListener('click',()=>{mode=btn.dataset.mode;document.querySelectorAll('.filter').forEach(x=>x.classList.toggle('active',x===btn));apply()}));document.querySelectorAll('[data-download]').forEach(btn=>btn.addEventListener('click',()=>{const id=btn.dataset.download,blob=new Blob([docs[id]],{type:'text/markdown;charset=utf-8'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='DESIGN.md';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}));</script></body></html>`;
}

function exportGallery(filePath) {
  const target = path.resolve(String(filePath || 'lumi-design-gallery.html'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderGalleryHtml(), 'utf8');
  return target;
}

function installDesignPreset(workspace, id, options) {
  const root = path.resolve(String(workspace || ''));
  if (!workspace || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('workspace inválida');
  const preset = getPreset(id);
  if (!preset) throw new Error(`preset de design não encontrado: ${id}`);
  const opts = options || {};
  const target = path.join(root, 'DESIGN.md');
  if (fs.existsSync(target) && !opts.overwrite) return { ok: false, conflict: true, path: target, preset: preset.id };
  let backup = '';
  if (fs.existsSync(target) && opts.overwrite) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = path.join(root, `DESIGN.md.lumi-backup-${stamp}`);
    fs.copyFileSync(target, backup);
  }
  const markdown = generateDesignMarkdown(preset, { projectName: opts.projectName || path.basename(root) });
  fs.writeFileSync(target, markdown, { encoding: 'utf8', mode: 0o600 });
  return { ok: true, path: target, backup: backup || null, preset: preset.id, version: preset.version };
}

function validateCatalog() {
  const seen = new Set();
  const errors = [];
  for (const preset of catalog) {
    for (const error of validatePreset(preset)) errors.push(`${preset && preset.id ? preset.id : '?'}: ${error}`);
    if (seen.has(preset.id)) errors.push(`${preset.id}: id duplicado`);
    seen.add(preset.id);
  }
  return errors;
}

module.exports = {
  catalog,
  getPreset,
  listPresets,
  validatePreset,
  validateCatalog,
  generateDesignMarkdown,
  renderPreviewSvg,
  previewDataUrl,
  renderGalleryHtml,
  exportGallery,
  installDesignPreset,
};
