// Controle de transparência da janela (persistido por página em config.pageOpacity).
// - Sempre restaura a opacidade salva ao abrir.
// - Expõe window.__lumiSetOpacity / __lumiGetOpacity para a própria página ajustar.
// - Injeta um controle flutuante discreto (ícone que expande no hover) — exceto onde
//   a página já tem o seu próprio controle (ex.: o chat, que tem #chatHeader).
(function () {
  // ---- toasts (avisos flutuantes padronizados) — disponíveis em TODAS as páginas ----
  window.__lumiToast = function (msg, ok) {
    let box = document.getElementById('lumi-toasts');
    if (!box) {
      const css = document.createElement('style');
      css.textContent =
        '#lumi-toasts{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);z-index:100000;' +
        'display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none;}' +
        '.lumi-toast{padding:8px 16px;border-radius:18px;font:12px "Segoe UI",sans-serif;color:var(--text,#eee);' +
        'background:color-mix(in srgb, var(--surface,#24242f) 88%, transparent);border:1px solid var(--border,#2a2a38);' +
        'box-shadow:0 6px 22px rgba(0,0,0,.45);backdrop-filter:blur(8px);animation:lumiToastIn .2s ease;' +
        'max-width:80vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
        '.lumi-toast.err{border-color:#e0556e;color:#ffb4b4;}' +
        '.lumi-toast.bye{opacity:0;transform:translateY(6px);transition:opacity .25s,transform .25s;}' +
        '@keyframes lumiToastIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}';
      document.head.appendChild(css);
      box = document.createElement('div');
      box.id = 'lumi-toasts';
      document.body.appendChild(box);
    }
    const t = document.createElement('div');
    t.className = 'lumi-toast' + (ok === false ? ' err' : '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.classList.add('bye'), 2200);
    setTimeout(() => t.remove(), 2550);
  };

  // ---- design system compartilhado (vale em TODAS as páginas, inclusive iframes) ----
  (function designSystem() {
    const css = document.createElement('style');
    css.textContent =
      "@font-face{font-family:'Outfit';src:url('fonts/outfit.woff2') format('woff2');font-weight:300 900;font-display:swap;}" +
      'h1,h2,#chatTitle,#planTitle,#rootname{font-family:Outfit,"Segoe UI",sans-serif;letter-spacing:.2px;}' +
      'input:focus,select:focus,textarea:focus{border-color:var(--accent,#7aa2ff)!important;' +
      'box-shadow:0 0 0 3px color-mix(in srgb,var(--accent,#7aa2ff) 16%,transparent)!important;outline:none!important;}' +
      'select{appearance:none;-webkit-appearance:none;' +
      'background-image:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%23889\' stroke-width=\'2.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'><path d=\'m6 9 6 6 6-6\'/></svg>");' +
      'background-repeat:no-repeat;background-position:right 8px center;padding-right:26px!important;cursor:pointer;}' +
      'button{transition:background .12s,color .12s,border-color .12s;}';
    document.head.appendChild(css);
  })();

  // ---- barra de título customizada (as janelas usam titleBarOverlay nativo) ----
  (function titlebar() {
    if (window.top !== window.self) return; // iframe não arrasta a janela hospedeira
    if (!window.api || window.api.platform !== 'win32') return; // Linux/mac usam a barra nativa
    const css = document.createElement('style');
    css.textContent =
      '.lumi-dragbar{-webkit-app-region:drag;padding-right:142px !important;}' +
      '#menubar.lumi-dragbar{min-height:34px;}' +
      '.lumi-dragbar button,.lumi-dragbar input,.lumi-dragbar select,.lumi-dragbar .mlabel,.lumi-dragbar .hbtn{-webkit-app-region:no-drag;}' +
      '#lumi-titlebar{position:fixed;top:0;left:0;right:0;height:34px;display:flex;align-items:center;gap:8px;' +
      'padding:0 146px 0 12px;-webkit-app-region:drag;z-index:9998;' +
      'background:color-mix(in srgb,var(--surface-2,#0f0f16) 72%,transparent);backdrop-filter:blur(10px);' +
      'border-bottom:1px solid color-mix(in srgb,var(--border,#2a2a38) 70%,transparent);' +
      "font:600 12px Outfit,'Segoe UI',sans-serif;color:#9aab;user-select:none;letter-spacing:.4px;}";
    document.head.appendChild(css);
    // página com header próprio (chat/menubar do editor) → o header vira a área de arrastar
    const header = document.getElementById('chatHeader') || document.getElementById('menubar');
    if (header) {
      header.classList.add('lumi-dragbar');
      return;
    }
    // demais páginas: mini barra "✦ Lumi — título" injetada
    const tb = document.createElement('div');
    tb.id = 'lumi-titlebar';
    const star = document.createElement('span');
    star.style.color = 'var(--accent, #7aa2ff)';
    star.textContent = '✦';
    tb.appendChild(star);
    tb.appendChild(document.createTextNode(document.title || 'Lumi'));
    document.body.prepend(tb);
    document.body.style.boxSizing = 'border-box';
    document.body.style.paddingTop = (parseFloat(getComputedStyle(document.body).paddingTop) || 0) + 34 + 'px';
  })();

  // Embutido num iframe (ex.: o chat dentro do editor da workspace)? Opacidade é por JANELA,
  // então NÃO mexe — senão a janela hospedeira inteira mudaria de opacidade. Sai fora.
  if (window.top !== window.self) return;
  const api = window.api;
  if (!api || !api.getConfig || !api.setWindowOpacity) return;

  const id = (location.pathname.split('/').pop() || 'page').replace(/\.html$/i, '');
  let pageOpacity = {};

  function save(v) {
    pageOpacity[id] = v;
    api.setConfig({ pageOpacity: pageOpacity });
  }
  window.__lumiSetOpacity = function (v) {
    v = Math.min(1, Math.max(0.25, v));
    api.setWindowOpacity(v);
    save(v);
    return v;
  };
  window.__lumiGetOpacity = function () {
    return pageOpacity[id] != null ? pageOpacity[id] : 1;
  };

  // controle flutuante discreto (só nas páginas sem cabeçalho próprio)
  function injectFloating(v) {
    if (document.getElementById('chatHeader')) return; // o chat tem o seu (painel de ajustes)
    const css = document.createElement('style');
    css.textContent =
      '#lumi-opacity{position:fixed;right:8px;top:8px;z-index:99999;display:flex;align-items:center;gap:0;' +
      'padding:5px;border-radius:16px;background:rgba(20,20,28,.5);border:1px solid var(--border);' +
      'color:var(--text);font:11px "Segoe UI",sans-serif;opacity:.4;backdrop-filter:blur(6px);' +
      'transition:opacity .2s,background .2s,gap .2s;}' +
      '#lumi-opacity:hover{opacity:1;background:rgba(20,20,28,.92);gap:7px;}' +
      '#lumi-opacity svg{width:15px;height:15px;flex:0 0 auto;}' +
      '#lumi-opacity input[type=range]{width:0;opacity:0;accent-color:var(--accent);cursor:pointer;' +
      'transition:width .2s,opacity .2s;}' +
      '#lumi-opacity:hover input[type=range]{width:82px;opacity:1;}' +
      '#lumi-opacity .v{width:0;opacity:0;overflow:hidden;white-space:nowrap;text-align:right;' +
      'font-variant-numeric:tabular-nums;transition:width .2s,opacity .2s;}' +
      '#lumi-opacity:hover .v{width:30px;opacity:1;}';
    document.head.appendChild(css);

    const box = document.createElement('div');
    box.id = 'lumi-opacity';
    box.title = 'Transparência desta janela';
    box.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round"><path d="M9 10h.01"/><path d="M15 10h.01"/>' +
      '<path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/></svg>' +
      '<input type="range" min="25" max="100" step="5" /><span class="v"></span>';
    document.body.appendChild(box);

    const slider = box.querySelector('input');
    const valEl = box.querySelector('.v');
    slider.value = Math.round(v * 100);
    valEl.textContent = slider.value + '%';
    slider.addEventListener('input', () => {
      valEl.textContent = slider.value + '%';
      window.__lumiSetOpacity(parseInt(slider.value, 10) / 100);
    });
  }

  api.getConfig().then((c) => {
    pageOpacity = Object.assign({}, (c && c.pageOpacity) || {});
    const v = pageOpacity[id] != null ? pageOpacity[id] : 1;
    if (v < 1) api.setWindowOpacity(v);
    injectFloating(v);
  });
})();
