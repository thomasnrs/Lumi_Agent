# Plano de evolução da Lumi

Este documento transforma a análise técnica do projeto em um roadmap executável. A ordem prioriza riscos de segurança, crashes e vazamentos de memória antes de refatorações maiores ou novas funcionalidades.

## Objetivos

- Reduzir crashes, travamentos e crescimento progressivo de memória.
- Proteger o workspace e os canais IPC do Electron.
- Tornar o código mais fácil de manter sem interromper o desenvolvimento da Lumi.
- Criar testes e diagnósticos que evitem regressões.
- Melhorar performance do processo principal e dos renderers.
- Reduzir dependências, vulnerabilidades e tamanho da distribuição.

## Princípios de execução

- Fazer mudanças pequenas, verificáveis e com commits atômicos.
- Não misturar correções de estabilidade com grandes mudanças visuais ou funcionalidades.
- Preservar compatibilidade com Windows e Linux.
- Medir memória, CPU e tempo antes e depois das mudanças relevantes.
- Extrair módulos aos poucos; não reescrever o `main.js` inteiro de uma vez.
- Toda correção de bug importante deve ganhar um teste de regressão.

---

## Fase 0 — Preparação e linha de base

Prioridade: imediata.

### Tarefas

- [ ] Finalizar, verificar e separar as alterações atuais do Claude Code/OpenCode.
- [ ] Revisar os arquivos não rastreados `$null`, `Output` e `print/`.
- [ ] Adicionar ao `.gitignore` apenas artefatos comprovadamente temporários.
- [ ] Registrar uma linha de base de memória:
  - processo principal;
  - renderer do avatar;
  - renderer do chat;
  - renderer da workspace;
  - memória após 10, 30 e 60 minutos de uso;
  - memória antes e depois de buscas, tool calls, troca de chat e exclusão de arquivos.
- [ ] Registrar cenários de reprodução dos crashes já observados.
- [ ] Definir uma checklist manual mínima para Windows e Linux.

### Critério de conclusão

Existe uma medição reproduzível do estado atual e as mudanças pendentes estão organizadas sem arquivos temporários misturados.

---

## Fase 1 — Segurança de workspace e IPC

Prioridade: crítica.

### 1.1 Corrigir validação de caminhos

O `safeWsPath` atual usa comparação por prefixo com `startsWith`, o que pode confundir pastas irmãs como `project` e `project-backup`.

- [ ] Trocar a validação por `path.relative`.
- [ ] Bloquear caminhos absolutos quando o handler espera caminhos relativos.
- [ ] Bloquear travessia com `..`.
- [ ] Considerar diferenças de caixa no Windows.
- [ ] Validar links simbólicos quando a operação puder escrever ou apagar arquivos.
- [ ] Aplicar a mesma função central a leitura, escrita, importação, exclusão e watcher.

Exemplo de regra:

```js
const relative = path.relative(workspaceRoot, target);
const inside =
  relative === '' ||
  (!relative.startsWith('..' + path.sep) &&
    relative !== '..' &&
    !path.isAbsolute(relative));
```

### 1.2 Endurecer os canais IPC

- [ ] Criar uma lista central dos canais expostos pelo preload.
- [ ] Validar formato, tamanho e tipos dos argumentos de cada canal.
- [ ] Verificar `event.senderFrame` e a origem da página quando aplicável.
- [ ] Não aceitar caminhos, comandos ou URLs diretamente sem normalização.
- [ ] Limitar payloads grandes enviados entre main, janelas e iframes.
- [ ] Revisar handlers que escrevem, apagam, executam comandos ou abrem URLs.
- [ ] Evitar expor primitivas genéricas demais no `contextBridge`.

### 1.3 Revisar configuração das janelas

- [ ] Justificar ou remover `nodeIntegrationInSubFrames`.
- [ ] Justificar ou remover `webviewTag`.
- [ ] Garantir `contextIsolation: true`, `nodeIntegration: false` e sandbox onde viável.
- [ ] Criar um preload mínimo por tipo de janela.
- [ ] Bloquear navegação externa e abertura inesperada de novas janelas.
- [ ] Permitir URLs externas apenas por uma função validada.

