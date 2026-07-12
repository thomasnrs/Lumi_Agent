#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const library = require('./index');

function usage() {
  console.log(`Lumi Design Library (módulo experimental)

Uso:
  node cli.js list [busca]
  node cli.js preview <preset> [arquivo.svg]
  node cli.js gallery [arquivo.html]
  node cli.js design <preset> [arquivo.md]

Os comandos apenas exportam artefatos; eles não integram o módulo à Lumi.`);
}

function write(target, content) {
  const fp = path.resolve(target);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, 'utf8');
  console.log(fp);
}

const [, , command, arg1, arg2] = process.argv;
try {
  if (!command || command === 'help' || command === '--help') usage();
  else if (command === 'list') {
    const rows = library.listPresets({ query: arg1 || '' });
    for (const preset of rows) console.log(`${preset.id.padEnd(22)} ${preset.mode.padEnd(5)} ${preset.name} — ${preset.summary}`);
  } else if (command === 'preview') {
    if (!arg1) throw new Error('informe o id do preset');
    write(arg2 || `${arg1}.svg`, library.renderPreviewSvg(arg1));
  } else if (command === 'gallery') {
    console.log(library.exportGallery(arg1 || 'lumi-design-gallery.html'));
  } else if (command === 'design') {
    if (!arg1) throw new Error('informe o id do preset');
    write(arg2 || 'DESIGN.md', library.generateDesignMarkdown(arg1));
  } else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error('Erro:', error.message);
  process.exitCode = 1;
}

