// Tela de entrada: login da equipe ou, no primeiro acesso, criação do sócio administrador.
const $ = (id) => document.getElementById(id);
let setup = false;

try {
  const t = localStorage.getItem('theme');
  document.documentElement.dataset.theme = t === 'light' || t === 'dark' ? t
    : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
} catch { /* ignore */ }

async function init() {
  const st = await fetch('/auth/state', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  if (!st) { $('error').textContent = 'Sem conexão com o servidor do escritório.'; return; }
  if (st.user) { location.href = '/'; return; }
  setup = st.setup;
  if (setup) {
    $('title').textContent = 'Primeiro acesso';
    $('hint').textContent = 'Crie a conta do sócio administrador. Depois você cadastra a equipe em Configurações.';
    $('name-row').hidden = false;
    $('code-row').hidden = !st.setupCode;
    if (st.setupCode) $('hint').textContent += ' O código de primeiro acesso aparece para quem instalou o servidor.';
    $('again-row').hidden = false;
    $('password').autocomplete = 'new-password';
    $('go').textContent = 'Criar conta e entrar';
    (st.setupCode ? $('code') : $('name')).focus();
  } else {
    $('login').focus();
  }
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('error').textContent = '';
  const body = { login: $('login').value.trim(), password: $('password').value };
  if (setup) {
    body.name = $('name').value.trim();
    body.code = $('code').value.trim();
    if (body.password !== $('again').value) { $('error').textContent = 'As duas senhas não são iguais.'; return; }
  }
  $('go').disabled = true;
  try {
    const r = await fetch(setup ? '/auth/setup' : '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CRM': '1' }, body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Não foi possível entrar.');
    location.href = '/';
  } catch (err) {
    $('error').textContent = err.message === 'Failed to fetch' ? 'Sem conexão com o servidor do escritório.' : err.message;
    $('go').disabled = false;
  }
});

// no app de desktop: voltar à tela de escolher o servidor do escritório ou "neste computador"
if (window.desktop?.setup) {
  $('switch').hidden = false;
  $('switch').addEventListener('click', () => window.desktop.setup.change());
}

init();
