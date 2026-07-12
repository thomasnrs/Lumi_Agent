# Inventários de paridade

Snapshots determinísticos extraídos do monólito funcional. Eles não são carregados pela Lumi em runtime; servem como checklist e contrato de migração.

Baseline atual:

- 180 registros IPC no main.
- 180 chamadas IPC no preload.
- Zero canais duplicados ou sem par correspondente.
- 65 ferramentas nativas.
- 12 toolsets.
- 13 fábricas de paths persistidos detectadas.
- 5 funções de turno/roteamento detectadas.
- 3 motores CLI: Claude Code, Codex e GLM Code.

Arquivos:

- `ipc.json`: canais, transporte, linhas e divergências preload/main.
- `tools.json`: ferramentas e toolsets.
- `persistence.json`: fábricas de paths e expressões atuais.
- `providers.json`: protocolos, turn functions, rotas especiais e motores CLI.

Regeneração:

```powershell
node src-next/scripts/inventory.js
```

Uma alteração no snapshot deve ser revisada como contrato público. Nunca aceite uma diferença apenas para “fazer o teste passar”: confirme se o monólito realmente adicionou, removeu ou renomeou o comportamento correspondente.
