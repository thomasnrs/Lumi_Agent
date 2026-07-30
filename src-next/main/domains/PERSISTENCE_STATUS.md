# Estado da persistência isolada

Implementado e coberto por fixtures legacy: facts, usage diário, reminders, scheduled tasks, chats por arquivo e artifacts content-addressed.

Garantias atuais:

- escrita JSON atômica, backup e recuperação de corrupção;
- limites defensivos e cópias contra mutação externa;
- coalescing de snapshots de chat;
- chat apagado não pode ser recriado por write atrasado;
- paths derivados de IDs validados;
- hash de artifacts validado e retenção por idade, quantidade e bytes.

Sessões vivas também possuem implementação isolada: foreground/background, AsyncLocalStorage, troca que preserva identidade, cancelamento antes de delete, limite de sessões ociosas e snapshot que separa estado durável do efêmero.

## Escopo por projeto

Memória não é global por padrão. Cada fato carrega `scope`:

- `user` — vale em qualquer projeto (quem o usuário é, preferências, jeito de trabalhar);
- `project` — vale só no projeto onde foi aprendido, identificado por `project` e comparado por `scopeKey` (`domains/workspace/workspace-path.js`), que canoniza barra, caixa no Windows e caminho relativo.

Consequências garantidas por teste (`tests/memory-scope.test.js`):

- `listForScope(workspace)` nunca devolve fato de outro projeto;
- fato legado sem `scope` continua valendo como `user`, então nada some na migração;
- retenção é **por escopo** (100 de usuário + 60 por projeto): um projeto movimentado não expulsa mais os fatos dos outros nem os do usuário;
- ledger e worklog só entram no prompt do projeto que os registrou (`entriesForWorkspace`), e entrada sem carimbo só passa quando a conversa também não tem projeto conhecido;
- subagente em worktree Git temporário usa `projectRoot` como projeto lógico, então o caminho efêmero não descarta o diário do projeto real.

Ainda pendente: memória `.lumi-memory.md`, montagem de ledger/context, timers do aplicativo e migrations reais completas da configuração.
