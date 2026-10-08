// Onde fica a pasta "BARROS ADVOGADOS": no disco deste computador (OneDrive
// sincronizado, modo local) ou no OneDrive pela API da Microsoft (Graph),
// quando o sistema roda num servidor. Os dois têm a mesma interface, com
// caminhos relativos à pasta do escritório ("02 CLIENTES/FULANO/…").
import fs from 'node:fs';
import path from 'node:path';

export const posix = (p) => String(p || '').split(/[\\/]+/).filter(Boolean).join('/');
const HIDDEN = /^(\.|~\$|desktop\.ini$|thumbs\.db$)/i;

// ------------------------------------------------------------ disco

export class LocalStore {
  constructor(root) { this.root = path.resolve(root); this.kind = 'local'; }

  /** Caminho no disco, sem sair da pasta do escritório. */
  abs(rel = '') {
    const a = path.resolve(this.root, posix(rel).replace(/\//g, path.sep));
    if (a !== this.root && !a.startsWith(this.root + path.sep)) throw new Error('Caminho fora da pasta do escritório.');
    return a;
  }

  async ok() { return fs.existsSync(this.root) && fs.statSync(this.root).isDirectory(); }
  async exists(rel) { return fs.existsSync(this.abs(rel)); }
  async stat(rel) {
    try {
      const st = fs.statSync(this.abs(rel));
      return { dir: st.isDirectory(), size: st.isDirectory() ? null : st.size, mtime: Math.floor(st.mtimeMs) };
    } catch { return null; }
  }

  async list(rel) {
    const dir = this.abs(rel);
    if (!fs.existsSync(dir)) return null;
    const out = [];
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (HIDDEN.test(d.name)) continue;
      let st;
      try { st = fs.statSync(path.join(dir, d.name)); } catch { continue; }
      out.push({ name: d.name, dir: st.isDirectory(), size: st.isDirectory() ? null : st.size, mtime: Math.floor(st.mtimeMs) });
    }
    return out;
  }

  async mkdir(rel) { fs.mkdirSync(this.abs(rel), { recursive: true }); }
  async read(rel) { return fs.readFileSync(this.abs(rel)); }
  async write(rel, buf) { fs.mkdirSync(path.dirname(this.abs(rel)), { recursive: true }); fs.writeFileSync(this.abs(rel), buf); }
  async copyIn(rel, srcPath) { fs.mkdirSync(path.dirname(this.abs(rel)), { recursive: true }); fs.copyFileSync(srcPath, this.abs(rel)); }
  async move(from, to) {
    fs.mkdirSync(path.dirname(this.abs(to)), { recursive: true });
    fs.renameSync(this.abs(from), this.abs(to));
  }

  /** Todos os arquivos (para o índice da busca), de pouco em pouco. */
  async* walk(limit = 100000) {
    const stack = [''];
    let n = 0;
    while (stack.length) {
      const rel = stack.pop();
      const list = await this.list(rel).catch(() => null);
      for (const e of list || []) {
        const r = posix(`${rel}/${e.name}`);
        if (e.dir) { stack.push(r); continue; }
        yield { rel: r, name: e.name, size: e.size, mtime: e.mtime };
        if (++n >= limit) return;
        if (n % 50 === 0) await new Promise((res) => setImmediate(res));
      }
    }
  }
}

// ------------------------------------------------------------ OneDrive (Microsoft Graph)

export const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * Pasta compartilhada com a conta do escritório: `driveId` + `itemId` da pasta
 * "BARROS ADVOGADOS". `getToken()` devolve um token de acesso válido.
 */
export class GraphStore {
  constructor({ driveId, itemId, getToken, fetch: f = globalThis.fetch }) {
    this.driveId = driveId;
    this.itemId = itemId;
    this.getToken = getToken;
    this.fetch = f;
    this.kind = 'onedrive';
    // cache: cada consulta à Microsoft leva ~0,3–1 s; pastas e itens já vistos
    // ficam guardados por alguns minutos e são esquecidos quando o sistema muda algo
    this.cache = new Map(); // 'L:caminho' (lista) | 'I:caminho' (item) → { at, v }
    this.ttl = 5 * 60e3;
    this.okAt = 0;
  }

  cached(key, load) {
    const c = this.cache.get(key);
    if (c && Date.now() - c.at < this.ttl) return c.v;
    const v = load().then((r) => r, (e) => { this.cache.delete(key); throw e; });
    this.cache.set(key, { at: Date.now(), v });
    if (this.cache.size > 5000) for (const k of [...this.cache.keys()].slice(0, 1000)) this.cache.delete(k);
    return v;
  }

  /** Esquece o caminho, o que está dentro dele e a lista da pasta de cima. */
  forget(rel) {
    const p = posix(rel);
    const parent = p.split('/').slice(0, -1).join('/');
    for (const k of [...this.cache.keys()]) {
      const kp = k.slice(2);
      if (kp === p || kp.startsWith(`${p}/`) || (k[0] === 'L' && kp === parent)) this.cache.delete(k);
    }
    if (!p) this.cache.clear();
  }

  /** Limpa tudo (botão "Atualizar" ou depois de reler o índice). */
  refresh() { this.cache.clear(); }

  base() { return `${GRAPH}/drives/${encodeURIComponent(this.driveId)}/items/${encodeURIComponent(this.itemId)}`; }
  itemUrl(rel) {
    const p = posix(rel);
    return p ? `${this.base()}:/${p.split('/').map(encodeURIComponent).join('/')}:` : this.base();
  }

