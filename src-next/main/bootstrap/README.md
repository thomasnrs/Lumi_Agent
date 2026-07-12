# Bootstrap

Futuro composition root da Lumi. Este diretório será o único lugar autorizado a conhecer implementações concretas de todos os domínios e adapters.

O arquivo `main.js` alvo não deve ser criado como entrypoint executável até o gate de cutover. Durante a migração, harnesses de teste vivem em `src-next/tests/`.
