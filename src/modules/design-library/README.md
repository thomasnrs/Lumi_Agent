# Lumi Design Library

Módulo interno e ainda não conectado à interface principal. Ele mantém presets visuais estruturados e transforma uma escolha em um `DESIGN.md` durável dentro da workspace.

## Estado atual

- 14 presets autorais.
- Busca por texto, modo e tags.
- Geração determinística de `DESIGN.md`.
- Preview SVG local, sem rede, imagem remota ou dependência externa.
- Instalação segura na raiz da workspace.
- Proteção contra sobrescrever um `DESIGN.md` existente sem confirmação.
- Backup automático quando a sobrescrita é explicitamente autorizada.

O módulo não é importado por `main.js`, não registra IPC, não aparece nas configurações e não altera prompts. A integração com a Lumi será feita em uma etapa posterior.

## Galeria de desenvolvimento

Para navegar pelos presets antes da integração:

```powershell
node src/modules/design-library/cli.js gallery
```

O comando cria `lumi-design-gallery.html` no diretório atual. A página funciona offline, oferece busca e filtros, renderiza os previews vetoriais e permite exportar o `DESIGN.md` de qualquer card.

Outros comandos úteis:

```powershell
node src/modules/design-library/cli.js list dark
node src/modules/design-library/cli.js preview signal-noir signal-noir.svg
node src/modules/design-library/cli.js design paper-orbit DESIGN.md
```

## API

```js
const designs = require('./src/modules/design-library');

const presets = designs.listPresets({ mode: 'dark' });
const preset = designs.getPreset('signal-noir');
const markdown = designs.generateDesignMarkdown(preset.id, {
  projectName: 'Meu produto',
});
const svg = designs.renderPreviewSvg(preset.id);

const result = designs.installDesignPreset('C:/workspace/meu-app', preset.id, {
  projectName: 'Meu produto',
  overwrite: false,
});
```

Se já houver um `DESIGN.md`, `installDesignPreset()` retorna:

```js
{ ok: false, conflict: true, path: '...', preset: 'signal-noir' }
```

Com `overwrite: true`, o arquivo anterior é preservado como `DESIGN.md.lumi-backup-<data>`.

## Estrutura de um preset

Cada entrada em `catalog.js` contém:

- identidade, descrição, modo e tags;
- usos recomendados;
- direção visual;
- cores semânticas;
- tipografia;
- geometria e densidade;
- regras de layout, componentes e movimento;
- anti-padrões;
- composição do preview.

O gerador converte esses dados em documentação técnica detalhada, incluindo responsividade, acessibilidade, estados interativos e contrato para agentes de código.

## Como adicionar um estilo

1. Crie um preset autoral em `catalog.js` com um `id` único.
2. Preencha todos os tokens semânticos; não use cores sem função definida.
3. Escreva regras concretas, verificáveis e úteis para implementação.
4. Escolha uma composição de preview existente ou adicione uma nova em `previewScene()`.
5. Rode `npm test` e confirme que `validateCatalog()` não retorna erros.
6. Inspecione o SVG em fundos claro e escuro e revise contraste, hierarquia e legibilidade.

## Conteúdo de terceiros

O catálogo foi inspirado por categorias amplas vistas em galerias públicas de design, mas seus nomes, textos, tokens, regras e previews são originais da Lumi. Não copie para este módulo screenshots, CSS, logos, fontes redistribuídas ou arquivos premium de terceiros sem uma licença que permita redistribuição dentro do aplicativo.

Quando uma referência externa for importante, salve apenas metadados e o link de origem; o preset distribuído pela Lumi deve continuar autoral ou devidamente licenciado.
