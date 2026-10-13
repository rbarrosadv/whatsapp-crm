// Página de acompanhamento do cliente (/c/<link>): pede os 4 últimos números
// do CPF/CNPJ (guardados neste aparelho para a próxima vez), mostra os processos
// e, em cada um, a etapa atual, o caminho até o fim, o próximo compromisso e as
// novidades aprovadas pelo escritório. Tudo montado com textContent (nada do
// servidor vira HTML).
const app = document.getElementById('app');
const token = location.pathname.split('/')[2] || '';
const KEY = `bportal:${token}`;
const LOGO = '/assets/logo-barros.jpg';
const ICON = '/assets/icon-192.png';
let data = null;
let openId = null;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
function svg(markup, size = 22, color = 'currentColor') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', color); s.setAttribute('stroke-width', '1.9');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  for (const d of markup) {
    const [tag, attrs] = d;
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    s.append(n);
  }
  return s;
}
const ICONS = {
  check: [['path', { d: 'M5 12l5 5L20 7' }]],
  cal: [['rect', { x: 3, y: 4, width: 18, height: 17, rx: 2 }], ['path', { d: 'M8 2v4M16 2v4M3 10h18' }]],
  chat: [['path', { d: 'M21 12a9 9 0 0 1-13.5 7.8L3 21l1.2-4.5A9 9 0 1 1 21 12z' }]],
  lock: [['rect', { x: 4, y: 11, width: 16, height: 10, rx: 2 }], ['path', { d: 'M8 11V7a4 4 0 0 1 8 0v4' }]],
};
const fmtDate = (ts) => new Date(ts).toLocaleDateString('pt-BR');
const fmtLong = (ts) => {
  const d = new Date(ts);
  const day = d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  const hasTime = d.getHours() || d.getMinutes();
  return `${day[0].toUpperCase()}${day.slice(1)}${hasTime ? `, às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}`;
};
/** Troca o conteúdo da página ignorando null (replaceChildren imprimiria "null"). */
const show = (...kids) => app.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const store = {
  get() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } },
  set(v) { try { localStorage.setItem(KEY, v); } catch { /* sem armazenamento */ } },
  clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } },
};

async function load(pin = store.get()) {
  let r;
  try {
    r = await fetch('/portal/data', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CRM': '1' }, body: JSON.stringify({ token, pin }) });
  } catch {
    return message('Sem conexão', 'Não conseguimos carregar agora. Confira a internet e tente de novo.');
  }
  const j = await r.json().catch(() => ({}));
  if (r.ok) { if (pin) store.set(pin); data = j; return render(); }
  if (j.needPin) { if (pin && r.status !== 429) store.clear(); return gate(j); }
  return message('Link indisponível', j.error || 'Este link não está mais ativo. Fale com o escritório.');
}

function message(title, text) {
  show(
    el('header', { class: 'pt-gate-head' }, el('img', { src: LOGO, alt: 'Barros Associados' }), el('div', { class: 'pt-rule' })),
    el('section', { class: 'pt-gate' }, el('h1', { text: title }), el('p', { class: 'pt-now-desc', text })),
  );
}

function gate(j) {
  const pin = el('input', { class: 'pt-pin', id: 'pin', inputmode: 'numeric', autocomplete: 'off', maxlength: '4', placeholder: '0000', 'aria-describedby': 'pin-err' });
  const err = el('div', { class: 'pt-err', id: 'pin-err', role: 'alert', text: j.error || '' });
  const form = el('form', {
    class: 'pt-gate',
    onsubmit: (e) => {
      e.preventDefault();
      const v = pin.value.replace(/\D/g, '');
      if (v.length !== 4) { err.textContent = 'Digite os 4 números.'; pin.focus(); return; }
      load(v);
    },
  },
  el('h1', { text: 'Olá! Para sua segurança, confirme quem é você.' }),
  el('label', { for: 'pin' }, 'Digite os ', el('b', { text: `4 últimos números do seu ${j.docKind || 'CPF'}` })),
  pin, err,
  el('button', { class: 'pt-btn', type: 'submit', text: 'Ver meu processo' }),
  el('div', { class: 'pt-lock' }, svg(ICONS.lock, 18, '#5a6873'), el('span', { text: 'Este link é só seu. O escritório consegue desligá-lo a qualquer momento.' })));
  show(
    el('header', { class: 'pt-gate-head' }, el('img', { src: LOGO, alt: 'Barros Associados' }), el('div', { class: 'pt-rule' }),
      el('div', { class: 'pt-gate-sub', text: 'Área do cliente · acompanhe o seu processo' })),
    form,
  );
  pin.addEventListener('input', () => { pin.value = pin.value.replace(/\D/g, '').slice(0, 4); err.textContent = ''; });
  setTimeout(() => pin.focus(), 50);
}

function head(title, sub, back) {
  return el('header', { class: 'pt-head' },
    el('div', { class: 'pt-head-top' }, el('img', { class: 'pt-logo', src: LOGO, alt: data.office?.name || 'Barros Associados' }), el('span', { class: 'pt-pill', text: 'Área do cliente' })),
    el('div', { class: 'pt-rule' }),
    back ? el('button', { class: 'pt-back', type: 'button', onclick: back, text: '← Seus processos' }) : null,
    el('div', null,
      el('div', { class: 'pt-hello', text: `Olá, ${data.name}!` }),
      el('h1', { class: 'pt-title', text: title }),
      sub ? el('div', { class: 'pt-sub', text: sub }) : null));
}

function waLink(text) {
  if (!data.whatsapp) return null;
  return el('a', { class: 'pt-wa', href: `https://wa.me/${data.whatsapp}?text=${encodeURIComponent(text)}`, target: '_blank', rel: 'noopener' },
    svg(ICONS.chat, 22, '#ffffff'), 'Falar com o advogado');
}

