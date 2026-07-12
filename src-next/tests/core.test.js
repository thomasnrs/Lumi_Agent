'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Lifecycle } = require('../main/core/lifecycle');
const { Container } = require('../main/core/container');
const { EventBus } = require('../main/core/event-bus');

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
