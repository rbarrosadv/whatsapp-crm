// Tela de "sem conexão" do app de desktop: tenta de novo sozinha a cada 15 s.
const q = new URLSearchParams(location.search);
document.getElementById('detail').textContent = [q.get('url'), q.get('reason')].filter(Boolean).join(' — ');
document.getElementById('retry').onclick = () => window.desktop.setup.retry();
document.getElementById('change').onclick = () => window.desktop.setup.change();
setInterval(() => window.desktop.setup.retry(), 15000);
