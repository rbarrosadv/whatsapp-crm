// Sugestões tiradas dos andamentos e intimações: "Audiência detectada" (pôr na
// agenda) e "Avisar o cliente" (mensagem pronta, conferida antes de enviar).
// Nada é feito sozinho: cada sugestão espera alguém conferir.
import { h, modal, toast, errToast, toLocalInput, fromLocalInput } from '../util.js';
import { api } from '../store.js';

const fmt = (ts) => new Date(ts).toLocaleDateString('pt-BR');
const fmtTs = (ts) => `${fmt(ts)} às ${new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;

export function hintLabel(hint) {
  if (hint.kind === 'hearing') return { title: `Audiência detectada: ${hint.title}`, meta: `${fmtTs(hint.ts)} · confira a data antes de pôr na agenda`, action: 'Pôr na agenda' };
  return { title: `Andamento importante: ${hint.title}`, meta: `${hint.ts ? fmt(hint.ts) : ''} · avise o cliente`, action: 'Conferir e enviar' };
}

/** Abre a ação da sugestão (agenda ou mensagem ao cliente). */
export function runHint(hint, onDone) {
  return hint.kind === 'hearing' ? hearingDialog(hint, onDone) : clientUpdateDialog(hint, onDone);
}

export function dismissHint(hint, onDone) {
  return api('hints:dismiss', hint.id).then(() => onDone?.()).catch(errToast);
}

function hearingDialog(hint, onDone) {
  const title = h('input', { class: 'input', value: hint.title });
  const when = h('input', { class: 'input', type: 'datetime-local', value: toLocalInput(hint.ts) });
  modal({
    title: 'Pôr a audiência na agenda',
    body: h('div', { class: 'form' },
      h('p', { class: 'muted small' }, 'Tirado do andamento/intimação:'),
      h('blockquote', { class: 'hint-quote' }, hint.text),
      h('label', { class: 'field' }, h('span', null, 'Compromisso'), title),
      h('label', { class: 'field' }, h('span', null, 'Data e hora (confira)'), when)),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Pôr na agenda', primary: true,
        onClick: async () => {
          const ts = fromLocalInput(when.value);
          if (!ts) { toast('Informe a data', 'error'); return false; }
          await api('hints:hearing', hint.id, { due_at: ts, title: title.value });
          toast('Audiência na agenda do responsável', 'success');
          onDone?.();
          return true;
        },
      },
    ],
  });
}

async function clientUpdateDialog(hint, onDone) {
  let info;
  try { info = await api('hints:clientText', hint.id); } catch (e) { errToast(e); return; }
  const text = h('textarea', { class: 'input', rows: 7 }, info.text);
  const send = async (via) => {
    await api('hints:sendClient', hint.id, text.value, { via });
    onDone?.();
    return true;
  };
  modal({
    title: `Avisar ${info.client_name || 'o cliente'}`,
    body: h('div', { class: 'form' },
      h('p', { class: 'muted small' }, 'Andamento:'),
      h('blockquote', { class: 'hint-quote' }, hint.text),
      h('label', { class: 'field' }, h('span', null, 'Mensagem (revise antes de enviar)'), text),
      info.jid ? null : h('p', { class: 'muted small' }, 'O cliente não tem WhatsApp ligado: copie o texto e envie por outro meio.')),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Copiar e marcar avisado',
        onClick: async () => {
          try { await navigator.clipboard.writeText(text.value); } catch { /* sem área de transferência */ }
          toast('Texto copiado', 'success');
          return send('copy');
        },
      },
      info.jid ? {
        label: 'Enviar pelo WhatsApp', primary: true,
        onClick: async () => { await send('whatsapp'); toast('Mensagem enviada ao cliente', 'success'); return true; },
      } : null,
    ].filter(Boolean),
  });
}
