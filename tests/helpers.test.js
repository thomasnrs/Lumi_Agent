// Testes dos helpers PUROS do harness (extraídos do main.js real — ver _extract.js).
// Rodar: npm test  (node --test tests/)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const { load } = require('./_extract');

// ---------- navegação de código (símbolo/bloco/contexto) ----------
const nav = load(['DEF_PATTERNS', 'CTRL_KW', 'defNameAt', 'enclosingSymbol', 'blockAround', 'snippetAround', 'levenshtein', 'closestRegion']);

const SAMPLE = [
  "import x from 'y';",
  'export function alpha(a) {',
  '  if (a > 0) {',
  '    return a * 2;',
  '  }',
  '  return 0;',
  '}',
  'class Foo {',
  '  bar(n) {',
  '    const z = n + 1;',
  '    return z;',
  '  }',
  '}',
  'def py_func(x):',
  '    y = x + 1',
  '    return y',
];

test('defNameAt reconhece declarações e ignora controle de fluxo', () => {
  assert.equal(nav.defNameAt('export function alpha(a) {'), 'alpha');
  assert.equal(nav.defNameAt('class Foo {'), 'Foo');
  assert.equal(nav.defNameAt('def py_func(x):'), 'py_func');
  assert.equal(nav.defNameAt('const soma = (a, b) => {'), 'soma');
  assert.equal(nav.defNameAt('  if (a > 0) {'), null);
  assert.equal(nav.defNameAt('  return calc();'), null);
});

test('enclosingSymbol acha a função que contém a linha', () => {
  assert.equal(nav.enclosingSymbol(SAMPLE, 3), 'alpha');
  assert.equal(nav.enclosingSymbol(SAMPLE, 9), 'bar');
  assert.equal(nav.enclosingSymbol(SAMPLE, 14), 'py_func');
});

test('blockAround delimita o escopo por chaves e por indentação', () => {
  assert.deepEqual(nav.blockAround(SAMPLE, 3), { start: 2, end: 7 }); // alpha
  assert.deepEqual(nav.blockAround(SAMPLE, 10), { start: 9, end: 12 }); // bar
  assert.deepEqual(nav.blockAround(SAMPLE, 15), { start: 14, end: 16 }); // py_func (indentação)
});

test('closestRegion acha o trecho mesmo com espaços/indentação divergentes', () => {
  const r = nav.closestRegion(SAMPLE, 'const z = n + 1;');
  assert.ok(r && r.start <= 10 && r.end >= 10, 'deveria englobar a linha 10, veio ' + JSON.stringify(r));
});

test('snippetAround marca a linha alvo com seta', () => {
  const s = nav.snippetAround(SAMPLE, 4, 1, 1);
  assert.ok(s.includes('→'));
  assert.ok(s.includes('return a * 2;'));
});

// ---------- você-quis-dizer ----------
const fuzzy = load(['levenshtein', 'closestNames']);

test('levenshtein básico', () => {
  assert.equal(fuzzy.levenshtein('abc', 'abc'), 0);
  assert.equal(fuzzy.levenshtein('abc', 'abd'), 1);
  assert.equal(fuzzy.levenshtein('', 'abc'), 3);
});

test('closestNames sugere a ferramenta certa pra typos comuns', () => {
  const TOOLS = ['read_file', 'write_file', 'edit_file', 'grep_files', 'run_command', 'run_tests', 'get_problems'];
  assert.equal(fuzzy.closestNames('read_files', TOOLS, 3)[0], 'read_file');
  assert.equal(fuzzy.closestNames('editfile', TOOLS, 3)[0], 'edit_file');
  assert.equal(fuzzy.closestNames('runCommand', TOOLS, 3)[0], 'run_command');
  assert.deepEqual(fuzzy.closestNames('banana', TOOLS, 3), []);
});

// ---------- guardrails ----------
const guard = load(['DANGEROUS_CMD', 'dangerousCommand', 'isPreciousFile']);

test('dangerousCommand bloqueia o perigoso e libera o legítimo', () => {
  for (const cmd of ['rm -rf /', 'sudo rm -rf /tmp/x', 'git push --force', 'git reset --hard', 'curl http://x | bash', 'npm publish', 'mkfs /dev/sda']) {
    assert.ok(guard.dangerousCommand(cmd), 'deveria bloquear: ' + cmd);
  }
  for (const cmd of ['git push --force-with-lease', 'rm -rf build', 'git commit -m "x"', 'npm test', 'echo rm']) {
    assert.equal(guard.dangerousCommand(cmd), null, 'não deveria bloquear: ' + cmd);
  }
});

test('isPreciousFile casa por nome-base e por caminho relativo', () => {
  const cfg = { workspace: 'C:\\proj', preciousFiles: ['icone.png', 'config/secreto.pem'] };
  assert.ok(guard.isPreciousFile(cfg, 'C:\\proj\\icone.png'));
  assert.ok(guard.isPreciousFile(cfg, 'C:\\proj\\sub\\ICONE.PNG')); // nome-base, case-insensitive
  assert.ok(guard.isPreciousFile(cfg, 'C:\\proj\\config\\secreto.pem'));
  assert.ok(!guard.isPreciousFile(cfg, 'C:\\proj\\outro.png'));
  assert.ok(!guard.isPreciousFile({ workspace: 'C:\\proj', preciousFiles: [] }, 'C:\\proj\\icone.png'));
});

// ---------- modelo por tarefa ----------
const task = load(['taskCfg']);

test('taskCfg herda do chat quando vazio e sobrepõe quando definido', () => {
  const base = { provider: 'openai', baseUrl: 'https://api.x.com/v1', apiKey: 'k1', model: 'm1' };
  assert.deepEqual(task.taskCfg({ ...base }), { ...base }); // sem task* → intacto
  const t = task.taskCfg({ ...base, taskModel: 'barato' });
  assert.equal(t.model, 'barato');
  assert.equal(t.baseUrl, base.baseUrl); // herda
  const t2 = task.taskCfg({ ...base, taskProvider: 'anthropic', taskModel: 'claude-x' });
  assert.equal(t2.provider, 'anthropic');
  assert.equal(t2.baseUrl, 'https://api.anthropic.com/v1'); // trocou de provedor sem URL → default oficial
});

// ---------- verificação (falhas estruturadas + filtro de teste) ----------
const ver = load(['extractFailures', 'tailStr', 'withTestFilter']);

test('extractFailures puxa tsc/jest/pytest/go da saída crua', () => {
  const out = [
    'src/a.ts(10,5): error TS2304: Cannot find name x',
    '  ✕ soma valores (5 ms)',
    'FAILED tests/test_x.py::test_soma - AssertionError',
    '--- FAIL: TestSoma (0.00s)',
    'tudo certo nesta linha',
  ].join('\n');
  const fails = ver.extractFailures(out);
  assert.ok(fails.some((f) => f.includes('src/a.ts:10')));
  assert.ok(fails.some((f) => f.includes('soma valores')));
  assert.ok(fails.some((f) => f.includes('test_x.py')));
  assert.ok(fails.some((f) => f.includes('TestSoma')));
});

test('tailStr mantém o FIM da saída', () => {
  assert.equal(ver.tailStr('abc', 10), 'abc');
  assert.ok(ver.tailStr('x'.repeat(100), 10).endsWith('x'.repeat(10)));
});

