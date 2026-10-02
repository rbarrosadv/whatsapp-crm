// Ponte segura entre a interface (renderer) e o processo principal.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listeners = new Map();
ipcRenderer.on('event', (_e, channel, payload) => {
  for (const cb of listeners.get(channel) || []) {
    try { cb(payload); } catch (err) { console.error(err); }
  }
});

contextBridge.exposeInMainWorld('api', {
  call: async (method, ...args) => {
    try {
      return await ipcRenderer.invoke('api', method, args);
    } catch (err) {
      // o Electron embrulha a mensagem: "Error invoking remote method 'api': Error: ..."
      const msg = String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      throw new Error(msg);
    }
  },
  on: (channel, cb) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(cb);
    return () => listeners.get(channel).delete(cb);
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
});
