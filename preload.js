const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('getConfig'),
  listModels: (sourceId) => ipcRenderer.invoke('listModels', { sourceId }),
  getModelDetail: (sourceId, jsonPath) => ipcRenderer.invoke('getModelDetail', { sourceId, jsonPath }),
  saveModel: (model) => ipcRenderer.invoke('saveModel', model),
  getModelImage: ({sourceId, imagePath}) => ipcRenderer.invoke('getModelImage', {sourceId, imagePath})
});