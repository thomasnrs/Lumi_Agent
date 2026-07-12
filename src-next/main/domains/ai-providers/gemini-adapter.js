'use strict';

const { readSse } = require('../../adapters/network/sse');
const { safeToolArguments } = require('../context/messages');
const { TurnAccumulator } = require('./turn-accumulator');
const { requestModel } = require('./protocol');

function parseArguments(value) {
  return JSON.parse(safeToolArguments(value));
}

function convertToGemini(messages) {
  let system = '';
  const contents = [];
  const toolNames = new Map();
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents.at(-1);
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const message of messages || []) {
    if (message.role === 'system') {
      if (typeof message.content === 'string') system += (system ? '\n\n' : '') + message.content;
      continue;
    }
    if (message.role === 'tool') {
      let response = message.content;
      try { response = JSON.parse(message.content); } catch (_) { response = { result: message.content }; }
      if (!response || typeof response !== 'object' || Array.isArray(response)) response = { result: response };
      push('user', [{ functionResponse: { id: message.tool_call_id, name: toolNames.get(message.tool_call_id) || 'tool', response } }]);
      continue;
    }
    const parts = [];
    if (typeof message.content === 'string') {
      if (message.content) parts.push({ text: message.content });
    } else {
      for (const part of message.content || []) {
        if (part.type === 'image_url') {
          const match = /^data:([^;]+);base64,(.*)$/.exec(part.image_url && part.image_url.url || '');
          if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        } else if (part.text) parts.push({ text: part.text });
      }
    }
    if (message.role === 'assistant') for (const call of message.tool_calls || []) {
      const name = call.function && call.function.name || 'tool';
      toolNames.set(call.id, name);
      parts.push({ functionCall: { id: call.id, name, args: parseArguments(call.function && call.function.arguments) } });
    }
    push(message.role === 'assistant' ? 'model' : 'user', parts);
  }
  return { system, contents };
}

class GeminiAdapter {
  constructor(options) {
    const opts = options || {};
    if (!opts.fetchPolicy) throw new Error('GeminiAdapter exige fetchPolicy');
    this.fetchPolicy = opts.fetchPolicy;
    this.clock = opts.clock || { now: () => Date.now() };
    this.nextId = opts.nextId || ((prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  }

  async turn(request) {
    const config = request.config;
    const converted = convertToGemini(request.messages);
    const body = { contents: converted.contents };
    if (converted.system) body.systemInstruction = { parts: [{ text: converted.system }] };
    if (request.tools && request.tools.length) body.tools = [{ functionDeclarations: request.tools.map((tool) => ({
      name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters,
    })) }];
    if (config.temperature != null) body.generationConfig = { temperature: Number(config.temperature) };
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['x-goog-api-key'] = config.apiKey;
    const acc = new TurnAccumulator({ clock: this.clock, onToken: request.onToken, onThink: request.onThink });
    const calls = [];
    const seen = new Set();
    try {
      const base = String(config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
      const url = `${base}/models/${encodeURIComponent(requestModel(config))}:streamGenerateContent?alt=sse`;
      const response = await this.fetchPolicy.request(config, url, { method: 'POST', headers, body: JSON.stringify(body), signal: request.signal });
      if (!response.ok) throw new Error(`Gemini HTTP ${response.status}: ${await response.text()}`);
      await readSse(response, (data) => {
        let event;
        try { event = JSON.parse(data); } catch (_) { return; }
        const parts = event.candidates && event.candidates[0] && event.candidates[0].content && event.candidates[0].content.parts || [];
        for (const part of parts) {
          if (part.text) (part.thought ? acc.reasoning(part.text) : acc.content(part.text));
          if (part.functionCall) {
            const call = part.functionCall;
            const signature = `${call.id || ''}|${call.name}|${JSON.stringify(call.args || {})}`;
            if (!seen.has(signature)) {
              seen.add(signature);
              calls.push({ id: call.id || this.nextId('gemini_call'), name: call.name, arguments: JSON.stringify(call.args || {}) });
            }
          }
        }
        if (event.usageMetadata) {
          const usage = event.usageMetadata;
          acc.usage = { prompt_tokens: usage.promptTokenCount || 0, completion_tokens: usage.candidatesTokenCount || 0, total_tokens: usage.totalTokenCount || (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0) };
        }
      });
    } catch (error) {
      if (request.signal && request.signal.aborted) return { ...acc.finish({ aborted: true }), toolCalls: calls };
      throw error;
    }
    return { ...acc.finish(), toolCalls: calls };
  }
}

module.exports = { GeminiAdapter, convertToGemini };
