'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentRuntime, resultMessages } = require('../main/domains/agent-runtime/agent-runtime');
const { SteeringQueue } = require('../main/domains/agent-runtime/steering-queue');
const { TurnLedger } = require('../main/domains/agent-runtime/turn-ledger');
const { taskContractFor, CompletionEvidenceGate } = require('../main/domains/agent-runtime/completion-gate');
const { ToolRegistry } = require('../main/domains/tools/tool-registry');
const { ToolExecutor } = require('../main/domains/tools/tool-executor');

function tool(name, run, options) {
  return { schema: { name, description: name, parameters: { type: 'object', properties: { path: { type: 'string' }, command: { type: 'string' } } } }, run, ...(options || {}) };
}
function harness(turns, tools) {
  const events = [], requests = [];
  const registry = new ToolRegistry();
  for (const [name, definition] of Object.entries(tools || {})) registry.register(name, definition);
  const executor = new ToolExecutor({ registry, authorize: async () => true });
  const turnService = { turn: async (request) => { requests.push(request); const next = turns.shift(); return typeof next === 'function' ? next(request) : next; } };
  return { events, requests, registry, executor, runtime: new AgentRuntime({ turnService, toolRegistry: registry, toolExecutor: executor, onEvent: (event) => events.push(event) }) };
}

test('runtime executa tool call, devolve resultado pareado e conclui na rodada seguinte', async () => {
  const h = harness([
    { text: 'vou ler', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.js"}' }] },
    { text: 'pronto', toolCalls: [] },
  ], { read_file: tool('read_file', async ({ path }) => ({ content: `arquivo:${path}` }), { readonly: true }) });
  const output = await h.runtime.run({ config: { maxSteps: 8 }, goal: 'leia o arquivo', messages: [{ role: 'user', content: 'leia' }], getTools: () => h.registry.schemas({ allow: ['read_file'] }) });
  assert.equal(output.status, 'completed');
  assert.equal(output.text, 'pronto');
  const toolResult = output.messages.find((message) => message.role === 'tool');
  assert.equal(toolResult.tool_call_id, 'c1');
  assert.deepEqual(JSON.parse(toolResult.content), { content: 'arquivo:a.js' });
  assert.equal(output.ledger.filesRead[0], 'a.js');
});

test('steering que chega durante resposta final reabre o loop e preserva continuidade', async () => {
  const queue = new SteeringQueue();
  const h = harness([
    (request) => { request.onToken('parcial'); queue.push('mude a direção'); return { text: 'parcial', responseItems: [{ type: 'message', id: 'r1' }], toolCalls: [] }; },
    { text: 'ajustado', toolCalls: [] },
  ]);
  const output = await h.runtime.run({ config: {}, goal: 'responda', messages: [], steeringQueue: queue, onToken: () => {}, getTools: () => [] });
  assert.equal(output.text, 'ajustado');
  assert.ok(output.messages.some((message) => message.role === 'assistant' && message._responsesItems && message._responsesItems[0].id === 'r1'));
  assert.ok(output.messages.some((message) => message.role === 'user' && message.content === 'mude a direção'));
  assert.ok(h.events.some((event) => event.type === 'agent.new-bubble'));
});

test('erro explícito de incompatibilidade repete sem schemas, mas JSON inválido não é mascarado', async () => {
  const h = harness([
    () => { throw new Error('tools are not supported by this model'); },
    { text: 'sem tools', toolCalls: [] },
  ], { read_file: tool('read_file', async () => ({}), { readonly: true }) });
  const output = await h.runtime.run({ config: {}, goal: 'leia', getTools: () => h.registry.schemas({ allow: ['read_file'] }) });
  assert.equal(output.toolsSuppressed, true);
  assert.equal(h.requests[0].tools.length, 1);
  assert.equal(h.requests[1].tools.length, 0);

  const broken = harness([() => { throw new Error("tool_calls[].function.arguments got invalid JSON"); }], { read_file: tool('read_file', async () => ({})) });
  await assert.rejects(() => broken.runtime.run({ config: {}, goal: 'leia', getTools: () => broken.registry.schemas({ allow: ['read_file'] }) }), /invalid JSON/);
});

test('gate de conclusão pede evidência uma vez após edição de código', async () => {
  const h = harness([
    { text: '', toolCalls: [{ id: 'w1', name: 'edit_file', arguments: '{"path":"app.js"}' }] },
    { text: 'terminei', toolCalls: [] },
    { text: 'não consegui testar, bloqueio explicado', toolCalls: [] },
  ], { edit_file: tool('edit_file', async () => ({ ok: true }), { exclusive: true }) });
  const output = await h.runtime.run({ config: {}, goal: 'corrija o código', workspace: 'ws', getTools: () => h.registry.schemas({ allow: ['edit_file'] }) });
  assert.equal(output.status, 'completed');
  assert.equal(output.text, 'não consegui testar, bloqueio explicado');
  assert.equal(output.messages.filter((message) => typeof message.content === 'string' && message.content.startsWith('[gate de conclusão]')).length, 1);
  assert.deepEqual(output.ledger.filesChanged, ['app.js']);
});

test('ledger reconhece verificação real e evita gate desnecessário', () => {
  const ledger = new TurnLedger('corrija');
  ledger.record('edit_file', { path: 'app.js' }, { ok: true });
  ledger.record('run_command', { command: 'npm test' }, { stdout: 'ok' });
  const gate = new CompletionEvidenceGate();
  assert.equal(gate.evaluate(taskContractFor('corrija o código', { architectMode: true }), ledger), null);
  assert.equal(ledger.hasSuccessfulVerification(), true);
});

test('resultado multimodal não reenvia base64 dentro do tool result', () => {
  const messages = resultMessages({ id: 'v1' }, { _image: 'data:image/png;base64,AAA', _imageNote: 'captura' });
  assert.doesNotMatch(messages[0].content, /base64/);
  assert.equal(messages[1].content[1].image_url.url, 'data:image/png;base64,AAA');
});

test('cancelamento encerra sem executar passos adicionais', async () => {
  const controller = new AbortController();
  const h = harness([(request) => { controller.abort(); return { text: 'parcial', toolCalls: [], aborted: true }; }]);
  const output = await h.runtime.run({ config: {}, signal: controller.signal, getTools: () => [] });
  assert.equal(output.status, 'aborted');
  assert.equal(output.text, 'parcial');
  assert.equal(h.requests.length, 1);
});

test('fallback escolhido permanece ativo nas próximas rodadas do mesmo turno', async () => {
  const h = harness([
    { text: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }], providerMeta: { fallback: true, model: 'reserva', protocol: 'openai' } },
    { text: 'fim', toolCalls: [], providerMeta: { fallback: false, model: 'reserva', protocol: 'openai' } },
  ], { read_file: tool('read_file', async () => ({ content: 'x' }), { readonly: true }) });
  const output = await h.runtime.run({ config: { model: 'principal', fallbackModel: 'reserva' }, goal: 'leia', getTools: () => h.registry.schemas({ allow: ['read_file'] }) });
  assert.equal(h.requests[0].config.model, 'principal');
  assert.equal(h.requests[1].config.model, 'reserva');
  assert.equal(output.effectiveConfig.model, 'reserva');
  assert.equal(output.effectiveConfig.fallbackModel, '');
});
