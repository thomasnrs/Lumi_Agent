# Terminal e execução

Este domínio separa o estado de terminais da execução curta de comandos:

- `CommandRunner` normaliza timeout, cancelamento, limite de saída e resultado;
- `TerminalRegistry` isola terminais por owner, limita scrollback e faz batching de eventos;
- o adaptador Node usa `child_process` de forma assíncrona; PTY/Electron serão conectados apenas na fase de shell;
- não há IPC, `BrowserWindow`, SSHFS ou `node-pty` dentro do domínio.

O roteamento local/remoto está em `domains/remote/workspace-command-router.js`; o adaptador SSH fica em `adapters/process`.
