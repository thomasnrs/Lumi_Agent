# Changelog

Todas as mudanças relevantes da Lumi são registradas aqui.

## [Não publicado]

### Memória separada por projeto

- **Fatos agora têm escopo.** `remember_fact` escolhe entre `user` (vale sempre) e `project` (só naquele projeto). Antes tudo ia para um `facts.json` global e reaparecia em qualquer conversa, de qualquer projeto.
- **Retenção por escopo**: 100 fatos de usuário e 60 por projeto, em vez de um teto global de 100 — um projeto movimentado não expulsa mais a memória dos outros.
- **Diário técnico carimbado**: cada entrada de worklog/ledger guarda o projeto em que foi registrada e só volta ao contexto naquele projeto. Fork e compactação deixaram de semear a conversa nova com registro de outro projeto.
- **Conversa lembra a que projeto pertence**: o campo `workspace` do chat passou a ser realmente persistido e lido (antes era gravado na criação e perdido no primeiro save).
- **Subagentes isolados**: o worktree Git temporário não é mais confundido com o projeto — memória e diário seguem o projeto lógico.
- **Página de memória** mostra o escopo de cada fato e permite reclassificar entre geral e projeto.
- Fatos antigos sem escopo continuam valendo como fatos de usuário: nada é perdido na migração.

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
