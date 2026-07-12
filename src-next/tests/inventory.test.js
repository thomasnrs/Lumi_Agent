'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { inventory, duplicates, objectRegion } = require('../scripts/inventory');

const inventoryDir = path.resolve(__dirname, '..', 'architecture', 'inventories');

function json(name) {
  return JSON.parse(fs.readFileSync(path.join(inventoryDir, name), 'utf8'));
}

test('helpers do inventário detectam duplicação e regiões ausentes', () => {
  assert.deepEqual(duplicates([{ id: 'a' }, { id: 'b' }, { id: 'a' }], 'id').map((item) => item.id), ['a']);
  assert.equal(objectRegion('before START content END after', 'START', 'END').text, 'START content ');
  assert.throws(() => objectRegion('x', 'START', 'END'), /marcador ausente/);
});

test('inventário baseline é determinístico e cobre contratos atuais', () => {
  const first = inventory();
  const before = fs.readFileSync(path.join(inventoryDir, 'ipc.json'), 'utf8');
  const second = inventory();
  const after = fs.readFileSync(path.join(inventoryDir, 'ipc.json'), 'utf8');
  assert.deepEqual(second, first);
  assert.equal(after, before);

  const ipc = json('ipc.json');
  const tools = json('tools.json');
  const persistence = json('persistence.json');
  const providers = json('providers.json');
  assert.equal(ipc.duplicates.length, 0);
  assert.deepEqual(ipc.preloadWithoutMainRegistration, []);
  assert.equal(ipc.summary.mainRegistrations, ipc.summary.preloadCalls);
  assert.ok(ipc.summary.uniqueMainChannels >= 180);
  assert.ok(tools.summary.tools >= 65);
  assert.equal(tools.duplicates.length, 0);
  assert.ok(persistence.pathFactories.some((item) => item.name === 'configPath'));
  assert.ok(providers.specialRoutes.every((route) => route.detected));
  assert.deepEqual(providers.engines.map((engine) => engine.id), ['claude-code', 'codex', 'glm-code']);
});