### Critério de conclusão

Nenhum handler sensível aceita caminhos fora do workspace ou payloads sem validação, e cada janela possui apenas as capacidades necessárias.

---

## Fase 2 — Estabilidade, memória e ciclo de vida

Prioridade: crítica.

### 2.1 Criar um registro central de recursos descartáveis

- [ ] Implementar um utilitário `DisposableRegistry`.
- [ ] Registrar nele:
  - `setTimeout`;
  - `setInterval`;
  - listeners de DOM;
  - listeners IPC;
  - watchers;
  - WebSockets;
  - processos filhos;
  - terminais PTY;
  - hooks globais;
  - janelas auxiliares.
- [ ] Descartar os recursos ao fechar/recarregar cada janela.
- [ ] Impedir registro duplicado de listeners após reload de página ou iframe.
- [ ] Garantir cleanup no `before-quit` e `will-quit`.

### 2.2 Auditar pontos com maior risco de vazamento

- [ ] `BrowserWindow.getAllWindows()` e broadcasts para frames descartados.
- [ ] Timers do chat, estatísticas, lembretes, cursor e watchers.
- [ ] `pendingPerms`, `pendingAsk`, `steerQueue`, checkpoints e mapas de sessões.
- [ ] Buffers de terminal e processos que já encerraram.
- [ ] WebSockets e streams SSE interrompidos.
- [ ] Subagentes executados em paralelo.
- [ ] Eventos persistidos do chat e histórico compactado.
- [ ] Object URLs, imagens base64, screenshots e previews.
- [ ] Monaco models e editores após fechar ou excluir arquivos.

### 2.3 Melhorar virtualização do chat

- [ ] Manter o histórico completo em memória estruturada ou no disco.
- [ ] Renderizar somente mensagens próximas ao viewport.
- [ ] Desmontar DOM pesado fora da área visível.
- [ ] Manter placeholders com a altura estimada para preservar o scroll.
- [ ] Reidratar mensagens quando o usuário rolar para cima.
- [ ] Descartar previews, diffs e imagens que estiverem longe do viewport.
- [ ] Limitar animações e atualizações durante streaming.
- [ ] Testar histórico com milhares de mensagens e tool calls.

### 2.4 Tornar `find_in_code` mais eficiente

- [ ] Preferir `rg` como mecanismo principal quando disponível.
- [ ] Usar busca Node apenas como fallback.
- [ ] Executar a busca em processo filho ou worker, nunca bloqueando o main.
- [ ] Cancelar a busca quando começar outra ou quando o turno for interrompido.
- [ ] Aplicar limites explícitos de:
  - tempo;
  - arquivos;
  - bytes;
  - resultados;
  - tamanho por linha.
- [ ] Ignorar binários, dependências, builds, caches e arquivos gigantes.
- [ ] Fazer streaming ou paginação dos resultados.
- [ ] Não guardar o conteúdo completo dos arquivos após a busca.

### 2.5 Corrigir ciclo de vida do editor

- [ ] Ao excluir arquivo, fechar menus, diálogos e overlays relacionados.
- [ ] Restaurar foco para um input/editor válido.
- [ ] Descartar o Monaco model do arquivo removido.
- [ ] Remover referências ao arquivo das abas, seleção e cache.
- [ ] Garantir que nenhuma camada invisível continue capturando teclado ou ponteiro.
- [ ] Adicionar teste de regressão para o bug em que todos os inputs paravam após exclusão.

### Critério de conclusão

Os cenários longos de chat, busca e edição não apresentam crescimento contínuo de memória, processos zumbis ou perda de foco.

---

## Fase 3 — Separação gradual do `main.js`

Prioridade: alta.

O `src/main/main.js` possui aproximadamente nove mil linhas e concentra configuração, IA, ferramentas, janelas, terminal, SSH, Docker, chat e persistência. A extração deve ser incremental.

### Estrutura sugerida

