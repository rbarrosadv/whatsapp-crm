// Ficha de dados do cliente: pessoa física (identificação, qualificação,
// endereço com busca pelo CEP) ou empresa (CNPJ com busca na Receita, sede,
// representante legal), com a "Qualificação pronta" ao vivo para copiar e para
// o marcador {qualificacao} dos modelos.
import { h, fill, toast, errToast, debounce } from '../util.js';
import { api, openClient } from '../store.js';
import { icon } from '../icons.js';
import {
  MARITAL, UFS, REP_ROLES, qualification, missingFields, fmtCpf, fmtCnpj, fmtCep, looksLikeCompany, parseRep,
} from '../qualify.js';

const digits = (v) => String(v || '').replace(/\D/g, '');

function field(label, input, { wide = false, cls = '' } = {}) {
  return h('label', { class: `field ${wide ? 'wide' : ''} ${cls}` }, h('span', null, label), input);
}
const input = (value, o = {}) => h('input', { class: 'input', value: value || '', ...o });
function select(value, options, { empty } = {}) {
  const opts = options.map(([v, l]) => [String(v), l]);
  if (value && !opts.some(([v]) => v === String(value))) opts.push([String(value), String(value)]); // texto antigo
  return h('select', { class: 'input' },
    empty !== undefined ? h('option', { value: '' }, empty) : null,
    opts.map(([v, l]) => h('option', { value: v, selected: String(value || '') === v }, l)));
}
const GENDERS = [['m', 'Masculino'], ['f', 'Feminino']];

/**
 * Bloco de endereço com busca pelo CEP. `get`/`set` leem e gravam no objeto
 * de dados (com prefixo opcional) e `onChange` atualiza a prévia.
 */
function addressBlock(data, prefix, onChange) {
  const k = (n) => `${prefix}${n}`;
  const status = h('span', { class: 'muted small cep-status' });
  const els = {
    cep: input(data[k('cep')] ? fmtCep(data[k('cep')]) : '', { placeholder: '00000-000', inputmode: 'numeric', maxlength: 9 }),
    street: input(data[k('street')], { placeholder: 'Rua, avenida…' }),
    number: input(data[k('number')], { placeholder: 'nº ou s/n' }),
    complement: input(data[k('complement')], { placeholder: 'apto, sala, quadra…' }),
    district: input(data[k('district')]),
    city: input(data[k('city')]),
    uf: select(data[k('uf')], UFS.map((u) => [u, u]), { empty: '—' }),
  };
  let last = digits(data[k('cep')]);
  const search = async () => {
    const d = digits(els.cep.value);
    if (d.length !== 8 || d === last) return;
    last = d;
    status.textContent = 'Buscando o CEP…';
    try {
      const r = await api('clients:lookupCep', d);
      if (!r) { status.textContent = 'CEP não encontrado: preencha à mão.'; return; }
      els.cep.value = fmtCep(r.cep);
      if (r.street) els.street.value = r.street;
      if (r.district) els.district.value = r.district;
      if (r.city) els.city.value = r.city;
      if (r.uf) els.uf.value = r.uf;
      if (r.complement && !els.complement.value) els.complement.value = r.complement;
      status.textContent = r.street ? 'Endereço encontrado. Complete o número.' : 'CEP geral da cidade: complete a rua.';
      for (const [n, el] of Object.entries(els)) data[k(n)] = el.value;
      onChange();
      (r.street ? els.number : els.street).focus();
    } catch (e) { status.textContent = e.message; }
  };
  els.cep.addEventListener('input', () => {
    const d = digits(els.cep.value).slice(0, 8);
    els.cep.value = d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
    if (d.length === 8) search();
  });
  for (const [n, el] of Object.entries(els)) {
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => { data[k(n)] = el.value; onChange(); });
  }
  return h('div', { class: 'client-form' },
    field('CEP', h('div', { class: 'cep-row' }, els.cep, status)),
    field('Rua / logradouro', els.street, { cls: 'span2' }),
    field('Número', els.number),
    field('Complemento', els.complement),
    field('Bairro', els.district),
    field('Cidade', els.city),
    field('UF', els.uf));
}

