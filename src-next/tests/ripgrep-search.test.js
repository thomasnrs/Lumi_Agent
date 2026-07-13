'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMatch, globEscape, ignoreArgs, RipgrepSearch } = require('../main/adapters/process/ripgrep-search');

test('parser do ripgrep normaliza caminho e corta texto sem vazar linhas', () => {
  const line = JSON.stringify({ type: 'match', data: { path: { text: 'src\\a.js' }, line_number: 7, lines: { text: '  const Lumi = true;\r\n' } } });
  assert.deepEqual(parseMatch(line, 'C:\\repo', 20), { file: 'src/a.js', line: 7, text: 'const Lumi = true;' });
  assert.equal(parseMatch('{inválido', '/repo'), null);
});

test('glob e ignores defendem caracteres especiais e diretórios pesados', () => {
  assert.equal(globEscape('a*[b]?'), 'a\\*\\[b\\]\\?');
  const args = ignoreArgs();
  assert.ok(args.includes('!**/node_modules/**'));
  assert.ok(args.includes('!**/.lumi-*/**'));
});

test('adapter cacheia indisponibilidade sem iniciar processo de busca', async () => {
  let checks = 0;
  const adapter = new RipgrepSearch({ execFile: async () => { checks++; throw new Error('ausente'); }, spawn: () => { throw new Error('não deveria spawnar'); } });
  assert.equal(await adapter.search({ root: '/repo', query: 'x', find: true }), null);
  assert.equal(await adapter.search({ root: '/repo', query: 'x', find: false }), null);
  assert.equal(checks, 1);
});
