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
