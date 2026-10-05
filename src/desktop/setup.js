// Primeira vez no app de desktop: escolher o servidor do escritório ou o modo local.
const $ = (id) => document.getElementById(id);
const mode = () => document.querySelector('input[name=mode]:checked').value;
const sync = () => { $('url-row').hidden = mode() !== 'remote'; };
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', sync));

window.desktop.setup.get().then((cfg) => {
  if (cfg.url) $('url').value = cfg.url;
  const m = cfg.mode || (cfg.hasLocalData ? 'local' : 'remote');
  document.querySelector(`input[name=mode][value=${m}]`).checked = true;
  sync();
});

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('error').textContent = '';
  try {
    await window.desktop.setup.choose(mode(), $('url').value);
  } catch (err) {
    $('error').textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
});
