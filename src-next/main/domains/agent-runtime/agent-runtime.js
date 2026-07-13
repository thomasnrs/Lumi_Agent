'use strict';

const { safeToolArguments } = require('../context/messages');
const { isExplicitToolUnsupportedError } = require('../ai-providers/protocol');
const { executeToolCallsOrdered } = require('../tools/tool-executor');
const { ToolGuard } = require('../tools/tool-guard');
const { SteeringQueue, injectSteering } = require('./steering-queue');
const { TurnLedger } = require('./turn-ledger');
const { CompletionEvidenceGate, taskContractFor } = require('./completion-gate');

function parseCallArguments(value) { return JSON.parse(safeToolArguments(value)); }
function assistantToolMessage(turn) {
  return {
    role: 'assistant', content: turn.text || null, ...(turn.responseItems && turn.responseItems.length ? { _responsesItems: turn.responseItems } : {}),
    tool_calls: (turn.toolCalls || []).map((call, index) => ({ id: call.id || `call_${index}`, type: 'function', function: { name: call.name || 'tool', arguments: safeToolArguments(call.arguments) } })),
  };
}
function resultMessages(call, result) {
  if (result && result._image) return [
    { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, note: 'Imagem anexada como visão.' }) },
    { role: 'user', content: [{ type: 'text', text: result._imageNote || 'Imagem retornada pela ferramenta:' }, { type: 'image_url', image_url: { url: result._image } }] },
  ];
  const safe = result && result.images ? { ok: true, generated: result.images.length, note: 'Imagem gerada e exibida ao usuário.' } : result;
  return [{ role: 'tool', tool_call_id: call.id, content: JSON.stringify(safe == null ? { ok: true } : safe) }];
}

class AgentRuntime {
  constructor(options) {
    const opts = options || {};
    if (!opts.turnService) throw new Error('AgentRuntime exige turnService');
    if (!opts.toolRegistry) throw new Error('AgentRuntime exige toolRegistry');
    if (!opts.toolExecutor) throw new Error('AgentRuntime exige toolExecutor');
    this.turnService = opts.turnService;
    this.toolRegistry = opts.toolRegistry;
    this.toolExecutor = opts.toolExecutor;
    this.compact = opts.compact || ((messages) => ({ messages, compacted: false }));
    this.onEvent = opts.onEvent || (() => {});
    this.completionGateFactory = opts.completionGateFactory || (() => new CompletionEvidenceGate());
    this.completionPolicyFactories = opts.completionPolicyFactories || [];
  }