test('withTestFilter aplica o filtro do jeito de cada runner', () => {
  assert.equal(ver.withTestFilter('npm test', 'node', 'src/x.test.ts'), 'npm test -- src/x.test.ts');
  assert.equal(ver.withTestFilter('npm test', 'node', 'soma valores'), 'npm test -- -t "soma valores"');
  assert.equal(ver.withTestFilter('pytest -q', 'pytest', 'tests/test_x.py'), 'pytest -q tests/test_x.py');
  assert.equal(ver.withTestFilter('pytest -q', 'pytest', 'test_soma'), 'pytest -q -k "test_soma"');
  assert.equal(ver.withTestFilter('go test ./...', 'go', 'TestSoma'), 'go test ./... -run TestSoma');
});

test('guessTestCommand detecta o runner pelo lockfile/manifesto', () => {
  const mk = (files) =>
    load(['guessTestCommand'], {
      fs: {
        existsSync: (p) => Object.keys(files).some((f) => String(p).endsWith(f)),
        readFileSync: (p) => {
          const hit = Object.keys(files).find((f) => String(p).endsWith(f));
          if (hit == null) throw new Error('ENOENT');
          return files[hit];
        },
      },
    }).guessTestCommand('/ws');
  assert.deepEqual(mk({ 'package.json': '{"scripts":{"test":"vitest"}}' }), { cmd: 'npm test', runner: 'node' });
  assert.deepEqual(mk({ 'package.json': '{"scripts":{"test":"x"}}', 'pnpm-lock.yaml': '' }), { cmd: 'pnpm test', runner: 'node' });
  assert.deepEqual(mk({ 'pyproject.toml': '' }), { cmd: 'pytest -q', runner: 'pytest' });
  assert.deepEqual(mk({ 'go.mod': '' }), { cmd: 'go test ./...', runner: 'go' });
  assert.equal(mk({}), null);
});

// ---------- aliases de args ----------
const alias = load(['ARG_ALIASES', 'normalizeToolArgs']);

test('normalizeToolArgs preenche o nome canônico a partir do alias', () => {
  const toolDef = { schema: { parameters: { properties: { path: {}, content: {} } } } };
  const a = { file: 'x.js', text: 'olá' };
  alias.normalizeToolArgs(toolDef, a);
  assert.equal(a.path, 'x.js');
  assert.equal(a.content, 'olá');
  const b = { path: 'já-tem.js', file: 'ignorado.js' };
  alias.normalizeToolArgs(toolDef, b);
  assert.equal(b.path, 'já-tem.js'); // não sobrescreve o canônico presente
});

// ---------- diff (o coração do card de diff) ----------
const diff = load(['lineDiff']);

function applyDiff(d, want) {
  // reconstrução: (' ' e '+') = texto novo; (' ' e '-') = texto antigo — invariante forte
  return d.filter((l) => l.t === ' ' || l.t === want).map((l) => l.v).join('\n');
}

test('lineDiff reconstrói exatamente o antes e o depois', () => {
  const cases = [
    ['a\nb\nc', 'a\nX\nc'],
    ['a\nb\nc', 'X\nY\nZ'],
    ['a\nb\nc\nd', 'a\nb\nc\nd\ne\nf'],
    ['x\na\nb', 'a\nb'],
    ['', 'a\nb'],
    ['a\nb', ''],
    ['l1\nl2\nl3\nl4\nl5', 'l1\nNEW\nl3\nl5'],
    ['same\nsame2', 'same\nsame2'],
  ];
  for (const [oldS, newS] of cases) {
    const d = diff.lineDiff(oldS, newS);
    assert.equal(applyDiff(d, '+'), newS, 'novo diverge p/ ' + JSON.stringify([oldS, newS]));
    assert.equal(applyDiff(d, '-'), oldS, 'antigo diverge p/ ' + JSON.stringify([oldS, newS]));
  }
});

test('lineDiff é rápido em arquivo grande com edição pequena (poda)', () => {
  const big = Array.from({ length: 3000 }, (_, i) => 'linha ' + i).join('\n');
  const edited = big.replace('linha 1500', 'linha 1500 EDITADA');
  const t0 = Date.now();
  const d = diff.lineDiff(big, edited);
  const ms = Date.now() - t0;
  assert.equal(applyDiff(d, '+'), edited);
  assert.ok(ms < 300, 'poda deveria deixar isso <300ms, levou ' + ms + 'ms');
});

// ---------- estimador de tokens cacheado ----------
const tok = load(['estimateTokens', '_msgTokCache', '_msgSig', '_toolsTokCache', 'promptTokenEstimate']);

test('promptTokenEstimate cacheia e invalida quando o conteúdo muda de tamanho', () => {
  const msgs = [{ role: 'user', content: 'x'.repeat(1000) }];
  const t1 = tok.promptTokenEstimate(msgs, []);
  assert.ok(t1 > 100);
  assert.equal(tok.promptTokenEstimate(msgs, []), t1); // cache estável
  msgs[0].content = 'y'.repeat(2000); // compactação/edição muda o tamanho → assinatura invalida
  const t2 = tok.promptTokenEstimate(msgs, []);
  assert.ok(t2 > t1, 'estimativa deveria crescer após o conteúdo dobrar');
});

const providers = load(['isNvidiaIntegrate', 'isHuggingFaceRouter', 'modelIdsFromResponse'], { URL });
test('NVIDIA NIM é detectada pela origem exata e catálogo de modelos é deduplicado', () => {
  assert.equal(providers.isNvidiaIntegrate({ baseUrl: 'https://integrate.api.nvidia.com/v1' }), true);
  assert.equal(providers.isNvidiaIntegrate({ baseUrl: 'https://evil.example/?next=integrate.api.nvidia.com' }), false);
  assert.deepEqual(
    providers.modelIdsFromResponse({ data: [{ id: 'nvidia/b' }, { id: 'nvidia/a' }, { id: 'nvidia/b' }] }),
    ['nvidia/a', 'nvidia/b']
  );
});

test('Hugging Face Inference reconhece somente o router OpenAI-compatible oficial', () => {
  assert.equal(providers.isHuggingFaceRouter({ baseUrl: 'https://router.huggingface.co/v1' }), true);
  assert.equal(providers.isHuggingFaceRouter({ baseUrl: 'https://router.huggingface.co/v1/' }), true);
  assert.equal(providers.isHuggingFaceRouter({ baseUrl: 'https://router.huggingface.co/hf-inference' }), false);
  assert.equal(providers.isHuggingFaceRouter({ baseUrl: 'https://evil.example/?next=router.huggingface.co/v1' }), false);
});

// ---------- roteamento agentic (menos schemas, expansão sob demanda) ----------
const routing = load(['CORE_TOOLS', 'TOOLSETS', 'inferToolsets', 'selectedToolNames'], {
  agentsAvailable: () => false,
});
test('roteador carrega somente capacidades pertinentes e mantém o núcleo', () => {
  const codeSets = routing.inferToolsets('corrija o bug no backend e rode os testes', { architectMode: true });
  assert.ok(codeSets.has('code_read'));
  assert.ok(codeSets.has('code_write'));
  assert.ok(!codeSets.has('computer'));
  const names = routing.selectedToolNames(codeSets, false);
  assert.ok(names.has('read_file'));
  assert.ok(names.has('run_tests'));
  assert.ok(names.has('ask_user'));
  assert.ok(names.has('load_toolset'));
  assert.ok(!names.has('click'));
  assert.ok(!names.has('delegate_to_agent'));

  const reminderSets = routing.inferToolsets('me lembra daqui a 20 minutos', null);
  assert.ok(reminderSets.has('reminders'));
  assert.ok(routing.selectedToolNames(reminderSets, false).has('set_reminder'));
});

