# Lumi Next — árvore paralela

Esta é a implementação futura e modular da Lumi. Ela está intencionalmente fora de `src/`.

## Estado

- Desconectada do aplicativo atual.
- Fora do entrypoint, bundle, instalador e scripts de release.
- Não deve ser importada por nenhum arquivo em `src/`.
- Fundação inicial em desenvolvimento; domínios ainda não migrados.
- Baseline atual inventariado: IPC, ferramentas, persistência e providers/motores.

## Execução durante a migração

Somente testes isolados podem executar código desta árvore:

```powershell
node --test src-next/tests/*.test.js
```

Para atualizar os snapshots depois de uma mudança legítima no monólito:

```powershell
node src-next/scripts/inventory.js
node --test src-next/tests/*.test.js
```

Não adicione esta pasta ao `main`, ao build do renderer ou a `build.files` antes de todos os gates descritos em `PLANO_REFATORACAO_SRC_NEXT.md` estarem concluídos.

## Convenção de módulos

- Factories recebem dependências explicitamente.
- Recursos expõem descarte idempotente.
- Domínios não conhecem Electron.
- Adapters não contêm regra de negócio.
- Contratos IPC e persistidos são serializáveis e versionados.
- Globals mutáveis são proibidos.
