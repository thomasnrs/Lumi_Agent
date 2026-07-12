# Config domain

Base do futuro domínio de configuração.

Implementado:

- carregamento por store injetado;
- merge profundo de defaults;
- migrations sequenciais por `schemaVersion`;
- bloqueio de versões futuras;
- validação injetável;
- cópias defensivas em leitura e escrita.

Ainda pendente antes de marcar o domínio como migrado:

- portar e organizar todos os defaults atuais;
- definir schema completo e campos secretos;
- mapear configuração global versus configuração por chat;
- migrations dos formatos já distribuídos;
- compatibilidade de ida e volta durante a janela de rollback;
- fixtures reais de `config.json` sem credenciais.