  async run(options) {
    const opts = options || {}, config = opts.config || {};
    let activeConfig = { ...config };
    let messages = (opts.messages || []).map((message) => ({ ...message }));
    const queue = opts.steeringQueue || new SteeringQueue();
    const goal = opts.goal || '';
    const contract = opts.contract || taskContractFor(goal, config);
    const ledger = opts.ledger || new TurnLedger(goal);
    const toolGuard = opts.toolGuard || new ToolGuard();
    const completionGate = this.completionGateFactory();
    const completionPolicies = this.completionPolicyFactories.map((factory) => factory());
    const maxSteps = Math.min(200, Math.max(4, Number(config.maxSteps) || 48));
    const toolsets = opts.toolsets || contract.toolsets;
    let toolsSuppressed = config.toolsEnabled === false;
    let full = '', finished = false, steps = 0;
    // Owner e mount são dados de execução explícitos: ferramentas de terminal/remoto
    // não devem inferi-los de globais e acabar rodando no host errado.
    const toolContext = {
      workspace: opts.workspace,
      chatId: opts.chatId,
      workspaceOwner: opts.workspaceOwner,
      remote: opts.remote,
      signal: opts.signal,
      ledger,
      toolGuard,
      session: opts.session,
    };

    const inject = () => injectSteering(queue, messages, (message, metadata) => {
      if (opts.onMessage) opts.onMessage(message, { steering: true, metadata });
      this.onEvent({ type: 'agent.steering', message, metadata });
    });

    for (let step = 0; step < maxSteps; step++) {
      steps = step + 1;
      if (opts.signal && opts.signal.aborted) break;
      inject();
      if (step > 0 && step % 8 === 0 && goal) messages.push({ role: 'user', content: `[foco — passo ${step}/${maxSteps}] Objetivo: "${String(goal).slice(0, 500)}". Volte ao objetivo, verifique e finalize; se travou, mude a abordagem.` });
      const schemas = toolsSuppressed ? [] : (opts.getTools ? opts.getTools({ toolsets, config: activeConfig }) : this.toolRegistry.schemas({ toolsets, delegate: !!opts.delegate }));
      const compacted = this.compact(messages, activeConfig, schemas);
      messages = compacted && compacted.messages || messages;
      this.onEvent({ type: 'agent.step', step, maxSteps, tools: schemas.length, compacted: !!(compacted && compacted.compacted) });
      let turn;
      try {
        turn = await this.turnService.turn({ config: activeConfig, messages, tools: schemas, signal: opts.signal, onToken: opts.onToken, onThink: opts.onThink });
      } catch (error) {
        if (!toolsSuppressed && schemas.length && isExplicitToolUnsupportedError(error)) {
          toolsSuppressed = true;
          this.onEvent({ type: 'agent.tools-unsupported', error });
          step--;
          continue;
        }
        throw error;
      }
      if (turn.providerMeta && turn.providerMeta.fallback && turn.providerMeta.model) activeConfig = { ...activeConfig, model: turn.providerMeta.model, fallbackModel: '' };
      if (turn.aborted || opts.signal && opts.signal.aborted) { full = turn.text || ''; break; }

      if (!(turn.toolCalls && turn.toolCalls.length) && queue.size) {
        if (turn.text && turn.text.trim() || turn.responseItems && turn.responseItems.length) {
          const assistant = { role: 'assistant', content: turn.text || null, ...(turn.responseItems && turn.responseItems.length ? { _responsesItems: turn.responseItems } : {}) };
          messages.push(assistant); if (opts.onMessage) opts.onMessage(assistant, { partialBeforeSteering: true });
        }
        inject();
        this.onEvent({ type: 'agent.new-bubble' });
        step--;
        continue;
      }

      if (turn.toolCalls && turn.toolCalls.length) {
        const assistant = assistantToolMessage(turn);
        messages.push(assistant); if (opts.onMessage) opts.onMessage(assistant, { toolCalls: true });
        const calls = assistant.tool_calls.map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments }));
        const executed = await executeToolCallsOrdered(calls, async (call) => {
          const args = parseCallArguments(call.arguments);
          this.onEvent({ type: 'agent.tool', call, args });
          const result = await this.toolExecutor.execute(call.name, args, toolContext);
          ledger.record(call.name, args, result);
          return { call, result };
        }, { concurrency: config.parallelToolConcurrency || 4, parallelNames: opts.parallelToolNames });
        for (const item of executed) for (const message of resultMessages(item.call, item.result)) {
          messages.push(message); if (opts.onMessage) opts.onMessage(message, { toolResult: true, call: item.call, result: item.result });
        }
        continue;
      }

      let policyMessage = null;
      for (const policy of completionPolicies) {
        policyMessage = await policy.evaluate({ config: activeConfig, contract, ledger, messages, workspace: opts.workspace, chatId: opts.chatId, signal: opts.signal, emit: (event) => this.onEvent(event) });
        if (policyMessage) break;
      }
      if (policyMessage) {
        messages.push(policyMessage); if (opts.onMessage) opts.onMessage(policyMessage, { completionPolicy: true });
        continue;
      }
      const evidence = completionGate.evaluate(contract, ledger);
      if (evidence) {
        messages.push(evidence); if (opts.onMessage) opts.onMessage(evidence, { completionGate: true });
        this.onEvent({ type: 'agent.completion-gate', files: ledger.changedCodeFiles() });
        continue;
      }
      full = turn.text || '';
      finished = true;
      break;
    }
    const status = opts.signal && opts.signal.aborted ? 'aborted' : finished ? 'completed' : 'step-limit';
    this.onEvent({ type: 'agent.done', status, steps, ledger: ledger.snapshot() });
    return { text: full, status, steps, messages, ledger: ledger.snapshot(), toolsSuppressed, effectiveConfig: activeConfig };
  }
}

module.exports = { AgentRuntime, parseCallArguments, assistantToolMessage, resultMessages };
