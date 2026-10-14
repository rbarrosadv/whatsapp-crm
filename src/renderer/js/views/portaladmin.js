// Página de acompanhamento do cliente — lado da equipe (ficha do cliente, menu ⋮):
// criar o link, copiar, enviar pelo WhatsApp (texto revisado), ver como o cliente,
// trocar/desligar, escolher quais processos aparecem e escrever novidades.
// As novidades também entram sozinhas quando alguém usa "Explicar ao cliente".
import { h, fill, modal, toast, errToast, confirmDialog, fmtDateTime, openExternal } from '../util.js';
import { state, api } from '../store.js';
import { icon } from '../icons.js';

export async function portalDialog(c) {
  const body = h('div', { class: 'form portal-admin' });
  const draw = async () => {
    let p;
    try { p = await api('portal:get', c.id); } catch (e) { errToast(e); return; }
    const url = p.token ? `${location.origin}/c/${p.token}` : null;
    const canAdmin = state.me?.role !== 'estagiario';
    const first = c.kind === 'pj' ? c.name : String(c.name || '').split(/\s+/)[0];
    const msg = h('textarea', { class: 'input', rows: 4 },
      `Olá, ${first}! Agora você pode acompanhar o seu processo pelo celular, a qualquer hora:\n${url || ''}\nPara entrar, digite os 4 últimos números do seu ${c.kind === 'pj' ? 'CNPJ' : 'CPF'}. Qualquer dúvida, é só chamar aqui.`);
    fill(body,
      h('p', { class: 'muted small' }, 'Uma página só deste cliente, como o rastreio de um pedido: a etapa do processo e há quanto tempo, o próximo passo, os andamentos do tribunal em palavras simples, os documentos que faltam, a próxima audiência (com confirmação de presença) e as novidades que vocês aprovarem pelo "Explicar ao cliente". Nada interno aparece.'),
      !p.hasDoc ? h('div', { class: 'chat-hint' }, icon('alert', 16), h('span', null, 'Sem CPF/CNPJ no cadastro: a página abre sem pedir os 4 números. Cadastre o documento para mais segurança.')) : null,
      url ? [
        h('div', { class: 'row portal-link' }, h('input', { class: 'input mono', readonly: true, value: url, onclick: (e) => e.target.select() }),
          h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(url); toast('Link copiado', 'success'); } catch { toast('Selecione e copie o link', 'info'); } } }, [icon('copy', 15), 'Copiar']),
          h('button', { class: 'btn', title: 'Abrir a página como o cliente vê', onclick: () => openExternal(url) }, 'Ver')),
        h('div', { class: 'muted small' }, p.views ? `Aberta ${p.views} vez(es) · última em ${fmtDateTime(p.last_view_at)}` : 'O cliente ainda não abriu a página.'),
        h('label', { class: 'field' }, h('span', null, 'Mensagem para o cliente'), msg),
        h('div', { class: 'row wrap' },
          p.jid ? h('button', { class: 'btn btn-primary', onclick: () => api('portal:send', c.id, msg.value).then(() => toast('Link enviado pelo WhatsApp', 'success')).catch(errToast) }, [icon('send', 15), 'Enviar pelo WhatsApp']) : null,
          h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(msg.value); toast('Mensagem copiada', 'success'); } catch { /* ignore */ } } }, 'Copiar mensagem'),
          h('div', { class: 'grow' }),
          canAdmin ? h('button', {
            class: 'btn', title: 'O link antigo para de funcionar e é criado um novo',
            onclick: async () => { if (await confirmDialog('Trocar o link? O antigo para de funcionar.', { okLabel: 'Trocar' })) { await api('portal:create', c.id).catch(errToast); draw(); } },
          }, 'Trocar link') : null,
          canAdmin ? h('button', {
            class: 'btn btn-danger',
            onclick: async () => { if (await confirmDialog('Desligar a página deste cliente? O link para de funcionar.', { okLabel: 'Desligar', danger: true })) { await api('portal:revoke', c.id).catch(errToast); draw(); } },
          }, 'Desligar') : null),
      ] : canAdmin ? h('button', { class: 'btn btn-primary', onclick: async () => { await api('portal:create', c.id).catch(errToast); draw(); } }, [icon('link', 15), 'Criar a página do cliente'])
        : h('p', { class: 'muted' }, 'Ainda não há página para este cliente. Peça a um advogado ou sócio para criar.'),
      url ? [
        h('h4', null, 'O que este cliente vê'),
        h('div', { class: 'portal-parts' }, Object.entries(p.partLabels).map(([key, label]) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: p.parts[key], disabled: !canAdmin, onchange: (e) => api('portal:setParts', c.id, { [key]: e.target.checked }).catch(errToast) }),
          ` ${label}`))),
        h('p', { class: 'muted small' }, 'A etapa do processo, a próxima audiência e as novidades que vocês aprovarem sempre aparecem. Valores, prazos internos e notas nunca aparecem.'),
      ] : null,
      h('h4', null, 'Processos que aparecem'),
      p.cases.length ? p.cases.map((k) => h('div', { class: 'list-row portal-case' },
        h('label', { class: 'check grow' },
          h('input', { type: 'checkbox', checked: k.on, disabled: !canAdmin, onchange: (e) => api('portal:caseToggle', k.id, e.target.checked).then(draw).catch(errToast) }),
          ` ${k.title}`, k.secret ? h('span', { class: 'muted small' }, ' · segredo de justiça') : null),
        k.on ? h('label', { class: 'check small', title: 'Os andamentos do tribunal aparecem sozinhos, em palavras simples (sentença, decisão, acordo… só depois do "Explicar ao cliente"). Desligado: só o que vocês aprovarem.' },
          h('input', { type: 'checkbox', checked: k.auto, disabled: !canAdmin, onchange: (e) => api('portal:caseAuto', k.id, e.target.checked).catch(errToast) }),
          ' andamentos automáticos') : null,
        h('span', { class: 'muted small' }, `${k.news} novidade(s)`),
        h('button', { class: 'btn btn-sm', onclick: () => newsDialog(k, draw) }, 'Novidades'))) : h('p', { class: 'muted small' }, 'Nenhum processo em andamento.'));
  };
  modal({ title: `Página de acompanhamento — ${c.name}`, wide: true, body, actions: [{ label: 'Fechar' }] });
  draw();
}

