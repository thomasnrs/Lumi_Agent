# 🐧 Port pra Linux — o que precisa pro Lumi rodar

> Veredito: **não é refactor, é port.** ~85% do código roda sem mexer (Electron/Node/Three.js são
> multiplataforma). O trabalho real é: 1 risco grande pra validar (janela do avatar), ~6 ajustes
> pequenos de código, dependências de sistema e o alvo de build. Estratégia recomendada:
> **X11 primeiro (suporte oficial), Wayland como best-effort via XWayland.**

> ## ✅ STATUS (2026-06-09): código já portado!
> Tudo da seção 3 e 5 **já está implementado** (com gates `process.platform` — zero impacto no
> Windows): flags de transparência/XWayland, delay de criação da janela, `focus_window` via
> wmctrl/xdotool, SO informado ao modelo, fallback de polling no fs.watch, mensagens amigáveis
> do nut.js, `build.linux` no package.json, ícone PNG 512 e `npm run dist -- --linux`.
> **Falta apenas:** a Fase 1 (validar numa VM/máquina Linux real) e o build final via WSL2/CI.

---

## 1. O que já funciona sem tocar em nada

| Área | Status |
|---|---|
| Chat, streaming, agente, multi-agentes, steering/stop | ✅ puro Node/fetch |
| Ferramentas de arquivo (read/write/list/delete) | ✅ usa `path.join`, sem caminho hardcoded |
| Editor workspace (Monaco, abas, árvore, drag&drop) | ✅ web puro |
| TTS: Edge (WebSocket), Gemini, XTTS, ElevenLabs, OpenAI | ✅ tudo via rede |
| STT (Whisper-compatível) + mic/saída de áudio | ✅ getUserMedia/WebAudio (PulseAudio/PipeWire) |
| MCP (stdio spawn) | ✅ (nota: configs com `cmd /c npx` viram só `npx` no Linux) |
| Multi-chat, presets, temas, galeria, @menções, slash | ✅ |
| Tray + menus | ✅ (algumas distros pedem libappindicator) |
| Galeria em `~/Imagens` | ✅ `app.getPath('pictures')` existe no Linux |
| Atalho global, clipboard, menu copiar/colar | ✅ |
| Acrílico Win11 | ✅ já tem gate `process.platform === 'win32'` (`acrylicAvailable()` no main.js) — no Linux simplesmente não ativa |

---

## 2. ⚠️ O risco nº 1: a janela do avatar (transparente + click-through)

O coração do produto: `transparent: true` + `alwaysOnTop` + `setIgnoreMouseEvents` por região.

**X11 (Xorg):**
- Funciona, mas exige **compositor ativo** (GNOME/KDE têm por padrão; i3/openbox puro não).
- Workarounds clássicos do Electron que provavelmente vamos precisar em `main.js`:
  ```js
  if (process.platform === 'linux') {
    app.commandLine.appendSwitch('enable-transparent-visuals');
    // criar a janela ~300ms após o app 'ready' (bug antigo de transparência no Linux)
  }
  ```
- `setIgnoreMouseEvents` funciona no X11 → nosso click-through por região continua valendo.

**Wayland (padrão do Ubuntu 22+/Fedora):**
- Electron sob Wayland nativo tem limitações sérias: posicionamento global de janela (`setPosition`)
  é restrito, `screen.getCursorScreenPoint` não funciona direito, transparência instável.
- **Solução: forçar XWayland** — funciona na prática como X11:
  ```js
  // antes do app.ready
  if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11');
  ```
- O cursor-follow (olhos seguem o mouse) usa `screen.getCursorScreenPoint` ~30Hz → só funciona
  via XWayland. Mais um motivo pra forçar X11.

**Sentar na barra de tarefas:** usa `workArea` (existe no Linux), mas painel pode ficar em CIMA
(GNOME) → a conta do `taskbarTop` precisa considerar painel no topo/lateral. Ajuste pequeno.

✔️ **Passo 1 do port é validar isso numa VM/máquina Linux antes de qualquer outra coisa.**

---

## 3. Mudanças de código necessárias (pequenas, com endereço)

### 3.1 `focus_window` é PowerShell-only — `main.js` ~linha 1088
Hoje: `powershell ... AppActivate('título')`. No Linux usar `wmctrl`/`xdotool`:
```js
if (process.platform === 'linux') {
  await execAsync(`wmctrl -a '${t}' || xdotool search --name '${t}' windowactivate`, ...);
} else if (process.platform === 'darwin') { /* osascript, se um dia rolar mac */ }
else { /* PowerShell atual */ }
```
Se `wmctrl` não estiver instalado → retornar `{ error: 'instale wmctrl: sudo apt install wmctrl' }`.

### 3.2 Computer use (nut.js) — degradar com elegância
`@nut-tree-fork/nut-js` suporta Linux/X11 mas exige libs de sistema (seção 4). No Wayland não funciona.
`getNut()` já é lazy-require — embrulhar com mensagem amigável quando falhar:
`{ error: 'controle do PC no Linux requer X11 + libxtst (sudo apt install libxtst6)' }`.

### 3.3 uiohook-napi
Já é tolerante (`hookOk = try-require`, e o hook está DESLIGADO no fluxo atual). No Linux/X11 até
funciona; no Wayland falha o require → `hookOk=false` → segue o fluxo normal. **Zero mudança**,
só não listar como bloqueador.

### 3.4 `see_screen` no Wayland
`desktopCapturer` no Wayland exige `xdg-desktop-portal` + PipeWire (abre um picker do sistema).
No X11/XWayland funciona direto. Com a estratégia "forçar X11" → sem mudança; documentar só.

