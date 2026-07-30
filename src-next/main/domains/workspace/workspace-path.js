'use strict';

const nodePath = require('node:path');

// Chave canônica de projeto, para COMPARAÇÃO apenas (não faz I/O). A mesma pasta escrita de
// formas diferentes — barra, caixa no Windows, caminho relativo — tem que cair na mesma chave,
// senão memória e diário de um projeto vazam no contexto de outro.
function scopeKey(workspace) {
  if (!workspace) return '';
  try {
    const absolute = nodePath.resolve(String(workspace));
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  } catch (_) {
    return String(workspace);
  }
}

class WorkspacePath {
  constructor(root, filesystem) {
    if (!root) throw new Error('WorkspacePath exige root');
    if (!filesystem) throw new Error('WorkspacePath exige filesystem');
    this.fs = filesystem;
    this.root = this.fs.resolve(root);
  }
  resolve(input) {
    const raw = String(input == null || input === '' ? '.' : input);
    const target = this.fs.isAbsolute(raw) ? this.fs.resolve(raw) : this.fs.resolve(this.root, raw);
    const relative = this.fs.relative(this.root, target);
    if (relative === '..' || relative.startsWith(`..${require('node:path').sep}`) || require('node:path').isAbsolute(relative)) throw new Error(`caminho fora do workspace: ${raw}`);
    return target;
  }
  relative(target) {
    const absolute = this.resolve(target);
    return this.fs.relative(this.root, absolute).replace(/\\/g, '/') || '.';
  }
}

module.exports = { WorkspacePath, scopeKey };
