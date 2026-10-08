// Converte as mensagens cruas do WhatsApp (formato protobuf do Baileys)
// num formato simples pra gravar no banco e mostrar na tela.
import { normalizeMessageContent, getContentType, BufferJSON, WAMessageStubType } from '@whiskeysockets/baileys';

const MEDIA_TYPES = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
};

function toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function tsOf(msg) {
  const t = toNum(msg.messageTimestamp);
  return t ? t * 1000 : Date.now();
}

function textOfContent(c) {
  if (!c) return '';
  const type = getContentType(c);
  const v = type ? c[type] : null;
  if (typeof v === 'string') return v;
  if (!v) return '';
  return v.text || v.caption || v.selectedDisplayText || v.name || v.title
    || v.singleSelectReply?.selectedRowId || v.displayName || '';
}

function b64(buf) {
  if (!buf) return null;
  try { return Buffer.from(buf).toString('base64'); } catch { return null; }
}

const STUB_TEXT = {
  GROUP_CREATE: 'criou o grupo',
  GROUP_CHANGE_SUBJECT: 'mudou o nome do grupo',
  GROUP_CHANGE_ICON: 'mudou a imagem do grupo',
  GROUP_CHANGE_DESCRIPTION: 'mudou a descrição do grupo',
  GROUP_PARTICIPANT_ADD: 'adicionou participante(s)',
  GROUP_PARTICIPANT_REMOVE: 'removeu participante(s)',
  GROUP_PARTICIPANT_LEAVE: 'saiu do grupo',
  GROUP_PARTICIPANT_INVITE: 'entrou pelo link de convite',
  GROUP_PARTICIPANT_PROMOTE: 'virou administrador',
  GROUP_PARTICIPANT_DEMOTE: 'deixou de ser administrador',
  CALL_MISSED_VOICE: 'Chamada de voz perdida',
  CALL_MISSED_VIDEO: 'Chamada de vídeo perdida',
  CALL_MISSED_GROUP_VOICE: 'Chamada de voz em grupo perdida',
  CALL_MISSED_GROUP_VIDEO: 'Chamada de vídeo em grupo perdida',
  E2E_ENCRYPTED: null,
  CIPHERTEXT: 'Aguardando esta mensagem. Isso pode levar alguns instantes.',
};

/**
 * @returns {{kind:'message', row:object} | {kind:'reaction', targetId, reaction:{from, text}} |
 *          {kind:'revoke', targetId} | {kind:'edit', targetId, text} | {kind:'ignore'}}
 */
