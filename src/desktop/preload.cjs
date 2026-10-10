// Ponte entre a página do sistema e o app de desktop (só o necessário:
// abrir/salvar arquivos com os programas do Windows, foco, aviso piscando,
// opções deste computador). A página funciona igual sem ela (navegador/celular).
const { contextBridge, ipcRenderer } = require('electron');

const call = (action, ...args) => ipcRenderer.invoke('desktop', action, ...args);

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  openUrl: (url, name) => call('openUrl', url, name),
  saveUrl: (url, name) => call('saveUrl', url, name),
  openExternal: (url) => call('openExternal', url),
  openDoc: (rel) => call('openDoc', rel),
  openOffice: (url) => call('openOffice', url),
  showDoc: (rel) => call('showDoc', rel),
  focus: () => call('focus'),
  flash: () => call('flash'),
  setBadge: (n) => call('setBadge', n),
  getSetting: (key) => call('getSetting', key),
  setSetting: (key, value) => call('setSetting', key, value),
  openNotificationSettings: () => call('openNotificationSettings'),
  // busca nos tribunais por este computador (Plano B, só endereços do CNJ)
  courtFetch: (req) => call('courtFetch', req),
  // certificado digital A3 (token/cartão) deste computador
  certs: {
    list: () => call('certs:list'),
    get: () => call('certs:get'),
    choose: (c) => call('certs:choose', c),
    sign: (base64) => call('certs:sign', base64),
  },
  setup: {
    get: () => call('setup:get'),
    choose: (mode, url) => call('setup:choose', mode, url),
    retry: () => call('setup:retry'),
    change: () => call('setup:change'),
  },
});
