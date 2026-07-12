'use strict';

const nodeFs = require('fs');
const nodePath = require('path');
const { clone } = require('../../../shared/schema');
const { AtomicJsonStore } = require('../../adapters/filesystem/atomic-json-store');

function validChatId(id) { return /^c[a-z0-9_-]{3,80}$/i.test(String(id || '')); }
function textContent(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return (message.content || []).filter((part) => part && part.type === 'text').map((part) => part.text || '').join(' ');
}
function titleFromHistory(history) {
  const first = (history || []).find((message) => message && message.role === 'user');
  return (textContent(first).replace(/\s+/g, ' ').trim().slice(0, 48) || 'Nova conversa');
}
function normalizeChat(raw, id, clock) {
  const value = raw && typeof raw === 'object' ? clone(raw) : {};
  const chatId = validChatId(value.id) ? value.id : id;
  if (!validChatId(chatId)) throw new Error(`chat id inválido: ${chatId}`);
  const history = Array.isArray(value.history) ? value.history.slice(-4000) : [];
  const now = clock.date().toISOString();
  return {
    ...value, id: chatId,
    title: String(value.title || titleFromHistory(history)).slice(0, 60), customTitle: !!value.customTitle,
    createdAt: value.createdAt || now, updatedAt: value.updatedAt || value.at || now,
    summary: String(value.summary || '').slice(0, 500000), history,
    events: Array.isArray(value.events) ? value.events.slice(-4000) : [],
    archive: Array.isArray(value.archive) ? value.archive.slice(-1000) : [],
    worklog: Array.isArray(value.worklog) ? value.worklog.slice(-60) : [],
    ledger: Array.isArray(value.ledger) ? value.ledger.slice(-40) : [],
    chatConfig: value.chatConfig && typeof value.chatConfig === 'object' ? value.chatConfig : null,
  };
}

class ChatRepository {
  constructor(options) {
    const opts = options || {};
    if (!opts.directory) throw new Error('ChatRepository exige directory');
    this.directory = opts.directory; this.fs = opts.fs || nodeFs.promises; this.path = opts.path || nodePath;
    this.clock = opts.clock || { date: () => new Date(), now: () => Date.now() };
    this.nextId = opts.nextId || (() => `c${this.clock.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`);
    this.stores = new Map(); this.writes = new Map(); this.deleted = new Set(); this.meta = new Map();
  }

  file(id) { if (!validChatId(id)) throw new Error(`chat id inválido: ${id}`); return this.path.join(this.directory, `${id}.json`); }
  store(id) { if (!this.stores.has(id)) this.stores.set(id, new AtomicJsonStore({ filePath: this.file(id), fs: this.fs, path: this.path, clock: this.clock, maxBytes: 32 * 1024 * 1024 })); return this.stores.get(id); }
  remember(chat) { this.meta.set(chat.id, { id: chat.id, title: chat.title, customTitle: chat.customTitle, createdAt: chat.createdAt, updatedAt: chat.updatedAt, count: chat.history.length, customEngine: !!chat.chatConfig }); }

  async create(seed) {
    let id; do { id = this.nextId('chat'); } while (!validChatId(id) || this.meta.has(id));
    const chat = normalizeChat({ ...(seed || {}), id }, id, this.clock); await this.save(chat); return clone(chat);
  }

  save(input) {
    const id = input && input.id; if (!validChatId(id) || this.deleted.has(id)) return Promise.reject(new Error(`chat indisponível: ${id}`));
    const chat = normalizeChat(input, id, this.clock); chat.updatedAt = this.clock.date().toISOString(); this.remember(chat);
    let state = this.writes.get(id);
    if (state) { state.latest = chat; return state.promise; }
    state = { latest: chat, writing: null, promise: null }; this.writes.set(id, state);
    state.promise = Promise.resolve().then(async () => {
      while (state.latest) { state.writing = state.latest; state.latest = null; await this.store(id).write(state.writing); state.writing = null; }
    }).finally(() => { if (this.writes.get(id) === state) this.writes.delete(id); });
    return state.promise;
  }

  async load(id) {
    const state = this.writes.get(id); const pending = state && (state.latest || state.writing);
    const chat = pending ? normalizeChat(pending, id, this.clock) : normalizeChat((await this.store(id).read()).value, id, this.clock);
    this.remember(chat); return clone(chat);
  }

  async list() {
    await this.fs.mkdir(this.directory, { recursive: true });
    const names = await this.fs.readdir(this.directory); const ids = new Set(names.filter((name) => /^c[a-z0-9_-]{3,80}\.json$/i.test(name)).map((name) => name.slice(0, -5)));
    for (const id of this.writes.keys()) ids.add(id);
    const result = [];
    for (const id of ids) try { const chat = await this.load(id); result.push(clone(this.meta.get(chat.id))); } catch (_) {}
    return result.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async rename(id, title) { const chat = await this.load(id); chat.title = String(title || titleFromHistory(chat.history)).slice(0, 60); chat.customTitle = true; await this.save(chat); return chat.title; }
  async delete(id) {
    this.deleted.add(id); const state = this.writes.get(id); if (state) await state.promise;
    this.meta.delete(id); this.stores.delete(id);
    await Promise.all([this.fs.unlink(this.file(id)).catch(() => {}), this.fs.unlink(`${this.file(id)}.bak`).catch(() => {})]); return true;
  }

  async migrateLegacy(history, summary) { return this.create({ history: Array.isArray(history) ? history : [], summary: summary || '' }); }
}

module.exports = { ChatRepository, normalizeChat, validChatId, titleFromHistory };