const capability = load(['isExplicitToolUnsupportedError', 'looksLikeVerificationCommand']);
test('fallback sem ferramentas ocorre só quando o provedor declara falta de suporte', () => {
  assert.equal(capability.isExplicitToolUnsupportedError(new Error('This model does not support tools')), true);
  assert.equal(capability.isExplicitToolUnsupportedError(new Error('HTTP 429: too many requests')), false);
  assert.equal(capability.isExplicitToolUnsupportedError(new Error("tool_calls[].function.arguments must be valid JSON")), false);
});

test('comandos de verificação são reconhecidos sem confundir comandos comuns', () => {
  assert.equal(capability.looksLikeVerificationCommand('npm test'), true);
  assert.equal(capability.looksLikeVerificationCommand('node --check src/main.js'), true);
  assert.equal(capability.looksLikeVerificationCommand('python -m pytest -q'), true);
  assert.equal(capability.looksLikeVerificationCommand('npm install'), false);
  assert.equal(capability.looksLikeVerificationCommand('git status'), false);
});

const externalTrace = load(['toolResultFailed', 'normalizeExternalToolTrace']);
test('diário normaliza ferramentas externas e reconhece falhas do Codex/Claude', () => {
  assert.deepEqual(externalTrace.normalizeExternalToolTrace('Bash', { command: 'npm test' }), {
    name: 'run_command',
    args: { command: 'npm test' },
  });
  assert.equal(externalTrace.normalizeExternalToolTrace('Read', { file_path: 'src/app.js' }).name, 'read_file');
  assert.equal(externalTrace.normalizeExternalToolTrace('Edit', { file_path: 'src/app.js' }).args.path, 'src/app.js');
  assert.equal(externalTrace.toolResultFailed({ status: 'failed', exitCode: 0 }), true);
  assert.equal(externalTrace.toolResultFailed({ status: 'completed', exitCode: 1 }), true);
  assert.equal(externalTrace.toolResultFailed({ status: 'completed', exitCode: 0 }), false);
});

const evidence = load(['changedCodeFiles', 'hasSuccessfulVerification']);
test('gate de conclusão exige evidência apenas quando código foi alterado', () => {
  const log = { filesChanged: new Set(['src/main.js', 'README.md']), verification: [] };
  assert.deepEqual(Array.from(evidence.changedCodeFiles(log)), ['src/main.js']);
  assert.equal(evidence.hasSuccessfulVerification(log), false);
  log.verification.push({ command: 'node --check src/main.js', ok: true });
  assert.equal(evidence.hasSuccessfulVerification(log), true);
});

test('ledger técnico preserva fatos de ferramentas sem incorporar narrativa do modelo', () => {
  const session = {
    stateSeq: 3,
    ledger: [],
    worklog: [],
    currentTurnLog: {
      at: '2026-07-11T12:00:00.000Z',
      goal: 'corrigir parser',
      filesRead: new Set(['src/parser.js']),
      filesChanged: new Set(['src/parser.js']),
      tools: [{ tool: 'run_tests', status: 'success', target: 'parser', summary: '4 testes passaram' }],
      verification: [{ command: 'npm test -- parser', ok: true, summary: 'passou' }],
    },
  };
  const ledger = load(['compactText', 'finishTurnLog', 'ledgerPrompt'], {
    S: () => session,
    contextLimits: () => ({ window: 128000 }),
  });
  ledger.finishTurnLog('afirmação livre potencialmente inventada', 'completed');
  assert.equal(session.ledger.length, 1);
  assert.equal(session.ledger[0].mutations, 3);
  assert.equal(session.ledger[0].verification[0].ok, true);
  assert.ok(!JSON.stringify(session.ledger).includes('potencialmente inventada'));
  assert.match(ledger.ledgerPrompt({ workspace: '/ws', memoryEnabled: true }), /npm test -- parser/);
});

const strategy = load(['toolStrategyKey', 'failureClass', 'strategyRecoveryAdvice']);
test('anti-loop agrupa falhas equivalentes por alvo e sugere outra estratégia', () => {
  const a = strategy.toolStrategyKey('edit_file', { path: 'SRC\\Main.js', old_text: 'a' });
  const b = strategy.toolStrategyKey('edit_file', { path: 'src/main.js', old_text: 'outro trecho' });
  assert.equal(a, b);
  assert.equal(strategy.failureClass('old_text NÃO encontrado no arquivo'), 'content-mismatch');
  assert.match(strategy.strategyRecoveryAdvice('content-mismatch'), /releia/i);
});

test('resultados grandes viram artefatos persistentes e recuperáveis durante a compactação', async (t) => {
  const session = { artifacts: new Map(), artifactSeq: 0 };
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-artifacts-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const artifacts = load(
    [
      'compactText', 'ARTIFACT_MIN_CHARS', 'ARTIFACT_MAX_ITEMS', 'ARTIFACT_MAX_CHARS',
      'ARTIFACT_DISK_MAX_CHARS', 'ARTIFACT_DISK_MAX_BYTES', 'ARTIFACT_DISK_MAX_ITEMS',
      'artifactWrites', 'artifactSweepAt', 'artifactsDir', 'artifactDiskPath', 'artifactHash',
      'rememberArtifact', 'sweepArtifactDisk', 'persistArtifact', 'loadPersistedArtifact',
      'attachToolArtifact', 'readToolArtifact', 'compactToolResultForContext',
    ],
    { S: () => session, fs, crypto: require('crypto'), app: { getPath: () => userData }, logd: () => {} }
  );
  const result = artifacts.attachToolArtifact('read_file', { content: 'abcdef'.repeat(2500) });
  assert.ok(result._artifact && result._artifact.id);
  assert.match(result._artifact.id, /^art_[a-f0-9]{24}$/);
  assert.equal(result._artifact.persisted, true);
  const compacted = artifacts.compactToolResultForContext(JSON.stringify(result), 160);
  assert.ok(compacted.length < 1000);
  assert.match(compacted, new RegExp(result._artifact.id));
  const page = artifacts.readToolArtifact(result._artifact.id, 10, 300);
  assert.equal(page.content.length, 300);
  assert.equal(page.id, result._artifact.id);
  await Promise.all([...artifacts.artifactWrites]);
  session.artifacts.clear();
  const restored = artifacts.readToolArtifact(result._artifact.id, 20, 240);
  assert.equal(restored.content.length, 240);
  const same = artifacts.attachToolArtifact('read_file', { content: 'abcdef'.repeat(2500) });
  assert.equal(same._artifact.id, result._artifact.id);
  assert.equal(artifacts.attachToolArtifact('read_artifact', { content: 'x'.repeat(13000) })._artifact, undefined);
});

