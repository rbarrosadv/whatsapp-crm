// OneDrive pela API da Microsoft (Graph), com uma "Microsoft" de mentira que
// responde no mesmo formato da real: login, pasta compartilhada por link,
// pastas de cliente/caso, documento do modelo, busca, abrir arquivo, arquivo morto.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeDocx, docxText } from '../src/main/docs.js';

const { startServer } = await import('../src/server/server.js');

/** Graph/identidade de mentira: uma árvore em memória. */
function fakeMicrosoft() {
  let seq = 1;
  const items = new Map(); // id → { id, name, parent, folder, content, mtime }
  const mk = (name, parent, folder, content = null) => {
    const id = `ID${seq++}`;
    items.set(id, { id, name, parent, folder, content, mtime: Date.now() });
    return id;
  };
  const root = mk('BARROS ADVOGADOS', null, true);
  for (const f of ['00 ENTRADA', '02 CLIENTES', '03 ARQUIVO MORTO', '04 MODELOS']) mk(f, root, true);
  const modelos = [...items.values()].find((x) => x.name === '04 MODELOS').id;
  const civel = mk('Cível', modelos, true);
  mk('MODELO - PROCURAÇÃO.docx', civel, false, makeDocx(['PROCURAÇÃO', 'OUTORGANTE: {qualificacao}']));
  const children = (id) => [...items.values()].filter((x) => x.parent === id);
  const byPath = (baseId, p) => {
    let cur = items.get(baseId);
    for (const part of p.split('/').filter(Boolean).map(decodeURIComponent)) {
      cur = children(cur.id).find((x) => x.name === part);
      if (!cur) return null;
    }
    return cur;
  };
  const out = (x) => ({
    id: x.id, name: x.name, lastModifiedDateTime: new Date(x.mtime).toISOString(),
    ...(x.folder ? { folder: { childCount: children(x.id).length } } : { file: {}, size: x.content.length }),
    '@microsoft.graph.downloadUrl': x.folder ? undefined : `https://download.example/${x.id}`,
    parentReference: { driveId: 'DRIVE1' },
  });
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push(`${method} ${u.pathname}`);
    if (u.host === 'login.microsoftonline.com') {
      const body = new URLSearchParams(String(init.body));
      if (!['authorization_code', 'refresh_token'].includes(body.get('grant_type'))) return json({ error: 'invalid_request' }, 400);
      return json({ access_token: `tok-${seq++}`, refresh_token: 'refresh-1', expires_in: 3600 });
    }
    assert.match(init.headers?.Authorization || '', /^Bearer tok-/, 'manda o token');
    const p = decodeURIComponent(u.pathname.replace(/^\/v1\.0/, ''));
    if (p === '/me') return json({ displayName: 'Escritório', mail: 'escritorio@outlook.com' });
    if (p.startsWith('/shares/')) return json({ ...out(items.get(root)), remoteItem: { ...out(items.get(root)), parentReference: { driveId: 'DRIVE1' } } });
    const m = /^\/drives\/DRIVE1\/items\/([^/:]+)(?::(\/.*?):?)?(\/children|\/content)?$/.exec(p);
    if (!m) return json({ error: { message: `rota desconhecida ${p}` } }, 400);
    const [, id, sub, tail] = m;
    let it = sub ? byPath(id, sub.replace(/:$/, '')) : items.get(id);
    if (method === 'PUT' && tail === '/content') {
      const parts = sub.replace(/:$/, '').split('/').filter(Boolean);
      const name = parts.pop();
      const parent = byPath(id, parts.join('/'));
      if (!parent) return json({ error: { message: 'pai não existe' } }, 404);
      const buf = Buffer.from(init.body);
      if (it) { it.content = buf; it.mtime = Date.now(); } else it = items.get(mk(name, parent.id, false, buf));
      return json(out(it), 201);
    }
    if (!it) return json({ error: { code: 'itemNotFound', message: 'não encontrado' } }, 404);
    if (method === 'POST' && tail === '/children') {
      const b = JSON.parse(init.body);
      if (children(it.id).some((x) => x.name === b.name)) return json({ error: { message: 'já existe' } }, 409);
      return json(out(items.get(mk(b.name, it.id, true))), 201);
    }
    if (method === 'PATCH') {
      const b = JSON.parse(init.body);
      it.parent = b.parentReference.id;
      it.name = b.name;
      return json(out(it));
    }
    if (tail === '/children') return json({ value: children(it.id).map(out) });
    if (tail === '/content') return new Response(it.content, { status: 200 });
    return json(out(it));
  };
  return { fetch, items, root, calls, byPath: (p) => byPath(root, p) };
}