/** Novidades de um processo na página do cliente: ver, escrever, apagar. */
async function newsDialog(k, onDone) {
  const list = h('div', { class: 'portal-news' });
  const title = h('input', { class: 'input', placeholder: 'Ex.: Audiência marcada' });
  const text = h('textarea', { class: 'input', rows: 4, placeholder: 'Em palavras simples: o que aconteceu e o que vem agora.' });
  const draw = async () => {
    const news = await api('portal:news', k.id).catch(() => []);
    fill(list, news.length ? news.map((n) => h('div', { class: 'list-row' },
      h('div', { class: 'grow' }, h('b', null, n.title), h('div', { class: 'small', style: { whiteSpace: 'pre-line' } }, n.text),
        h('div', { class: 'muted small' }, `${new Date(n.ts).toLocaleDateString('pt-BR')}${n.created_by ? ` · ${n.created_by}` : ''}`)),
      state.me?.role !== 'estagiario' ? h('button', { class: 'icon-btn small', title: 'Apagar', onclick: async () => { await api('portal:deleteNews', n.id).catch(errToast); draw(); onDone?.(); } }, icon('trash', 15)) : null))
      : h('p', { class: 'muted small' }, 'Nenhuma novidade ainda. Elas entram sozinhas quando alguém usa "Explicar ao cliente" num andamento.'));
  };
  modal({
    title: `Novidades — ${k.title}`,
    body: h('div', { class: 'form' }, list, h('h4', null, 'Escrever uma novidade'),
      h('label', { class: 'field' }, h('span', null, 'Título'), title), h('label', { class: 'field' }, h('span', null, 'Texto'), text)),
    actions: [{ label: 'Fechar' }, {
      label: 'Publicar na página', primary: true,
      onClick: async () => {
        if (!text.value.trim()) { toast('Escreva a novidade', 'error'); return false; }
        await api('portal:addNews', k.id, { title: title.value.trim() || undefined, text: text.value.trim() });
        title.value = ''; text.value = '';
        toast('Publicada na página do cliente', 'success');
        draw();
        onDone?.();
        return false;
      },
    }],
  });
  draw();
}

