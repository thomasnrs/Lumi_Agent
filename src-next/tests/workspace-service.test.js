'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { NodeFilesystem } = require('../main/adapters/filesystem/node-filesystem');
const { decodeText } = require('../main/domains/workspace/encoding');
const { WorkspacePath } = require('../main/domains/workspace/workspace-path');
const { WorkspaceService, replaceTextSmart } = require('../main/domains/workspace/workspace-service');
const { registerWorkspaceTools } = require('../main/domains/workspace/workspace-tools');
const { ToolRegistry } = require('../main/domains/tools/tool-registry');
const { ToolExecutor } = require('../main/domains/tools/tool-executor');

async function fixture(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumi-next-workspace-'));
  for (const [relative, value] of Object.entries(files || {})) {
    const target = path.join(root, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, value);
  }
  return root;
}
async function service(files, options) {
  const root = await fixture(files); const mutations = [];
  return { root, mutations, instance: new WorkspaceService({ filesystem: new NodeFilesystem(), root, onMutation: (event) => mutations.push(event), ...(options || {}) }) };
}
test.afterEach(async () => {});

test('decoder preserva UTF-8, BOM, UTF-16 e Windows-1252 sem mojibake', () => {
  assert.deepEqual(decodeText(Buffer.from('ação', 'utf8')), { text: 'ação', encoding: 'utf-8' });
  assert.equal(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x6f, 0x6b])).encoding, 'utf-8-bom');
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x6f, 0x00, 0x6b, 0x00])).text, 'ok');
  assert.equal(decodeText(Buffer.from([0xfe, 0xff, 0x00, 0x6f, 0x00, 0x6b])).text, 'ok');
  assert.equal(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9])).text, 'café');
});

test('WorkspacePath bloqueia traversal e mantém caminhos relativos normalizados', async () => {
  const root = await fixture({ 'src/a.js': 'ok' });
  const paths = new WorkspacePath(root, new NodeFilesystem());
  assert.equal(paths.relative('src/a.js'), 'src/a.js');
  assert.throws(() => paths.resolve('../fora.txt'), /fora do workspace/);
  assert.throws(() => paths.resolve(path.resolve(root, '..', 'fora.txt')), /fora do workspace/);
  await fs.rm(root, { recursive: true, force: true });
});

test('read pagina conteúdo, informa encoding e registra leitura para edição segura', async () => {
  const { root, instance } = await service({ 'doc.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78]) });
  const read = await instance.readFile({ path: 'doc.txt', limit: 1 });
  assert.equal(read.content, 'café');
  assert.equal(read.encoding, 'windows-1252');
  assert.match(read.note, /offset=2/);
  const edit = await instance.editFile({ path: 'doc.txt', old_text: 'café', new_text: 'chá' });
  assert.equal(edit.ok, true);
  assert.equal((await fs.readFile(path.join(root, 'doc.txt'), 'utf8')).startsWith('chá'), true);
  await fs.rm(root, { recursive: true, force: true });
});

test('edição tolera CRLF/LF, preserva EOL dominante e write protege sobrescrita cega', async () => {
  const { root, instance } = await service({ 'a.txt': 'um\r\ndois\r\n' });
  const blocked = await instance.writeFile({ path: 'a.txt', content: 'novo' });
  assert.match(blocked.error, /não foi lido/);
  await instance.readFile({ path: 'a.txt' });
  const edit = await instance.editFile({ path: 'a.txt', old_text: 'um\ndois\n', new_text: 'três\nquatro\n' });
  assert.equal(edit.replaced, 1);
  assert.match(edit.note, /CRLF/);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'três\r\nquatro\r\n');
  await fs.rm(root, { recursive: true, force: true });
});

test('mutações geram eventos, respeitam proteção e listagem é serializável', async () => {
  const { root, instance, mutations } = await service({}, { isProtected: (target) => target.endsWith('secret.txt') });
  await instance.makeDir({ path: 'src' });
  await instance.writeFile({ path: 'src/a.js', content: 'const x = 1;' });
  await instance.appendFile({ path: 'src/a.js', content: '\nexport { x };' });
  const list = await instance.listDir({ path: 'src' });
  assert.deepEqual(list.entries.map((entry) => entry.name), ['a.js']);
  assert.equal((await instance.deleteFile({ path: 'secret.txt' })).blocked, true);
  await instance.deleteFile({ path: 'src/a.js' });
  assert.deepEqual(mutations.map((event) => event.kind), ['make_dir', 'write_file', 'append_file', 'delete_file']);
  await fs.rm(root, { recursive: true, force: true });
});

test('busca assíncrona encontra nome e conteúdo, pulando diretórios pesados', async () => {
  const { root, instance } = await service({ 'src/app.js': 'export const Lumi = true;\n', 'README.md': 'Lumi workspace\n', 'node_modules/skip.js': 'Lumi escondida' });
  const found = await instance.findInCode({ query: 'Lumi' });
  assert.deepEqual(found.files_matching_name, []);
  assert.deepEqual(found.content_matches.map((match) => match.file).sort(), ['README.md', 'src/app.js']);
  const grep = await instance.grepFiles({ pattern: 'export', path: 'src' });
  assert.equal(grep.total, 1);
  const oneFile = await instance.grepFiles({ pattern: 'export', path: 'src/app.js' });
  assert.equal(oneFile.total, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test('replaceTextSmart rejeita ambiguidade e expõe modo determinístico', () => {
  assert.match(replaceTextSmart('a\na', 'a', 'b').error, /aparece 2 vezes/);
  assert.equal(replaceTextSmart('a\r\nb', 'a\nb', 'c\nd').mode, 'eol-normalized');
});

test('factory registra ferramentas do workspace no registry e passa pelo executor', async () => {
  const { root, instance } = await service({ 'a.js': 'const x = 1;\n' });
  const registry = registerWorkspaceTools(new ToolRegistry(), instance);
  const executor = new ToolExecutor({ registry, authorize: async () => true });
  const read = await executor.execute('read_file', { file: 'a.js' });
  assert.equal(read.totalLines, 2);
  const edit = await executor.execute('edit_file', { file: 'a.js', old: 'const x = 1;', replacement: 'const x = 2;' });
  assert.equal(edit.ok, true);
  assert.equal(await fs.readFile(path.join(root, 'a.js'), 'utf8'), 'const x = 2;\n');
  assert.ok(registry.schemas({ toolsets: new Set(['code_read', 'code_write']) }).length >= 8);
  await fs.rm(root, { recursive: true, force: true });
});
