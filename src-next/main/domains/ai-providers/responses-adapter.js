'use strict';

const { readSse } = require('../../adapters/network/sse');
const { safeToolArguments } = require('../context/messages');
const { TurnAccumulator } = require('./turn-accumulator');
const { requestModel } = require('./protocol');

function convertToResponses(messages) {
  let instructions = '';
  const input = [];
  const contentFor = (role, content) => {
    if (typeof content === 'string') return content;
    const parts = [];
    for (const part of content || []) {
      if (part.type === 'image_url' && role === 'user') parts.push({ type: 'input_image', image_url: part.image_url && part.image_url.url });
      else if (part.text) parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text });
    }
    return parts;
  };
  for (const message of messages || []) {
    if (message.role === 'system') {
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content || '');
      if (text) instructions += (instructions ? '\n\n' : '') + text;
      continue;
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message._responsesItems) && message._responsesItems.length) {
      input.push(...message._responsesItems);
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      if (typeof message.content === 'string' && message.content.trim()) input.push({ role: 'assistant', content: message.content });
      for (const call of message.tool_calls) input.push({
        type: 'function_call', call_id: call.id, name: call.function && call.function.name || 'tool', arguments: safeToolArguments(call.function && call.function.arguments),
      });
      continue;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    input.push({ role, content: contentFor(role, message.content) });
  }
  return { instructions, input };
}

class ResponsesAdapter {
  constructor(options) {
    const opts = options || {};
    if (!opts.fetchPolicy) throw new Error('ResponsesAdapter exige fetchPolicy');
    this.fetchPolicy = opts.fetchPolicy;
    this.clock = opts.clock || { now: () => Date.now() };
    this.nextId = opts.nextId || ((prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  }

  async turn(request) {
    const config = request.config;
    const converted = convertToResponses(request.messages);
    const body = { model: requestModel(config), input: converted.input, stream: true };
    if (converted.instructions) body.instructions = converted.instructions;
    if (request.tools && request.tools.length) body.tools = request.tools.map((tool) => ({
      type: 'function', name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters, strict: false,
    }));
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const acc = new TurnAccumulator({ clock: this.clock, onToken: request.onToken, onThink: request.onThink });
    const calls = new Map();
    let responseItems = [];
    const callFor = (event) => {
      const item = event.item || {};
      const key = event.item_id || item.id || item.call_id || String(event.output_index == null ? calls.size : event.output_index);
      if (!calls.has(key)) calls.set(key, { id: item.call_id || item.id || this.nextId('response_call'), name: item.name || '', arguments: '' });
      return calls.get(key);
    };
    try {
      const response = await this.fetchPolicy.request(config, String(config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/responses', {
        method: 'POST', headers, body: JSON.stringify(body), signal: request.signal,
      });
      if (!response.ok) throw new Error(`Responses HTTP ${response.status}: ${await response.text()}`);
      await readSse(response, (data) => {
        if (!data || data === '[DONE]') return;
        let event;
        try { event = JSON.parse(data); } catch (_) { return; }
        if (event.type === 'response.output_text.delta') acc.content(event.delta);
        else if (event.type === 'response.reasoning_text.delta' || event.type === 'response.reasoning_summary_text.delta') acc.reasoning(event.delta);
        else if (event.type === 'response.output_item.added' && event.item && event.item.type === 'function_call') {
          const call = callFor(event); call.name = event.item.name || call.name; call.arguments = event.item.arguments || call.arguments;
        } else if (event.type === 'response.function_call_arguments.delta') callFor(event).arguments += event.delta || '';
        else if (event.type === 'response.output_item.done' && event.item) {
          responseItems.push(event.item);
          if (event.item.type === 'function_call') {
            const call = callFor(event); call.name = event.item.name || call.name; if (event.item.arguments) call.arguments = event.item.arguments;
          }
        } else if (event.type === 'response.completed' && event.response) {
          if (!responseItems.length && Array.isArray(event.response.output)) responseItems = event.response.output;
          const usage = event.response.usage;
          if (usage) acc.usage = { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, total_tokens: usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0) };
        } else if (event.type === 'error') throw new Error(event.error && event.error.message || event.message || 'erro no stream Responses');
      });
    } catch (error) {
      if (request.signal && request.signal.aborted) return { ...acc.finish({ aborted: true }), toolCalls: [...calls.values()].filter((call) => call.name), responseItems };
      throw error;
    }
    return { ...acc.finish(), toolCalls: [...calls.values()].filter((call) => call.name), responseItems };
  }
}

module.exports = { ResponsesAdapter, convertToResponses };
