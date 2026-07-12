'use strict';

const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|cs|fs|cpp|cc|cxx|c|h|hpp|php|rb|swift|dart|vue|svelte|astro|html|css|scss|sass|less|json|ya?ml|toml)$/i;
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'append_file', 'make_dir', 'delete_file', 'apply_patch', 'update_project_memory']);

function resultFailed(result) {
  const status = String(result && result.status || '').toLowerCase();
  return !!(result && (result.error || result.isError || result.ok === false || Number(result.status) >= 400 || result.exitCode != null && Number(result.exitCode) !== 0 || /^(?:failed|error|cancelled|canceled|declined|denied|rejected)$/.test(status)));
}
function looksLikeVerification(command) {
  return /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|typecheck)\b|\b(?:pytest|jest|vitest|mocha|cargo\s+(?:test|check|clippy)|go\s+(?:test|vet|build)|dotnet\s+(?:test|build)|mvn\s+(?:test|verify|package)|gradle\w*\s+(?:test|build)|tsc\b|eslint\b|ruff\b|node\s+--check\b|python\s+-m\s+(?:pytest|compileall))/.test(String(command || '').trim().toLowerCase());
}

class TurnLedger {
  constructor(goal) { this.goal = String(goal || '').slice(0, 500); this.tools = []; this.filesRead = new Set(); this.filesChanged = new Set(); this.verification = []; }
  record(name, args, result) {
    const failed = resultFailed(result), path = args && args.path;
    this.tools.push({ tool: name, status: failed ? 'failed' : 'success', target: String(path || args && (args.query || args.pattern || args.command || args.url || args.agent) || '').slice(0, 180) });
    if (this.tools.length > 40) this.tools.shift();
    if (path && ['read_file', 'view_image'].includes(name)) this.filesRead.add(String(path));
    if (path && WRITE_TOOLS.has(name) && !failed) this.filesChanged.add(String(path));
    if (name === 'apply_patch' && !failed) for (const file of result && result.files || args && args.files || []) this.filesChanged.add(String(file));
    if (name === 'run_tests') this.verification.push({ command: result && result.command || 'run_tests', ok: result && result.ok === true });
    else if (name === 'get_problems' && !failed && Array.isArray(result && result.tools) && result.tools.length) this.verification.push({ command: 'get_problems', ok: Number(result.errors != null ? result.errors : result.total) === 0 });
    else if (name === 'run_command' && looksLikeVerification(args && args.command)) this.verification.push({ command: args.command, ok: !failed });
    return { failed };
  }
  changedCodeFiles() { return [...this.filesChanged].filter((file) => CODE_FILE.test(file)); }
  hasSuccessfulVerification() { return this.verification.some((item) => item.ok === true); }
  snapshot() { return { goal: this.goal, tools: this.tools.map((item) => ({ ...item })), filesRead: [...this.filesRead], filesChanged: [...this.filesChanged], verification: this.verification.map((item) => ({ ...item })) }; }
}

module.exports = { TurnLedger, resultFailed, looksLikeVerification, CODE_FILE, WRITE_TOOLS };