const locks = load(['withKeyedLock']);
test('lock por workspace serializa mutações concorrentes sem bloquear chaves diferentes', async () => {
  const tails = new Map();
  const events = [];
  const first = locks.withKeyedLock(tails, 'ws-a', async () => {
    events.push('a1-start');
    await new Promise((resolve) => setTimeout(resolve, 15));
    events.push('a1-end');
  });
  const second = locks.withKeyedLock(tails, 'ws-a', async () => {
    events.push('a2-start');
    events.push('a2-end');
  });
  const other = locks.withKeyedLock(tails, 'ws-b', async () => events.push('b'));
  await Promise.all([first, second, other]);
  assert.ok(events.indexOf('a2-start') > events.indexOf('a1-end'));
  assert.ok(events.indexOf('b') < events.indexOf('a1-end'));
  assert.equal(tails.size, 0);
});

test('numeração de agentes e checkpoints não vazam entre conversas paralelas', () => {
  let active = { agentSeq: {} };
  const isolated = load(['nextAgentLabel', 'checkpointUndoBatch'], { S: () => active });
  assert.equal(isolated.nextAgentLabel('Programador'), 'Programador 1');
  active = { agentSeq: {} };
  assert.equal(isolated.nextAgentLabel('Programador'), 'Programador 1');

  const all = [
    { id: 'a1', sessionId: 'a' },
    { id: 'b1', sessionId: 'b' },
    { id: 'a2', sessionId: 'a' },
    { id: 'b2', sessionId: 'b' },
  ];
  const batch = isolated.checkpointUndoBatch(all, 'a1');
  assert.deepEqual(Array.from(batch.undo, (x) => x.id), ['a2', 'a1']);
  assert.deepEqual(Array.from(batch.remaining, (x) => x.id), ['b1', 'b2']);
});

const parallel = load(['READONLY_TOOLS', 'PARALLEL_READ_TOOLS', 'executeToolCallsOrdered']);
test('toolsets cobrem todo o registro e paralelismo contém apenas leituras', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const start = source.indexOf('const TOOLS = {');
  const end = source.indexOf('// Toolsets sob demanda', start);
  const actual = new Set([...source.slice(start, end).matchAll(/^  ([a-zA-Z0-9_]+): \{/gm)].map((m) => m[1]));
  const routed = new Set(Array.from(routing.CORE_TOOLS));
  for (const group of Object.values(routing.TOOLSETS)) for (const name of group) routed.add(name);
  assert.deepEqual([...routed].filter((name) => !actual.has(name)), []);
  assert.deepEqual([...actual].filter((name) => !routed.has(name)), []);
  assert.deepEqual([...parallel.PARALLEL_READ_TOOLS].filter((name) => !parallel.READONLY_TOOLS.has(name)), []);
});

test('leituras paralelizam em lotes, mas escrita preserva a barreira e a ordem', async () => {
  const events = [];
  const calls = [{ name: 'read_file', id: 1 }, { name: 'grep_files', id: 2 }, { name: 'edit_file', id: 3 }, { name: 'read_file', id: 4 }];
  const result = await parallel.executeToolCallsOrdered(
    calls,
    async (tc) => {
      events.push('start' + tc.id);
      await new Promise((resolve) => setTimeout(resolve, tc.id === 1 ? 12 : 2));
      events.push('end' + tc.id);
      return tc.id;
    },
    parallel.PARALLEL_READ_TOOLS,
    4
  );
  assert.deepEqual(Array.from(result), [1, 2, 3, 4]);
  assert.ok(events.indexOf('start2') < events.indexOf('end1'), 'as duas leituras deveriam se sobrepor');
  assert.ok(events.indexOf('start3') > events.indexOf('end1'));
  assert.ok(events.indexOf('start3') > events.indexOf('end2'));
  assert.ok(events.indexOf('start4') > events.indexOf('end3'));
});

// ---------- isolamento de subagentes escritores (Git worktrees) ----------
const worktrees = load(['WRITE_TOOLS', 'AGENT_WRITE_TOOLS', 'agentCanWrite', 'safeWorktreeRel', 'planAgentIntegration']);

test('somente subagentes com ferramentas de escrita pedem worktree', () => {
  assert.equal(worktrees.agentCanWrite({ tools: ['read_file', 'grep_files'] }), false);
  assert.equal(worktrees.agentCanWrite({ tools: ['read_file', 'edit_file'] }), true);
  assert.equal(worktrees.agentCanWrite({ tools: ['update_project_memory'] }), true);
});

test('caminhos de worktree rejeitam escape do repositório', () => {
  assert.equal(worktrees.safeWorktreeRel('src/main.js'), 'src/main.js');
  assert.equal(worktrees.safeWorktreeRel('src\\main.js'), 'src/main.js');
  assert.equal(worktrees.safeWorktreeRel('../fora.txt'), '');
  assert.equal(worktrees.safeWorktreeRel('src/../../fora.txt'), '');
  assert.equal(worktrees.safeWorktreeRel('src/..'), '');
});

test('integração de worktree aceita arquivos independentes e bloqueia sobreposição', () => {
  const clean = worktrees.planAgentIntegration(
    ['a.js', 'b.js'],
    { 'a.js': 'base-a', 'b.js': 'base-b' },
    { 'a.js': 'agent-a', 'b.js': 'base-b' },
    { 'a.js': 'base-a', 'b.js': 'outro-b' }
  );
  assert.deepEqual(clean.plan, [{ rel: 'a.js', agent: 'agent-a' }]);
  assert.deepEqual(clean.conflicts, []);

  const overlap = worktrees.planAgentIntegration(
    ['a.js'],
    { 'a.js': 'base' },
    { 'a.js': 'agente-2' },
    { 'a.js': 'agente-1' }
  );
  assert.deepEqual(overlap.plan, []);
  assert.deepEqual(overlap.conflicts, ['a.js']);
});

