'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ToolRegistry, normalizeToolArgs } = require('../main/domains/tools/tool-registry');
const { ToolGuard, callKey, failureClass } = require('../main/domains/tools/tool-guard');
const { ToolExecutor, strategyKey, executeToolCallsOrdered } = require('../main/domains/tools/tool-executor');
const { inferToolsets, selectedToolNames } = require('../main/domains/tools/toolsets');

function definition(name, options) {
  const opts = options || {};
  return { schema: { name, description: name, parameters: { type: 'object', properties: opts.properties || {} } }, run: opts.run || (async () => ({ ok: true })), ...opts };
}

test('registry rejeita duplicação e filtra schemas por toolset/delegação', () => {
  const registry = new ToolRegistry()
    .register('read_file', definition('read_file'))
    .register('edit_file', definition('edit_file'))
    .register('ask_user', definition('ask_user'))
    .register('delegate_to_agent', definition('delegate_to_agent'));
  assert.throws(() => registry.register('read_file', definition('read_file')), /duplicada/);
  const codeRead = registry.schemas({ toolsets: new Set(['code_read']), delegate: false }).map((item) => item.function.name);
  assert.deepEqual(codeRead.sort(), ['ask_user', 'read_file']);
  assert.equal(registry.schemas({ allow: ['delegate_to_agent'], delegate: false }).length, 0);
  assert.equal(registry.schemas({ allow: ['delegate_to_agent'], delegate: true }).length, 1);
});

test('normalização de aliases não modifica os argumentos recebidos', () => {
  const input = { file: 'x.js', text: 'novo' };
  const normalized = normalizeToolArgs(definition('write_file', { properties: { path: {}, content: {} } }), input);
  assert.deepEqual(normalized, { file: 'x.js', text: 'novo', path: 'x.js', content: 'novo' });
  assert.deepEqual(input, { file: 'x.js', text: 'novo' });
});

test('toolsets inferem escrita no modo arquiteto e não liberam delegate implicitamente', () => {
  const inferred = inferToolsets('corrija este bug no arquivo', { architectMode: true });
  assert.equal(inferred.has('code_read'), true);
  assert.equal(inferred.has('code_write'), true);
  assert.equal(selectedToolNames(inferred, false).has('delegate_to_agent'), false);
});

test('guard usa chave canônica, detecta loops e libera retry após mudança de estado', () => {
  const guard = new ToolGuard();
  assert.equal(callKey('x', { b: 2, a: 1 }), callKey('x', { a: 1, b: 2 }));
  const args = { path: 'x' }, key = strategyKey('edit_file', args);
  guard.after('edit_file', args, { error: 'old_text não encontrado no arquivo' }, { strategyKey: key });
  guard.after('edit_file', args, { error: 'old_text não encontrado no arquivo' }, { strategyKey: key });
  assert.equal(guard.before('edit_file', args, key).loop, true);
  guard.after('write_file', { path: 'y' }, { ok: true }, { readonly: false });
  assert.equal(guard.before('edit_file', args, key), null);
  assert.equal(failureClass('arquivo com CRLF e encoding quebrado'), 'encoding-line-endings');
});

test('executor aplica permissão, aliases, lock exclusivo, eventos e nota de releitura', async () => {
  const events = [], locks = [], seen = [];
  const registry = new ToolRegistry()
    .register('read_file', definition('read_file', { readonly: true, properties: { path: {} }, run: async (args) => (seen.push(args), { content: 'x' }) }))
    .register('write_file', definition('write_file', { category: 'write', exclusive: true, properties: { path: {} }, run: async () => ({ ok: true }) }));
  const executor = new ToolExecutor({
    registry,
    authorize: async (category) => category !== 'write',
    lock: async (key, operation) => (locks.push(key), operation()),
    onEvent: (event) => events.push(event.type),
  });
  const first = await executor.execute('read_file', { file: 'a.js' });
  const second = await executor.execute('read_file', { file: 'a.js' });
  assert.equal(first.content, 'x');
  assert.match(second._nota, /já foi feita/);
  assert.equal(seen[0].path, 'a.js');
  const denied = await executor.execute('write_file', { path: 'a.js' });
  assert.equal(denied.denied, true);
  assert.deepEqual(locks, []);
  assert.ok(events.includes('tool.start') && events.includes('tool.done') && events.includes('tool.denied'));
});

test('executor sugere nome próximo e serializa ferramenta exclusiva autorizada', async () => {
  const locks = [];
  const registry = new ToolRegistry().register('read_file', definition('read_file')).register('write_file', definition('write_file', { category: 'write', exclusive: true }));
  const executor = new ToolExecutor({ registry, authorize: async () => true, lock: async (key, operation) => (locks.push(key), operation()) });
  assert.match((await executor.execute('read_fil', {})).error, /read_file/);
  assert.equal((await executor.execute('write_file', {}, { workspace: 'ws' })).ok, true);
  assert.deepEqual(locks, ['ws']);
});

test('execução ordenada paraleliza apenas leituras contíguas e respeita barreira', async () => {
  const timeline = [];
  const calls = [{ name: 'read_file', id: 1 }, { name: 'read_file', id: 2 }, { name: 'write_file', id: 3 }, { name: 'read_file', id: 4 }];
  await executeToolCallsOrdered(calls, async (call) => {
    timeline.push(`start${call.id}`);
    if (call.name === 'read_file') await new Promise((resolve) => setTimeout(resolve, call.id === 1 ? 15 : 2));
    timeline.push(`end${call.id}`);
    return call.id;
  }, { concurrency: 4, parallelNames: new Set(['read_file']) });
  const startWrite = timeline.indexOf('start3');
  assert.ok(timeline.indexOf('end1') < startWrite && timeline.indexOf('end2') < startWrite);
  assert.ok(timeline.indexOf('end3') < timeline.indexOf('start4'));
});
