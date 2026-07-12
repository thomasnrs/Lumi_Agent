# Agent runtime

Loop agêntico isolado e livre de Electron/globals.

- passos e teto configuráveis;
- compactação e provider recebidos por portas explícitas;
- steering antes do passo e também quando chega durante a resposta final;
- continuidade por `_responsesItems` para Responses API;
- tool calls normalizadas, resultados multimodais e execução ordenada;
- desativação aprendida de tools somente para erro explícito de incompatibilidade;
- ledger técnico e gate único de evidência após alterações de código;
- cancelamento e resultado distinguem conclusão, aborto e teto de passos.

Auto-verificação, auto-revisão, checkpoints e subagentes serão conectados como políticas/ports nas próximas ondas, sem alterar este loop central.
