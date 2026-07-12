# Plano de refatoração paralela — Lumi `src-next`

## Objetivo

Substituir gradualmente o monólito atual por uma arquitetura modular sem interromper o uso diário da Lumi e sem conectar código incompleto ao aplicativo funcional.

O código atual em `src/` permanece como fonte de produção durante toda a migração. O código novo vive em `src-next/`, fora do entrypoint, do bundle e do empacotamento. A conexão acontece somente em um cutover atômico depois que todos os módulos atingirem paridade funcional e operacional.

## Regra principal

> `src/` nunca importa `src-next/` durante a migração.

- Nada de feature flags apontando parcialmente para a implementação nova.
- Nada de trocar um IPC isolado no aplicativo em produção.
- Nada de compartilhar estado global entre as árvores.
- `src-next/` pode reutilizar algoritmos e comportamento já provados, mas recebe cópias extraídas, dependências explícitas e testes próprios.
- Correções urgentes continuam sendo feitas em `src/`; quando afetarem código já migrado, devem ser portadas conscientemente para `src-next/`.

## Por que uma árvore paralela

O processo principal atual possui aproximadamente 15 mil linhas e concentra janelas, chats, providers, agente, ferramentas, SSH, terminal, workspace, Git, sistema, memória, mídia, banco, voz e dezenas de handlers IPC. Extrair diretamente dentro do runtime criaria um período longo em que metade da Lumi usaria arquitetura antiga e metade usaria arquitetura nova.

A árvore paralela permite:

- continuar publicando correções no monólito;
- testar módulos novos sem Electron e sem estado global;
- comparar resultados antigos e novos com fixtures;
- descartar ou redesenhar um módulo sem afetar usuários;
- fazer uma única troca reversível ao final.

## Estado de isolamento inicial

- Entry point: `src/main/main.js`.
- Renderer build: `src/renderer/main.js` → `src/renderer/renderer.bundle.js`.
- Empacotamento: somente `src/**/*`.
- Ofuscação de release: caminhos explícitos em `src/main/`.
- `src-next/` não é importado, empacotado nem executado pela Lumi atual.

## Arquitetura-alvo

```text
src-next/
├── architecture/       decisões, mapa e manifesto de migração
├── main/
│   ├── bootstrap/      composition root e ordem de inicialização
│   ├── core/           lifecycle, DI, eventos, erros e observabilidade
│   ├── domains/        regras de negócio sem dependência direta de Electron
│   └── adapters/       Electron, filesystem, processos, rede e bancos
├── preload/            ponte IPC tipada e mínima
├── renderer/           shells e features visuais por domínio
├── shared/             contratos serializáveis e schemas
└── tests/              unitários, contratos, fixtures, integração e E2E
```

## Regras arquiteturais

1. Apenas `bootstrap` conhece todos os módulos.
2. Domínios não importam Electron, `ipcMain`, `BrowserWindow`, `dialog` ou caminhos globais.
3. Adapters implementam portas exigidas pelos domínios.
4. Estado pertence a uma instância explícita de serviço, chat, janela ou workspace.
5. Todo serviço com recursos possui `start()` e `stop()`/`dispose()` idempotentes.
6. Toda operação longa aceita cancelamento e possui timeout na borda apropriada.
7. IPC é registrado por um único registry que rejeita canais duplicados.
8. Payloads externos são validados antes de chegar ao domínio.
9. Logs usam eventos estruturados e removem segredos na origem.
10. Nenhum domínio acessa configuração ou filesystem por singleton oculto.

## Ondas de implementação

### Fase 0 — baseline e inventário

- Congelar o inventário de canais IPC, ferramentas, providers e formatos persistidos.
- Registrar fixtures de SSE, tool calls, erros e respostas reais sem segredos.
- Medir boot, memória, CPU ociosa, event-loop lag, FPS e operações críticas.
- Criar testes de caracterização para comportamentos que ainda não têm cobertura.

Saída: baseline reproduzível e manifesto completo.

### Fase 1 — fundação independente

- Lifecycle e descarte ordenado.
- Container de dependências explícitas.
- Event bus local e tipado por contrato.
- Erros normalizados.
- Logger estruturado, redaction e métricas.
- Clock, IDs e scheduler injetáveis para testes.
- Schemas e Result serializável.

Saída: core sem Electron, com testes unitários.

### Fase 2 — persistência e estado

- Configuração versionada com migrations.
- Chats, histórico, timeline e arquivos de contexto.
- Memória do usuário e do projeto.
- Usage/custos.
- Lembretes.
- Escrita atômica, backup e recuperação de arquivo corrompido.

Saída: dados antigos abrem na implementação nova e podem voltar para a antiga durante a janela de rollback.

### Fase 3 — workspace e execução

