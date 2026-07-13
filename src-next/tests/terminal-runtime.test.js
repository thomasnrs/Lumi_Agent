'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CommandRunner } = require('../main/domains/terminal/command-runner');
const { TerminalRegistry, stripAnsi } = require('../main/domains/terminal/terminal-registry');
const { WorkspaceCommandRouter, remoteWorkingDirectory } = require('../main/domains/remote/workspace-command-router');
const { SshCommandExecutor, posixShellQuote } = require('../main/adapters/process/ssh-command-executor');
const { NodeProcessPort, appendCapped } = require('../main/adapters/process/node-process-port');
const { NodeTerminalPort } = require('../main/adapters/process/node-terminal-port');
const { registerTerminalTools } = require('../main/domains/terminal/terminal-tools');
const { ToolRegistry } = require('../main/domains/tools/tool-registry');
const { EventEmitter } = require('node:events');

class Clock {
  constructor() { this.time = 100; this.timers = new Map(); this.next = 0; }
  now() { return this.time; }
  setTimeout(fn) { const id = ++this.next; this.timers.set(id, fn); return id; }
  clearTimeout(id) { this.timers.delete(id); }
  tick() { const current = [...this.timers.values()]; this.timers.clear(); current.forEach((fn) => fn()); }
}
class FakeHandle {
  constructor() { this.pid = 42; this.pty = true; this.writes = []; this.data = []; this.exits = []; this.killed = 0; }
  write(value) { this.writes.push(value); }
  kill() { this.killed++; }
  resize(cols, rows) { this.size = [cols, rows]; }
  onData(fn) { this.data.push(fn); }
  onExit(fn) { this.exits.push(fn); }
  onError() {}
  emit(value) { this.data.forEach((fn) => fn(value)); }
  exit(code) { this.exits.forEach((fn) => fn(code)); }
}

test('CommandRunner normaliza limites e preserva resultado de exit code', async () => {
  const seen = [];
  const runner = new CommandRunner({ clock: { now: () => 10 }, processPort: { execute: async (request) => { seen.push(request); return { stdout: 'oi', stderr: 'erro', exitCode: 2, outputLimited: true }; } } });
  const result = await runner.run({ command: 'bad', timeoutMs: 5, maxOutputBytes: 99 });
  assert.equal(result.ok, false); assert.equal(result.exitCode, 2); assert.equal(result.outputLimited, true);
  assert.equal(seen[0].timeoutMs, 1000); assert.equal(seen[0].maxOutputBytes, 1024);
  const failedStart = new CommandRunner({ processPort: { execute: async () => ({ error: 'ENOENT', exitCode: null }) } });
  assert.equal((await failedStart.run({ command: 'missing' })).ok, false);
  const cappedOnly = new CommandRunner({ processPort: { execute: async () => ({ exitCode: 0, outputLimited: true }) } });
  assert.equal((await cappedOnly.run({ command: 'verbose' })).ok, false);
});

test('registry isola owner, agrupa saída e descarrega antes de exit', async () => {
  const clock = new Clock(), events = [], handle = new FakeHandle();
  const registry = new TerminalRegistry({ clock, nextId: () => 't1', terminalPort: { open: async () => handle }, onEvent: (event) => events.push(event) });
  const terminal = await registry.open({ title: 'bash', owner: 'janela-a', command: 'pwd' });
  assert.equal(terminal.id, 't1'); assert.deepEqual(handle.writes, ['pwd\r']);
  assert.deepEqual(registry.list('janela-b'), []);
  handle.emit('\u001b[31mok\u001b[0m\r\n'); handle.emit('mais'); clock.tick();
  assert.equal(events.filter((event) => event.type === 'terminal.data').length, 1);
  assert.equal(registry.read('t1', 'janela-a', 100).output, 'ok\nmais');
  assert.match(registry.read('t1', 'janela-b', 10).error, /sem acesso/);
  handle.emit('fim'); handle.exit(0);
  const types = events.map((event) => event.type);
  assert.deepEqual(types, ['terminal.opened', 'terminal.data', 'terminal.data', 'terminal.exit']);
  assert.equal(registry.list('janela-a').length, 0);
});

test('stripAnsi remove sequências de terminal sem remover texto', () => {
  assert.equal(stripAnsi('\u001b[1mOlá\u001b[0m\r\n'), 'Olá\n');
});

