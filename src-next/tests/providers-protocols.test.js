'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResponsesAdapter, convertToResponses } = require('../main/domains/ai-providers/responses-adapter');
const { GeminiAdapter, convertToGemini } = require('../main/domains/ai-providers/gemini-adapter');
const { openCodeProtocol, providerProtocol, isExplicitToolUnsupportedError } = require('../main/domains/ai-providers/protocol');
const { ProviderAdapterRegistry, ObservedCapabilityStore } = require('../main/domains/ai-providers/adapter-registry');

function streamResponse(chunks) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => '',
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  };
}

function sse(events) { return events.map((event) => `data: ${JSON.stringify(event)}\n`).join(''); }

test('Responses converte imagens, tools e argumentos inválidos sem quebrar o próximo request', () => {
  const converted = convertToResponses([
    { role: 'system', content: 'regra' },
    { role: 'user', content: [{ type: 'text', text: 'veja' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{quebrado' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'resultado' },
  ]);
  assert.equal(converted.instructions, 'regra');
  assert.equal(converted.input[0].content[1].type, 'input_image');
  assert.equal(JSON.parse(converted.input[1].arguments)._invalid_json_arguments, true);
  assert.equal(converted.input[2].type, 'function_call_output');
});

test('Responses recompõe function call e preserva itens nativos para continuidade', async () => {
  const events = [
    { type: 'response.output_text.delta', delta: 'feito ' },
    { type: 'response.reasoning_summary_text.delta', delta: 'pensei' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'item1', call_id: 'call1', name: 'grep_files', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'item1', delta: '{"pattern":' },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'item1', delta: '"Lumi"}' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'item1', call_id: 'call1', name: 'grep_files', arguments: '{"pattern":"Lumi"}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 } } },
  ];
  const wire = sse(events);
  const requests = [];
  const adapter = new ResponsesAdapter({ fetchPolicy: { request: async (...args) => (requests.push(args), streamResponse([wire.slice(0, 23), wire.slice(23, 81), wire.slice(81)])) } });
  const result = await adapter.turn({ config: { provider: 'opencode', baseUrl: 'https://opencode.ai/zen/v1', model: 'opencode/gpt-5' }, messages: [], tools: [], onToken: () => {}, onThink: () => {} });
  assert.equal(result.text, 'feito ');
  assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), { pattern: 'Lumi' });
  assert.equal(result.responseItems[0].call_id, 'call1');
  assert.equal(result.usage.total_tokens, 16);
  assert.match(requests[0][1], /\/responses$/);
});

test('Gemini converte multimodal e associa function response ao nome correto', () => {
  const converted = convertToGemini([
    { role: 'system', content: 'regra' },
    { role: 'user', content: [{ type: 'text', text: 'imagem' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } }] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'g1', function: { name: 'read_file', arguments: '{"path":"x"}' } }] },
    { role: 'tool', tool_call_id: 'g1', content: '{"ok":true}' },
  ]);
  assert.equal(converted.system, 'regra');
  assert.equal(converted.contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
  assert.equal(converted.contents[2].parts[0].functionResponse.name, 'read_file');
});

test('Gemini separa thought, deduplica function calls e normaliza usage', async () => {
  const call = { id: 'g1', name: 'read_file', args: { path: 'a.js' } };
  const events = [
    { candidates: [{ content: { parts: [{ text: 'raciocínio', thought: true }, { text: 'ok' }, { functionCall: call }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: call }] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10 } },
  ];
  const wire = sse(events);
  const thought = [];
  const adapter = new GeminiAdapter({ fetchPolicy: { request: async () => streamResponse([wire.slice(0, 19), wire.slice(19)]) } });
  const result = await adapter.turn({ config: { provider: 'opencode', baseUrl: 'https://opencode.ai/zen/v1', model: 'opencode/gemini-2.5-pro' }, messages: [], tools: [], onToken: () => {}, onThink: (value) => thought.push(value) });
  assert.equal(result.text, 'ok');
  assert.equal(thought.join(''), 'raciocínio');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.usage.total_tokens, 10);
});

test('roteamento OpenCode escolhe protocolo pela família e preserva aliases diretos', () => {
  assert.equal(openCodeProtocol('opencode/gpt-5', 'https://opencode.ai/zen/v1'), 'responses');
  assert.equal(openCodeProtocol('gemini-2.5-pro'), 'gemini');
  assert.equal(openCodeProtocol('qwen3-coder'), 'anthropic');
  assert.equal(openCodeProtocol('kimi-k2'), 'openai');
  assert.equal(providerProtocol({ provider: 'google' }), 'gemini');
  assert.equal(providerProtocol({ provider: 'openai-responses' }), 'responses');
});

test('registry aprende capability por modelo sem confundir JSON inválido com falta de tools', async () => {
  let now = 10;
  const capabilities = new ObservedCapabilityStore({ clock: { now: () => ++now }, limit: 10 });
  const registry = new ProviderAdapterRegistry({ capabilities });
  const config = { provider: 'openai', baseUrl: 'https://api', model: 'modelo' };
  registry.register('openai', { turn: async () => { throw new Error('tools are not supported by this model'); } });
  await assert.rejects(() => registry.turn({ config, tools: [{}] }));
  assert.equal(registry.describe(config).capabilities.tools, false);
  assert.equal(isExplicitToolUnsupportedError(new Error("tool_calls[].function.arguments got invalid JSON")), false);
  registry.register('openai', { turn: async () => ({ text: '', toolCalls: [{ name: 'read_file' }] }) });
  await registry.turn({ config, tools: [{}] });
  assert.equal(registry.describe(config).capabilities.tools, true);
});
