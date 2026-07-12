'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createIdFactory, safePrefix } = require('../main/core/ids');
const { MetricsRegistry } = require('../main/core/metrics');
const s = require('../shared/schema');
const { AtomicJsonStore } = require('../main/adapters/filesystem/atomic-json-store');
const { ConfigService, deepMerge } = require('../main/domains/config/config-service');

test('IDs são injetáveis, ordenáveis por chamada e usam prefixo seguro', () => {
  let uuid = 0;
  const next = createIdFactory({ now: () => 1000, randomUUID: () => `00000000-0000-0000-0000-${String(++uuid).padStart(12, '0')}` });
  assert.equal(safePrefix(' Chat Main! '), 'chat-main');
  const a = next('Chat Main!');
  const b = next('Chat Main!');
  assert.notEqual(a, b);
  assert.match(a, /^chat-main_rs_1_/);
  assert.match(b, /^chat-main_rs_2_/);
});

test('schemas validam, aplicam defaults, removem mutabilidade e apontam o path', () => {
  const configSchema = s.object({
    name: s.string({ trim: true, min: 2, max: 20 }),
    fps: s.number({ integer: true, min: 0, max: 60 }),
    mode: s.enumeration(['light', 'dark']),
    tags: s.optional(s.array(s.string({ min: 1 }), { max: 3 }), []),
    meta: s.optional(s.record(s.string(), { max: 2 }), {}),
  });
  const parsed = configSchema.parse({ name: ' Lumi ', fps: 60, mode: 'dark' });
  assert.deepEqual(parsed, { name: 'Lumi', fps: 60, mode: 'dark', tags: [], meta: {} });
  assert.throws(() => configSchema.parse({ name: 'x', fps: 61, mode: 'blue' }), /\$\.name/);
  assert.throws(() => configSchema.parse({ name: 'Lumi', fps: 30, mode: 'dark', extra: true }), /\$\.extra/);
});

test('métricas agregam sem guardar amostras e limitam cardinalidade', () => {
  let now = 10;
  const metrics = new MetricsRegistry({ clock: { now: () => now }, maxSeries: 10 });
  metrics.increment('tool.calls', 2, { tool: 'read' });
  metrics.gauge('queue.depth', 4, { queue: 'chat' });
  const end = metrics.timer('tool.duration', { tool: 'read' });
  now = 35;
  assert.equal(end(), 25);
  assert.equal(end(), null);
  const histogram = metrics.snapshot().find((item) => item.name === 'tool.duration');
  assert.deepEqual({ count: histogram.count, sum: histogram.sum, min: histogram.min, max: histogram.max }, { count: 1, sum: 25, min: 25, max: 25 });
  for (let i = 0; i < 7; i++) metrics.gauge(`extra.${i}`, i);
  assert.throws(() => metrics.gauge('overflow', 1), /limite de séries/);
});

test('atomic store serializa writes e recupera JSON corrompido pelo backup', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-next-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'config.json');
  const store = new AtomicJsonStore({ filePath, defaultValue: { count: 0 }, clock: { now: () => 1234 } });

  const empty = await store.read();
  assert.deepEqual(empty.value, { count: 0 });
  assert.equal(empty.source, 'default');
  await Promise.all([store.write({ count: 1 }), store.write({ count: 2 }), store.write({ count: 3 })]);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { count: 3 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${filePath}.bak`, 'utf8')), { count: 2 });

  fs.writeFileSync(filePath, '{quebrado', 'utf8');
  const recovered = await store.read();
  assert.equal(recovered.source, 'backup');
  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.value, { count: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { count: 2 });
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('config.json.corrupt-1234-')));
});

test('atomic store valida antes de tocar no disco e update é transacional', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-next-schema-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'state.json');
  const stateSchema = s.object({ value: s.number({ integer: true, min: 0 }) });
  const store = new AtomicJsonStore({ filePath, schema: stateSchema, defaultValue: { value: 0 } });
  await store.write({ value: 1 });
  await assert.rejects(() => store.write({ value: -1 }), /\$\.value/);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { value: 1 });
  await Promise.all(Array.from({ length: 8 }, () => store.update((current) => ({ value: current.value + 1 }))));
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { value: 9 });
});

test('config service migra versões, mescla defaults e devolve cópias', async () => {
  const writes = [];
  const store = {
    read: async () => ({ value: { schemaVersion: 0, oldName: 'Lumi', nested: { custom: true } }, source: 'primary' }),
    write: async (value) => writes.push(structuredClone(value)),
  };
  const service = new ConfigService({
    store,
    currentVersion: 2,
    defaults: { name: 'Default', nested: { enabled: true, custom: false } },
    migrations: {
      0: (value) => ({ ...value, name: value.oldName, oldName: undefined }),
      1: (value) => ({ ...value, migrated: true }),
    },
    validate: (value) => value,
  });
  const initial = await service.initialize();
  assert.equal(initial.schemaVersion, 2);
  assert.equal(initial.name, 'Lumi');
  assert.deepEqual(initial.nested, { enabled: true, custom: true });
  assert.equal(initial.migrated, true);
  initial.name = 'mutado fora';
  assert.equal(service.get().name, 'Lumi');
  assert.equal(writes.length, 1);
  const patched = await service.patch({ nested: { enabled: false } });
  assert.deepEqual(patched.nested, { enabled: false, custom: true });
  assert.equal(writes.length, 2);
});

test('config service bloqueia versão futura e migration ausente', async () => {
  const future = new ConfigService({ store: { read: async () => ({ value: { schemaVersion: 9 }, source: 'primary' }) }, currentVersion: 2 });
  await assert.rejects(() => future.initialize(), (error) => error.code === 'CONFIG_FUTURE_VERSION');
  const missing = new ConfigService({ store: { read: async () => ({ value: { schemaVersion: 0 }, source: 'primary' }) }, currentVersion: 2, migrations: { 0: (x) => x } });
  await assert.rejects(() => missing.initialize(), (error) => error.code === 'CONFIG_MIGRATION_MISSING');
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 } }, { a: { b: 3 } }), { a: { b: 3, c: 2 } });
});
