'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AutoVerificationPolicy, AutoReviewPolicy } = require('../main/domains/agent-runtime/completion-policies');
const { TurnLedger } = require('../main/domains/agent-runtime/turn-ledger');
const { AgentRuntime } = require('../main/domains/agent-runtime/agent-runtime');
const { ToolRegistry } = require('../main/domains/tools/tool-registry');
const { ToolExecutor } = require('../main/domains/tools/tool-executor');

function context(config, ledger, events) { return { config, ledger, messages: [], emit: (event) => events.push(event) }; }

test('auto-verificação registra falha, pede correção e para ao obter sucesso', async () => {
  const ledger = new TurnLedger('corrija');
  ledger.record('edit_file', { path: 'app.js' }, { ok: true });
  const outputs = [{ ok: false, output: 'syntax error' }, { ok: true, output: 'passou' }];
  const events = [];
  const policy = new AutoVerificationPolicy({ run: async () => outputs.shift(), resolveCommand: () => 'node --check app.js' });
  const first = await policy.evaluate(context({ autoVerify: true }, ledger, events));
  assert.match(first.content, /syntax error/);
  assert.equal(ledger.verification[0].ok, false);
  assert.equal(await policy.evaluate(context({ autoVerify: true }, ledger, events)), null);
  assert.equal(ledger.hasSuccessfulVerification(), true);
  assert.equal(policy.attempts, 2);
});

test('auto-verificação respeita opt-in e teto de tentativas', async () => {
  const ledger = new TurnLedger('corrija');
  ledger.record('edit_file', { path: 'app.js' }, { ok: true });
  let calls = 0;
  const policy = new AutoVerificationPolicy({ maxAttempts: 1, run: async () => (calls++, { ok: false, output: 'x' }), resolveCommand: () => 'npm test' });
  assert.equal(await policy.evaluate(context({ autoVerify: false }, ledger, [])), null);
  assert.ok(await policy.evaluate(context({ autoVerify: true }, ledger, [])));
  assert.equal(await policy.evaluate(context({ autoVerify: true }, ledger, [])), null);
  assert.equal(calls, 1);
});

test('auto-revisão injeta achados uma única vez e tolera falha do reviewer', async () => {
  const ledger = new TurnLedger('corrija');
  ledger.record('edit_file', { path: 'app.js' }, { ok: true });
  let calls = 0;
  const policy = new AutoReviewPolicy({ review: async () => (calls++, 'Risco de null na linha 3') });
  const message = await policy.evaluate(context({ autoReview: true }, ledger, []));
  assert.match(message.content, /Risco de null/);
  assert.equal(await policy.evaluate(context({ autoReview: true }, ledger, [])), null);
  assert.equal(calls, 1);
  const events = [];
  const broken = new AutoReviewPolicy({ review: async () => { throw new Error('offline'); } });
  assert.equal(await broken.evaluate(context({ autoReview: true }, ledger, events)), null);
  assert.equal(events[0].type, 'agent.auto-review-error');
});

test('factories criam estado novo de política para cada execução paralela', async () => {
  let reviews = 0;
  const registry = new ToolRegistry().register('edit_file', {
    schema: { name: 'edit_file', description: '', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    exclusive: true,
    run: async () => ({ ok: true }),
  });
  const executor = new ToolExecutor({ registry, authorize: async () => true });
  const sequences = new Map();
  const turnService = { turn: async (request) => {
    const id = request.messages[0].content;
    const step = sequences.get(id) || 0; sequences.set(id, step + 1);
    if (step === 0) return { text: '', toolCalls: [{ id: `${id}-call`, name: 'edit_file', arguments: `{"path":"${id}.js"}` }] };
    return { text: 'fim', toolCalls: [] };
  } };
  const runtime = new AgentRuntime({
    turnService, toolRegistry: registry, toolExecutor: executor,
    completionPolicyFactories: [() => new AutoReviewPolicy({ review: async () => (reviews++, 'ok') })],
  });
  const run = (id) => runtime.run({ config: { autoReview: true }, goal: 'corrija o código', messages: [{ role: 'user', content: id }], getTools: () => registry.schemas({ allow: ['edit_file'] }) });
  const [a, b] = await Promise.all([run('a'), run('b')]);
  assert.equal(a.status, 'completed'); assert.equal(b.status, 'completed');
  assert.equal(reviews, 2);
});
