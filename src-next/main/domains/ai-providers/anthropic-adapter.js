'use strict';

const { readSse } = require('../../adapters/network/sse');
const { TurnAccumulator } = require('./turn-accumulator');
const { requestModel } = require('./protocol');

function convertToAnthropic(messages) {
  let system = '';
  const output = [];
  const pushUser = (blocks) => {
    if (!blocks.length) return;
    const last = output.at(-1);
    if (last && last.role === 'user') last.content.push(...blocks);
    else output.push({ role: 'user', content: blocks });
  };
  for (const message of messages || []) {
    if (message.role === 'system') {
      if (typeof message.content === 'string' && message.content) system += (system ? '\n\n' : '') + message.content;
      continue;
    }
    if (message.role === 'tool') {
      pushUser([{ type: 'tool_result', tool_use_id: message.tool_call_id, content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }]);
      continue;
    }
    if (message.role === 'assistant') {
      const blocks = [];
      if (typeof message.content === 'string' && message.content.trim()) blocks.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(call.function && call.function.arguments || '{}'); } catch (_) {}
        blocks.push({ type: 'tool_use', id: call.id, name: call.function && call.function.name || 'tool', input });
      }
      if (blocks.length) output.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (typeof message.content === 'string') {
      if (message.content.trim()) pushUser([{ type: 'text', text: message.content }]);
      continue;
    }
    const blocks = [];
    for (const part of message.content || []) {
      if (part.type === 'image_url') {
        const match = /^data:([^;]+);base64,(.*)$/.exec(part.image_url.url);
        if (match) blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
      } else if (part.text && part.text.trim()) blocks.push({ type: 'text', text: part.text });
    }
    pushUser(blocks);
  }
  if (!output.length || output[0].role !== 'user') output.unshift({ role: 'user', content: [{ type: 'text', text: '(início da conversa)' }] });
  return { system, messages: output };
}

class AnthropicAdapter {
  constructor(options) {
    const opts = options || {};
    if (!opts.fetchPolicy) throw new Error('AnthropicAdapter exige fetchPolicy');
    this.fetchPolicy = opts.fetchPolicy;
    this.clock = opts.clock || { now: () => Date.now() };
  }

  async turn(request) {
    const config = request.config;
    const converted = convertToAnthropic(request.messages);
    const body = { model: requestModel(config), max_tokens: config.maxTokens || 8192, messages: converted.messages, stream: true };
    if (converted.system) body.system = converted.system;
    if (request.tools && request.tools.length) body.tools = request.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters }));
    const acc = new TurnAccumulator({ clock: this.clock, onToken: request.onToken, onThink: request.onThink });
    let inputTokens = 0;
    try {
      const response = await this.fetchPolicy.request(config, String(config.baseUrl || 'https://api.anthropic.com/v1').replace(/\/$/, '') + '/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body), signal: request.signal,
      });
      if (!response.ok) throw new Error(`Anthropic HTTP ${response.status}: ${await response.text()}`);
      await readSse(response, (data) => {
        let event;
        try { event = JSON.parse(data); } catch (_) { return; }
        if (event.type === 'message_start' && event.message && event.message.usage) inputTokens = event.message.usage.input_tokens || 0;
        else if (event.type === 'content_block_start' && event.content_block && event.content_block.type === 'tool_use') acc.tool(event.index, { id: event.content_block.id, name: event.content_block.name });
        else if (event.type === 'content_block_delta' && event.delta) {
          if (event.delta.type === 'text_delta') acc.content(event.delta.text);
          else if (event.delta.type === 'input_json_delta') acc.tool(event.index, { arguments: event.delta.partial_json || '' });
          else if (event.delta.type === 'thinking_delta') acc.reasoning(event.delta.thinking);
        } else if (event.type === 'message_delta' && event.usage) {
          const output = event.usage.output_tokens || 0;
          acc.usage = { prompt_tokens: inputTokens, completion_tokens: output, total_tokens: inputTokens + output };
        }
      });
    } catch (error) {
      if (request.signal && request.signal.aborted) return acc.finish({ aborted: true });
      throw error;
    }
    return acc.finish();
  }
}

module.exports = { AnthropicAdapter, convertToAnthropic };
