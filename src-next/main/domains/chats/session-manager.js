'use strict';
const { ChatSession } = require('./chat-session');

class SessionManager {
  constructor(options) {
    const opts = options || {}; if (!opts.repository || !opts.context) throw new Error('SessionManager exige repository e context');
    this.repository = opts.repository; this.context = opts.context; this.clock = opts.clock || { date: () => new Date() };
    this.maxBackground = Math.max(1, Number(opts.maxBackground) || 6); this.foreground = null; this.background = new Map(); this.loading = new Map();
  }
  current() { return this.context.get() || this.foreground; }
  async initialize(preferredId) {
    let chat = null; if (preferredId) try { chat = await this.repository.load(preferredId); } catch (_) {}
    if (!chat) { const list = await this.repository.list(); if (list[0]) chat = await this.repository.load(list[0].id); }
    if (!chat) chat = await this.repository.create(); this.foreground = new ChatSession(chat); return this.foreground;
  }
  async loadSession(id) {
    if (this.foreground && this.foreground.id === id) return this.foreground; if (this.background.has(id)) return this.background.get(id);
    if (!this.loading.has(id)) this.loading.set(id, this.repository.load(id).then((chat) => {
      const session = new ChatSession(chat); this.background.set(id, session); this.trim(); return session;
    }).finally(() => this.loading.delete(id)));
    return this.loading.get(id);
  }
  async get(id) { return !id ? this.foreground : this.loadSession(id); }
  run(sessionOrId, task) { const load = typeof sessionOrId === 'string' ? this.get(sessionOrId) : Promise.resolve(sessionOrId || this.foreground); return load.then((session) => this.context.run(session, () => task(session))); }
  async save(session) { const target = session || this.current(); if (!target || target.deleted) return false; await this.repository.save(target.snapshot(this.clock)); return true; }
  async create(seed) { const chat = await this.repository.create(seed); if (this.foreground) this.background.set(this.foreground.id, this.foreground); this.foreground = new ChatSession(chat); this.trim(); return this.foreground; }
  async switch(id) {
    if (!id || (this.foreground && id === this.foreground.id)) return this.foreground; if (this.foreground) { await this.save(this.foreground); this.background.set(this.foreground.id, this.foreground); }
    const live = this.background.get(id); if (live) { this.background.delete(id); this.foreground = live; } else this.foreground = await this.loadSession(id);
    this.background.delete(id); this.trim(); return this.foreground;
  }
  trim() { while (this.background.size > this.maxBackground) { const candidate = [...this.background].find(([, session]) => !session.running); if (!candidate) break; this.background.delete(candidate[0]); } }
  async delete(id) {
    const session = this.foreground && this.foreground.id === id ? this.foreground : this.background.get(id); if (session) { session.deleted = true; session.stop(); }
    this.background.delete(id); await this.repository.delete(id);
    if (this.foreground && this.foreground.id === id) { this.foreground = null; await this.initialize(); }
    return this.foreground;
  }
  async dispose() { const all = [this.foreground, ...this.background.values()].filter(Boolean); for (const session of all) { session.stop(); await this.save(session); } this.background.clear(); }
}
module.exports = { SessionManager };
