// Pré-visualização de links (título, resumo e imagem da página), como o
// WhatsApp faz: usada para mostrar o cartão enquanto você digita e para enviar
// o link já com o cartão para o contato.
const UA = 'Mozilla/5.0 (compatible; facebookexternalhit/1.1; +http://www.facebook.com/externalhit_uatext.php)';
const MAX_HTML = 1.5e6;
const MAX_IMG = 4e6;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lê as etiquetas og:/twitter:/<title> do HTML. */
export function parseMeta(html, baseUrl) {
  const head = String(html).slice(0, 300000);
  const meta = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = /\b(?:property|name|itemprop)\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase();
    const val = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (key && val && !(key in meta)) meta[key] = decode(val[1] ?? val[2] ?? val[3]);
  }
  const titleTag = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]);
  const abs = (u) => { try { return u ? new URL(u, baseUrl).href : null; } catch { return null; } };
  return {
    title: meta['og:title'] || meta['twitter:title'] || titleTag || '',
    description: meta['og:description'] || meta['twitter:description'] || meta.description || '',
    image: abs(meta['og:image:secure_url'] || meta['og:image'] || meta['twitter:image'] || meta['twitter:image:src'] || meta.image),
    canonical: abs(meta['og:url']) || baseUrl,
  };
}

async function readLimited(res, max) {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.from(await res.arrayBuffer()).subarray(0, max);
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
    if (size >= max) { reader.cancel().catch(() => {}); break; }
  }
  return Buffer.concat(parts);
}

export class LinkPreviewService {
  /**
   * @param {{fetch?: Function, thumbnail?: (buf:Buffer)=>Buffer|null, timeoutMs?: number}} opts
   *   thumbnail: reduz a imagem para JPEG pequeno (no Electron usa nativeImage)
   */
  constructor({ fetch: f = globalThis.fetch, thumbnail = null, timeoutMs = 7000 } = {}) {
    this.fetch = f;
    this.thumbnail = thumbnail;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
  }

  async get(url) {
    if (!/^https?:\/\//i.test(url || '')) return null;
    if (this.cache.has(url)) return this.cache.get(url);
    const p = this.load(url).catch(() => null);
    this.cache.set(url, p);
    if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value);
    const r = await p;
    if (!r) this.cache.delete(url); // tenta de novo numa próxima vez
    return r;
  }

  async request(url, accept) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetch(url, { headers: { 'user-agent': UA, accept, 'accept-language': 'pt-BR,pt;q=0.9' }, redirect: 'follow', signal: ctrl.signal });
    } finally { clearTimeout(t); }
  }

  async load(url) {
    const res = await this.request(url, 'text/html,application/xhtml+xml');
    if (!res.ok || !/html/i.test(res.headers.get('content-type') || 'text/html')) return null;
    const html = (await readLimited(res, MAX_HTML)).toString('utf-8');
    const meta = parseMeta(html, res.url || url);
    if (!meta.title && !meta.description) return null;
    let thumb = null;
    if (meta.image && this.thumbnail) {
      try {
        const ir = await this.request(meta.image, 'image/*');
        if (ir.ok && /^image\//i.test(ir.headers.get('content-type') || 'image/')) {
          thumb = this.thumbnail(await readLimited(ir, MAX_IMG)) || null;
        }
      } catch { thumb = null; }
    }
    return {
      url,
      canonical: meta.canonical || url,
      title: meta.title.slice(0, 200),
      description: meta.description.slice(0, 300),
      thumb, // Buffer JPEG pequeno, ou null
    };
  }
}