```text
src/main/
  main.js
  app/
    lifecycle.js
    windows.js
    broadcast.js
  config/
    defaults.js
    store.js
  ipc/
    register.js
    schemas.js
    workspace.js
    chat.js
    terminal.js
  ai/
    agent-loop.js
    context.js
    compaction.js
    usage.js
    providers/
      openai.js
      anthropic.js
      opencode.js
      claude-code.js
  tools/
    registry.js
    filesystem.js
    search.js
    terminal.js
    web.js
    computer.js
    mcp.js
  workspace/
    paths.js
    watcher.js
    memory.js
  services/
    ssh.js
    docker.js
    server.js
    reminders.js
  persistence/
    json-store.js
    chats.js
```

### Ordem de extração

- [ ] Funções puras: tokens, limites, compactação, diffs e normalização.
- [ ] Configuração e persistência.
- [ ] Validação de caminhos.
- [ ] Broadcast e batching.
- [ ] Adaptadores de provedores.
- [ ] Registro e execução de ferramentas.
- [ ] Terminal, Docker, SSH e servidor.
- [ ] Criação de janelas e lifecycle.
- [ ] Deixar o `main.js` somente como composição e bootstrap.

### Regras

- [ ] Uma extração por commit.
- [ ] Nenhuma mudança de comportamento durante extração.
- [ ] Manter interfaces explícitas entre módulos.
- [ ] Evitar estado global novo; encapsular estado em serviços.
- [ ] Adicionar testes antes ou junto da extração de funções críticas.

### Critério de conclusão

O `main.js` se torna um ponto de entrada pequeno, e cada domínio pode ser testado ou alterado isoladamente.

---

## Fase 4 — Testes e qualidade automatizada

Prioridade: alta.

### 4.1 Infraestrutura

- [ ] Escolher um runner leve para testes unitários.
- [ ] Adicionar scripts:
  - `test`;
  - `test:watch`;
  - `lint`;
  - `check`;
  - `audit`.
- [ ] Configurar CI no GitHub Actions para Windows e Linux.
- [ ] Rodar build, testes, lint e verificação de segurança em cada PR.

### 4.2 Testes unitários prioritários

- [ ] `safeWsPath` e traversal.
- [ ] conversão OpenAI → Anthropic;
- [ ] parser de tool calls em texto;
- [ ] compactação de contexto;
- [ ] estimativa e limites de tokens;
- [ ] sanitização do histórico;
- [ ] normalização de emoções;
- [ ] parser de busca;
- [ ] persistência atômica;
- [ ] roteamento dos provedores;
- [ ] seleção e fallback de modelos.

### 4.3 Testes de integração

- [ ] Chat com streaming e interrupção.
- [ ] Tool call seguida de tool result.
- [ ] Fallback de modelo.
- [ ] Claude Code com sessão simulada.
- [ ] OpenCode por cada protocolo suportado.
- [ ] Exclusão e importação de arquivos.
- [ ] Reinício do app mantendo chats e configurações.
- [ ] Watcher local e workspace remoto.
- [ ] Fechamento de terminais e processos.

### 4.4 Testes de estresse

- [ ] Milhares de mensagens no chat.
- [ ] Centenas de tool calls e diffs.
- [ ] Busca repetida em projeto grande.
- [ ] Várias sessões e subagentes.
- [ ] Abrir e fechar a workspace repetidamente.
- [ ] Uma hora de streaming e uso contínuo.

### Critério de conclusão

Os fluxos críticos possuem testes de regressão e toda alteração passa por uma verificação automatizada mínima.

---

## Fase 5 — Performance do processo principal

Prioridade: alta.

### 5.1 Remover I/O síncrono dos caminhos quentes

- [ ] Mapear `readFileSync`, `writeFileSync`, `statSync`, `readdirSync` e `execSync`.
- [ ] Manter sync apenas no bootstrap ou em operações realmente pequenas.
- [ ] Migrar operações de chat, busca, workspace e persistência para APIs assíncronas.
- [ ] Evitar serializar objetos gigantes repetidamente para estimar tokens.
- [ ] Cachear resultados estáveis com invalidação clara.

### 5.2 Tirar trabalho pesado do main

- [ ] Mover busca, diff grande e varredura de projeto para worker/processo filho.
- [ ] Usar fila com cancelamento e concorrência limitada.
- [ ] Evitar múltiplas buscas ou verificações simultâneas sobre o mesmo workspace.
- [ ] Aplicar backpressure aos streams e IPC.

