'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const path = require('path');
const { FactsRepository } = require('../main/domains/memory/facts-repository');
const { scopeKey } = require('../main/domains/workspace/workspace-path');
const { renderLedger, renderWorklog, entriesForWorkspace } = require('../main/domains/context/journal');

const CLOCK = { date: () => new Date('2026-07-30T12:00:00Z') };
function mem(value) { return { value, read: async function () { return { value: this.value, source: 'primary' }; }, write: async function (v) { this.value = structuredClone(v); } }; }
const A = path.resolve('/projetos/alpha'); const B = path.resolve('/projetos/beta');
const cfg = (workspace) => ({ workspace, memoryEnabled: true, contextWindow: 8192 });

test('scopeKey canoniza a mesma pasta escrita de formas diferentes', () => {
  assert.equal(scopeKey(path.join(A, 'sub', '..')), scopeKey(A));
  assert.equal(scopeKey(''), '');
  if (process.platform === 'win32') assert.equal(scopeKey(A.toUpperCase()), scopeKey(A.toLowerCase()));
});

test('fato de projeto não aparece em outro projeto; fato do usuário aparece em todos', async () => {
  const repo = new FactsRepository({ store: mem([]), clock: CLOCK }); await repo.initialize();
  await repo.add({ fact: 'prefere respostas curtas' });
  await repo.add({ fact: 'o backend roda na porta 5173', scope: 'project', project: A });
  await repo.add({ fact: 'os testes usam pytest', scope: 'project', project: B });

  assert.deepEqual(repo.listForScope(A).map((f) => f.fact), ['prefere respostas curtas', 'o backend roda na porta 5173']);
  assert.deepEqual(repo.listForScope(B).map((f) => f.fact), ['prefere respostas curtas', 'os testes usam pytest']);
  // sem projeto aberto, nenhum fato de projeto entra no contexto
  assert.deepEqual(repo.listForScope('').map((f) => f.fact), ['prefere respostas curtas']);
});

test('fato legacy sem escopo continua valendo como fato do usuário', async () => {
  const repo = new FactsRepository({ store: mem(['gosta de café', { fact: 'usa Windows' }]), clock: CLOCK });
  await repo.initialize();
  assert.deepEqual(repo.list().map((f) => f.scope), ['user', 'user']);
  assert.equal(repo.listForScope(A).length, 2);
});

test('retenção é por escopo: projeto movimentado não expulsa fatos do usuário', async () => {
  const repo = new FactsRepository({ store: mem([]), clock: CLOCK, limit: 2, projectLimit: 2 }); await repo.initialize();
  await repo.add({ fact: 'u1' }); await repo.add({ fact: 'u2' });
  for (const n of [1, 2, 3, 4]) await repo.add({ fact: 'p' + n, scope: 'project', project: A });
  assert.deepEqual(repo.list().map((f) => f.fact), ['u1', 'u2', 'p3', 'p4']);
  assert.deepEqual(repo.listForScope(B).map((f) => f.fact), ['u1', 'u2']);
});

test('reclassificar um fato preserva o texto e troca só o escopo', async () => {
  const repo = new FactsRepository({ store: mem([]), clock: CLOCK }); await repo.initialize();
  await repo.add({ fact: 'usa pnpm neste repo' });
  assert.equal(await repo.set(0, { scope: 'project', project: A }), true);
  assert.deepEqual(repo.list()[0].fact, 'usa pnpm neste repo');
  assert.equal(repo.listForScope(B).length, 0);
});

test('diário técnico só entra no projeto em que foi registrado', () => {
  const session = {
    chatWorkspace: A,
    ledger: [
      { at: '2026-07-30T10:00', goal: 'ajustar alpha', ws: A, mutations: 1, status: 'completed', filesChanged: ['alpha.js'], verification: [{ ok: true, command: 'npm test' }], failures: [] },
      { at: '2026-07-30T11:00', goal: 'ajustar beta', ws: B, mutations: 1, status: 'completed', filesChanged: ['beta.js'], verification: [{ ok: true, command: 'pytest' }], failures: [] },
    ],
    worklog: [
      { at: '2026-07-30T10:00', goal: 'ajustar alpha', ws: A, status: 'completed', tools: [{ status: 'success', tool: 'read_file', target: 'alpha.js', summary: 'ok' }] },
      { at: '2026-07-30T11:00', goal: 'ajustar beta', ws: B, status: 'completed', tools: [{ status: 'success', tool: 'read_file', target: 'beta.js', summary: 'ok' }] },
    ],
  };
  const ledgerA = renderLedger(session, cfg(A));
  assert.match(ledgerA, /alpha\.js/); assert.ok(!ledgerA.includes('beta.js'));
  const worklogB = renderWorklog(session, cfg(B));
  assert.match(worklogB, /beta\.js/); assert.ok(!worklogB.includes('alpha.js'));
});

test('subagente em worktree temporário mantém o diário do projeto lógico', () => {
  const worktree = path.resolve('/tmp/lumi-worktree-1');
  const session = { projectRoot: A, chatWorkspace: A, worklog: [{ at: '2026-07-30T10:00', goal: 'ajustar alpha', ws: A, status: 'completed', tools: [{ status: 'success', tool: 'read_file', target: 'alpha.js', summary: 'ok' }] }] };
  // cfg.workspace é o worktree; o escopo tem que seguir projectRoot, senão o subagente perde o diário
  assert.match(renderWorklog(session, cfg(worktree)), /alpha\.js/);
});

test('entrada legacy sem carimbo passa só quando a conversa não tem projeto conhecido', () => {
  const legacy = [{ at: '2026-07-30T10:00', goal: 'antigo', status: 'completed' }];
  assert.equal(entriesForWorkspace(legacy, { chatWorkspace: '' }, cfg(A)).length, 1);
  assert.equal(entriesForWorkspace(legacy, { chatWorkspace: A }, cfg(A)).length, 1);
  assert.equal(entriesForWorkspace(legacy, { chatWorkspace: A }, cfg(B)).length, 0);
});
