# Tools

Núcleo isolado do registro e da execução de ferramentas.

- registro único rejeita nomes duplicados;
- schemas podem ser filtrados por allowlist ou toolset;
- aliases comuns são normalizados sem alterar o payload original;
- permissão, locks, checkpoints/artifacts e eventos entram por portas injetadas;
- leituras seguras paralelizam em lotes, mutações preservam barreiras e ordem;
- anti-loop diferencia chamada idêntica, estratégia repetida e releitura sem mudança de estado.

As implementações concretas das ferramentas serão migradas por domínio (workspace, Git, terminal, remoto, web, sistema e mídia). Este módulo não importa Electron nem o monólito.
