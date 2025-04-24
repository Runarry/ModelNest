const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('getConfig'),
  listModels: (sourceId, directory = null) => ipcRenderer.invoke('listModels', { sourceId, directory }), // 添加 directory 参数
  listSubdirectories: (sourceId) => ipcRenderer.invoke('listSubdirectories', { sourceId }), // 添加新 API
  getModelDetail: (sourceId, jsonPath) => ipcRenderer.invoke('getModelDetail', { sourceId, jsonPath }),
  saveModel: (model) => ipcRenderer.invoke('saveModel', model),
  getModelImage: ({sourceId, imagePath}) => ipcRenderer.invoke('getModelImage', {sourceId, imagePath})
});