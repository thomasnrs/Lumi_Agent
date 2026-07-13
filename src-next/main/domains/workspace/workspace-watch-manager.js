'use strict';

const IGNORED = /(^|[\\/])(node_modules|\.git|dist|build|out|\.next|\.cache)([\\/]|$)/i;
const PROJECT_CONTEXT_FILE = /(^|[\\/])(?:package\.json|(?:pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|package-lock\.json)|pyproject\.toml|requirements\.txt|setup\.(?:py|cfg)|Pipfile(?:\.lock)?|poetry\.lock|uv\.lock|environment\.ya?ml|go\.mod|Cargo\.toml|composer\.json|pom\.xml|build\.gradle(?:\.kts)?|Gemfile|pubspec\.yaml|Package\.swift|mix\.exs|build\.sbt|deno\.jsonc?|CMakeLists\.txt|Makefile|Dockerfile|[^\\/]+\.(?:csproj|fsproj|sln)|\.env(?:\.[^\\/]+)?|CLAUDE\.md|AGENTS\.md|DESIGN\.md|\.cursorrules|copilot-instructions\.md|\.lumi-memory\.md)$/i;

function shouldIgnore(filename) {
  const file = String(filename || '');
  return IGNORED.test(file) || /\.lumi-/.test(file) && !/\.lumi-memory\.md$/i.test(file);
}

class WorkspaceWatchManager {
  constructor(options) {
    const opts = options || {};
    if (!opts.port) throw new Error('WorkspaceWatchManager exige port');
    this.port = opts.port;
    this.clock = opts.clock || { setTimeout, clearTimeout, setInterval, clearInterval };
    this.debounceMs = Math.max(50, Number(opts.debounceMs) || 300);
    this.localPollMs = Math.max(1000, Number(opts.localPollMs) || 3000);
    this.remotePollMs = Math.max(1000, Number(opts.remotePollMs) || 10000);
    this.onChange = opts.onChange || (() => {});
    this.onProjectContextChange = opts.onProjectContextChange || (() => {});
    this.onError = opts.onError || (() => {});
    this.records = new Map();
  }

  subscribe(root, owner, options) {
    if (!root || !owner) throw new Error('root e owner são obrigatórios');
    let record = this.records.get(root);
    if (record) { record.owners.add(owner); return () => this.unsubscribe(root, owner); }
    record = { root, owners: new Set([owner]), timer: null, close: () => {}, poll: null, signature: '', remote: !!(options && options.remote) };
    const change = (_event, filename) => this.changed(record, filename);
    try {
      const watcher = this.port.watch(root, change, (error) => this.onError({ root, error }));
      record.close = () => { try { watcher.close(); } catch (_) {} };
    } catch (error) {
      if (typeof this.port.signature !== 'function') throw error;
      record.poll = this.clock.setInterval(async () => {
        try {
          const signature = await this.port.signature(root, { remote: record.remote });
          if (record.signature && signature !== record.signature) this.changed(record, '');
          record.signature = signature;
        } catch (pollError) { this.onError({ root, error: pollError }); }
      }, record.remote ? this.remotePollMs : this.localPollMs);
    }
    this.records.set(root, record);
    return () => this.unsubscribe(root, owner);
  }

  changed(record, filename) {
    if (shouldIgnore(filename)) return;
    if (PROJECT_CONTEXT_FILE.test(String(filename || ''))) this.onProjectContextChange({ root: record.root, filename: String(filename || '') });
    if (record.timer) this.clock.clearTimeout(record.timer);
    record.timer = this.clock.setTimeout(() => { record.timer = null; this.onChange({ root: record.root, filename: String(filename || '') }); }, this.debounceMs);
  }

  unsubscribe(root, owner) {
    const record = this.records.get(root);
    if (!record) return false;
    record.owners.delete(owner);
    if (record.owners.size) return true;
    if (record.timer) this.clock.clearTimeout(record.timer);
    if (record.poll) this.clock.clearInterval(record.poll);
    record.close(); this.records.delete(root); return true;
  }

  dispose() { for (const [root, record] of this.records) { record.owners.clear(); this.unsubscribe(root, '__dispose__'); } }
}

module.exports = { WorkspaceWatchManager, shouldIgnore, PROJECT_CONTEXT_FILE };
