// Extrai funções/consts PUROS do src/main/main.js pra testar o código REAL sem carregar o
// Electron. Funciona porque o arquivo segue o estilo: declarações top-level fecham com "}"
// (ou "];" / "};") na coluna 0. Se uma extração falhar, o teste quebra avisando — é proposital.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '..', 'src', 'main', 'main.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const LINES = SRC.split('\n');

function extractDecl(name) {
  const isStart = (l) =>
    l.startsWith('function ' + name + '(') ||
    l.startsWith('async function ' + name + '(') ||
    l.startsWith('const ' + name + ' =') ||
    l.startsWith('let ' + name + ' =');
  const start = LINES.findIndex(isStart);
  if (start < 0) throw new Error('extract: não achei a declaração de "' + name + '" no main.js');
  const first = LINES[start];
  // const/let de uma linha só (ex.: const X = /re/; | let Y = null; // comentário)
  const sansComment = first.replace(/\s\/\/.*$/, '').trimEnd();
  if ((first.startsWith('const ') || first.startsWith('let ')) && sansComment.endsWith(';')) return sansComment;
  const isFn = first.startsWith('function') || first.startsWith('async function');
  for (let i = start + 1; i < LINES.length; i++) {
    const l = LINES[i];
    if (isFn ? l === '}' : l === '];' || l === '};') return LINES.slice(start, i + 1).join('\n');
  }
  throw new Error('extract: não achei o fim de "' + name + '"');
}

// carrega um conjunto de declarações num sandbox e devolve { nome: valor }
function load(names, extra) {
  const code = names.map(extractDecl).join('\n\n') + '\n;({' + names.filter((n) => !n.startsWith('_decl:')).join(',') + '});';
  const ctx = vm.createContext(Object.assign({ path, console, require }, extra || {}));
  return vm.runInContext(code, ctx, { filename: 'extracted-from-main.js' });
}

module.exports = { load, extractDecl };