  async req(url, init = {}, { allow404 = false, raw = false } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await this.getToken();
      const r = await this.fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
      if (r.status === 404 && allow404) return null;
      if (r.status === 429 || r.status === 503) {
        const wait = Math.min(30, Number(r.headers?.get?.('retry-after')) || 2 * (attempt + 1));
        await new Promise((res) => setTimeout(res, wait * 1000));
        continue;
      }
      if (!r.ok) {
        let msg = `OneDrive respondeu ${r.status}`;
        try { const j = await r.json(); if (j?.error?.message) msg += `: ${j.error.message}`; } catch { /* sem corpo */ }
        const e = new Error(msg);
        e.status = r.status;
        throw e;
      }
      if (raw) return r;
      return r.status === 204 ? null : r.json();
    }
    throw new Error('O OneDrive pediu para esperar. Tente de novo em alguns minutos.');
  }

  async ok() {
    if (Date.now() - this.okAt < this.ttl) return true;
    try {
      const it = await this.req(this.base());
      if (it?.folder) this.okAt = Date.now();
      return !!it?.folder;
    } catch { return false; }
  }

  async item(rel) {
    const p = posix(rel);
    const it = await this.cached(`I:${p}`, () => this.req(this.itemUrl(p), {}, { allow404: true }));
    if (!it) this.cache.delete(`I:${p}`); // não existe ainda: pode ser criado por fora
    return it;
  }
  async exists(rel) { return !!(await this.item(rel)); }
  async stat(rel) {
    const it = await this.item(rel);
    return it ? { dir: !!it.folder, size: it.folder ? null : it.size, mtime: Date.parse(it.lastModifiedDateTime) || 0, id: it.id } : null;
  }

  async list(rel) {
    const p = posix(rel);
    const out = await this.cached(`L:${p}`, () => this.listNow(p));
    if (!out) this.cache.delete(`L:${p}`);
    return out && out.map((e) => ({ ...e }));
  }

  async listNow(p) {
    let url = `${p ? this.itemUrl(p) : this.base()}/children?$top=999&$select=id,name,size,lastModifiedDateTime,folder,file`;
    const out = [];
    while (url) {
      const j = await this.req(url, {}, { allow404: true });
      if (!j) return out.length ? out : null;
      for (const it of j.value || []) {
        if (HIDDEN.test(it.name)) continue;
        out.push({ name: it.name, dir: !!it.folder, size: it.folder ? null : it.size, mtime: Date.parse(it.lastModifiedDateTime) || 0, id: it.id });
      }
      url = j['@odata.nextLink'] || null;
    }
    return out;
  }

  /** Cria as pastas que faltam no caminho. */
  async mkdir(rel) {
    const parts = posix(rel).split('/').filter(Boolean);
    let cur = '';
    for (const name of parts) {
      const next = cur ? `${cur}/${name}` : name;
      if (!(await this.item(next))) {
        const parentUrl = cur ? this.itemUrl(cur) : this.base();
        try {
          await this.req(`${parentUrl}/children`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
          });
        } catch (e) { if (e.status !== 409) throw e; }
        this.forget(next);
      }
      cur = next;
    }
  }

  async read(rel) {
    const r = await this.req(`${this.itemUrl(rel)}/content`, {}, { raw: true });
    return Buffer.from(await r.arrayBuffer());
  }

  async write(rel, buf) {
    const dir = posix(rel).split('/').slice(0, -1).join('/');
    if (dir) await this.mkdir(dir);
    if (buf.length > 200 * 1024 * 1024) throw new Error('Arquivo grande demais para enviar ao OneDrive pelo sistema (limite 200 MB).');
    await this.req(`${this.itemUrl(rel)}/content`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: buf });
    this.forget(rel);
  }

  async copyIn(rel, srcPath) { await this.write(rel, fs.readFileSync(srcPath)); }

  async move(from, to) {
    const src = await this.item(from);
    if (!src) throw new Error('A pasta não foi encontrada no OneDrive.');
    const parts = posix(to).split('/');
    const name = parts.pop();
    const parentRel = parts.join('/');
    if (parentRel) await this.mkdir(parentRel);
    const parent = parentRel ? await this.item(parentRel) : { id: this.itemId };
    await this.req(`${GRAPH}/drives/${encodeURIComponent(this.driveId)}/items/${encodeURIComponent(src.id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentReference: { id: parent.id }, name }),
    });
    this.forget(from);
    this.forget(to);
  }

  /** Link temporário (pré-autorizado) para baixar/abrir o arquivo. */
  async downloadUrl(rel) {
    const it = await this.req(`${this.itemUrl(rel)}?$select=id,name,@microsoft.graph.downloadUrl`, {}, { allow404: true });
    return it?.['@microsoft.graph.downloadUrl'] || null;
  }

  async* walk(limit = 100000) {
    const stack = [''];
    let n = 0;
    while (stack.length) {
      const rel = stack.pop();
      // relê da Microsoft (o índice é o que descobre mudanças feitas por fora) e renova o cache
      const p = posix(rel);
      const list = await this.listNow(p).catch(() => null);
      if (list) this.cache.set(`L:${p}`, { at: Date.now(), v: Promise.resolve(list) });
      for (const e of list || []) {
        const r = posix(`${rel}/${e.name}`);
        if (e.dir) { stack.push(r); continue; }
        yield { rel: r, name: e.name, size: e.size, mtime: e.mtime };
        if (++n >= limit) return;
      }
      await new Promise((res) => setTimeout(res, 150)); // sem rajadas à Microsoft
    }
  }
}