/** Campos de qualificação de pessoa física (cliente ou representante). */
function personBlock(data, prefix, onChange, { nameLabel = 'Nome completo', withName = true, withBirth = true } = {}) {
  const k = (n) => `${prefix}${n}`;
  const els = {};
  const mk = (n, el) => { els[n] = el; el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => { data[k(n)] = el.value; onChange(n); }); return el; };
  const cpf = mk('cpf', input(data[k('cpf')] ? fmtCpf(data[k('cpf')]) : '', { placeholder: '000.000.000-00', inputmode: 'numeric' }));
  cpf.addEventListener('blur', () => { cpf.value = fmtCpf(cpf.value); data[k('cpf')] = cpf.value; });
  return {
    els,
    identity: h('div', { class: 'client-form' },
      withName ? field(nameLabel, mk('name', input(data[k('name')])), { wide: true }) : null,
      field('CPF', cpf),
      field('RG', mk('rg', input(data[k('rg')]))),
      field('Órgão emissor / UF', mk('rg_issuer', input(data[k('rg_issuer')], { placeholder: 'SSP/MT' }))),
      withBirth ? field('Nascimento', mk('birth', input(data[k('birth')], { placeholder: 'dd/mm/aaaa' }))) : null,
      field('Sexo (para a concordância)', mk('gender', select(data[k('gender')], GENDERS, { empty: 'Não informado' })))),
    qualif: h('div', { class: 'client-form' },
      field('Nacionalidade', mk('nationality', input(data[k('nationality')] || 'brasileiro(a)', { list: 'nationality-list' }))),
      field('Estado civil', mk('marital', select(data[k('marital')], MARITAL.map((m) => [m[0], m[1]]), { empty: 'Não informado' }))),
      field('Profissão', mk('profession', input(data[k('profession')], { list: 'profession-list' })))),
  };
}

const section = (title, sub, ...body) => h('section', { class: 'client-sec' },
  h('h3', null, title), sub ? h('p', { class: 'muted small' }, sub) : null, ...body);

/**
 * Formulário completo. `c` = cliente (de clients:get). Devolve o elemento;
 * `onSaved` é chamado depois de salvar.
 */
