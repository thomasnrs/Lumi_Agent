# Changelog

Todas as mudanças relevantes da Lumi são registradas aqui.

## [1.1.0] — 2026-07-02

### Destaques

- Integração completa do Codex oficial via `codex app-server`, reutilizando com segurança a autenticação ChatGPT já existente no computador.
- Threads do Codex persistentes por chat e workspace, com streaming, ferramentas, comandos, diffs, planos, subagentes, aprovações, steering, stop, compactação e rate limits no HUD.
- Claude Code com sessões paralelas, perguntas/confirmações integradas, níveis de raciocínio ampliados e melhor reaproveitamento do login local.
- Chats e workspaces verdadeiramente paralelos: cada janela mantém arquivos, contexto, terminais e motor de código isolados.
- Novo design system compartilhado entre as páginas internas e refinamento visual geral.
- Presets gráficos Batata/Economia/Performance para reduzir CPU e GPU em máquinas modestas.
- Controles de janela estilo macOS em Windows e Linux.
- Ícones de arquivos e stacks baseados no Material Icon Theme.
- Tarefas agendadas, sentinela de logs e indicador de trabalho nas conversas.

### Engenharia e estabilidade

- Harness de desenvolvimento expandido com outline, busca de usos, stack traces, informações do ambiente, consultas de banco, diagnósticos estruturados e testes focados.
- Busca de código assíncrona e limitada para evitar travamentos em projetos grandes.
- Edições mais resilientes a CRLF, encoding e pequenas divergências no trecho original.
- Contexto técnico em camadas, compactação melhorada e histórico virtualizado para chats longos.
- Caches e batching em caminhos quentes, terminal e diffs mais eficientes.
- Guardrails, anti-loop, checkpoints, auto-verificação e auto-revisão fortalecidos.
- Correções em inputs após excluir arquivos, confirmações do Claude Code, tool calls inválidas, duplicidade de IPC e slider de transparência.

### Plataforma

- Auto-detecção do Codex instalado pelo CLI, VS Code, VS Code Insiders, Cursor e caminhos comuns em Windows, Linux e macOS.
- Melhorias de Linux/X11, terminais por janela, Remote SSH e persistência de tamanho/posição das janelas.

[1.1.0]: https://github.com/thomasnrs/Lumi_Agent/compare/v1.0.3...v1.1.0
