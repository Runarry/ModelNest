const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('getConfig'),
  listModels: (sourceId, directory = null) => ipcRenderer.invoke('listModels', { sourceId, directory }), // 添加 directory 参数
  listSubdirectories: (sourceId) => ipcRenderer.invoke('listSubdirectories', { sourceId }), // 添加新 API
  getModelDetail: (sourceId, jsonPath) => ipcRenderer.invoke('getModelDetail', { sourceId, jsonPath }),
  saveModel: (model) => ipcRenderer.invoke('saveModel', model),
  getModelImage: ({sourceId, imagePath}) => ipcRenderer.invoke('getModelImage', {sourceId, imagePath}),
  saveConfig: (configData) => ipcRenderer.invoke('save-config', configData), // Add saveConfig API
  // Listen for config updates from main process
  onConfigUpdated: (callback) => ipcRenderer.on('config-updated', callback),
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'), // Add open folder dialog API

  // --- Updater API ---
  checkForUpdate: () => ipcRenderer.invoke('updater.checkForUpdate'),
  quitAndInstall: () => ipcRenderer.invoke('updater.quitAndInstall'),
  onUpdateStatus: (callback) => {
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on('updater.onUpdateStatus', listener);
    // Return a function to remove the listener
    return () => ipcRenderer.removeListener('updater.onUpdateStatus', listener);
  }
  // --- End Updater API ---
});