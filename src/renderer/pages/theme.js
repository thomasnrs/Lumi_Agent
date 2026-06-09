// Tema compartilhado: aplica as cores customizadas (config.theme) como variaveis
// CSS no :root. Incluido em todas as janelas. As cores padrao batem com o visual
// atual, entao sem tema custom nada muda. Atualiza ao vivo via 'theme-changed'.
(function () {
  const DEFAULTS = {
    bg: '#16161e', // fundo das janelas
    surface: '#24242f', // superficies (balao da assistente, cartoes)
    'surface-2': '#0f0f16', // caixas/inputs/código
    accent: '#7aa2ff', // cor de destaque (botões, sua mensagem, links)
    'accent-text': '#ffffff', // texto sobre o destaque
    text: '#eeeeee', // texto principal
    border: '#2a2a38', // bordas
  };
  let acrylicOn = false; // vidro nativo do Win11 ativo? (vem do main em config._acrylicOn)

  // hex (#rgb/#rrggbb) -> rgba com alpha (pro fundo translúcido do acrílico)
  function hexA(hex, a) {
    let h = String(hex || '').replace('#', '').trim();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length < 6) return hex;
    const n = parseInt(h.slice(0, 6), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function apply(theme) {
    const t = Object.assign({}, DEFAULTS, theme || {});
    const r = document.documentElement.style;
    for (const k in t) r.setProperty('--' + k, t[k]);
    if (acrylicOn) {
      // fundo translúcido revela o blur do acrílico; superfícies levemente translúcidas também
      r.setProperty('--bg', hexA(t.bg, 0.62));
      r.setProperty('--surface', hexA(t.surface, 0.78));
    }
  }
  apply(); // aplica os padrões já (evita qualquer flash)

  // Páginas que NÃO foram var-izadas à mão (window.__lumiThemed) ganham um
  // override genérico que tematiza os elementos comuns (fundo, títulos, inputs, botões).
  if (!window.__lumiThemed) {
    const ov = document.createElement('style');
    ov.textContent =
      'body{background:var(--bg);color:var(--text);}' +
      'h1,h2,h3{color:var(--text);}' +
      'a{color:var(--accent);}' +
      'label{color:var(--text);}' +
      'input,select,textarea{background:var(--surface-2);color:var(--text);border-color:var(--border);}' +
      'button{background:var(--accent);color:var(--accent-text);}';
    document.head.appendChild(ov);
  }
  const api = window.api;
  let lastTheme = null;
  if (api && api.getConfig)
    api.getConfig().then((c) => {
      acrylicOn = !!(c && c._acrylicOn); // vale também no iframe (compõe sobre a janela acrílica)
      lastTheme = c && c.theme;
      apply(lastTheme);
    });
  if (api && api.onThemeChanged)
    api.onThemeChanged((t) => {
      lastTheme = t;
      apply(t);
    });
  window.__lumiApplyTheme = apply; // util para o editor aplicar preview local
})();
