// Resumo do mês para o cliente: o sistema monta o rascunho (fase de cada processo,
// o que aconteceu de importante, próxima audiência); alguém revisa e envia pelo
// WhatsApp ou copia para mandar por outro meio. Nada sai sozinho.
import { h, modal, toast, errToast } from '../util.js';
import { api } from '../store.js';

export async function summaryDialog(clientId, onDone) {
  let s;
  try { s = await api('clients:monthlySummary', clientId); } catch (e) { errToast(e); return; }
  const text = h('textarea', { class: 'input', rows: 14 }, s.text);
  const finish = async (via) => {
    try {
      if (via === 'copy') await navigator.clipboard.writeText(text.value).catch(() => {});
      await api('clients:sendSummary', clientId, text.value, { via });
      toast(via === 'whatsapp' ? 'Resumo enviado pelo WhatsApp' : 'Texto copiado e resumo marcado como enviado', 'success');
      onDone?.();
      return true;
    } catch (e) { errToast(e); return false; }
  };
  modal({
    title: `Resumo do mês — ${s.name}`,
    wide: true,
    body: h('div', { class: 'form' },
      h('p', { class: 'muted small' }, 'Revise o texto antes de enviar: ele é montado com os andamentos importantes do mês passado (sem os de rotina).'),
      text),
    actions: [
      { label: 'Cancelar' },
      { label: 'Copiar e marcar como enviado', onClick: () => finish('copy') },
      s.jid ? { label: 'Enviar pelo WhatsApp', primary: true, onClick: () => finish('whatsapp') } : null,
    ].filter(Boolean),
  });
}