- Workspace local e remoto.
- Árvore, watchers, busca, encoding e mutações.
- Git e worktrees.
- Terminal/PTY e processos.
- SSH/SSHFS, servidor, portas e Docker.
- Diagnósticos e monitoramento do sistema.

Saída: operações locais e remotas passam pelos mesmos contratos de workspace.

### Fase 4 — runtime de IA

- Contrato único de provider e streaming.
- OpenAI-compatible, Anthropic, NVIDIA, Hugging Face e demais presets.
- Rate limiting, retry, fallback e usage.
- Context builder e compactação.
- Registro de ferramentas e permissões.
- Loop do agente, steering, planos e checkpoints.
- Subagentes, paralelismo e isolamento por worktree.
- Claude Code, Codex e outros motores CLI.

Saída: fixtures antigas e novas produzem eventos equivalentes e preservam ordem/cancelamento.

### Fase 5 — shell Electron

- Window manager e ownership de janelas.
- Registry IPC único.
- Preload mínimo por capabilities.
- Avatar, tray, atalhos, menus e click-through.
- Watchdog de renderers e restauração de estado.
- Atualizador e lifecycle do aplicativo.

Saída: processo principal novo sobe em harness próprio, ainda sem substituir a Lumi instalada.

### Fase 6 — renderer modular

- Shell compartilhado e design tokens.
- Chat virtualizado e estado por aba.
- Workspace/editor/explorer.
- Avatar e configurações gráficas.
- Configurações, memória, MCP, galeria e páginas auxiliares.
- Tratamento uniforme de loading, vazio, erro e reconexão.

Saída: build paralelo navegável em ambiente de teste, sem ser distribuído.

### Fase 7 — paridade e soak

- Testes E2E dos fluxos críticos em Windows e Linux.
- Testes de crash/reload de renderer.
- Sessões longas com chat, tools, SSH e watchers.
- Comparação de CPU, memória, event-loop lag e tempo de boot.
- Auditoria de segurança, paths, IPC e segredos.
- Validação manual de todos os canais do inventário.

Saída: relatório de paridade assinado e zero bloqueadores.

### Fase 8 — cutover atômico

- Criar branch e release candidate exclusivos.
- Alterar entrypoint/build/package somente neste momento.
- Manter o monólito congelado como rollback por pelo menos uma release.
- Migrar dados com backup e journal.
- Publicar primeiro em canal beta.
- Reverter o entrypoint se os indicadores de saúde piorarem.

## Gates obrigatórios antes do cutover

- 100% dos canais IPC inventariados e sem duplicação.
- 100% das ferramentas registradas e cobertas por contrato.
- Providers com fixtures de texto, thinking, tool call, 429, aborto e stream inválido.
- Configurações e históricos antigos migrados em cópia de teste.
- Fluxos E2E críticos verdes em Windows e Linux.
- Nenhum import de produção entre `src/` e `src-next/`.
- CPU ociosa, memória e boot iguais ou melhores que o baseline.
- Busca, diff e parsing pesado fora do event loop principal.
- Watchdog recupera renderer sem perder chat ou input.
- Plano de rollback testado, não apenas documentado.

## Fluxos E2E críticos

1. Primeiro boot e wizard.
2. Abrir/reabrir workspace e restaurar janelas.
3. Criar, editar, renomear e apagar arquivo.
4. Chat nativo com streaming, imagem, steering e stop.
5. Tool call com permissão, erro, retry e checkpoint.
6. Troca de provider/modelo por aba.
7. Subagentes paralelos e worktrees.
8. Claude Code e Codex com autenticação existente.
9. SSH remoto, terminal, Git e watchers.
10. Crash de chat/avatar/workspace e recuperação isolada.
11. Reinício durante tarefa longa e retomada.
12. Instalação e leitura contextual de `DESIGN.md`.

## Estratégia para reaproveitar código pronto

- Extrair primeiro funções puras com testes de caracterização.
- Substituir globals por argumentos/dependências durante a cópia para `src-next/`.
- Preservar formatos públicos enquanto o comportamento for compatível.
- Não “melhorar junto” uma regra complexa sem fixture; migrar fielmente e otimizar depois.
- Manter uma tabela de origem no manifesto para saber de qual área do monólito veio cada módulo.
- Portar correções feitas no monólito para módulos já migrados até o cutover.

## Política de commits

- Um módulo ou contrato por commit quando possível.
- Todo commit de migração inclui teste próprio.
- Commits em `src-next/` não alteram entrypoint, build, preload atual ou IPC atual.
- Mudanças urgentes em `src/` continuam independentes.
- Checkpoints maiores: fundação, persistência, workspace, IA, Electron, renderer e paridade.

## Próxima etapa recomendada

Completar a Fase 0: gerar inventários versionados de IPC, ferramentas, persistência e providers. Em seguida terminar o core da Fase 1 antes de copiar qualquer domínio que dependa de Electron.
