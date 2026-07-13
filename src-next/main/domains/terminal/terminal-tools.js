'use strict';

function schema(name, description, properties, required) {
  return { name, description, parameters: { type: 'object', properties: properties || {}, ...(required && required.length ? { required } : {}) } };
}
function ownerFrom(context) { return context && context.workspaceOwner != null ? context.workspaceOwner : null; }

/** Registra somente os contratos de terminal; permissão/lock continuam no ToolExecutor. */
function registerTerminalTools(registry, services) {
  const deps = services || {};
  if (!registry || typeof registry.register !== 'function') throw new Error('registerTerminalTools exige registry');
  if (!deps.commandRouter || typeof deps.commandRouter.run !== 'function') throw new Error('registerTerminalTools exige commandRouter');
  if (!deps.terminals) throw new Error('registerTerminalTools exige terminals');
  const resolveOwner = deps.ownerFromContext || ownerFrom;
  const terminalRequest = deps.createTerminalRequest || ((args, context) => ({ ...args, owner: resolveOwner(context) }));
  registry.register('run_command', {
    category: 'exec', exclusive: true, readonly: false,
    summary: (args) => `executar o comando: ${String(args && args.command || '').slice(0, 180)}`,
    schema: schema('run_command', 'Executa um comando curto e retorna saída. Em contexto SSH, o roteador executa no servidor remoto; local=true força o PC local.', { command: { type: 'string' }, cwd: { type: 'string' }, local: { type: 'boolean' } }, ['command']),
    run: (args, context) => deps.commandRouter.run({ ...args, context }),
  });
  registry.register('run_in_terminal', {
    category: 'exec', exclusive: true, readonly: false,
    summary: (args) => `rodar no terminal: ${String(args && args.command || '').slice(0, 180)}`,
    schema: schema('run_in_terminal', 'Roda processo longo em terminal integrado. O adaptador pode abrir SSH no contexto remoto.', { command: { type: 'string' }, cwd: { type: 'string' }, terminalId: { type: 'string' }, local: { type: 'boolean' } }, ['command']),
    run: async (args, context) => {
      const owner = resolveOwner(context);
      if (args && args.terminalId) {
        const sent = deps.terminals.write(args.terminalId, String(args.command || '') + '\n', owner);
        if (!sent.error) return { ...sent, terminalId: String(args.terminalId), reused: true };
      }
      const terminal = await deps.terminals.open(terminalRequest(args || {}, context));
      return { ok: true, terminalId: terminal.id, pid: terminal.pid, pty: terminal.pty, remoteHost: terminal.remoteHost || undefined };
    },
  });
  registry.register('read_terminal', {
    category: null, readonly: true,
    summary: (args) => `ler o terminal ${args && args.terminalId || ''}`,
    schema: schema('read_terminal', 'Lê a saída recente de um terminal integrado.', { terminalId: { type: 'string' }, chars: { type: 'number' } }, ['terminalId']),
    run: (args, context) => deps.terminals.read(args.terminalId, resolveOwner(context), args.chars),
  });
  registry.register('list_terminals', {
    category: null, readonly: true, summary: () => 'listar terminais abertos', schema: schema('list_terminals', 'Lista os terminais visíveis para esta sessão.', {}, []),
    run: (_args, context) => ({ terminals: deps.terminals.list(resolveOwner(context)) }),
  });
  registry.register('kill_terminal', {
    category: 'exec', exclusive: true, readonly: false, summary: (args) => `fechar o terminal ${args && args.terminalId || ''}`,
    schema: schema('kill_terminal', 'Encerra um terminal integrado.', { terminalId: { type: 'string' } }, ['terminalId']),
    run: (args, context) => deps.terminals.kill(args.terminalId, resolveOwner(context)),
  });
  return registry;
}

module.exports = { registerTerminalTools, ownerFrom };
