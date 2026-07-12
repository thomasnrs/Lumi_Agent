# Workspace core

Operações de arquivos isoladas para workspaces locais ou montados remotamente, sempre via uma porta de filesystem:

- paths confinados à raiz do workspace;
- leitura paginada com detecção UTF-8, BOM, UTF-16 e Windows-1252;
- escrita protegida contra sobrescrita cega e edição tolerante a CRLF/LF;
- eventos de mutação com resumo de diff;
- busca assíncrona limitada, sem varrer diretórios pesados;
- factories para registrar as ferramentas de arquivos no núcleo de tools.

Watchers, ripgrep, árvore/editor, stack detection, Git e remoto entram em módulos complementares. Nada deste domínio acessa Electron ou o monólito.
