// Gera os ícones do app (assets/icon.png, icon.ico e tray.png) desenhando
// um SVG no próprio Electron. Uso: npx electron scripts/make-icons.mjs
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'assets');
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#25d366"/><stop offset="1" stop-color="#008069"/></linearGradient></defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#g)"/>
  <path d="M128 50c-44 0-80 32-80 72 0 22 11 42 29 55l-7 29 32-16c8 3 17 4 26 4 44 0 80-32 80-72s-36-72-80-72z" fill="#fff"/>
  <rect x="84" y="98" width="20" height="46" rx="5" fill="#94a3b8"/>
  <rect x="118" y="88" width="20" height="66" rx="5" fill="#3b82f6"/>
  <rect x="152" y="108" width="20" height="36" rx="5" fill="#22c55e"/>
</svg>`;

async function render(win, size) {
  await win.setContentSize(size, size);
  await win.loadURL(`data:text/html,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`)}`);
  await new Promise((r) => setTimeout(r, 150));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return img.resize({ width: size, height: size }).toPNG();
}

function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, buf }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size; dir[o + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(buf.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.buf)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  fs.mkdirSync(OUT, { recursive: true });
  const sizes = [16, 32, 48, 256];
  const pngs = [];
  for (const s of sizes) pngs.push({ size: s, buf: await render(win, s) });
  fs.writeFileSync(path.join(OUT, 'icon.png'), pngs.find((p) => p.size === 256).buf);
  fs.writeFileSync(path.join(OUT, 'tray.png'), pngs.find((p) => p.size === 32).buf);
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(pngs));
  console.log('ícones gerados em', OUT);
  app.quit();
});
