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
- coleta cacheada e invalidável de regras, DESIGN.md e memória da workspace;
- composição de prompt com precedência de persona, facts, summary, ledger, remoto, stack, subprojetos e agentes;
- DESIGN.md completo somente em tarefas visuais.

O domínio está implementado isoladamente. Detecção de stack, editor ativo, remote mount e provider são portas externas que serão conectadas apenas no composition root futuro.