export function clientForm(c, { onSaved, footer } = {}) {
  const data = { ...c, rep: undefined };
  const rep = { ...parseRep(c) };
  const host = h('div', { class: 'client-data' });
  const preview = h('div', { class: 'qualif-text' });
  const missing = h('div', { class: 'muted small' });
  const dupBox = h('div', { class: 'dup-box', hidden: true });

  const update = () => {
    const text = qualification({ ...data, rep });
    preview.textContent = text || 'Preencha o nome para ver a qualificação.';
    const miss = missingFields({ ...data, rep });
    missing.textContent = miss.length ? `Falta: ${miss.join(', ')}.` : 'Qualificação completa.';
    missing.className = `small ${miss.length ? 'warn-text' : 'ok-text'}`;
  };

  const checkDup = debounce(async () => {
    const list = await api('clients:similar', { name: data.name, cpf: data.cpf, excludeId: c.id }).catch(() => []);
    if (!list.length) { dupBox.hidden = true; return; }
    dupBox.hidden = false;
    fill(dupBox, icon('alert', 16), h('span', null, 'Pode ser o mesmo cliente: '),
      list.map((x, i) => [i ? ', ' : '', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openClient(x.id); } }, x.name)]),
      '. Confira antes de salvar para não duplicar.');
  }, 500);

  const draw = () => {
    const pj = data.kind === 'pj';
    const kindSeg = h('div', { class: 'segmented' },
      [['pf', 'Pessoa física'], ['pj', 'Empresa']].map(([v, l]) => h('button', {
        class: `seg ${(data.kind || 'pf') === v ? 'active' : ''}`, type: 'button',
        onclick: () => { if ((data.kind || 'pf') === v) return; data.kind = v; draw(); },
      }, l)));
    const contact = h('div', { class: 'client-form' },
      ...['phone', 'phone2', 'email', 'origin'].map((n) => {
        const el = input(data[n], { type: n === 'email' ? 'email' : 'text', placeholder: n === 'phone' ? '(65) 99999-0000' : '' });
        el.addEventListener('input', () => { data[n] = el.value; update(); });
        return field({ phone: 'Telefone', phone2: 'Outro telefone', email: 'E-mail', origin: 'Como chegou (indicação, Instagram…)' }[n], el);
      }));
    const notes = h('textarea', { class: 'input', rows: 3 }, data.notes || '');
    notes.addEventListener('input', () => { data.notes = notes.value; });

    let blocks;
    if (!pj) {
      const p = personBlock(data, '', (n) => { update(); if (n === 'name' || n === 'cpf') checkDup(); });
      blocks = [
        section('Identificação', null, p.identity),
        section('Qualificação', 'Usada nas procurações, contratos e petições.', p.qualif),
        section('Endereço', 'Digite o CEP: a rua, o bairro e a cidade se preenchem sozinhos.', addressBlock(data, '', update)),
      ];
    } else {
      const cnpj = input(data.cpf ? fmtCnpj(data.cpf) : '', { placeholder: '00.000.000/0000-00', inputmode: 'numeric' });
      const cnpjStatus = h('span', { class: 'muted small' });
      const name = input(data.name);
      const trade = input(data.trade_name);
      const ie = input(data.ie);
      const im = input(data.im);
      let partners = [];
      const roleList = h('datalist', { id: 'rep-roles' }, REP_ROLES.map((r) => h('option', { value: r })));
      const bind = (el, n) => el.addEventListener('input', () => { data[n] = el.value; update(); if (n === 'name' || n === 'cpf') checkDup(); });
      bind(cnpj, 'cpf'); bind(name, 'name'); bind(trade, 'trade_name'); bind(ie, 'ie'); bind(im, 'im');
      const lookupCnpj = async () => {
        const d = digits(cnpj.value);
        if (d.length !== 14) { cnpjStatus.textContent = 'Digite os 14 números do CNPJ.'; return; }
        cnpjStatus.textContent = 'Buscando na Receita…';
        try {
          const r = await api('clients:lookupCnpj', d);
          if (!r) { cnpjStatus.textContent = 'CNPJ não encontrado.'; return; }
          Object.assign(data, {
            cpf: fmtCnpj(r.cnpj), name: r.name || data.name, trade_name: r.trade_name || data.trade_name,
            cep: r.cep || data.cep, street: r.street || data.street, number: r.number || data.number, complement: r.complement || data.complement,
            district: r.district || data.district, city: r.city || data.city, uf: r.uf || data.uf,
            email: data.email || r.email, phone: data.phone || r.phone,
          });
          partners = r.partners || [];
          if (!rep.name && partners.length === 1) { rep.name = partners[0].name; rep.role = partners[0].role || rep.role; }
          draw();
          toast(`Dados da Receita preenchidos${r.situation && !/ativa/i.test(r.situation) ? ` — situação: ${r.situation}` : ''}`, r.situation && !/ativa/i.test(r.situation) ? 'error' : 'success');
        } catch (e) { cnpjStatus.textContent = e.message; }
      };
      cnpj.addEventListener('input', () => { if (digits(cnpj.value).length === 14 && digits(cnpj.value) !== digits(c.cpf)) lookupCnpj(); });
      const rp = personBlock(rep, '', update, { nameLabel: 'Nome do representante', withBirth: false });
      const sameAddr = h('input', { type: 'checkbox', checked: rep.same_address !== false && !rep.street });
      rep.same_address = sameAddr.checked;
      const repAddr = h('div', { hidden: sameAddr.checked }, addressBlock(rep, '', update));
      sameAddr.addEventListener('change', () => { rep.same_address = sameAddr.checked; repAddr.hidden = sameAddr.checked; update(); });
      const role = input(rep.role, { list: 'rep-roles', placeholder: 'sócio-administrador' });
      role.addEventListener('input', () => { rep.role = role.value; update(); });
      blocks = [
        section('Empresa', 'Digite o CNPJ: razão social, nome fantasia e endereço vêm da Receita.',
          h('div', { class: 'client-form' },
            field('CNPJ', h('div', { class: 'cep-row' }, cnpj, h('button', { class: 'btn btn-sm', type: 'button', onclick: lookupCnpj }, 'Buscar'))),
            field('Razão social', name, { cls: 'span2' }),
            field('Nome fantasia', trade),
            field('Inscrição estadual', ie),
            field('Inscrição municipal', im)),
          cnpjStatus),
        section('Sede', null, addressBlock(data, '', update)),
        section('Representante legal', partners.length > 1 ? `Sócios na Receita: ${partners.map((p) => p.name).join(', ')}.` : 'Quem assina pela empresa.',
          roleList,
          partners.length > 1 ? h('div', { class: 'row wrap' }, partners.map((p) => h('button', {
            class: 'btn btn-sm', type: 'button', onclick: () => { rep.name = p.name; rep.role = p.role || rep.role; draw(); },
          }, p.name))) : null,
          h('div', { class: 'client-form' }, field('Cargo', role)),
          rp.identity, rp.qualif,
          h('label', { class: 'inline-check' }, sameAddr, ' Mora no mesmo endereço da empresa'),
          repAddr),
      ];
    }

    fill(host,
      h('datalist', { id: 'nationality-list' }, ['brasileiro(a)', 'portuguesa', 'italiana', 'argentina', 'paraguaia', 'boliviana', 'venezuelana', 'haitiana'].map((v) => h('option', { value: v }))),
      h('datalist', { id: 'profession-list' }, ['autônomo(a)', 'empresário(a)', 'servidor(a) público(a)', 'aposentado(a)', 'do lar', 'estudante', 'comerciante', 'motorista', 'professor(a)', 'advogado(a)', 'médico(a)', 'engenheiro(a)', 'vendedor(a)', 'pedreiro', 'agricultor(a)', 'desempregado(a)'].map((v) => h('option', { value: v }))),
      h('div', { class: 'client-data-head' }, kindSeg, dupBox),
      h('div', { class: 'client-data-grid' },
        h('div', { class: 'client-data-main' }, ...blocks,
          section('Contato', null, contact),
          section('Observações', null, notes)),
        h('aside', { class: 'qualif-box' },
          h('h3', null, 'Qualificação pronta'),
          preview,
          missing,
          h('div', { class: 'row wrap' },
            h('button', {
              class: 'btn btn-sm', type: 'button',
              onclick: async () => { try { await navigator.clipboard.writeText(preview.textContent); toast('Qualificação copiada', 'success'); } catch { toast('Não foi possível copiar', 'error'); } },
            }, icon('copy', 15), 'Copiar')),
          h('p', { class: 'muted small' }, 'Nos modelos do Word use {qualificacao} — ou os campos soltos: {nome}, {cpf}, {estado_civil}, {endereco}…'))),
      h('div', { class: 'row client-save' },
        h('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            if (!String(data.name || '').trim()) { toast('Informe o nome', 'error'); return; }
            const payload = { id: c.id };
            for (const n of ['name', 'kind', 'cpf', 'rg', 'rg_issuer', 'birth', 'gender', 'nationality', 'marital', 'profession',
              'cep', 'street', 'number', 'complement', 'district', 'city', 'uf', 'trade_name', 'ie', 'im', 'phone', 'phone2', 'email', 'origin', 'notes']) payload[n] = data[n] ?? '';
            if (payload.kind !== 'pj') { payload.rep = null; payload.trade_name = ''; payload.ie = ''; payload.im = ''; } else payload.rep = { ...rep };
            try { await api('clients:save', payload); toast('Dados salvos', 'success'); onSaved?.(); } catch (e) { errToast(e); }
          },
        }, 'Salvar'),
        h('div', { class: 'grow' }),
        footer || null));
    update();
  };
  if (!c.kind && looksLikeCompany(c.name)) data.kind = 'pj';
  draw();
  return host;
}
