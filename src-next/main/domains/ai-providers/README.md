# AI providers

Camada isolada de protocolos de rede do agente:

- SSE incremental com chunks arbitrários e CRLF;
- rate limiter por provider/base/chave hasheada;
- retry único de `429` quando RPS explícito está ativo;
- contrato comum para texto, thinking, tool calls, usage e abort parcial;
- OpenAI Chat Completions, Anthropic Messages, OpenAI Responses e Gemini GenerateContent;
- roteamento OpenCode por família de modelo;
- registry explícito de adapters e capabilities observadas;
- continuidade nativa da Responses API preservada por `responseItems`.

Pendente antes de concluir o domínio: catálogo/cache de modelos, política de fallback, accounting de usage e fixtures de compatibilidade por provedor real. Esta pasta continua desconectada do runtime atual.