test('worktree real nasce do snapshot sujo e detecta somente a edição do agente', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-worktree-test-'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-worktree-base-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'a.txt'), 'commitado\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@local', 'commit', '-q', '-m', 'base'], { cwd: root });
  fs.writeFileSync(path.join(root, 'a.txt'), 'alteração local\n');
  fs.writeFileSync(path.join(root, 'segredo-local.txt'), 'não grave isto em objeto Git\n');

  const runtime = load(
    ['safeWorktreeRel', 'localGit', 'gitPathList', 'gitBlobFingerprint', 'copyIsolatedFile', 'linkWorktreeDependencies', 'createAgentWorktree', 'changedWorktreePaths'],
    {
      fs,
      process,
      execFileAsync: promisify(execFile),
      app: { getPath: () => temp },
      agentWorktreeSeq: 0,
      remoteMountForWorkspace: () => null,
      remoteMountForSession: () => null,
      S: () => ({}),
      discoverProjectDirs: () => [],
      sanitizeName: (s) => String(s).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 48),
    }
  );
  const ctx = await runtime.createAgentWorktree({ workspace: root }, 'Programador 1');
  t.after(() => {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', ctx.worktreeRoot], { cwd: root });
      execFileSync('git', ['worktree', 'prune'], { cwd: root });
    } catch (e) {}
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  assert.equal(fs.readFileSync(path.join(ctx.worktreeRoot, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'alteração local\n');
  assert.equal(fs.readFileSync(path.join(ctx.worktreeRoot, 'segredo-local.txt'), 'utf8'), 'não grave isto em objeto Git\n');
  assert.throws(() => execFileSync('git', ['cat-file', '-e', `${ctx.baseCommit}:segredo-local.txt`], { cwd: ctx.worktreeRoot, stdio: 'ignore' }));
  fs.writeFileSync(path.join(ctx.worktreeRoot, 'a.txt'), 'edição do agente\n');
  assert.deepEqual(await runtime.changedWorktreePaths(ctx), ['a.txt']);
});

const rateLimit = load(['normalizedRequestRps', 'retryAfterMs']);
test('limite de RPS preserva automático e aceita valores fracionários seguros', () => {
  assert.equal(rateLimit.normalizedRequestRps({ requestRps: 0 }), 0);
  assert.equal(rateLimit.normalizedRequestRps({ requestRps: '' }), 0);
  assert.equal(rateLimit.normalizedRequestRps({ requestRps: 0.5 }), 0.5);
  assert.equal(rateLimit.normalizedRequestRps({ requestRps: 999 }), 100);
});

test('Retry-After aceita segundos e data HTTP com teto defensivo', () => {
  const now = Date.parse('2026-07-04T12:00:00Z');
  assert.equal(rateLimit.retryAfterMs('1.5', now), 1500);
  assert.equal(rateLimit.retryAfterMs('Sat, 04 Jul 2026 12:00:03 GMT', now), 3000);
  assert.equal(rateLimit.retryAfterMs('inválido', now), 0);
  assert.equal(rateLimit.retryAfterMs('9999', now), 5 * 60000);
});

test('aiFetch repete um 429 apenas quando há RPS explícito', async () => {
  const calls = [];
  const fakeFetch = async () => {
    calls.push(Date.now());
    return calls.length === 1
      ? { status: 429, headers: { get: () => '0' }, body: { cancel: async () => {} } }
      : { status: 200, headers: { get: () => null }, body: null };
  };
  const limiter = load(
    [
      'aiRateQueues',
      'normalizedRequestRps',
      'retryAfterMs',
      'aiRateScope',
      'abortableDelay',
      'pruneAiRateQueues',
      'waitForAiRateSlot',
      'aiFetch',
    ],
    {
      crypto: require('crypto'),
      fetch: fakeFetch,
      logd: () => {},
      setTimeout,
      clearTimeout,
      Date,
      Map,
      Promise,
    }
  );
  const res = await limiter.aiFetch(
    { provider: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1', apiKey: 'teste', requestRps: 100 },
    'https://integrate.api.nvidia.com/v1/chat/completions',
    {}
  );
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);

  calls.length = 0;
  const noLimit = await limiter.aiFetch(
    { provider: 'openai', baseUrl: 'https://outro.example/v1', apiKey: 'teste', requestRps: 0 },
    'https://outro.example/v1/chat/completions',
    {}
  );
  assert.equal(noLimit.status, 429);
  assert.equal(calls.length, 1);
});

test('contexto preserva imagem somente no pedido atual', () => {
  const image = 'data:image/png;base64,QUJD';
  const session = {
    history: [
      { role: 'user', content: [{ type: 'text', text: 'antiga' }, { type: 'image_url', image_url: { url: image } }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: 'atual' }, { type: 'image_url', image_url: { url: image } }] },
    ],
    lastTurnContext: null,
  };
  const context = load(['cloneContextMessage', 'contextMessagesForTurn'], { S: () => session });
  const messages = context.contextMessagesForTurn();
  assert.equal(messages[0].content[1].type, 'text');
  assert.match(messages[0].content[1].text, /imagem do turno anterior/);
  assert.equal(messages[2].content[1].type, 'image_url');
  assert.equal(messages[2].content[1].image_url.url, image);
});

test('estimativa de tokens não conta base64 de imagem como texto', () => {
  const estimate = load(['estimateTokens']);
  const hugeImage = 'data:image/jpeg;base64,' + 'A'.repeat(200000);
  assert.ok(estimate.estimateTokens({ image_url: { url: hugeImage } }) < 100);
});

