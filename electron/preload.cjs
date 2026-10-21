const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  getState: invoke('state:get'), saveState: invoke('state:save'),
  importFiles: invoke('library:import'), removeTrack: invoke('library:remove'),
  openExternal: invoke('shell:open'), getVkStatus: invoke('vk:status'),
  openVkMusic: invoke('vk:web'),
  connectVk: invoke('vk:connect'), disconnectVk: invoke('vk:disconnect'),
  refreshVk: invoke('vk:refresh'), searchVk: invoke('vk:search'),
  resolveVkTrack: invoke('vk:resolve'), getVersion: invoke('app:version'),
  exportDiagnostics: invoke('app:diagnostics'),
  onCommand(callback) {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('player:command', listener);
    return () => ipcRenderer.removeListener('player:command', listener);
  },
}));
