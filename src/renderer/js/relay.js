// Plano B dos tribunais: no app de desktop, esta janela se oferece ao servidor
// para buscar no DJEN/DataJud pela internet do escritório quando o servidor é
// recusado. Quem busca é o app (só os endereços públicos do CNJ); a resposta
// volta para o servidor, que segue como se tivesse buscado ele mesmo.
import { api } from './store.js';

export function setupRelay() {
  if (!window.desktop?.courtFetch) return;
  const register = () => api('relay:register').catch(() => {});
  register();
  window.api.on('bridge:reconnected', register);
  window.api.on('relay:fetch', async (req) => {
    let out;
    try { out = await window.desktop.courtFetch(req); } catch (e) { out = { error: e.message || String(e) }; }
    api('relay:done', req.id, out).catch(() => {});
  });
}