test('fila do Claude/GLM entrega steering e converte imagem em bloco multimodal', async () => {
  const sdk = load(['claudeSdkContent', 'claudeSdkUserMessage', 'createAsyncInputQueue'], { Symbol, Promise });
  const input = sdk.claudeSdkUserMessage(
    [
      { type: 'text', text: 'olha isso' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ],
    'sessao-1'
  );
  assert.equal(input.message.content[1].type, 'image');
  assert.equal(input.message.content[1].source.media_type, 'image/png');
  assert.equal(input.message.content[1].source.data, 'QUJD');

  const queue = sdk.createAsyncInputQueue(input);
  assert.equal((await queue.next()).value.message.content[0].text, 'olha isso');
  assert.equal(queue.push(sdk.claudeSdkUserMessage('mude o rumo', 'sessao-1')), true);
  assert.equal((await queue.next()).value.message.content, 'mude o rumo');
  assert.equal(queue.pushedCount, 2);
  queue.close();
  assert.equal((await queue.next()).done, true);
  assert.equal(queue.push(input), false);
});

test('resposta final é reaberta quando steering chega durante o stream', () => {
  const session = {
    steerQueue: [{ content: 'faça de outro jeito' }],
    pendingTurnTranscript: { historyTailCount: 1, messages: [] },
    editedSinceTurn: true,
  };
  const events = [];
  const steer = load(['cloneContextMessage', 'injectQueuedSteering', 'continueAfterQueuedSteering'], {
    S: () => session,
    broadcast: (...args) => events.push(args),
  });
  const messages = [];
  assert.equal(steer.continueAfterQueuedSteering({ text: 'resposta anterior', responseItems: [] }, messages), true);
  assert.deepEqual(
    messages.map((m) => m.role),
    ['assistant', 'user']
  );
  assert.equal(messages[1].content, 'faça de outro jeito');
  assert.equal(session.steerQueue.length, 0);
  assert.equal(session.pendingTurnTranscript.historyTailCount, 2);
  assert.equal(events[0][0], 'chat:newbubble');
});

test('detector encontra front/back, gerenciador herdado, venvs e .envs aninhados', () => {
  const detector = load(
    [
      'PROJECT_SCAN_SKIP',
      'PROJECT_MARKERS',
      'isProjectEnvFile',
      'isProjectMarker',
      'discoverProjectDirs',
      'scopedProjectCommand',
      'projectMetadata',
      'detectStackAt',
      'detectStack',
      'projectMapText',
      'parseEnv',
    ],
    { fs, path, process }
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-monorepo-'));
  try {
    fs.mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
    fs.mkdirSync(path.join(root, 'services', 'api', '.venv'), { recursive: true });
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    fs.writeFileSync(
      path.join(root, 'apps', 'web', 'package.json'),
      JSON.stringify({
        scripts: { dev: 'vite', test: 'vitest run' },
        dependencies: { react: '^19.0.0' },
        devDependencies: { typescript: '^5.0.0', vite: '^7.0.0' },
      })
    );
    fs.writeFileSync(path.join(root, 'apps', 'web', '.env.local'), 'VITE_API_URL=https://segredo.invalid\nVITE_MODE=dev\n');
    fs.writeFileSync(path.join(root, 'services', 'api', 'requirements.txt'), 'fastapi==1.0\nuvicorn==1.0\n');
    fs.writeFileSync(path.join(root, 'services', 'api', '.env'), 'DATABASE_URL=postgres://usuario:senha@host/db\n');
    fs.writeFileSync(path.join(root, 'config', '.env.production'), 'FEATURE_FLAG=true\n');

    const started = Date.now();
    const det = detector.detectStack(root);
    const byPath = new Map(det.projects.map((p) => [p.path, p]));
    assert.ok(Date.now() - started < 1000);
    assert.match(det.stack, /React/);
    assert.match(det.stack, /FastAPI/);
    assert.equal(byPath.get('apps/web').packageManager, 'pnpm');
    assert.deepEqual(byPath.get('apps/web').scripts, ['dev', 'test']);
    assert.match(byPath.get('apps/web').verify, /pnpm test/);
    assert.equal(byPath.get('services/api').hasVenv, true);
    assert.deepEqual(byPath.get('services/api').envFiles[0].keys, ['DATABASE_URL']);
    assert.deepEqual(byPath.get('config').envFiles[0].keys, ['FEATURE_FLAG']);
    assert.ok(!JSON.stringify(det).includes('postgres://usuario:senha'));
    assert.match(detector.projectMapText(det), /apps\/web/);
    assert.match(detector.projectMapText(det), /services\/api\/\.env: DATABASE_URL/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('caminho de .env aninhado fica preso ao workspace', () => {
  const envPath = load(['isProjectEnvFile', 'resolveEnvPath'], { path });
  const cfg = { workspace: path.resolve(os.tmpdir(), 'workspace-lumi') };
  assert.equal(envPath.resolveEnvPath(cfg, 'backend/.env'), path.resolve(cfg.workspace, 'backend/.env'));
  assert.equal(envPath.resolveEnvPath(cfg, '../.env'), null);
  assert.equal(envPath.resolveEnvPath(cfg, 'backend/config.json'), null);
});

// ---------- persistência assíncrona/coalescida do chat ----------
test('queueChatWrite serializa por chat e coalesce snapshots intermediários', async () => {
  const writes = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => (releaseFirst = resolve));
  const fakeFs = {
    promises: {
      writeFile: async (_file, json) => {
        writes.push(JSON.parse(json));
        if (writes.length === 1) await firstGate;
      },
    },
  };
  const persist = load(
    ['CHAT_CONFIG_KEYS', 'sanitizeChatConfig', 'chatWriteStates', 'chatMetaCache', 'rememberChatMeta', 'pendingChatData', 'queueChatWrite'],
    { fs: fakeFs, chatFile: (id) => id + '.json', logd: () => {} }
  );
  const done = persist.queueChatWrite('c1', { id: 'c1', title: 'primeiro', history: [1] });
  await new Promise((resolve) => setImmediate(resolve)); // deixa a primeira escrita começar
  persist.queueChatWrite('c1', { id: 'c1', title: 'intermediário', history: [1, 2] });
  persist.queueChatWrite('c1', { id: 'c1', title: 'final', history: [1, 2, 3] });
  assert.equal(persist.pendingChatData('c1').title, 'final');
  releaseFirst();
  await done;
  assert.deepEqual(
    writes.map((x) => x.title),
    ['primeiro', 'final']
  );
  assert.equal(persist.chatWriteStates.size, 0);
});

test('configuração por chat aceita só campos do motor e sobrepõe o padrão sem mutá-lo', () => {
  const chatCfg = load(['CHAT_CONFIG_KEYS', 'sanitizeChatConfig', 'applyChatConfig']);
  const global = { provider: 'openai', model: 'global', sounds: true, perms: { read: 'ask' } };
  const override = chatCfg.sanitizeChatConfig({
    provider: 'anthropic',
    model: 'claude-tab',
    apiKey: 'chave-da-aba',
    _preset: 'Claude',
    sounds: false,
    perms: { read: 'allow' },
    campoInventado: 'não',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(override)), {
    provider: 'anthropic',
    apiKey: 'chave-da-aba',
    model: 'claude-tab',
    _preset: 'Claude',
  });
  const effective = chatCfg.applyChatConfig(global, override);
  assert.equal(effective.provider, 'anthropic');
  assert.equal(effective.apiKey, 'chave-da-aba');
  assert.equal(effective.model, 'claude-tab');
  assert.equal(effective.sounds, true);
  assert.deepEqual(global, { provider: 'openai', model: 'global', sounds: true, perms: { read: 'ask' } });
  assert.deepEqual(JSON.parse(JSON.stringify(chatCfg.applyChatConfig(global, null))), global);
});

test('subagente herda a configuração efetiva da aba quando não possui modelo próprio', () => {
  const { subAgentConfig } = load(['subAgentConfig']);
  const chat = { provider: 'anthropic', baseUrl: 'https://chat.example/v1', apiKey: 'tab-key', model: 'modelo-da-aba', temperature: 0.8 };
  const inherited = subAgentConfig(chat, { name: 'Revisor', model: '' });
  assert.equal(inherited.provider, 'anthropic');
  assert.equal(inherited.apiKey, 'tab-key');
  assert.equal(inherited.model, 'modelo-da-aba');
  const explicit = subAgentConfig(chat, { name: 'Revisor', model: 'modelo-específico', temperature: 0.2 });
  assert.equal(explicit.model, 'modelo-específico');
  assert.equal(explicit.temperature, 0.2);
  assert.equal(chat.model, 'modelo-da-aba');
});

test('mutação do workspace notifica o Explorer com a raiz correta', () => {
  const calls = [];
  const { notifyWorkspaceMutation } = load(['notifyWorkspaceMutation'], { broadcast: (...args) => calls.push(args) });
  notifyWorkspaceMutation({ workspace: 'C:\\projeto' });
  assert.deepEqual(calls, [['workspace:changed', 'C:\\projeto']]);
});

test('mounts SSH ficam isolados por owner e o fallback global é explícito', () => {
  const winWorkspace = new Map([[404, path.resolve('C:\\local')]]);
  const ssh = load(
    ['remoteMounts', 'remoteOwnerKey', 'remoteMountForOwner', 'remoteMountForWorkspace', 'remoteMountForSession', 'posixShellQuote', 'remoteWorkingDirectory', 'remoteCwdArgument', 'remotePathForLocal', 'remoteExecutableName', 'remoteShellCommand', 'isRemoteWorkspace', 'serverCtx'],
    { winWorkspace, IS_LINUX: false, S: () => ({}) }
  );
  ssh.remoteMounts.set('global', { ownerId: null, host: 'global', workspace: path.resolve('Z:\\'), remotePath: '/srv/global' });
  ssh.remoteMounts.set('101', { ownerId: 101, host: 'janela-a', workspace: path.resolve('Y:\\'), remotePath: '/srv/app' });
  ssh.remoteMounts.set('202', { ownerId: 202, host: 'janela-b', workspace: path.resolve('X:\\') });

  assert.equal(ssh.remoteOwnerKey(null), 'global');
  assert.equal(ssh.remoteOwnerKey(101), '101');
  assert.equal(ssh.remoteMountForOwner(101, true).host, 'janela-a');
  assert.equal(ssh.remoteMountForOwner(202, false).host, 'janela-b');
  assert.equal(ssh.remoteMountForOwner(303, false), null);
  assert.equal(ssh.remoteMountForOwner(303, true).host, 'global');
  assert.equal(ssh.remoteMountForWorkspace(path.resolve('Y:\\')).host, 'janela-a');
  assert.equal(ssh.remoteMountForSession({ workspaceOwner: 101, workspace: path.resolve('Y:\\') }).host, 'janela-a');
  assert.equal(ssh.remoteWorkingDirectory(ssh.remoteMountForOwner(101, false), 'frontend'), '/srv/app/frontend');
  assert.equal(ssh.remoteCwdArgument(ssh.remoteMountForOwner(101, false), path.resolve('Y:\\frontend')), 'frontend');
  assert.equal(ssh.remotePathForLocal(ssh.remoteMountForOwner(101, false), path.resolve('Y:\\src\\main.js')), '/srv/app/src/main.js');
  assert.equal(ssh.remoteExecutableName('Y:\\node_modules\\.bin\\eslint.cmd'), './node_modules/.bin/eslint');
  assert.equal(ssh.remoteShellCommand(ssh.remoteMountForOwner(101, false), 'npm test', 'frontend'), "cd -- '/srv/app/frontend' && npm test");
  assert.equal(ssh.isRemoteWorkspace(path.resolve('Y:\\')), true);
  assert.equal(ssh.isRemoteWorkspace(path.resolve('W:\\')), false);
  assert.equal(ssh.serverCtx({ sender: { id: 101 } }).host, 'janela-a');
  assert.equal(ssh.serverCtx({ sender: { id: 404 } }).kind, 'none'); // janela local não herda remoto global
  assert.equal(ssh.serverCtx({ sender: { id: 505 } }).host, 'global'); // janela sem binding segue o slot global legado
});

test('executor de workspace envia comandos ao SSH em vez do shell local', async () => {
  const calls = [];
  const remote = { host: 'meu-vps', remotePath: '/srv/app' };
  const runner = load(['execWorkspaceCommand'], {
    S: () => ({}),
    remoteMountForSession: () => remote,
    remoteShellCommand: (_remote, command) => "cd -- '/srv/app' && " + command,
    remoteWorkingDirectory: () => '/srv/app',
    remoteCwdArgument: (_remote, cwd) => cwd,
    resolveExe: () => 'ssh',
    execFileAsync: async (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return { stdout: 'ok', stderr: '' };
    },
    execAsync: async () => {
      throw new Error('não deveria executar localmente');
    },
    resolvePath: () => 'local',
  });
  const result = await runner.execWorkspaceCommand('npm test', { timeout: 1234 });
  assert.equal(result.remote, 'meu-vps');
  assert.equal(calls[0].bin, 'ssh');
  assert.equal(calls[0].args.at(-2), 'meu-vps');
  assert.equal(calls[0].args.at(-1), "cd -- '/srv/app' && npm test");
});

const terminalScope = load(['terminalVisibleToSession']);
test('terminais ficam visíveis apenas para a sessão dona', () => {
  assert.equal(terminalScope.terminalVisibleToSession({ owner: 10 }, { workspaceOwner: 10 }), true);
  assert.equal(terminalScope.terminalVisibleToSession({ owner: 11 }, { workspaceOwner: 10 }), false);
  assert.equal(terminalScope.terminalVisibleToSession({ owner: null }, { workspaceOwner: null }), true);
});

test('arquivo ativo do editor é isolado por janela/workspace', () => {
  const editors = load(
    ['activeEditorFile', 'activeEditorFiles', 'activeEditorContext', 'activeEditorContexts', 'activeEditorForSession', 'activeEditorContextForSession'],
    { S: () => ({}) }
  );
  editors.activeEditorFiles.set(10, 'front/src/App.tsx');
  editors.activeEditorFiles.set(20, 'back/server.py');
  editors.activeEditorContexts.set(10, { path: 'front/src/App.tsx', line: 42, column: 7 });
  assert.equal(editors.activeEditorForSession({ workspaceOwner: 10 }), 'front/src/App.tsx');
  assert.equal(editors.activeEditorForSession({ workspaceOwner: 20 }), 'back/server.py');
  assert.equal(editors.activeEditorForSession({ workspaceOwner: 30 }), null);
  assert.equal(editors.activeEditorContextForSession({ workspaceOwner: 10 }).line, 42);
});

test('contexto automático do editor envia o símbolo focado, não o arquivo inteiro', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-focused-context-'));
  try {
    const lines = ['const distante = true;', '', 'function alvo(valor) {', '  const dobro = valor * 2;', '  return dobro;', '}', '', 'x'.repeat(20000)];
    fs.writeFileSync(path.join(ws, 'app.js'), lines.join('\n'));
    const focused = load(
      ['DEF_PATTERNS', 'CTRL_KW', 'defNameAt', 'enclosingSymbol', 'blockAround', 'decodeTextBuffer', 'safeWsPath', 'focusedEditorBlock'],
      { fs, Buffer, TextDecoder }
    );
    const block = focused.focusedEditorBlock({ workspace: ws }, { path: 'app.js', line: 4, column: 9 });
    assert.match(block, /Símbolo ativo: alvo/);
    assert.match(block, /const dobro/);
    assert.ok(block.length < 15000);
    assert.ok(!block.includes('x'.repeat(1000)));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------- parsers de diagnóstico ----------
const parse = load(['_relTo', 'parseTsc', 'parseColonList', 'parseEslintJson'], { remoteMountForSession: () => null, S: () => ({}) });

test('parseTsc extrai arquivo/linha/mensagem', () => {
  const out = 'src/x.ts(12,3): error TS2304: Cannot find name foo\noutra linha';
  const p = parse.parseTsc('/ws', out);
  assert.equal(p.length, 1);
  assert.equal(p[0].line, 12);
  assert.equal(p[0].severity, 'error');
  assert.ok(p[0].message.includes('Cannot find name'));
});

test('parseEslintJson estrutura os problemas', () => {
  const j = JSON.stringify([{ filePath: '/ws/a.js', messages: [{ line: 3, column: 1, severity: 2, message: 'boom', ruleId: 'no-undef' }] }]);
  const p = parse.parseEslintJson('/ws', j);
  assert.equal(p.length, 1);
  assert.equal(p[0].severity, 'error');
  assert.ok(p[0].message.includes('no-undef'));
});

test('parseColonList entende file:line:col: msg', () => {
  const p = parse.parseColonList('/ws', 'pkg/a.go:10:2: undefined: foo', 'go vet');
  assert.equal(p.length, 1);
  assert.equal(p[0].line, 10);
  assert.equal(p[0].source, 'go vet');
});

// ---------- diagnósticos do sistema ----------
const sysdiag = load(['sanitizeProcessCommand', 'processLauncher', 'systemEntryMatchesWorkspace', 'isNoisySystemEvent']);

test('sanitizeProcessCommand não deixa segredo de launcher/comando vazar', () => {
  const clean = sysdiag.sanitizeProcessCommand(
    'game.exe --token abc123 --password="segredo" API_KEY=chave456 Authorization Bearer xyz.123 https://user:senha@host/api'
  );
  assert.ok(!clean.includes('abc123'));
  assert.ok(!clean.includes('segredo'));
  assert.ok(!clean.includes('chave456'));
  assert.ok(!clean.includes(':senha@'));
  assert.ok(!clean.includes('xyz.123'));
  assert.ok(clean.includes('[oculto]'));
});

test('processLauncher reconhece launchers comuns', () => {
  assert.equal(sysdiag.processLauncher({ cmd: '"C:\\Program Files (x86)\\Steam\\steam.exe" -applaunch 730' }), 'Steam');
  assert.equal(sysdiag.processLauncher({ parentCmd: 'EpicGamesLauncher.exe com.epicgames.launcher://apps/foo' }), 'Epic Games');
  assert.equal(sysdiag.processLauncher({ exe: 'C:\\XboxGames\\Game\\game.exe', parent: 'GamingServices' }), 'Xbox/Microsoft Store');
});

test('systemEntryMatchesWorkspace cruza caminho, cwd e mensagem sem falso positivo parcial', () => {
  const ws = 'C:\\dev\\minha-api';
  assert.equal(sysdiag.systemEntryMatchesWorkspace({ launch: 'node C:\\dev\\minha-api\\server.js' }, ws), true);
  assert.equal(sysdiag.systemEntryMatchesWorkspace({ cwd: 'C:/dev/minha-api' }, ws), true);
  assert.equal(sysdiag.systemEntryMatchesWorkspace({ message: 'falha em minha-api' }, ws), true);
  assert.equal(sysdiag.systemEntryMatchesWorkspace({ message: 'falha em minha-api-antiga' }, ws), false);
});

test('isNoisySystemEvent filtra DCOM 10016, mas preserva crash real', () => {
  assert.equal(sysdiag.isNoisySystemEvent({ source: 'Microsoft-Windows-DistributedCOM', id: 10016 }), true);
  assert.equal(sysdiag.isNoisySystemEvent({ source: 'Application Hang', id: 1002 }), false);
});

test('readSystemLogs correlaciona evento do Windows com processo e launcher lembrados', async () => {
  const fakeEvent = {
    time: '2026-07-02T20:47:06',
    source: 'Application Hang',
    processId: 321,
    Id: 1002,
    LevelDisplayName: 'Erro',
    Message: 'O programa game.exe deixou de interagir com o Windows.',
  };
  const diag = load(
    ['procSnapshot', 'procByPid', 'sanitizeProcessCommand', 'processLauncher', 'procRemember', 'procInfoOf', 'recentActiveApps', 'readSystemLogs'],
    {
      process: { platform: 'win32' },
      execAsync: async () => ({ stdout: JSON.stringify(fakeEvent) }),
    }
  );
  diag.procRemember('game.exe', {
    cmd: '"C:\\Program Files (x86)\\Steam\\steamapps\\common\\Game\\game.exe" -windowed',
    pid: 321,
    parent: 'steam.exe',
    parentCmd: '"C:\\Program Files (x86)\\Steam\\steam.exe" -silent',
    exe: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Game\\game.exe',
  });
  const result = await diag.readSystemLogs(60, 'error');
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].launcher, 'Steam');
  assert.equal(result.entries[0].processId, 321);
  assert.ok(result.entries[0].launch.includes('game.exe'));
  assert.equal(result.entries[0].parent, 'steam.exe');
});

// ---------- biblioteca integrada de DESIGN.md ----------
const designLibrary = require('../src/modules/design-library');

test('catálogo visual possui presets autorais válidos e ids únicos', () => {
  assert.ok(designLibrary.catalog.length >= 26);
  assert.deepEqual(designLibrary.validateCatalog(), []);
  const ids = designLibrary.catalog.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(designLibrary.listPresets({ mode: 'dark' }).length >= 13);
  assert.ok(designLibrary.listPresets({ query: 'documentação' }).some((preset) => preset.id === 'schematic-indigo'));
});

test('DESIGN.md é reconhecido por preset e só ganha contexto completo em tarefas visuais', (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-design-context-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, 'DESIGN.md'), designLibrary.generateDesignMarkdown('olive-luxe'));
  const context = load(['readDesignRules', 'uiTaskRelevant', 'designStatusFor'], {
    fs,
    path,
    designLibrary,
    readTextFileSmart: (fp) => ({ text: fs.readFileSync(fp, 'utf8') }),
    compactText: (value, max) => String(value || '').replace(/\s+/g, ' ').slice(0, max),
  });
  assert.match(context.readDesignRules(ws), /Olive Luxe/);
  assert.equal(context.designStatusFor({ workspace: ws }).preset, 'olive-luxe');
  assert.equal(context.designStatusFor({ workspace: ws }).known, true);
  assert.equal(context.uiTaskRelevant('corrija a autenticação da API', 'server.js'), false);
  assert.equal(context.uiTaskRelevant('crie um dashboard responsivo', 'server.js'), true);
  assert.equal(context.uiTaskRelevant('ajuste isso', 'src/app.css'), true);
});

test('workspace expõe a galeria sem transformar o módulo em dependência do renderer bundle', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
  const workspace = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'pages', 'workspace.html'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'pages', 'designs.html'), 'utf8');
  assert.match(preload, /designInstall:/);
  assert.match(workspace, /id="designBtn"/);
  assert.match(workspace, /id="designOverlay"/);
  assert.match(page, /window\.api\.designList/);
  assert.match(page, /window\.api\.designInstall/);
  assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'main.js'), 'utf8').includes('design-library'));
});

