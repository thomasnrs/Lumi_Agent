# Context domain

Implementado isoladamente:

- orçamento e estimativa com cache;
- imagens base64 não inflam estimativas;
- normalização de tool calls e JSON inválido;
- preservação literal do último turno;
- remoção de imagens antigas;
- compactação em duas passagens protegendo a cauda recente;
- referências de artifacts recuperáveis;
- projeções limitadas de ledger/worklog com redaction;
- sumarização por porta injetada e realinhamento de anchors/eventos.

Ainda pendente antes do domínio completo:

- composição do system prompt;
- regras do repositório, DESIGN.md e memória de workspace;
- detecção de stack/mapa de subprojetos;
- active editor context;
- integração com providers e runtime do agente.