### 3.5 Dizer o SO pro modelo — `buildSystemPrompt()`
Hoje a Lumi assume Windows ao escrever comandos (`run_command` roda `/bin/sh` no Linux).
Adicionar 1 linha no system prompt: `Sistema operacional: ${process.platform === 'win32' ? 'Windows' : 'Linux'}`
→ ela passa a gerar `ls/grep/apt` em vez de `dir/Select-String`. **Mudança de 2 linhas, alto impacto.**

### 3.6 `fs.watch recursive` (auto-refresh do editor)
Só funciona no Linux a partir do Node 20.13 — Electron 31 traz Node 20.14 ✅. Mas deixar
fallback: se `fs.watch(ws, {recursive:true})` lançar erro, cair pra polling leve (re-scan a cada 3s)
ou simplesmente desativar o auto-refresh (botão ↻ continua existindo). O try/catch já existe —
só falta o fallback dentro do catch.

### 3.7 `windowsHide: true` nos `execAsync`
Inofensivo no Linux (ignorado). Zero mudança.

---

## 4. Dependências de sistema (lado do usuário Linux)

Documentar no README / instalador:

```bash
# Debian/Ubuntu
sudo apt install libxtst6 libpng16-16 wmctrl xdotool      # computer use + focus_window
sudo apt install libappindicator3-1 | libayatana-appindicator3-1   # tray (algumas distros)
# áudio: PulseAudio ou PipeWire (padrão em tudo que é moderno) — nada a fazer
```

- **Compositor ativo** (padrão no GNOME/KDE/Cinnamon). Sem compositor → avatar com fundo preto.
- AppImage roda em qualquer distro; .deb cobre Ubuntu/Mint/Debian.

---

## 5. Build / empacotamento

### 5.1 `package.json` → adicionar target Linux
```json
"linux": {
  "target": ["AppImage", "deb"],
  "icon": "build/icons",            // PNGs 256/512 (Linux não usa .ico)
  "category": "Utility",
  "synopsis": "Sua companheira de desktop com IA"
}
```

### 5.2 `scripts/make-icon.js`
Hoje gera só `build/icon.ico`. Adicionar saída `build/icons/512x512.png` (já temos jimp — 3 linhas).

### 5.3 `scripts/dist.js`
Hoje: `Platform.WINDOWS.createTarget('nsis', Arch.x64)`. Adicionar modo por argumento:
```js
const target = process.argv.includes('--linux')
  ? Platform.LINUX.createTarget(['AppImage', 'deb'], Arch.x64)
  : Platform.WINDOWS.createTarget('nsis', Arch.x64);
```

### 5.4 Onde buildar
- **Buildar Linux a partir do Windows não é confiável** (módulos nativos: uiohook-napi e nut.js
  precisam compilar pro Linux). Opções:
  1. **WSL2** com o projeto clonado dentro do filesystem do WSL (não no /mnt/c!) — `npm i && npm run dist -- --linux`;
  2. **GitHub Actions** (matrix windows-latest + ubuntu-latest) — o caminho "profissional" pra Steam;
  3. VM/máquina Linux.
- Steam: o runtime Linux da Valve (sniper) roda Electron de boa; depot separado win/linux.

---

## 6. Checklist de validação (na primeira sessão em Linux)

Ordem de prioridade — se o item 1 falhar, o resto nem importa:

- [ ] **Avatar transparente** sobre o desktop (X11 e XWayland forçado)
- [ ] Click-through fora do corpo / captura sobre o corpo (arrastar, menu de contexto)
- [ ] Olhos seguindo o cursor (getCursorScreenPoint via XWayland)
- [ ] Sentar na barra/painel (testar GNOME painel-em-cima e KDE painel-embaixo)
- [ ] Chat + streaming + ferramentas + agentes (deve passar liso)
- [ ] Editor workspace: árvore, abas, auto-refresh (fs.watch recursive)
- [ ] TTS Edge tocando + mic STT (PipeWire)
- [ ] Tray icon + menu
- [ ] `run_command` gerando comandos de Linux (após item 3.5)
- [ ] see_screen capturando
- [ ] Computer use com libxtst instalado (X11)
- [ ] Galeria salvando em ~/Imagens
- [ ] AppImage abre numa distro "virgem" (sem deps de dev)

---

## 7. Plano de fases

| Fase | O quê | Esforço |
|---|---|---|
| **1. Spike de viabilidade** | VM Ubuntu → rodar `npm start` como está + flags de transparência. Decide tudo. | ~meio dia |
| **2. Gates de plataforma** | Itens 3.1–3.6 acima | ~1 dia |
| **3. Build Linux** | 5.1–5.3 + testar AppImage/deb | ~meio dia |
| **4. Polimento** | painel do GNOME, ícone, docs de deps, mensagens de erro amigáveis | ~1 dia |
| **5. CI (opcional, pré-Steam)** | GitHub Actions buildando win+linux a cada release | ~meio dia |

**Total estimado: ~3 dias de trabalho** — sendo que a Fase 1 é a única com risco de
descobrir algo feio (transparência em distro X). Tudo o resto é mecânico.

---

## 8. Decisões recomendadas

1. **Suporte oficial: X11** (e Wayland via XWayland forçado com `ozone-platform=x11`). É o que
   apps de overlay fazem; cobre 95%+ dos usuários de desktop Linux.
2. **Computer use = "quando disponível"**: no Linux exige X11+libs; se faltar, a ferramenta
   responde com instrução de instalação em vez de quebrar.
3. **Lançamento Steam: Windows primeiro, Linux depois** como update — valida demanda sem
   atrasar o lançamento.
4. **Não suportar** (por ora): Wayland nativo (limitações do Electron) e macOS (outra briga:
   assinatura/notarização, vibrancy, acessibilidade pra computer use).