test('cada preset gera DESIGN.md completo e preview SVG autocontido', () => {
  for (const preset of designLibrary.catalog) {
    const markdown = designLibrary.generateDesignMarkdown(preset.id, { projectName: 'Projeto teste' });
    assert.match(markdown, new RegExp(`lumi_design_preset: ${preset.id}`));
    assert.match(markdown, /## 2\. Tokens de cor/);
    assert.match(markdown, /## 10\. Contrato para agentes de código/);
    assert.ok(!markdown.includes('undefined'));
    const svg = designLibrary.renderPreviewSvg(preset.id);
    assert.match(svg, /^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, new RegExp(`Preview do preset ${preset.name}`));
    assert.match(svg, new RegExp(`data-lumi-design="${preset.id}"`));
    assert.match(svg, new RegExp(`aria-labelledby="lumi-design-${preset.id}-title lumi-design-${preset.id}-desc"`));
    assert.match(svg, new RegExp(`svg\\[data-lumi-design="${preset.id}"\\] \\.lumi-ds-hero`));
    assert.ok(!/class="(?:hero|body|label|metric|button)(?:\s|")/.test(svg), `${preset.id} não deve vazar classes genéricas no documento`);
    assert.ok(svg.length > 1500, `${preset.id} deveria produzir um preview substancial`);
  }
});

test('galeria de desenvolvimento é offline, filtrável e contém todos os presets', () => {
  const html = designLibrary.renderGalleryHtml();
  assert.match(html, /Lumi Design Atlas/);
  assert.match(html, /class="search"/);
  assert.match(html, /data-download="signal-noir"/);
  assert.equal((html.match(/class="design-card"/g) || []).length, designLibrary.catalog.length);
  assert.ok(!/<script[^>]+src=|<link[^>]+href=|fetch\s*\(/i.test(html));
});

test('instalação do preset protege DESIGN.md existente e cria backup ao sobrescrever', (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-design-library-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const target = path.join(ws, 'DESIGN.md');
  fs.writeFileSync(target, '# Regras do usuário\n');
  const conflict = designLibrary.installDesignPreset(ws, 'signal-noir');
  assert.equal(conflict.conflict, true);
  assert.equal(fs.readFileSync(target, 'utf8'), '# Regras do usuário\n');
  const installed = designLibrary.installDesignPreset(ws, 'signal-noir', { overwrite: true, projectName: 'Nebula' });
  assert.equal(installed.ok, true);
  assert.ok(installed.backup && fs.existsSync(installed.backup));
  assert.equal(fs.readFileSync(installed.backup, 'utf8'), '# Regras do usuário\n');
  assert.match(fs.readFileSync(target, 'utf8'), /Projeto: \*\*Nebula\*\*/);
});