### 5.3 Melhorar algoritmos custosos

- [ ] Substituir o LCS quadrático de diffs grandes por biblioteca/algoritmo apropriado ou processo isolado.
- [ ] Manter o resumo de diff para arquivos grandes.
- [ ] Evitar reconstruir todo o system prompt em cada etapa quando partes não mudaram.
- [ ] Separar contexto estático, contexto de projeto e contexto do turno.
- [ ] Invalidar o cache somente quando configuração, memória ou workspace mudar.

### Critério de conclusão

Buscas, diffs e persistência não congelam a UI, e o event loop do processo principal permanece responsivo.

---

## Fase 6 — Persistência robusta

Prioridade: alta.

### Tarefas

- [ ] Criar um `JsonStore` central.
- [ ] Escrever em arquivo temporário e renomear atomicamente.
- [ ] Usar uma fila por arquivo para evitar escritas concorrentes.
- [ ] Manter backup válido da última versão.
- [ ] Validar o schema ao carregar configurações, histórico, fatos e uso.
- [ ] Recuperar automaticamente arquivos truncados ou corrompidos.
- [ ] Versionar formatos persistidos e criar migrações.
- [ ] Limitar tamanho e retenção de:
  - logs;
  - eventos do chat;
  - histórico;
  - checkpoints;
  - uso diário;
  - memória técnica.

### Critério de conclusão

Uma queda ou encerramento durante escrita não corrompe configurações nem conversas.

---

## Fase 7 — Contratos e validação de dados

Prioridade: média-alta.

### Tarefas

- [ ] Adotar validação de runtime para configurações, IPC e argumentos de tools.
- [ ] Compartilhar contratos entre main, preload e renderer.
- [ ] Padronizar respostas:
  - `{ ok: true, data }`;
  - `{ ok: false, error, code }`.
- [ ] Padronizar erros de permissão, cancelamento, timeout e indisponibilidade.
- [ ] Validar configurações de provedores antes de iniciar o turno.
- [ ] Validar tools vindas de modelos e MCP antes da execução.
- [ ] Considerar migração gradual para TypeScript ou JSDoc tipado.

### Critério de conclusão

Payloads inválidos falham cedo, com erro claro, sem derrubar o processo ou deixar estado parcial.

---

## Fase 8 — Dependências e cadeia de distribuição

Prioridade: média-alta.

### Situação observada

- O audit de produção encontrou vulnerabilidades, incluindo uma de severidade alta na cadeia do MCP/Hono.
- Algumas dependências diretas parecem não ser usadas diretamente pelo código, como `cors`, `express`, `socket.io` e `uuid`.
- Dependências nativas e de automação aumentam o tamanho e a superfície de falhas.

### Tarefas

- [ ] Atualizar `@modelcontextprotocol/sdk` e confirmar a correção do `hono`.
- [ ] Revisar vulnerabilidades transitivas do Jimp, `file-type` e nut-js.
- [ ] Confirmar uso real de cada dependência direta.
- [ ] Remover dependências diretas não utilizadas.
- [ ] Separar dependências opcionais quando a funcionalidade puder ser desativada.
- [ ] Fixar versões críticas usadas no empacotamento.
- [ ] Testar instalação limpa e build reproduzível.
- [ ] Medir tamanho do instalador antes e depois.
- [ ] Documentar requisitos de módulos nativos por plataforma.

### Critério de conclusão

Não há vulnerabilidade alta com correção disponível ignorada, e cada dependência direta possui uma finalidade conhecida.

---

## Fase 9 — Diagnóstico dentro da própria Lumi

Prioridade: média.

### Painel de diagnóstico sugerido

- [ ] Uso de memória por processo Electron.
- [ ] CPU por processo.
- [ ] Quantidade de janelas e frames.
- [ ] Listeners, timers, watchers e WebSockets ativos.
- [ ] Terminais e processos filhos.
- [ ] Tamanho do histórico e quantidade de mensagens renderizadas.
- [ ] Tokens do contexto, reserva e ponto de compactação.
- [ ] Tamanho dos arquivos persistidos.
- [ ] Últimos erros e rejeições não tratadas.
- [ ] Estado dos provedores, MCPs, Claude Code e OpenCode.
- [ ] Botão para exportar diagnóstico sem incluir segredos.

