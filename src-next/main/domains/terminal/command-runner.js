'use strict';

function clampNumber(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback));
}

/**
 * Contrato de execução curta de processos. O domínio não conhece child_process:
 * processPort.execute recebe { command|file,args,cwd,env,shell,timeoutMs,
 * maxOutputBytes,signal } e retorna stdout/stderr/exitCode ou lança em falha
 * de inicialização.
 */
class CommandRunner {
  constructor(options) {
    const opts = options || {};
    if (!opts.processPort || typeof opts.processPort.execute !== 'function') throw new Error('CommandRunner exige processPort.execute');
    this.processPort = opts.processPort;
    this.clock = opts.clock || { now: () => Date.now() };
    this.defaultTimeoutMs = clampNumber(opts.defaultTimeoutMs, 1000, 15 * 60 * 1000, 20000);
    this.defaultMaxOutputBytes = clampNumber(opts.defaultMaxOutputBytes, 1024, 64 * 1024 * 1024, 1024 * 1024);
  }

  async run(input) {
    const request = input || {};
    const command = request.command == null ? '' : String(request.command);
    const file = request.file == null ? '' : String(request.file);
    if (!command && !file) return { ok: false, error: 'comando vazio', stdout: '', stderr: '', exitCode: null };
    const startedAt = this.clock.now();
    const normalized = {
      command: command || undefined,
      file: file || undefined,
      args: Array.isArray(request.args) ? request.args.map(String) : [],
      cwd: request.cwd || undefined,
      env: request.env && typeof request.env === 'object' ? request.env : undefined,
      shell: request.shell !== false,
      timeoutMs: clampNumber(request.timeoutMs, 1000, 15 * 60 * 1000, this.defaultTimeoutMs),
      maxOutputBytes: clampNumber(request.maxOutputBytes, 1024, 64 * 1024 * 1024, this.defaultMaxOutputBytes),
      signal: request.signal,
    };
    try {
      const raw = await this.processPort.execute(normalized);
      const exitCode = raw && raw.exitCode != null ? Number(raw.exitCode) : 0;
      const timedOut = !!(raw && raw.timedOut), aborted = !!(raw && raw.aborted), outputLimited = !!(raw && raw.outputLimited), portError = raw && raw.error;
      const ok = !portError && !timedOut && !aborted && !outputLimited && exitCode === 0;
      const stderr = String(raw && raw.stderr || '');
      return {
        ok,
        command: command || [file, ...normalized.args].join(' '),
        cwd: normalized.cwd || '',
        stdout: String(raw && raw.stdout || ''),
        stderr,
        exitCode,
        timedOut,
        aborted,
        outputLimited,
        durationMs: Math.max(0, this.clock.now() - startedAt),
        ...(portError ? { error: String(portError) } : !ok && !stderr ? { error: timedOut ? 'comando excedeu o tempo limite' : aborted ? 'comando cancelado' : outputLimited ? 'saída do comando excedeu o limite configurado' : `comando terminou com código ${exitCode}` } : {}),
      };
    } catch (error) {
      return {
        ok: false, command: command || [file, ...normalized.args].join(' '), cwd: normalized.cwd || '', stdout: String(error && error.stdout || ''), stderr: String(error && error.stderr || ''),
        exitCode: error && Number.isFinite(Number(error.exitCode)) ? Number(error.exitCode) : null,
        timedOut: !!(error && error.timedOut), aborted: !!(error && error.aborted), outputLimited: !!(error && error.outputLimited),
        durationMs: Math.max(0, this.clock.now() - startedAt), error: String(error && error.message || error || 'não consegui iniciar o comando'),
      };
    }
  }
}

module.exports = { CommandRunner, clampNumber };
