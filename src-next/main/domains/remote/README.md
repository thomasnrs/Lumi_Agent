# Remote

O roteador remoto recebe o contexto de mount por porta e escolhe local ou SSH de forma explícita.
Ele converte somente caminhos descendentes do mount para a pasta remota e recusa `cwd` externo, evitando executar acidentalmente no host errado.

Montagem SSHFS, hosts recentes, painel de servidor e IPC serão migrados em ondas seguintes. Nada daqui importa Electron ou o runtime atual.
