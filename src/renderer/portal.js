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
  doc: [['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }], ['path', { d: 'M14 3v5h5M9 13h6M9 17h4' }]],
  pin: [['path', { d: 'M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z' }], ['circle', { cx: 12, cy: 9.5, r: 2.5 }]],
  video: [['rect', { x: 3, y: 6, width: 13, height: 12, rx: 2 }], ['path', { d: 'm16 10 5-3v10l-5-3z' }]],
  scale: [['path', { d: 'M12 3v18M7 21h10M5 7h14' }], ['path', { d: 'm5 7-3 7a3.5 3.5 0 0 0 6 0Z' }], ['path', { d: 'm19 7-3 7a3.5 3.5 0 0 0 6 0Z' }]],
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

/** Envia uma resposta do cliente (confirmação de audiência, avaliação) com os 4 números guardados. */
async function post(path, data) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CRM': '1' }, body: JSON.stringify({ token, pin: store.get(), ...data }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Não foi possível enviar agora. Tente de novo.');
  return j;
}
const days = (ms) => Math.max(0, Math.floor(ms / 864e5));
const duration = (d) => {
  if (d < 1) return 'hoje';
  if (d < 45) return d === 1 ? '1 dia' : `${d} dias`;
  if (d < 365) { const m = Math.round(d / 30); return m === 1 ? '1 mês' : `${m} meses`; }
  const y = Math.round((d / 365) * 10) / 10;
  return y === 1 ? '1 ano' : `${String(y).replace('.', ',')} anos`;
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

function waLink(text, label = 'Falar com o advogado') {
  if (!data.whatsapp) return null;
  return el('a', { class: 'pt-wa', href: `https://wa.me/${data.whatsapp}?text=${encodeURIComponent(text)}`, target: '_blank', rel: 'noopener' },
    svg(ICONS.chat, 22, '#ffffff'), label);
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
      el('div', { class: 'pt-k', text: c.closed ? 'Situação' : 'Agora' }),
      el('div', { class: 'pt-now', text: c.label }),
      cur?.desc ? el('div', { class: 'pt-now-desc', text: cur.desc }) : null,
      el('div', { class: 'pt-bar', role: 'img', 'aria-label': `Etapa ${c.index} de ${c.total}` }, el('span', { style: `width: ${pct}%` })),
      el('div', { class: 'pt-step-n', text: `Etapa ${c.index} de ${c.total}` }),
      c.since || c.avgDays >= 7 || c.nextLabel ? el('div', { class: 'pt-facts' },
        c.since ? el('div', null, el('b', { text: 'Nesta etapa desde ' }), `${fmtDate(c.since)}${days(Date.now() - c.since) >= 1 ? ` (há ${duration(days(Date.now() - c.since))})` : ' (hoje)'}`) : null,
        c.avgDays >= 7 ? el('div', null, el('b', { text: 'Costuma durar ' }), `cerca de ${duration(c.avgDays)} nos processos do escritório`) : null,
        c.nextLabel ? el('div', null, el('b', { text: 'Próximo passo: ' }), c.nextLabel) : null) : null),
    c.next ? hearingCard(c) : null,
    c.docs.length ? el('section', { class: 'pt-card pt-need' },
      el('h2', { class: 'pt-h2', text: 'O que precisamos de você' }),
      el('p', { class: 'pt-now-desc', text: 'Para seguir com o seu processo, envie ao escritório:' }),
      el('ul', { class: 'pt-docs' }, c.docs.map((d) => el('li', null, svg(ICONS.doc, 18, '#8a4f00'), el('span', { text: d.label })))),
      waLink(`Olá! Sobre o processo "${c.title}", segue o documento que vocês pediram.`, 'Enviar pelo WhatsApp')) : null,
    el('section', { class: 'pt-card' },
      el('h2', { class: 'pt-h2', text: 'O caminho do seu processo' }),
      c.steps.map((s, i) => el('div', { class: `pt-step ${s.state}` },
        el('div', { class: 'pt-rail' }, el('div', { class: 'pt-dot' }, s.state === 'done' ? svg(ICONS.check, 14, '#ffffff') : null),
          i < c.steps.length - 1 ? el('div', { class: 'pt-line' }) : null),
        el('div', { class: 'pt-step-body' },
          el('div', { class: 'pt-step-label', text: s.label }),
          s.date && s.state !== 'next' ? el('div', { class: 'pt-step-date', text: fmtDate(s.date) }) : null,
          s.desc ? el('div', { class: 'pt-step-desc', text: s.desc }) : null)))),
    c.faq.length ? el('section', { class: 'pt-card' },
      el('h2', { class: 'pt-h2', text: 'Dúvidas comuns nesta etapa' }),
      c.faq.map((f) => el('details', { class: 'pt-faq' }, el('summary', { text: f.q }), el('p', { text: f.a })))) : null,
    el('section', { class: 'pt-card' },
      el('h2', { class: 'pt-h2', text: 'Andamentos e novidades' }),
      c.timeline.length ? c.timeline.map((n) => el('article', { class: `pt-news ${n.kind === 'move' ? 'pt-move' : ''}` },
        el('div', { class: 'pt-news-date', text: `${fmtDate(n.ts)}${n.kind === 'move' ? ' · no tribunal' : ''}` }),
        el('div', { class: 'pt-news-title', text: n.title }),
        n.text ? el('div', { class: 'pt-news-text', text: n.text }) : null))
        : el('p', { class: 'pt-empty', text: 'Quando houver novidade, ela aparece aqui, explicada em palavras simples.' }),
      c.timeline.some((n) => n.kind === 'move') ? el('p', { class: 'pt-note', text: 'Os andamentos do tribunal aparecem aqui de forma resumida. Decisões importantes são explicadas pelo seu advogado.' }) : null),
    c.rating ? ratingCard(c) : null,
    c.number ? el('section', { class: 'pt-card pt-proc' },
      el('h2', { class: 'pt-h2', text: 'Dados do processo' }),
      el('dl', null,
        el('dt', { text: 'Número' }), el('dd', { class: 'pt-mono', text: c.number }),
        c.tribunal ? [el('dt', { text: 'Tribunal' }), el('dd', { text: c.tribunal })] : null,
        c.court ? [el('dt', { text: 'Vara' }), el('dd', { text: c.court })] : null),
      c.checkedAt ? el('div', { class: 'pt-checked', text: `Conferido no tribunal em ${fmtDateTime(c.checkedAt)}` }) : null,
      c.consulta ? el('a', { class: 'pt-help', href: c.consulta, target: '_blank', rel: 'noopener', onclick: () => { try { navigator.clipboard.writeText(c.number); } catch { /* sem área de transferência */ } } },
        svg(ICONS.scale, 18, '#2f4a5a'), ' Ver no site do tribunal') : null,
      c.consulta ? el('p', { class: 'pt-note', text: 'O número do processo é copiado ao tocar no botão: é só colar na consulta do tribunal.' }) : null) : null,
    el('div', { class: 'pt-actions' },
      waLink(`Olá! Tenho uma dúvida sobre o processo "${c.title}".`),
      el('div', { class: 'pt-updated', text: `Atualizado em ${fmtDate(c.updated || Date.now())}${c.lawyer ? ` · Seu advogado: ${c.lawyer}` : ''}` })),
    foot(),
  );
}

