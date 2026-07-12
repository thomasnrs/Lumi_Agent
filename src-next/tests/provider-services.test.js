'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ModelCatalogService, modelIdsFromResponse, catalogKey } = require('../main/domains/ai-providers/model-catalog');
const { ProviderTurnService } = require('../main/domains/ai-providers/turn-service');
const { providerProtocol } = require('../main/domains/ai-providers/protocol');
const { priceFor, usageHost } = require('../main/domains/ai-providers/pricing');

test('catálogo deduplica IDs e sua chave nunca contém credencial', () => {
  assert.deepEqual(modelIdsFromResponse({ models: [{ name: 'models/gemini-b' }, { name: 'models/gemini-a' }, { name: 'models/gemini-a' }] }), ['gemini-a', 'gemini-b']);
  const key = catalogKey({ provider: 'openai', baseUrl: 'https://api.example/v1', apiKey: 'segredo' });
  assert.doesNotMatch(key, /segredo|api\.example/);
});

test('catálogo usa TTL e devolve cache stale quando refresh falha', async () => {
  let now = 100;
  let calls = 0;
  let fail = false;
  const service = new ModelCatalogService({
    ttlMs: 1000,
    clock: { now: () => now },
    fetchPolicy: { request: async () => {
      calls++;
      if (fail) throw new Error('offline');
      return { ok: true, json: async () => ({ data: [{ id: 'm2' }, { id: 'm1' }] }) };
    } },
  });
  const config = { provider: 'openai', baseUrl: 'https://api/v1', apiKey: 'x' };
  assert.deepEqual((await service.list(config)).models, ['m1', 'm2']);
  assert.equal((await service.list(config)).cached, true);
  assert.equal(calls, 1);
  now += 2000;
  fail = true;
  const stale = await service.list(config);
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.models, ['m1', 'm2']);
});

test('catálogo escolhe autenticação nativa por protocolo', () => {
  const service = new ModelCatalogService({ fetchPolicy: {} });
  assert.equal(service.headers({ provider: 'anthropic', apiKey: 'a' })['x-api-key'], 'a');
  assert.equal(service.headers({ provider: 'gemini', apiKey: 'g' })['x-goog-api-key'], 'g');
  assert.equal(service.headers({ provider: 'openai', apiKey: 'o' }).Authorization, 'Bearer o');
});

test('turn service troca uma vez para fallback, recalcula protocolo e contabiliza o modelo efetivo', async () => {
  const seen = [];
  const records = [];
  const notes = [];
  const registry = {
    protocol: providerProtocol,
    turn: async (request) => {
      seen.push(request.config.model);
      if (seen.length === 1) throw new Error('modelo indisponível');
      return { text: 'ok', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
    },
  };
  const service = new ProviderTurnService({
    registry,
    usage: { record: async (...args) => records.push(args) },
    onFallback: (note) => notes.push(note),
  });
  const result = await service.turn({ config: { provider: 'opencode', baseUrl: 'https://opencode.ai/zen/v1', model: 'gpt-5', fallbackModel: 'gemini-2.5-pro' } });
  assert.deepEqual(seen, ['gpt-5', 'gemini-2.5-pro']);
  assert.equal(result.providerMeta.protocol, 'gemini');
  assert.equal(result.providerMeta.fallback, true);
  assert.equal(notes.length, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0][0], 'opencode.ai');
});

test('turn service não faz fallback após cancelamento', async () => {
  const controller = new AbortController();
  let calls = 0;
  const service = new ProviderTurnService({ registry: { protocol: providerProtocol, turn: async () => { calls++; controller.abort(); throw new Error('abort'); } } });
  await assert.rejects(() => service.turn({ config: { provider: 'openai', model: 'a', fallbackModel: 'b' }, signal: controller.signal }));
  assert.equal(calls, 1);
});

test('pricing reconhece endpoints grátis, modelos conhecidos e host explícito', () => {
  assert.deepEqual(priceFor('meta/llama-3.3-70b', { baseUrl: 'https://integrate.api.nvidia.com/v1' }), [0, 0]);
  assert.deepEqual(priceFor('gpt-5-mini'), [0.25, 2]);
  assert.equal(priceFor('modelo-local'), null);
  assert.equal(usageHost({ usageHost: 'codex-chatgpt', baseUrl: 'x' }), 'codex-chatgpt');
});