function foot() {
  return el('footer', { class: 'pt-foot' }, el('img', { src: ICON, alt: '' }),
    el('div', null, 'Página pessoal e confidencial. Não repasse este link.', el('br'), `${data.office?.name || 'Barros Associados'}${data.office?.city ? ` · ${data.office.city}` : ''}`));
}

function render() {
  const cases = data.cases || [];
  if (!cases.length) {
    show(head('Seus processos', null), el('section', { class: 'pt-card' }, el('p', { class: 'pt-empty', text: 'Nenhum processo para mostrar agora. Qualquer dúvida, fale com o escritório.' })),
      el('div', { class: 'pt-actions' }, waLink('Olá! Tenho uma dúvida sobre o meu processo.')), foot());
    return;
  }
  if (cases.length === 1) return renderCase(cases[0], null);
  const k = openId && cases.find((c) => c.id === openId);
  if (k) return renderCase(k, () => { openId = null; render(); scrollTo(0, 0); });
  show(
    head('Seus processos', null),
    el('div', { class: 'pt-list' }, cases.map((c) => el('button', { class: 'pt-item', type: 'button', onclick: () => { openId = c.id; render(); scrollTo(0, 0); } },
      el('div', { class: 'pt-item-top' }, el('div', { class: 'pt-item-title', text: c.title }),
        c.isNew ? el('span', { class: 'pt-badge', text: 'Novidade' }) : c.closed ? el('span', { class: 'pt-badge ok', text: 'Concluído' }) : null),
      el('div', { class: 'pt-item-now', text: c.label }),
      el('div', { class: 'pt-segs' }, c.steps.map((s) => el('span', { class: s.state === 'done' ? 'on' : s.state === 'current' ? 'cur' : '' }))),
      el('div', { class: 'pt-item-meta', text: c.next ? `${c.next.title} em ${fmtDate(c.next.due_at)} · Etapa ${c.index} de ${c.total}` : `Etapa ${c.index} de ${c.total}` })))),
    el('div', { class: 'pt-actions' }, waLink('Olá! Tenho uma dúvida sobre os meus processos.')),
    foot(),
  );
}

function renderCase(c, back) {
  const cur = c.steps.find((s) => s.state === 'current');
  const pct = Math.round((c.index / c.total) * 100);
  show(
    head(c.title, [c.number ? `Processo ${c.number}` : null, c.court].filter(Boolean).join(' · '), back),
    el('section', { class: 'pt-card' },
      el('div', { class: 'pt-k', text: 'Agora' }),
      el('div', { class: 'pt-now', text: c.label }),
      cur?.desc ? el('div', { class: 'pt-now-desc', text: cur.desc }) : null,
      el('div', { class: 'pt-bar', role: 'img', 'aria-label': `Etapa ${c.index} de ${c.total}` }, el('span', { style: `width: ${pct}%` })),
      el('div', { class: 'pt-step-n', text: `Etapa ${c.index} de ${c.total}` })),
    c.next ? el('section', { class: 'pt-next' }, svg(ICONS.cal, 26, '#9a5b00'),
      el('div', null, el('div', { class: 'pt-k', text: 'Próximo compromisso' }), el('div', { class: 'pt-next-title', text: c.next.title }),
        el('div', { class: 'pt-next-when', text: fmtLong(c.next.due_at) }))) : null,
    el('section', { class: 'pt-card' },
      el('h2', { class: 'pt-h2', text: 'O caminho do seu processo' }),
      c.steps.map((s, i) => el('div', { class: `pt-step ${s.state}` },
        el('div', { class: 'pt-rail' }, el('div', { class: 'pt-dot' }, s.state === 'done' ? svg(ICONS.check, 14, '#ffffff') : null),
          i < c.steps.length - 1 ? el('div', { class: 'pt-line' }) : null),
        el('div', { class: 'pt-step-body' },
          el('div', { class: 'pt-step-label', text: s.label }),
          s.date && s.state !== 'next' ? el('div', { class: 'pt-step-date', text: fmtDate(s.date) }) : null,
          s.desc ? el('div', { class: 'pt-step-desc', text: s.desc }) : null)))),
    el('section', { class: 'pt-card' },
      el('h2', { class: 'pt-h2', text: 'Novidades' }),
      c.news.length ? c.news.map((n) => el('article', { class: 'pt-news' },
        el('div', { class: 'pt-news-date', text: fmtDate(n.ts) }), el('div', { class: 'pt-news-title', text: n.title }), el('div', { class: 'pt-news-text', text: n.text })))
        : el('p', { class: 'pt-empty', text: 'Quando houver novidade, ela aparece aqui, explicada em palavras simples.' })),
    el('div', { class: 'pt-actions' },
      waLink(`Olá! Tenho uma dúvida sobre o processo "${c.title}".`),
      el('div', { class: 'pt-updated', text: `Atualizado em ${fmtDate(c.updated || Date.now())}${c.lawyer ? ` · Seu advogado: ${c.lawyer}` : ''}` })),
    foot(),
  );
}

load();