let dir;
let srv;
let ms;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-od-'));
  srv = await startServer({ dataDir: dir, demo: true, port: 0 });
  ms = fakeMicrosoft();
  srv.core.onedrive.fetch = ms.fetch;
});
after(async () => {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  const req = async (p, { body, headers = {}, redirect = 'follow' } = {}) => {
    const r = await fetch(`${srv.url}${p}`, {
      method: body ? 'POST' : 'GET', redirect,
      headers: { 'X-CRM': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return r;
  };
  const call = async (method, ...args) => {
    const r = await req(`/api/${method}`, { body: { args } });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
    return j.result;
  };
  return { req, call };
}

test('OneDrive pela API: conectar, pasta compartilhada, pastas, modelo, busca, abrir e arquivo morto', async () => {
  const c = client();
  await c.req('/auth/setup', { body: { name: 'Rafael Barros', login: 'barros', password: 'segredo1' } });
  await assert.rejects(c.call('onedrive:setApp', { clientId: 'x', clientSecret: 'y' }), /formato/);
  await c.call('onedrive:setApp', { clientId: '11111111-2222-3333-4444-555555555555', clientSecret: 'segredo-do-app' });
  const authUrl = await c.call('onedrive:authUrl', srv.url);
  const au = new URL(authUrl);
  assert.equal(au.host, 'login.microsoftonline.com');
  assert.match(au.pathname, /\/consumers\/oauth2\/v2\.0\/authorize$/, 'contas pessoais');
  assert.equal(au.searchParams.get('redirect_uri'), `${srv.url}/onedrive/callback`);
  assert.equal(au.searchParams.get('code_challenge_method'), 'S256');
  // a Microsoft devolve para o sistema com o código
  const back = await c.req(`/onedrive/callback?code=abc&state=${au.searchParams.get('state')}`, { redirect: 'manual' });
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), '/?onedrive=ok');
  let st = await c.call('onedrive:status');
  assert.equal(st.connected, true);
  assert.equal(st.account, 'escritorio@outlook.com');
  assert.ok(!fs.readFileSync(path.join(dir, 'onedrive', 'onedrive.bin')).toString('latin1').includes('refresh-1'), 'token cifrado no disco');
  // pasta pelo link de compartilhamento
  await assert.rejects(c.call('onedrive:useLink', 'https://exemplo.com/pasta'), /link de compartilhamento/);
  st = await c.call('onedrive:useLink', 'https://1drv.ms/f/s!AbCdEf');
  assert.equal(st.mode, 'onedrive');
  const ds = await c.call('docs:status');
  assert.equal(ds.ok, true);
  assert.equal(ds.mode, 'onedrive');
  assert.ok(ds.folders.includes('02 CLIENTES'));

  // cliente, pasta, caso, documento do modelo preenchido
  const cid = await c.call('clients:save', { name: 'Fulana de Tal', cpf: '123.456.789-00', gender: 'f' });
  const cf = await c.call('docs:createClientFolder', cid);
  assert.equal(cf, '02 CLIENTES/FULANA DE TAL');
  assert.ok(ms.byPath('02 CLIENTES/FULANA DE TAL/_CADASTRO'), 'pasta criada no OneDrive');
  const k = await c.call('cases:save', { client_id: cid, title: 'Divórcio' });
  const kf = await c.call('docs:createCaseFolder', k);
  const tpl = (await c.call('docs:templates')).find((t) => /PROCURAÇÃO/.test(t.name));
  assert.equal(tpl.area, 'Cível');
  const made = await c.call('docs:useAsBase', tpl.rel, { caseId: k });
  assert.ok(made.rel.startsWith(`${kf}/`));
  assert.equal(made.path, null, 'sem caminho de disco no modo OneDrive');
  const doc = ms.byPath(made.rel);
  assert.match(docxText(doc.content), /OUTORGANTE: FULANA DE TAL, brasileira, inscrita no CPF sob o nº 123\.456\.789-00/);
  // busca e abrir o arquivo (link temporário da Microsoft)
  await c.call('docs:reindex');
  const hits = await c.call('docs:search', 'outorgante fulana');
  assert.ok(hits.some((d) => d.rel === made.rel), 'busca no conteúdo dos arquivos do OneDrive');
  const open = await c.req(hits[0].url, { redirect: 'manual' });
  assert.equal(open.status, 302);
  assert.match(open.headers.get('location'), /^https:\/\/download\.example\//);
  const list = await c.call('docs:list', kf);
  assert.ok(list.entries.some((e) => e.name === made.rel.split('/').pop()));

  // encerrar → pasta do cliente vai para o arquivo morto (move na Microsoft)
  await c.call('cases:archive', k, { action: 'close' });
  const to = await c.call('docs:archiveFolder', k);
  assert.equal(to, '03 ARQUIVO MORTO/FULANA DE TAL');
  assert.ok(ms.byPath(to) && !ms.byPath(cf), 'movida no OneDrive');
  assert.ok((await c.call('docs:search', 'outorgante fulana')).every((d) => d.rel.startsWith('03 ARQUIVO MORTO/')), 'busca acompanha');
  assert.ok(ms.calls.some((x) => x.startsWith('PATCH')));

  // desligar volta para a pasta deste computador
  await c.call('onedrive:disconnect');
  assert.equal((await c.call('docs:status')).mode, 'local');
});
