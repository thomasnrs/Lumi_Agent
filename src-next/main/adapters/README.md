# Adapters

Implementações concretas das portas usadas pelos domínios: Electron, Node filesystem, processos, rede, bancos e integrações de plataforma.

Adapters traduzem APIs externas; não decidem regras do produto.

## Implementado isoladamente

- `filesystem/atomic-json-store.js`: escrita em arquivo temporário, `fsync`, rename atômico, backup, fila de mutações e recuperação de JSON corrompido.
