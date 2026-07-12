'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Lifecycle } = require('../main/core/lifecycle');
const { Container } = require('../main/core/container');
const { EventBus } = require('../main/core/event-bus');
const { LumiError, normalizeError, serializeError } = require('../main/core/errors');
const { redact, redactString } = require('../main/core/redaction');
const { createLogger } = require('../main/core/logger');
const { Scheduler } = require('../main/core/scheduler');

test('lifecycle inicia em ordem e encerra em ordem reversa', async () => {
  const calls = [];
  const lifecycle = new Lifecycle();
  lifecycle.register('a', { start: () => calls.push('start:a'), stop: () => calls.push('stop:a') });
  lifecycle.register('b', { start: () => calls.push('start:b'), stop: () => calls.push('stop:b') });
  await lifecycle.start();
  await lifecycle.stop();
  assert.deepEqual(calls, ['start:a', 'start:b', 'stop:b', 'stop:a']);
  assert.equal(lifecycle.state, 'stopped');
});

test('lifecycle faz rollback se um serviço falhar ao iniciar', async () => {
  const calls = [];
  const lifecycle = new Lifecycle();
  lifecycle.register('ok', { start: () => calls.push('start:ok'), stop: () => calls.push('stop:ok') });
  lifecycle.register('fail', { start: () => { throw new Error('boom'); } });
  await assert.rejects(() => lifecycle.start(), /boom/);
  assert.deepEqual(calls, ['start:ok', 'stop:ok']);
});

test('container resolve factories uma vez e detecta ciclos', () => {
  const container = new Container();
  let creates = 0;
  container.value('base', 4).factory('double', (resolve) => {
    creates++;
    return resolve('base') * 2;
  });
  assert.equal(container.resolve('double'), 8);
  assert.equal(container.resolve('double'), 8);
  assert.equal(creates, 1);

  const cyclic = new Container();
  cyclic.factory('a', (resolve) => resolve('b')).factory('b', (resolve) => resolve('a'));
  assert.throws(() => cyclic.resolve('a'), /a -> b -> a/);
});

test('event bus devolve unsubscribe idempotente e descarta listeners', () => {
  const bus = new EventBus();
  const values = [];
  const unsubscribe = bus.on('tick', (value) => values.push(value));
  bus.emit('tick', 1);
  unsubscribe();
  unsubscribe();
  bus.emit('tick', 2);
  bus.dispose();
  assert.equal(bus.emit('tick', 3), false);
  assert.deepEqual(values, [1]);
});

test('erros normalizados preservam código sem expor stack por padrão', () => {
  const original = new LumiError('RATE_LIMIT', 'muitas requisições', { retryable: true, details: { wait: 2 } });
  assert.equal(normalizeError(original), original);
  assert.deepEqual(serializeError(original), {
    name: 'LumiError',
    code: 'RATE_LIMIT',
    message: 'muitas requisições',
    retryable: true,
    details: { wait: 2 },
  });
  assert.equal('stack' in serializeError(new Error('boom')), false);
  assert.equal(normalizeError('falhou', 'LEGACY').code, 'LEGACY');
});

test('redaction remove segredos por chave, texto e credenciais de URL', () => {
  const input = {
    apiKey: 'sk-abcdefghijk',
    nested: { authorization: 'Bearer abcdefghijklmnop', note: 'token hf_abcdefghijk' },
    url: 'https://user:senha@example.com/api',
  };
  const clean = redact(input);
  assert.equal(clean.apiKey, '[oculto]');
  assert.equal(clean.nested.authorization, '[oculto]');
  assert.ok(!JSON.stringify(clean).includes('abcdefghijk'));
  assert.equal(clean.url, 'https://user:[oculto]@example.com/api');
  assert.equal(redactString('Bearer abcdefghijklmnop'), '[oculto]');
});

test('logger filtra nível, fixa campos reservados e mede operações', async () => {
  const entries = [];
  let now = 100;
  const logger = createLogger({
    level: 'info',
    sink: (entry) => entries.push(entry),
    clock: { now: () => now },
    context: { module: 'test', token: 'segredo' },
  });
  logger.debug('ignorado');
  logger.info('pronto', { level: 'fake', apiKey: 'sk-abcdefghijk' });
  const child = logger.child({ chatId: 'c1' });
  const result = await child.time('task', async () => {
    now = 145;
    return 7;
  });
  assert.equal(result, 7);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].level, 'info');
  assert.equal(entries[0].message, 'pronto');
  assert.equal(entries[0].apiKey, '[oculto]');
  assert.equal(entries[0].token, '[oculto]');
  assert.equal(entries[1].durationMs, 45);
  assert.equal(entries[1].chatId, 'c1');
});

test('scheduler cancela timers por owner e descarte é idempotente', () => {
  let sequence = 0;
  const active = new Map();
  const clock = {
    setTimeout(fn) { const id = ++sequence; active.set(id, { kind: 'timeout', fn }); return id; },
    clearTimeout(id) { active.delete(id); },
    setInterval(fn) { const id = ++sequence; active.set(id, { kind: 'interval', fn }); return id; },
    clearInterval(id) { active.delete(id); },
  };
  const scheduler = new Scheduler(clock);
  const calls = [];
  scheduler.timeout('chat:a', () => calls.push('once'), 10);
  scheduler.interval('chat:a', () => calls.push('repeat'), 20);
  scheduler.interval('chat:b', () => calls.push('other'), 30);
  assert.equal(active.size, 3);
  assert.equal(scheduler.cancelOwner('chat:a'), 2);
  assert.equal(active.size, 1);
  active.values().next().value.fn();
  assert.deepEqual(calls, ['other']);
  scheduler.dispose();
  scheduler.dispose();
  assert.equal(active.size, 0);
  assert.throws(() => scheduler.timeout('x', () => {}, 1), /descartado/);
});
