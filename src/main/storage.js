// Onde fica a pasta "BARROS ADVOGADOS": no disco deste computador (OneDrive
// sincronizado, modo local) ou no OneDrive pela API da Microsoft (Graph),
// quando o sistema roda num servidor. Os dois têm a mesma interface, com
// caminhos relativos à pasta do escritório ("02 CLIENTES/FULANO/…").
import fs from 'node:fs';
import path from 'node:path';

export const posix = (p) => String(p || '').split(/[\\/]+/).filter(Boolean).join('/');
const HIDDEN = /^(\.|~\$|desktop\.ini$|thumbs\.db$)/i;
const listSig = (l) => (l ? l.map((e) => `${e.name}|${e.dir ? 1 : 0}|${e.size}|${e.mtime}`).sort().join('\n') : '');

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

const OFFICE_APP = [[/\.(docx?|docm|dotx|rtf|odt)$/i, 'word'], [/\.(xlsx?|xlsm|csv|ods)$/i, 'excel'], [/\.(pptx?|ppsx|odp)$/i, 'powerpoint']];
export const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * Pasta compartilhada com a conta do escritório: `driveId` + `itemId` da pasta
 * "BARROS ADVOGADOS". `getToken()` devolve um token de acesso válido.
 */
export class GraphStore {
  constructor({ driveId, itemId, getToken, fetch: f = globalThis.fetch, mirror = null, filesDir = null, filesMax = 2 * 1024 ** 3, onChange = null }) {
    this.driveId = driveId;
    this.itemId = itemId;
    this.getToken = getToken;
    this.fetch = f;
    this.kind = 'onedrive';
    // como o aplicativo do OneDrive: as pastas ficam guardadas (abrem na hora e
    // são conferidas em segundo plano; `onChange(rel)` quando mudou) e os arquivos
    // já abertos ficam numa cópia no servidor, baixados de novo só se mudarem
    this.mirror = mirror; // { get(p) → {at, list}, set(p, list), drop(p), prune(vistos) }
    this.filesDir = filesDir;
    this.filesMax = filesMax;
    this.onChange = onChange;
    this.revalidating = new Set();
    this.downloading = new Map();
    // cache: cada consulta à Microsoft leva ~0,3–1 s; pastas e itens já vistos
    // ficam guardados por alguns minutos e são esquecidos quando o sistema muda algo
    this.cache = new Map(); // 'L:caminho' (lista) | 'I:caminho' (item) → { at, v }
    this.ttl = 5 * 60e3;
    this.okAt = 0;
  }

  cached(key, load) {
    const c = this.cache.get(key);
    if (c && Date.now() - c.at < this.ttl) return c.v;
    const entry = { at: Date.now(), done: false };
    entry.v = load().then((r) => { entry.done = true; return r; }, (e) => { this.cache.delete(key); throw e; });
    this.cache.set(key, entry);
    const v = entry.v;
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
    // a cópia guardada também (a próxima abertura relê da Microsoft)
    this.mirror?.drop(p);
    this.mirror?.drop(parent);
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
    const key = `L:${p}`;
    const c = this.cache.get(key);
    let out;
    if (c && c.done && Date.now() - c.at < this.ttl) out = await c.v;
    else {
      const saved = this.mirror?.get(p);
      if (saved) {
        // abre na hora com a cópia guardada; confere com a Microsoft por trás
        out = saved.list;
        if (Date.now() - saved.at > 30e3) this.revalidate(p, saved.list);
      } else out = await this.cached(key, () => this.listNow(p));
    }
    if (!out) this.cache.delete(key);
    return out && out.map((e) => ({ ...e }));
  }

  /** Relê a pasta em segundo plano e avisa se mudou desde a cópia guardada. */
  revalidate(p, old) {
    if (this.revalidating.has(p)) return;
    this.revalidating.add(p);
    this.cache.delete(`L:${p}`);
    this.cached(`L:${p}`, () => this.listNow(p))
      .then((list) => { if (listSig(list) !== listSig(old)) this.onChange?.(p); })
      .catch(() => {})
      .finally(() => this.revalidating.delete(p));
  }

  async listNow(p) {
    const out = await this.listRemote(p);
    if (this.mirror) { if (out) this.mirror.set(p, out); else this.mirror.drop(p); }
    return out;
  }

  async listRemote(p) {
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
    const c = await this.localCopy(rel).catch(() => null);
    if (c?.file) return fs.promises.readFile(c.file);
    const r = await this.req(`${this.itemUrl(rel)}/content`, {}, { raw: true });
    return Buffer.from(await r.arrayBuffer());
  }

