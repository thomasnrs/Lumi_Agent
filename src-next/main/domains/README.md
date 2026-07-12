# Domains

Regras de negócio independentes de Electron. Cada domínio deve possuir:

- factory ou classe sem singleton global;
- portas explícitas para filesystem, rede, processos e UI;
- lifecycle/dispose quando mantiver recursos;
- contratos serializáveis;
- testes unitários e de caracterização;
- entrada correspondente no manifesto de migração.

Consulte `architecture/MODULE_MAP.md` para a divisão planejada.