### Instrumentação

- [ ] Adicionar IDs de correlação por turno e tool call.
- [ ] Registrar início, fim, duração, cancelamento e erro.
- [ ] Nunca registrar API keys, tokens OAuth, valores de `.env` ou conteúdo sensível.
- [ ] Rotacionar logs por tamanho e quantidade.
- [ ] Expor uma forma simples de gerar relatório para bugs.

### Critério de conclusão

Quando ocorrer um crash ou lentidão, é possível identificar o subsistema e o recurso acumulado sem depender apenas de tentativa e erro.

---

## Fase 10 — Organização dos renderers

Prioridade: média.

Os arquivos `chat.html` e `workspace.html` também cresceram bastante e misturam estrutura, estilo, estado e comportamento.

### Tarefas

- [ ] Extrair CSS para folhas organizadas por página e componentes.
- [ ] Extrair scripts inline para módulos.
- [ ] Separar componentes de:
  - mensagens;
  - tool calls;
  - diffs;
  - permissões;
  - estatísticas;
  - terminal;
  - árvore de arquivos;
  - configuração de provedores.
- [ ] Criar um pequeno store por página em vez de muitas variáveis globais.
- [ ] Centralizar registro e cleanup de eventos.
- [ ] Preservar o visual atual durante a extração.
- [ ] Adicionar acessibilidade de teclado, foco visível e estados ARIA.

### Critério de conclusão

Cada página possui módulos menores e pode ser alterada sem percorrer milhares de linhas de HTML, CSS e JavaScript misturados.

---

## Ordem recomendada de entregas

### Marco 1 — Blindagem

- Fase 0.
- Validação segura de caminhos.
- Validação dos IPCs sensíveis.
- Revisão das configurações Electron.
- Persistência atômica básica.

### Marco 2 — Estabilidade

- Registro de recursos descartáveis.
- Cleanup de timers, listeners, streams, terminais e watchers.
- Busca de código cancelável e fora do processo principal.
- Regressão da exclusão de arquivos.
- Virtualização completa do chat.

### Marco 3 — Base sustentável

- Infraestrutura de testes.
- Extração das funções puras.
- Separação gradual do `main.js`.
- Contratos compartilhados.

### Marco 4 — Performance e manutenção

- Migração de I/O síncrono.
- Workers/processos filhos.
- Cache de contexto e prompts.
- Organização dos renderers.

### Marco 5 — Operação confiável

- Painel de diagnóstico.
- CI multiplataforma.
- Auditoria e limpeza de dependências.
- Testes de estresse e soak test.

---

## Checklist para cada mudança

- [ ] O comportamento anterior foi preservado onde não fazia parte da tarefa?
- [ ] Existe teste ou cenário manual reproduzível?
- [ ] A mudança libera timers, listeners, streams e processos?
- [ ] Caminhos e payloads externos foram validados?
- [ ] Erros e cancelamentos deixam o estado consistente?
- [ ] O processo principal continua responsivo?
- [ ] O histórico e a sessão continuam funcionando após reiniciar?
- [ ] Windows e Linux foram considerados?
- [ ] Nenhum segredo foi registrado ou enviado para a UI?
- [ ] Build, testes e `git diff --check` passaram?

---

## Primeira sequência prática sugerida

1. Corrigir `safeWsPath` e adicionar seus testes.
2. Criar persistência JSON atômica.
3. Introduzir `DisposableRegistry`.
4. Auditar e corrigir o lifecycle do chat e da workspace.
5. Migrar `find_in_code` para `rg` cancelável em processo filho.
6. Adicionar virtualização e descarte de conteúdo pesado do chat.
7. Criar testes para contexto, tool calls e provedores.
8. Começar a extração do `main.js` pelas funções puras.
9. Atualizar/remover dependências problemáticas.
10. Criar o painel de diagnóstico e executar um teste contínuo de uma hora.