  /**
   * Cópia do arquivo no servidor: `{ file, size, mtime, name }` (pronta, ou baixada
   * agora) ou `{ link, size, mtime }` para os grandes demais (> 150 MB), ou null.
   * Confere a versão na Microsoft a cada abertura (uma consulta rápida) e só
   * baixa de novo se o arquivo mudou.
   */
  async localCopy(rel) {
    const it = await this.req(`${this.itemUrl(rel)}?$select=id,name,size,lastModifiedDateTime,file,folder,@microsoft.graph.downloadUrl`, {}, { allow404: true });
    if (!it || it.folder) return null;
    const mtime = Date.parse(it.lastModifiedDateTime) || 0;
    const link = it['@microsoft.graph.downloadUrl'];
    if (!this.filesDir || it.size > 150 * 1024 * 1024) return link ? { link, size: it.size, mtime, name: it.name } : null;
    const id = String(it.id).replace(/[^A-Za-z0-9_-]/g, '_');
    const file = path.join(this.filesDir, `${id}-${mtime}-${it.size}${path.extname(it.name).toLowerCase().replace(/[^.a-z0-9]/g, '')}`);
    const out = { file, size: it.size, mtime, name: it.name };
    if (fs.existsSync(file)) {
      try { fs.utimesSync(file, new Date(), new Date(mtime)); } catch { /* ignore */ }
      return out;
    }
    if (!link) return null;
    if (!this.downloading.has(file)) {
      this.downloading.set(file, (async () => {
        const r = await this.fetch(link);
        if (!r.ok) throw new Error(`OneDrive respondeu ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        fs.mkdirSync(this.filesDir, { recursive: true });
        // versões antigas do mesmo arquivo saem
        for (const f of fs.readdirSync(this.filesDir)) if (f.startsWith(`${id}-`)) fs.rmSync(path.join(this.filesDir, f), { force: true });
        const tmp = `${file}.parcial`;
        fs.writeFileSync(tmp, buf);
        fs.utimesSync(tmp, new Date(), new Date(mtime));
        fs.renameSync(tmp, file);
        this.pruneFiles();
      })().finally(() => this.downloading.delete(file)));
    }
    await this.downloading.get(file);
    return out;
  }

  /** Guarda no máximo `filesMax` bytes: sai o que foi aberto há mais tempo. */
  pruneFiles() {
    let files;
    try {
      files = fs.readdirSync(this.filesDir).filter((f) => !f.endsWith('.parcial')).map((f) => {
        const st = fs.statSync(path.join(this.filesDir, f));
        return { f, size: st.size, used: st.atimeMs };
      });
    } catch { return; }
    let total = files.reduce((n, x) => n + x.size, 0);
    files.sort((a, b) => a.used - b.used);
    for (const x of files) {
      if (total <= this.filesMax) break;
      fs.rmSync(path.join(this.filesDir, x.f), { force: true });
      total -= x.size;
    }
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

  /**
   * Para editar no Office sem baixar cópia: o Word/Excel do computador abre o
   * arquivo do próprio OneDrive (ms-word:ofe|u|https://d.docs.live.net/…) e o
   * Word online pelo webUrl. Salvar = salvar no OneDrive.
   */
  async editInfo(rel) {
    const it = await this.req(`${this.itemUrl(rel)}?$select=id,name,webUrl,parentReference`, {}, { allow404: true });
    if (!it) throw new Error('Arquivo não encontrado no OneDrive.');
    this.forget(rel); // vai mudar por fora: a próxima lista busca de novo
    const app = OFFICE_APP.find(([re]) => re.test(it.name))?.[1] || null;
    const ref = it.parentReference || {};
    const at = ref.path ? String(ref.path).indexOf('root:') : -1;
    let live = null;
    if (at >= 0) {
      const parts = decodeURIComponent(String(ref.path).slice(at + 5)).split('/').filter(Boolean);
      live = `https://d.docs.live.net/${encodeURIComponent(ref.driveId || this.driveId)}/${[...parts, it.name].map(encodeURIComponent).join('/')}`;
    }
    const target = live || it.webUrl || null;
    return { app, webUrl: it.webUrl || null, desktopUrl: app && target ? `ms-${app}:ofe|u|${target}` : null };
  }

  /** Link temporário (pré-autorizado) para baixar/abrir o arquivo. */
  async downloadUrl(rel) {
    const it = await this.req(`${this.itemUrl(rel)}?$select=id,name,@microsoft.graph.downloadUrl`, {}, { allow404: true });
    return it?.['@microsoft.graph.downloadUrl'] || null;
  }

  async* walk(limit = 100000) {
    const stack = [''];
    const seen = new Set();
    let n = 0;
    let failed = false;
    while (stack.length) {
      const rel = stack.pop();
      // relê da Microsoft (o índice é o que descobre mudanças feitas por fora) e renova o cache
      const p = posix(rel);
      const old = this.mirror?.get(p);
      const list = await this.listNow(p).catch(() => { failed = true; return null; });
      seen.add(p);
      if (list) {
        this.cache.set(`L:${p}`, { at: Date.now(), done: true, v: Promise.resolve(list) });
        if (old && listSig(list) !== listSig(old.list)) this.onChange?.(p);
      }
      for (const e of list || []) {
        const r = posix(`${rel}/${e.name}`);
        if (e.dir) { stack.push(r); continue; }
        yield { rel: r, name: e.name, size: e.size, mtime: e.mtime };
        if (++n >= limit) return;
      }
      await new Promise((res) => setTimeout(res, 150)); // sem rajadas à Microsoft
    }
    // pastas que sumiram da Microsoft saem da cópia guardada
    if (!failed) this.mirror?.prune(seen);
  }
}