const fmtDateTime = (ts) => `${new Date(ts).toLocaleDateString('pt-BR')} às ${new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;

/** Próxima audiência: quando, onde (endereço ou link), dica e a confirmação de presença. */
function hearingCard(c) {
  const n = c.next;
  const isLink = /^https?:\/\//i.test(n.place || '');
  const box = el('div', { class: 'pt-confirm' });
  const drawConfirm = (state) => {
    if (!n.confirm) return box.replaceChildren();
    if (state === 'presente') return box.replaceChildren(el('div', { class: 'pt-ok', text: '✓ Presença confirmada. Obrigado!' }));
    if (state === 'falar') return box.replaceChildren(el('div', { class: 'pt-ok', text: '✓ Recebemos. O seu advogado vai entrar em contato.' }));
    const send = (answer) => async (e) => {
      e.currentTarget.disabled = true;
      try { await post('/portal/confirm', { taskId: n.id, answer }); n.confirm = answer; drawConfirm(answer); } catch (err) { box.append(el('div', { class: 'pt-err', text: err.message })); e.currentTarget.disabled = false; }
    };
    return box.replaceChildren(
      el('button', { class: 'pt-btn', type: 'button', onclick: send('presente'), text: 'Estarei presente' }),
      el('button', { class: 'pt-btn pt-btn-2', type: 'button', onclick: send('falar'), text: 'Preciso falar com o advogado' }));
  };
  drawConfirm(n.confirm);
  return el('section', { class: 'pt-next' }, svg(ICONS.cal, 26, '#9a5b00'),
    el('div', { class: 'pt-next-body' },
      el('div', { class: 'pt-k', text: 'Próximo compromisso' }),
      el('div', { class: 'pt-next-title', text: n.title }),
      el('div', { class: 'pt-next-when', text: fmtLong(n.due_at) }),
      el('div', { class: 'pt-tag', text: n.virtual ? 'Audiência virtual (por vídeo)' : 'Audiência presencial' }),
      n.place ? (isLink
        ? el('a', { class: 'pt-place', href: n.place, target: '_blank', rel: 'noopener' }, svg(ICONS.video, 18, '#8a4f00'), ' Entrar na sala virtual')
        : el('div', { class: 'pt-place' }, svg(ICONS.pin, 18, '#8a4f00'), el('span', { text: n.place }))) : null,
      el('div', { class: 'pt-tip', text: n.virtual ? 'Entre no link 10 minutos antes, num lugar tranquilo, com o documento com foto em mãos.' : 'Chegue 30 minutos antes e leve um documento com foto.' }),
      box));
}

/** Avaliação ao final (processo encerrado): estrelas de 1 a 5 e um comentário. */
function ratingCard(c) {
  const sec = el('section', { class: 'pt-card pt-rate' });
  if (c.rating.done) {
    sec.append(el('h2', { class: 'pt-h2', text: 'Obrigado pela sua avaliação!' }), el('div', { class: 'pt-stars-done', text: '★'.repeat(c.rating.score) + '☆'.repeat(5 - c.rating.score) }));
    return sec;
  }
  let score = 0;
  const stars = el('div', { class: 'pt-stars', role: 'radiogroup', 'aria-label': 'Nota de 1 a 5' });
  const paint = () => [...stars.children].forEach((b, i) => { b.textContent = i < score ? '★' : '☆'; b.setAttribute('aria-checked', String(i + 1 === score)); });
  for (let i = 1; i <= 5; i++) stars.append(el('button', { type: 'button', role: 'radio', 'aria-label': `${i} de 5`, onclick: () => { score = i; paint(); } }, '☆'));
  const comment = el('textarea', { class: 'pt-text', rows: '3', placeholder: 'Conte como foi (opcional)', maxlength: '1000' });
  const err = el('div', { class: 'pt-err', role: 'alert' });
  sec.append(el('h2', { class: 'pt-h2', text: 'Como foi o nosso atendimento?' }), stars, comment, err,
    el('button', {
      class: 'pt-btn', type: 'button', text: 'Enviar avaliação',
      onclick: async (e) => {
        if (!score) { err.textContent = 'Escolha de 1 a 5 estrelas.'; return; }
        e.currentTarget.disabled = true;
        try {
          const r = await post('/portal/rate', { caseId: c.id, score, comment: comment.value });
          c.rating = { done: true, score };
          sec.replaceChildren(...[el('h2', { class: 'pt-h2', text: 'Obrigado pela sua avaliação!' }), el('div', { class: 'pt-stars-done', text: '★'.repeat(score) + '☆'.repeat(5 - score) }),
            r.review ? el('a', { class: 'pt-help', href: r.review, target: '_blank', rel: 'noopener', text: 'Gostou? Avalie o escritório no Google' }) : null].filter(Boolean));
        } catch (x) { err.textContent = x.message; e.currentTarget.disabled = false; }
      },
    }));
  return sec;
}

load();
