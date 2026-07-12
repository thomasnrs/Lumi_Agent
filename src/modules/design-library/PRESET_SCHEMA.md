# Contrato dos presets

Este documento estabiliza o formato interno antes da futura integração com a interface.

## Campos obrigatórios

| Campo | Tipo | Finalidade |
|---|---|---|
| `id` | string kebab-case | Identificador persistente do preset |
| `name` | string | Nome exibido ao usuário |
| `version` | number | Versão das regras do preset |
| `mode` | `light` ou `dark` | Aparência predominante |
| `summary` | string | Descrição curta para a galeria |
| `tags` | string[] | Busca e filtros |
| `suitableFor` | string[] | Tipos de produto recomendados |
| `direction` | string[] | Princípios visuais de alto nível |
| `colors` | object | Tokens semânticos em hexadecimal |
| `typography` | object | Famílias, pesos e tracking |
| `geometry` | object | Raios, borda, sombra e densidade |
| `layout` | string[] | Regras de composição |
| `components` | string[] | Anatomia e comportamento de UI |
| `motion` | string[] | Movimento e feedback |
| `avoid` | string[] | Anti-padrões específicos |
| `preview` | object | Composição e texto do preview SVG |

## Compatibilidade futura

- `id` nunca deve mudar depois que um preset for publicado.
- Alterações incompatíveis incrementam `version`.
- Campos novos devem ter fallback no gerador.
- O `DESIGN.md` instalado pertence à workspace. Atualizações futuras nunca devem substituir personalizações silenciosamente.
- A seleção visual poderá guardar `{ id, version }`, mas a implementação sempre lê o `DESIGN.md` materializado como fonte de verdade.

