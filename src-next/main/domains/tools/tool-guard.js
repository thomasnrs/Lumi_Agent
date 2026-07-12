'use strict';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function callKey(name, args) { return `${name}|${JSON.stringify(stable(args || {}))}`; }
function failed(result) { return !!(result && (result.error || result.isError || result.ok === false || Number(result.status) >= 400 || result.exitCode != null && Number(result.exitCode) !== 0)); }
function failureClass(error) {
  const value = String(error || '').toLowerCase();
  if (/crlf|line endings?|\r\n|encoding|utf-?8|acentua/.test(value)) return 'encoding-line-endings';
  if (/old_text|não encontrado no arquivo|not found in (?:the )?file|patch não aplica|does not apply|context mismatch/.test(value)) return 'content-mismatch';
  if (/não encontrado|not found|enoent|no such file|caminho/.test(value)) return 'not-found';
  if (/permission|permissão|access denied|eacces|bloquead/.test(value)) return 'permission';
  if (/timed? ?out|timeout|etimedout/.test(value)) return 'timeout';
  if (/invalid json|json inválido|arguments.*json/.test(value)) return 'invalid-json';
  return value.replace(/\b\d+\b/g, '#').replace(/\s+/g, ' ').slice(0, 120) || 'unknown';
}
const RECOVERY = Object.freeze({
  'encoding-line-endings': 'Releia o trecho e use edição normalizada ou patch preservando o arquivo.',
  'content-mismatch': 'Releia o trecho real e troque a estratégia de edição.', 'not-found': 'Resolva primeiro o caminho real.',
  permission: 'Peça a permissão necessária ou explique o bloqueio.', timeout: 'Reduza o escopo ou use uma ferramenta mais específica.',
  'invalid-json': 'Reconstrua argumentos mínimos e válidos.',
});

class ToolGuard {
  constructor(options) { this.maxEntries = Math.max(20, Number(options && options.maxEntries) || 80); this.reset(); }
  reset() { this.calls = []; this.strategies = []; this.state = 0; }
  before(name, args, strategyKey) {
    const key = callKey(name, args);
    const identical = this.calls.filter((entry) => entry.key === key && entry.failed && entry.state === this.state);
    if (identical.length >= 2) return { error: `LOOP DETECTADO: esta chamada já falhou ${identical.length}x sem mudança de estado. Mude a abordagem.`, loop: true };
    if (strategyKey) {
      const same = this.strategies.filter((entry) => entry.key === strategyKey && entry.state === this.state);
      const counts = new Map(); for (const entry of same) counts.set(entry.kind, (counts.get(entry.kind) || 0) + 1);
      const repeated = [...counts].find(([, count]) => count >= 2);
      if (repeated) return { error: `ESTRATÉGIA TRAVADA: falhou ${repeated[1]}x pelo mesmo motivo (${repeated[0]}). ${RECOVERY[repeated[0]] || 'Mude de ferramenta ou obtenha nova evidência.'}`, loop: true, strategy: repeated[0] };
    }
    return null;
  }
  after(name, args, result, options) {
    const opts = options || {}, isFailed = failed(result), key = callKey(name, args);
    const repeatedRead = !!opts.readonly && !isFailed && this.calls.some((entry) => entry.key === key && !entry.failed && entry.state === this.state);
    this.calls.push({ key, failed: isFailed, state: this.state });
    if (isFailed && opts.strategyKey) this.strategies.push({ key: opts.strategyKey, kind: failureClass(result.error || result.message || 'erro'), state: this.state });
    if (!opts.readonly && !isFailed) this.state++;
    if (this.calls.length > this.maxEntries) this.calls = this.calls.slice(-Math.floor(this.maxEntries * .75));
    if (this.strategies.length > this.maxEntries) this.strategies = this.strategies.slice(-Math.floor(this.maxEntries * .75));
    return { repeatedRead, failed: isFailed, state: this.state };
  }
}

module.exports = { ToolGuard, callKey, failed, failureClass };
