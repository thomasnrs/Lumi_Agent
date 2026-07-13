'use strict';

const path = require('node:path');

function isInside(relative) { return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }
function remoteJoin(base, relative) {
  const prefix = String(base || '.').replace(/\\/g, '/').replace(/\/$/, '') || '.';
  const suffix = String(relative || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return !suffix || suffix === '.' ? prefix : prefix === '.' ? suffix : `${prefix}/${suffix}`;
}
function remoteWorkingDirectory(remote, localCwd) {
  const mount = remote && (remote.workspace || remote.mountPoint);
  const base = String(remote && remote.remotePath || '.');
  if (!localCwd) return base;
  if (!mount) return String(localCwd).replace(/\\/g, '/');
  const relative = path.relative(path.resolve(mount), path.resolve(localCwd));
  if (!isInside(relative)) return null;
  return remoteJoin(base, relative);
}

/** Seleciona execução local ou SSH sem deixar caminhos do mount vazarem ao servidor. */
class WorkspaceCommandRouter {
  constructor(options) {
    const opts = options || {};
    if (!opts.localRunner || typeof opts.localRunner.run !== 'function') throw new Error('WorkspaceCommandRouter exige localRunner');
    this.localRunner = opts.localRunner;
    this.remoteExecutor = opts.remoteExecutor || null;
    this.resolveRemote = opts.resolveRemote || (() => null);
  }

  async run(input) {
    const request = input || {};
    const remote = request.local ? null : request.remote || this.resolveRemote(request.context);
    if (!remote) return this.localRunner.run({ ...request, local: undefined, remote: undefined });
    if (!this.remoteExecutor || typeof this.remoteExecutor.execute !== 'function') return { ok: false, error: 'execução remota indisponível', stdout: '', stderr: '', exitCode: null };
    const cwd = remoteWorkingDirectory(remote, request.cwd);
    if (!cwd) return { ok: false, error: 'cwd está fora da workspace remota; use local=true para executar no PC local', stdout: '', stderr: '', exitCode: null };
    const result = await this.remoteExecutor.execute({ ...request, host: remote.host, cwd, remote, local: undefined, remote: undefined });
    return { ...result, remote: remote.host, cwd };
  }
}

module.exports = { WorkspaceCommandRouter, remoteWorkingDirectory, remoteJoin, isInside };