test('roteador envia comandos à origem certa e não aceita cwd fora do mount', async () => {
  const local = { run: async (request) => ({ ok: true, source: 'local', cwd: request.cwd }) };
  const calls = [], remote = { execute: async (request) => { calls.push(request); return { ok: true, source: 'remote' }; } };
  const router = new WorkspaceCommandRouter({ localRunner: local, remoteExecutor: remote, resolveRemote: () => ({ host: 'dev', workspace: 'C:\\mount\\repo', remotePath: '/srv/repo' }) });
  assert.equal((await router.run({ command: 'pwd', cwd: 'C:\\mount\\repo\\apps\\web' })).source, 'remote');
  assert.equal(calls[0].cwd, '/srv/repo/apps/web');
  const escaped = await router.run({ command: 'pwd', cwd: 'C:\\elsewhere' });
  assert.equal(escaped.ok, false); assert.match(escaped.error, /fora da workspace/);
  assert.equal((await router.run({ command: 'hostname', cwd: 'C:\\elsewhere', local: true })).source, 'local');
  assert.equal(remoteWorkingDirectory({ workspace: '/mnt/repo', remotePath: '/srv/repo' }, '/mnt/repo'), '/srv/repo');
});

test('executor SSH usa argumentos sem shell local e faz quoting POSIX', async () => {
  const calls = [], runner = { run: async (request) => { calls.push(request); return { ok: true, stdout: 'ok' }; } };
  const ssh = new SshCommandExecutor({ commandRunner: runner, sshBinary: 'ssh.exe' });
  await ssh.execute({ host: 'alias', cwd: "/srv/it's", command: 'npm test', timeoutMs: 5000 });
  assert.equal(calls[0].file, 'ssh.exe'); assert.equal(calls[0].shell, false);
  assert.equal(calls[0].args.at(-1), "cd -- '/srv/it'\\''s' && npm test");
  assert.equal(posixShellQuote("a'b"), "'a'\\''b'");
});

test('process port executa arquivo sem shell e limita saída por bytes', async () => {
  const port = new NodeProcessPort();
  const result = await port.execute({ file: process.execPath, args: ['-e', "process.stdout.write('ok')"], shell: false, timeoutMs: 2000, maxOutputBytes: 1024 });
  assert.equal(result.exitCode, 0); assert.equal(result.stdout, 'ok');
  const capped = appendCapped('á', 'á', 3);
  assert.equal(capped.value, 'á'); assert.equal(capped.limited, true);
});

test('terminal port PIPE adapta streams ao contrato de terminal', () => {
  const child = new EventEmitter(); child.pid = 7; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { write: (value) => { child.input = value; } }; child.kill = () => { child.killed = true; };
  const port = new NodeTerminalPort({ platform: 'linux', spawn: () => child, env: {} });
  const handle = port.open({ shell: 'bash', args: [] }), received = [];
  handle.onData((data) => received.push(data)); handle.write('echo x\n'); child.stdout.emit('data', 'a\n'); handle.kill();
  assert.equal(handle.pty, false); assert.equal(child.input, 'echo x\n'); assert.deepEqual(received, ['a\r\n']); assert.equal(child.killed, true);
});

test('factory registra ferramentas de terminal com owner contextual', async () => {
  const registry = new ToolRegistry(), writes = [];
  const terminals = { write: (id, data, owner) => (writes.push({ id, data, owner }), { ok: true }), open: async () => ({ id: 't2', pid: 2, pty: true, remoteHost: 'dev' }), read: (id, owner) => ({ id, owner, output: 'x' }), list: (owner) => [{ id: 't2', owner }], kill: (id, owner) => ({ ok: true, id, owner }) };
  const commandRouter = { run: async (request) => ({ ok: true, command: request.command, remote: request.context.remote }) };
  registerTerminalTools(registry, { terminals, commandRouter, ownerFromContext: (context) => context.owner, createTerminalRequest: (args, context) => ({ ...args, owner: context.owner }) });
  const context = { owner: 'w1', remote: 'dev' };
  assert.equal((await registry.get('run_command').run({ command: 'pwd' }, context)).remote, 'dev');
  const reused = await registry.get('run_in_terminal').run({ command: 'npm run dev', terminalId: 't1' }, context);
  assert.equal(reused.reused, true); assert.deepEqual(writes[0], { id: 't1', data: 'npm run dev\n', owner: 'w1' });
  assert.deepEqual(registry.get('list_terminals').run({}, context), { terminals: [{ id: 't2', owner: 'w1' }] });
});