export function parseMessage(msg, { chatJid, senderJid, senderName, keepRaw }) {
  const key = msg.key || {};
  const base = {
    chat_jid: chatJid,
    id: key.id,
    from_me: key.fromMe ? 1 : 0,
    sender: senderJid || null,
    sender_name: senderName || null,
    ts: tsOf(msg),
    status: msg.status ?? (key.fromMe ? 2 : null),
  };

  // visualização única: o WhatsApp não entrega o conteúdo aos aparelhos conectados,
  // só ao celular — mostra um aviso no lugar para a mensagem não sumir
  const vo = viewOnceKind(msg);
  if (vo) {
    return {
      kind: 'message',
      row: { ...base, type: 'text', text: `👁 ${vo} de visualização única. Abra no celular para ver.`, extra: JSON.stringify({ viewOnce: true }) },
    };
  }

  if (msg.messageStubType) {
    const stubName = WAMessageStubType[msg.messageStubType];
    if (stubName === 'REVOKE') return { kind: 'revoke', targetId: key.id };
    const txt = STUB_TEXT[stubName];
    if (txt === undefined || txt === null) return { kind: 'ignore' };
    const isCall = stubName.startsWith('CALL_');
    return { kind: 'message', row: { ...base, type: isCall ? 'call' : 'system', text: txt } };
  }

  const content = normalizeMessageContent(msg.message);
  if (!content) return { kind: 'ignore' };
  const type = getContentType(content);
  if (!type) return { kind: 'ignore' };
  const inner = content[type];

  if (type === 'protocolMessage') {
    const pm = inner;
    // 0 = REVOKE, 14 = MESSAGE_EDIT
    if (pm.type === 0 && pm.key?.id) return { kind: 'revoke', targetId: pm.key.id };
    if (pm.type === 14 && pm.key?.id) {
      return { kind: 'edit', targetId: pm.key.id, text: textOfContent(pm.editedMessage) };
    }
    return { kind: 'ignore' };
  }
  if (type === 'editedMessage') {
    const pm = inner?.message?.protocolMessage;
    if (pm?.key?.id) return { kind: 'edit', targetId: pm.key.id, text: textOfContent(pm.editedMessage) };
    return { kind: 'ignore' };
  }
  if (type === 'reactionMessage') {
    return {
      kind: 'reaction',
      targetId: inner.key?.id,
      reaction: { from: key.fromMe ? 'me' : (senderJid || chatJid), text: inner.text || '' },
    };
  }
  if (['senderKeyDistributionMessage', 'messageContextInfo', 'pollUpdateMessage', 'keepInChatMessage',
    'encReactionMessage', 'pinInChatMessage', 'deviceSentMessage'].includes(type)) {
    return { kind: 'ignore' };
  }

  const row = { ...base, type: 'text', text: '' };
  const ctx = inner?.contextInfo;
  if (ctx?.stanzaId) {
    row.quoted_id = ctx.stanzaId;
    row.quoted_sender = ctx.participant || null;
    row.quoted_text = describeContent(normalizeMessageContent(ctx.quotedMessage)) || null;
  }

  if (MEDIA_TYPES[type]) {
    row.type = MEDIA_TYPES[type];
    if (type === 'audioMessage' && inner.ptt) row.type = 'ptt';
    row.text = inner.caption || '';
    row.media_mime = inner.mimetype || null;
    row.media_name = inner.fileName || inner.title || null;
    row.media_size = toNum(inner.fileLength);
    row.media_seconds = toNum(inner.seconds);
    const thumb = b64(inner.jpegThumbnail);
    if (thumb) row.thumb = `data:image/jpeg;base64,${thumb}`;
    keepRaw = true;
  } else if (type === 'conversation') {
    row.text = inner || '';
  } else if (type === 'extendedTextMessage') {
    row.text = inner.text || '';
    if (inner.matchedText || inner.title) {
      // cartão de pré-visualização do link (imagem pequena vem junto na mensagem)
      row.extra = JSON.stringify({ link: { url: inner.canonicalUrl || inner.matchedText, title: inner.title, description: inner.description } });
      const thumb = b64(inner.jpegThumbnail);
      if (thumb) row.thumb = `data:image/jpeg;base64,${thumb}`;
    }
  } else if (type === 'locationMessage' || type === 'liveLocationMessage') {
    row.type = 'location';
    row.text = inner.name || inner.address || inner.caption || '';
    row.extra = JSON.stringify({ lat: inner.degreesLatitude, lng: inner.degreesLongitude });
    const thumb = b64(inner.jpegThumbnail);
    if (thumb) row.thumb = `data:image/jpeg;base64,${thumb}`;
  } else if (type === 'contactMessage') {
    row.type = 'contact';
    row.text = inner.displayName || '';
    row.extra = JSON.stringify({ contacts: [{ name: inner.displayName, vcard: inner.vcard }] });
  } else if (type === 'contactsArrayMessage') {
    row.type = 'contact';
    row.text = inner.displayName || `${inner.contacts?.length || 0} contatos`;
    row.extra = JSON.stringify({ contacts: (inner.contacts || []).map((c) => ({ name: c.displayName, vcard: c.vcard })) });
  } else if (type.startsWith('pollCreationMessage')) {
    row.type = 'poll';
    row.text = inner.name || '';
    row.extra = JSON.stringify({ options: (inner.options || []).map((o) => o.optionName) });
    keepRaw = true;
  } else if (type === 'eventMessage') {
    row.text = `📅 ${inner.name || 'Evento'}${inner.description ? `\n${inner.description}` : ''}`;
  } else if (type === 'call') {
    row.type = 'call';
    row.text = 'Chamada em grupo recebida';
  } else {
    const t = textOfContent(content);
    if (!t) return { kind: 'ignore' };
    row.text = t;
  }

  if (keepRaw) row.raw = JSON.stringify(msg, BufferJSON.replacer);
  return { kind: 'message', row };
}

/** Se for mensagem de visualização única, devolve o tipo ("Foto", "Vídeo", "Áudio", "Mensagem"). */
export function viewOnceKind(msg) {
  const m = msg.message || {};
  const wrapped = m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension;
  const content = wrapped ? normalizeMessageContent(m) : null;
  const inner = content ? content[getContentType(content)] : null;
  const flagged = Object.values(m).some((v) => v && typeof v === 'object' && v.viewOnce === true);
  if (!msg.key?.isViewOnce && !wrapped && !flagged) return null;
  const type = content ? getContentType(content) : Object.keys(m).find((k) => m[k]?.viewOnce);
  if (inner?.viewOnce === false) return null;
  return { imageMessage: 'Foto', videoMessage: 'Vídeo', audioMessage: 'Áudio' }[type] || 'Mensagem';
}

export function describeContent(c) {
  if (!c) return '';
  const type = getContentType(c);
  const t = textOfContent(c);
  const label = {
    imageMessage: '📷 Foto', videoMessage: '🎥 Vídeo', audioMessage: '🎤 Áudio', documentMessage: '📄 Documento',
    stickerMessage: '💟 Figurinha', locationMessage: '📍 Localização', contactMessage: '👤 Contato',
  }[type];
  if (label) return t ? `${label}: ${t}` : label;
  return t;
}

export function rawToMessage(raw) {
  if (!raw) return null;
  return JSON.parse(raw, BufferJSON.reviver);
}
