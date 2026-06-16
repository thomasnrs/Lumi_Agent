// ---- nav: shadow on scroll ----
const nav = document.getElementById('nav');
const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 12);
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

// ---- mobile menu ----
const burger = document.getElementById('burger');
const links = document.querySelector('.nav-links');
burger?.addEventListener('click', () => links.classList.toggle('open'));
links?.querySelectorAll('a').forEach(a => a.addEventListener('click', () => links.classList.remove('open')));

// ---- reveal on scroll ----
const io = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  });
}, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

document.querySelectorAll('.reveal').forEach((el, i) => {
  // small stagger for grouped cards
  el.style.transitionDelay = `${Math.min(i % 6, 5) * 60}ms`;
  io.observe(el);
});

// ---- count-up stats ----
const fmt = (el, val) => {
  const prefix = el.dataset.prefix || (el.textContent.trim().startsWith('~') ? '~' : '');
  el.textContent = prefix + val;
};
const countUp = (el) => {
  const target = parseInt(el.dataset.count, 10);
  const prefix = el.textContent.trim().startsWith('~') ? '~' : '';
  const dur = 1100, t0 = performance.now();
  const tick = (now) => {
    const p = Math.min((now - t0) / dur, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = prefix + Math.round(target * eased);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
const statIO = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting) { countUp(e.target); statIO.unobserve(e.target); }
  });
}, { threshold: 0.6 });
document.querySelectorAll('.stat b[data-count]').forEach(el => statIO.observe(el));

// ---- copiar o pix copia-e-cola ----
const pixCopy = document.getElementById('pixCopy');
pixCopy?.addEventListener('click', async () => {
  const code = document.getElementById('pixCode')?.textContent.trim() || '';
  try {
    await navigator.clipboard.writeText(code);
  } catch (e) {
    // fallback p/ navegadores sem clipboard API (ou http)
    const t = document.createElement('textarea');
    t.value = code; document.body.appendChild(t); t.select();
    document.execCommand('copy'); t.remove();
  }
  const lbl = pixCopy.querySelector('.lbl');
  const old = lbl.textContent;
  lbl.textContent = 'Copiado!';
  pixCopy.classList.add('copied');
  setTimeout(() => { lbl.textContent = old; pixCopy.classList.remove('copied'); }, 1800);
});
