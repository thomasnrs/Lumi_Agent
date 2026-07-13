'use strict';

function posixShellQuote(value) { return `'${String(value == null ? '' : value).replace(/'/g, "'\\''")}'`; }
function remoteShellCommand(command, cwd) { return `cd -- ${posixShellQuote(cwd || '.')} && ${String(command || '')}`; }

class SshCommandExecutor {
  constructor(options) {
    const opts = options || {};
    if (!opts.commandRunner || typeof opts.commandRunner.run !== 'function') throw new Error('SshCommandExecutor exige commandRunner');
    this.commandRunner = opts.commandRunner;
    this.sshBinary = opts.sshBinary || 'ssh';
    this.baseArgs = opts.baseArgs || ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new'];
  }
  execute(input) {
    const request = input || {};
    if (!request.host) return Promise.resolve({ ok: false, error: 'host SSH vazio', stdout: '', stderr: '', exitCode: null });
    const remoteCommand = remoteShellCommand(request.command, request.cwd);
    return this.commandRunner.run({ file: this.sshBinary, args: [...this.baseArgs, String(request.host), remoteCommand], cwd: undefined, timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes, signal: request.signal, shell: false });
  }
}

module.exports = { SshCommandExecutor, posixShellQuote, remoteShellCommand };
