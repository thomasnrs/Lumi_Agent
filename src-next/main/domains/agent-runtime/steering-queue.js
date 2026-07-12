'use strict';

class SteeringQueue {
  constructor() { this.items = []; }
  push(content, metadata) {
    const text = typeof content === 'string' ? content : content;
    this.items.push({ content: text, metadata: metadata || null });
    return this.items.length;
  }
  get size() { return this.items.length; }
  drain() { return this.items.splice(0); }
  clear() { this.items.length = 0; }
}

function injectSteering(queue, messages, onInject) {
  let count = 0;
  for (const item of queue.drain()) {
    const message = { role: 'user', content: item.content };
    messages.push(message);
    if (onInject) onInject(message, item.metadata);
    count++;
  }
  return count;
}

module.exports = { SteeringQueue, injectSteering };
