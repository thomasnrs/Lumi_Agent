'use strict';

const { normalizeToolArgs } = require('./tool-registry');
const { ToolGuard } = require('./tool-guard');

function strategyKey(name, args) {
  const value = args || {};
  if (['edit_file', 'write_file', 'append_file', 'delete_file', 'read_file'].includes(name)) return `${name}|path:${String(value.path || '').replace(/\\/g, '/').toLowerCase()}`;
  if (name === 'apply_patch') return `${name}|files:${[...String(value.patch || '').matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1].trim().toLowerCase()).sort().join(',')}`;
  if (name === 'grep_files') return `${name}|path:${String(value.path || '.').toLowerCase()}|pattern:${String(value.pattern || '').toLowerCase().replace(/\W+/g, ' ').trim()}`;
  if (name === 'find_in_code') return `${name}|query:${String(value.query || '').toLowerCase().replace(/\W+/g, ' ').trim()}`;
  if (name === 'run_tests') return `${name}|cwd:${String(value.cwd || '.').toLowerCase()}|filter:${String(value.filter || '').toLowerCase()}`;
  return '';
}

function distance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]; previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j], cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + cost); diagonal = above;
    }
  }
  return previous[b.length];
}
function closestNames(name, candidates, limit) {
  const query = String(name || '').toLowerCase().slice(0, 48);
  return candidates.map((candidate) => ({ candidate, score: distance(query, String(candidate).toLowerCase().slice(0, 48)) / Math.max(query.length, String(candidate).length, 1) }))
    .filter((item) => item.score <= .6).sort((a, b) => a.score - b.score).slice(0, limit || 3).map((item) => item.candidate);
}

class ToolExecutor {
  constructor(options) {
    const opts = options || {};
    if (!opts.registry) throw new Error('ToolExecutor exige registry');
    this.registry = opts.registry;
    this.authorize = opts.authorize || (async () => true);
    this.lock = opts.lock || (async (_key, operation) => operation());
    this.guard = opts.guard || new ToolGuard();
    this.beforeRun = opts.beforeRun || (async () => {});
    this.afterRun = opts.afterRun || (async () => {});
    this.onEvent = opts.onEvent || (() => {});
  }

  resetTurn() { this.guard.reset(); }

  async execute(name, input, context) {
    const guard = context && context.toolGuard || this.guard;
    const definition = this.registry.get(name);
    if (!definition) {
      const suggestions = closestNames(name, this.registry.names());
      return { error: `ferramenta desconhecida: "${name}".${suggestions.length ? ` Você quis dizer: ${suggestions.join(' | ')}?` : ''}` };
    }
    const args = normalizeToolArgs(definition, input);
    const strategy = strategyKey(name, args);
    const blocked = guard.before(name, args, strategy);
    if (blocked) { this.onEvent({ type: 'tool.blocked', name, args, result: blocked, context }); return blocked; }
    const allowed = await this.authorize(definition.category || null, definition.summary ? definition.summary(args) : '', context);
    if (!allowed) {
      const denied = { error: `permissão negada pelo usuário (${definition.category || 'tool'})`, denied: true };
      guard.after(name, args, denied, { readonly: !!definition.readonly, strategyKey: strategy });
      this.onEvent({ type: 'tool.denied', name, args, result: denied, context });
      return denied;
    }
    this.onEvent({ type: 'tool.start', name, args, context });
    let result;
    try {
      const operation = async () => {
        await this.beforeRun({ name, args, definition, context });
        return definition.run(args, context);
      };
      result = await (definition.exclusive ? this.lock(context && context.workspace || 'global', operation) : operation());
      if (result == null) result = { ok: true };
    } catch (error) { result = { error: String(error && error.message || error) }; }
    const guardResult = guard.after(name, args, result, { readonly: !!definition.readonly, strategyKey: strategy });
    if (guardResult.repeatedRead && result && typeof result === 'object') result = { ...result, _nota: 'esta leitura idêntica já foi feita e nada mudou; não repita.' };
    await this.afterRun({ name, args, definition, result, context, guard: guardResult });
    this.onEvent({ type: 'tool.done', name, args, result, context });
    return result;
  }
}

const DEFAULT_PARALLEL_READS = new Set(['read_file', 'list_dir', 'grep_files', 'find_in_code', 'git_status', 'git_diff', 'git_log', 'get_problems', 'locate_stack', 'read_project_memory', 'read_terminal', 'list_terminals', 'project_overview', 'outline', 'find_usages', 'env_info', 'list_ssh_hosts', 'recall_facts', 'list_reminders', 'list_scheduled_tasks', 'get_datetime', 'read_artifact']);

async function executeToolCallsOrdered(calls, execute, options) {
  const opts = options || {}, safe = opts.parallelNames || DEFAULT_PARALLEL_READS;
  const concurrency = Math.max(1, Math.min(Number(opts.concurrency) || 4, 8));
  const output = [];
  let reads = [];
  const flush = async () => {
    for (let index = 0; index < reads.length; index += concurrency) output.push(...await Promise.all(reads.slice(index, index + concurrency).map(execute)));
    reads = [];
  };
  for (const call of calls || []) {
    if (safe.has(call.name)) reads.push(call);
    else { await flush(); output.push(await execute(call)); }
  }
  await flush();
  return output;
}

module.exports = { ToolExecutor, strategyKey, closestNames, DEFAULT_PARALLEL_READS, executeToolCallsOrdered };
