// Testes dos helpers PUROS do harness (extraídos do main.js real — ver _extract.js).
// Rodar: npm test  (node --test tests/)
const { test } = require('node:test');
const assert = require('node:assert');
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

const providers = load(['isNvidiaIntegrate', 'modelIdsFromResponse'], { URL });
test('NVIDIA NIM é detectada pela origem exata e catálogo de modelos é deduplicado', () => {
  assert.equal(providers.isNvidiaIntegrate({ baseUrl: 'https://integrate.api.nvidia.com/v1' }), true);
  assert.equal(providers.isNvidiaIntegrate({ baseUrl: 'https://evil.example/?next=integrate.api.nvidia.com' }), false);
  assert.deepEqual(
    providers.modelIdsFromResponse({ data: [{ id: 'nvidia/b' }, { id: 'nvidia/a' }, { id: 'nvidia/b' }] }),
    ['nvidia/a', 'nvidia/b']
  );
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
    ['chatWriteStates', 'chatMetaCache', 'rememberChatMeta', 'pendingChatData', 'queueChatWrite'],
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

// ---------- parsers de diagnóstico ----------
const parse = load(['_relTo', 'parseTsc', 'parseColonList', 'parseEslintJson']);

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
