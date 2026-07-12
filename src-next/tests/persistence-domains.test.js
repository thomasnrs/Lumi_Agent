'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { AtomicJsonStore } = require('../main/adapters/filesystem/atomic-json-store');
const { FactsRepository } = require('../main/domains/memory/facts-repository');
const { UsageRepository } = require('../main/domains/usage/usage-repository');
const { SchedulingRepository } = require('../main/domains/scheduling/scheduling-repository');
const { nextTaskRun } = require('../main/domains/scheduling/schedule');
const { ChatRepository, normalizeChat, validChatId } = require('../main/domains/chats/chat-repository');
const { ArtifactRepository, artifactId } = require('../main/domains/artifacts/artifact-repository');

function tempDir(t, prefix) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function store(file, fallback) { return new AtomicJsonStore({ filePath: file, defaultValue: fallback }); }
function fixture(name) { return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'persistence', name), 'utf8')); }

test('facts migra strings legacy, limita e não entrega referência mutável', async (t) => {
  const dir = tempDir(t, 'lumi-facts-'); const s = store(path.join(dir, 'facts.json'), []); await s.write(fixture('facts-legacy.json'));
  const repo = new FactsRepository({ store: s, limit: 2, clock: { date: () => new Date('2026-07-12T00:00:00Z') } }); await repo.initialize();
  assert.deepEqual(repo.list().map((x) => x.fact), ['gosta de café', 'usa Windows']); const added = await repo.add('prefere dark'); added.fact = 'mutado';
  assert.deepEqual(repo.list().map((x) => x.fact), ['usa Windows', 'prefere dark']); assert.equal(await repo.delete(99), false);
});

test('usage preserva formato legacy e vira o dia sem carregar custo anterior', async () => {
  let day = new Date('2026-07-12T10:00:00Z'); const s = { value: fixture('usage-legacy.json'), read: async function(){return {value:this.value,source:'primary'}}, write: async function(v){this.value=structuredClone(v)} };
  const repo = new UsageRepository({ store: s, clock: { date: () => day } }); await repo.initialize(); assert.equal(repo.totals().in, 10);
  await repo.record('api', { prompt_tokens: 5, completion_tokens: 3 }, [1, 2]); assert.deepEqual({ in: repo.totals().in, out: repo.totals().out }, { in: 15, out: 5 });
  day = new Date('2026-07-13T01:00:00Z'); assert.deepEqual(repo.totals(), { day: '2026-07-13', usd: 0, in: 0, out: 0, unknown: false });
});

test('scheduling mantém IDs legacy, calcula recorrência e encontra tarefas vencidas', async () => {
  const mem = (value) => ({ value, read: async function(){return {value:this.value,source:'primary'}}, write: async function(v){this.value=structuredClone(v)} });
  const reminders = mem(fixture('reminders-legacy.json')); const tasks = mem(fixture('tasks-legacy.json'));
  const repo = new SchedulingRepository({ remindersStore: reminders, tasksStore: tasks, clock: { now: () => 1000 } }); await repo.initialize();
  assert.equal((await repo.addReminder({ at: 2000, message: 'novo' })).id, 'r8'); assert.equal((await repo.saveTask({ prompt: 'intervalo', schedule: 'interval', everyMin: 1 })).id, 'tk5');
  assert.equal(repo.due(100).map((x) => x.id).includes('tk4'), true); assert.equal(nextTaskRun({ schedule: 'interval', everyMin: 1 }, 1000), 301000);
});

test('chat repository migra legacy, coalesce writes, lista, renomeia e não ressuscita delete', async (t) => {
  const dir = tempDir(t, 'lumi-chats-'); let tick = 0; const clock = { now: () => 1000 + tick, date: () => new Date(1700000000000 + tick++ * 1000) }; let seq = 0;
  const repo = new ChatRepository({ directory: dir, clock, nextId: () => `ctest${++seq}` });
  const chat = await repo.migrateLegacy([{ role: 'user', content: 'Olá mundo' }], 'resumo'); assert.equal(validChatId(chat.id), true); assert.equal(chat.title, 'Olá mundo');
  await Promise.all(Array.from({ length: 20 }, (_, i) => repo.save({ ...chat, history: [{ role: 'user', content: `mensagem ${i}` }] })));
  const loaded = await repo.load(chat.id); assert.equal(loaded.history[0].content, 'mensagem 19'); await repo.rename(chat.id, 'Meu chat'); assert.equal((await repo.list())[0].title, 'Meu chat');
  await repo.delete(chat.id); await assert.rejects(() => repo.save(loaded), /indisponível/); assert.equal((await repo.list()).length, 0);
  assert.throws(() => normalizeChat({}, '../escape', clock), /inválido/);
});

test('chat normaliza fixture legacy preservando IDs de motores e configuração por chat', () => {
  const legacy = fixture('chat-legacy.json'); const chat = normalizeChat(legacy, legacy.id, { date: () => new Date() });
  assert.equal(chat.claudeSessionId, 'claude-1'); assert.equal(chat.codexThreadId, 'codex-1'); assert.deepEqual(chat.chatConfig, { provider: 'openai', model: 'teste' });
});

test('artifact repository deduplica por hash, rejeita adulteração e aplica retenção', async (t) => {
  const dir = tempDir(t, 'lumi-artifacts-'); let now = Date.now(); const clock = { now: () => now, date: () => new Date(now) }; const repo = new ArtifactRepository({ directory: dir, clock, maxItems: 2, maxBytes: 100000 });
  const first = await repo.save('grep', 'conteúdo'); const again = await repo.save('grep', 'conteúdo'); assert.equal(first.id, artifactId('grep', 'conteúdo')); assert.equal(again.reused, true); assert.equal((await repo.load(first.id)).content, 'conteúdo');
  fs.writeFileSync(path.join(dir, `${first.id}.json`), JSON.stringify({ id: first.id, tool: 'grep', content: 'adulterado' })); assert.equal(await repo.load(first.id), null);
  for (let i = 0; i < 4; i++) { now += 1000; await repo.save('tool', `item-${i}`); } assert.ok(await repo.sweep() >= 2);
});
