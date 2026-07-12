# Regras de dependência

Fluxo permitido:

```text
bootstrap → domains → core/shared
bootstrap → adapters → core/shared
preload   → shared
renderer  → shared
```

Regras:

1. `bootstrap` é o único composition root.
2. `domains` declara portas e recebe implementações; não importa `adapters`.
3. `adapters` pode importar contratos de domínio, mas não outro adapter por conveniência.
4. `shared` não importa Electron, Node filesystem, processos ou implementações de domínio.
5. `renderer` e `preload` não importam código de `main`.
6. Comunicação main/renderer acontece apenas por contratos IPC versionados.
7. Um módulo não acessa estado de outro por singleton; usa API pública injetada.
8. Toda inscrição, timer, watcher, processo e janela deve possuir owner e descarte.
9. Dependência circular bloqueia a conclusão do módulo.
10. Até o cutover, qualquer dependência entre `src/` e `src-next/` é proibida.
