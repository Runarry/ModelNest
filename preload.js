const { contextBridge, ipcRenderer } = require('electron');

console.log('[Preload] Exposing API via contextBridge...');
contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('getConfig'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'), // 添加获取应用版本号的 API
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
  },
  // --- End Updater API ---

  // 通用日志记录接口
  logMessage: (level, message, ...args) => {
    // 验证 level 是否是有效的日志级别 (可选但推荐)
    const validLevels = ['error', 'warn', 'info', 'verbose', 'debug', 'silly'];
    if (!validLevels.includes(level)) {
      console.warn(`[Preload] Invalid log level used: ${level}. Defaulting to 'info'.`);
      level = 'info';
    }
    ipcRenderer.send('log-message', level, message, ...args);
  },

clearImageCache: () => ipcRenderer.invoke('clear-image-cache'), // 添加图片缓存清理接口
  sendRendererError: (errorInfo) => ipcRenderer.send('renderer-error', errorInfo)
});
console.log('[Preload] API exposed successfully.');