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

Ainda pendente: memória `.lumi-memory.md`, montagem de ledger/context, timers do aplicativo e migrations reais completas da configuração.
