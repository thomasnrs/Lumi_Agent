'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { createAsyncContext } = require('../main/adapters/async-context'); const { ChatSession } = require('../main/domains/chats/chat-session'); const { SessionManager } = require('../main/domains/chats/session-manager');

function chat(id, content) { return { id, title: id, createdAt: '2026-01-01', updatedAt: '2026-01-01', history: content ? [{ role: 'user', content }] : [], events: [], archive: [], summary: '', worklog: [], ledger: [], chatConfig: null }; }
function repository(seed) {
  const data = new Map((seed || []).map((item) => [item.id, structuredClone(item)])); let seq = data.size;
  return { data, load: async (id) => { if (!data.has(id)) throw new Error('not found'); return structuredClone(data.get(id)); }, list: async () => [...data.values()].map((x) => ({ id: x.id, updatedAt: x.updatedAt })).reverse(),
    create: async (value) => { const item = { ...chat(`ctest${++seq}`), ...(value || {}) }; data.set(item.id, structuredClone(item)); return item; }, save: async (item) => data.set(item.id, structuredClone(item)), delete: async (id) => data.delete(id) };
}

test('ChatSession separa estado durável do efêmero e snapshot preserva motores', () => {
  const session = new ChatSession({ ...chat('ctest1', 'oi'), claudeSessionId: 'claude', glmSessionId: 'glm', codexThreadId: 'codex', lastTurnContext: { messages: [] } });
  session.running = true; session.steerQueue.push('x'); const snap = session.snapshot({ date: () => new Date('2026-07-12T00:00:00Z') });
  assert.equal(snap.claudeSessionId, 'claude'); assert.equal(snap.glmSessionId, 'glm'); assert.equal(snap.codexThreadId, 'codex'); assert.equal('running' in snap, false); assert.equal('steerQueue' in snap, false);
});

test('SessionManager mantém contexto assíncrono isolado em tarefas paralelas', async () => {
  const repo = repository([chat('ctest1'), chat('ctest2')]); const manager = new SessionManager({ repository: repo, context: createAsyncContext() }); await manager.initialize('ctest1');
  const seen = [];
  await Promise.all([
    manager.run('ctest1', async (session) => { await new Promise((r) => setTimeout(r, 8)); seen.push(['a', manager.current().id, session.id]); }),
    manager.run('ctest2', async (session) => { await new Promise((r) => setTimeout(r, 1)); seen.push(['b', manager.current().id, session.id]); }),
  ]);
  assert.deepEqual(seen.sort(), [['a', 'ctest1', 'ctest1'], ['b', 'ctest2', 'ctest2']]); assert.equal(manager.current().id, 'ctest1');
});

test('switch adota sessão viva e delete aborta antes de escolher substituta', async () => {
  const repo = repository([chat('ctest1'), chat('ctest2')]); const manager = new SessionManager({ repository: repo, context: createAsyncContext() }); await manager.initialize('ctest1');
  const second = await manager.get('ctest2'); second.running = true; let aborted = false; second.abort = { abort: () => { aborted = true; } };
  assert.equal((await manager.switch('ctest2')), second); await manager.delete('ctest2'); assert.equal(aborted, true); assert.equal(manager.foreground.id, 'ctest1'); assert.equal(repo.data.has('ctest2'), false);
});

test('trim nunca descarta sessão background em execução', async () => {
  const repo = repository([chat('ctest1'), chat('ctest2'), chat('ctest3')]); const manager = new SessionManager({ repository: repo, context: createAsyncContext(), maxBackground: 1 }); await manager.initialize('ctest1');
  const running = await manager.get('ctest2'); running.running = true; manager.background.set(running.id, running); const idle = await manager.get('ctest3'); manager.background.set(idle.id, idle); manager.trim();
  assert.equal(manager.background.has('ctest2'), true); assert.equal(manager.background.has('ctest3'), false);
});
