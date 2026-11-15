const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  show: () => ipcRenderer.send('win:show'),
  notify: (opts) => ipcRenderer.send('notify', opts),
  getAutoLaunch: () => ipcRenderer.invoke('autolaunch:get'),
  setAutoLaunch: (on) => ipcRenderer.invoke('autolaunch:set', on),
  onAction: (cb) => ipcRenderer.on('action', (_e, a) => cb(a))
});
