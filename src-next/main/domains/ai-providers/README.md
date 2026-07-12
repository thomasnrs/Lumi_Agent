# AI providers

Contrato de saída comum: texto, tool calls fragmentadas, usage, duração e estado de aborto.

Implementado isoladamente:

- SSE incremental com chunks arbitrários e CRLF;
- rate limiter por provider/base/chave hasheada;
- `Retry-After` em segundos ou data HTTP, com teto;
- um retry de 429 somente quando RPS explícito está ativo;
- OpenAI-compatible Chat Completions;
- Anthropic Messages, incluindo system, imagens, tool use/result e thinking;
- separação de `<think>` mesmo quando tags chegam fragmentadas.

Pendente: Responses API, Gemini GenerateContent, roteamento OpenCode, descoberta de capabilities/modelos e fallback do runtime.
