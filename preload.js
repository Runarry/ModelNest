const { contextBridge, ipcRenderer } = require('electron');

console.log('[Preload] Exposing API via contextBridge...');
contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('getConfig'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'), // 添加获取应用版本号的 API
  listModels: (sourceId, directory = null, filters = {}) => ipcRenderer.invoke('listModels', { sourceId, directory, filters }), // 添加 directory 和 filters 参数
  listSubdirectories: (sourceId) => ipcRenderer.invoke('listSubdirectories', { sourceId }), // 添加新 API
  getModelDetail: (sourceId, jsonPath) => ipcRenderer.invoke('getModelDetail', { sourceId, jsonPath }),
  saveModel: (model) => ipcRenderer.invoke('saveModel', model),
  getModelImage: ({sourceId, imagePath}) => ipcRenderer.invoke('getModelImage', {sourceId, imagePath}),
  saveConfig: (configData) => ipcRenderer.invoke('save-config', configData), // Add saveConfig API
  // Listen for config updates from main process
  onConfigUpdated: (callback) => ipcRenderer.on('config-updated', callback),
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'), // Add open folder dialog API
  getAllSourceConfigs: () => ipcRenderer.invoke('getAllSourceConfigs'), // Add getAllSourceConfigs API
  getFilterOptions: (sourceId) => ipcRenderer.invoke('getFilterOptions', { sourceId }), // Add getFilterOptions API, now accepts sourceId

  // --- Updater API ---
  checkForUpdate: () => ipcRenderer.invoke('updater.checkForUpdate'),
downloadUpdate: () => ipcRenderer.invoke('updater.downloadUpdate'), // <-- 添加下载更新 API
  quitAndInstall: () => ipcRenderer.invoke('updater.quitAndInstall'),
  onUpdateStatus: (callback) => {
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on('updater.onUpdateStatus', listener);
    // Return a function to remove the listener
    return () => ipcRenderer.removeListener('updater.onUpdateStatus', listener);
  },
  // --- End Updater API ---

  // --- Model Crawler API ---
  startCrawl: (sourceId, directory) => ipcRenderer.invoke('start-crawl', sourceId, directory),
  pauseCrawl: () => ipcRenderer.invoke('pause-crawl'),
  resumeCrawl: () => ipcRenderer.invoke('resume-crawl'),
  cancelCrawl: () => ipcRenderer.invoke('cancel-crawl'),
  getCrawlStatus: () => ipcRenderer.invoke('get-crawl-status'),
  onCrawlStatusUpdate: (callback) => {
    // Wrap the callback to match the expected signature (event, status) => callback(status)
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('crawl-status-update', listener);
    // Return a function to remove this specific listener
    return () => ipcRenderer.removeListener('crawl-status-update', listener);
  },
  removeCrawlStatusUpdateListener: (callback) => ipcRenderer.removeListener('crawl-status-update', callback),

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
  getImageCacheSize: () => ipcRenderer.invoke('get-image-cache-size'), // 添加获取缓存大小的接口
  getCacheStats: () => ipcRenderer.invoke('get-cache-stats'), // 添加获取图片缓存统计的接口
  migrateImageCache: () => ipcRenderer.invoke('migrate-image-cache'), // 添加图片缓存迁移的接口
  migrateModelCache: () => ipcRenderer.invoke('migrate-model-cache'), // 添加模型缓存迁移的接口
  getPackageInfo: () => ipcRenderer.invoke('get-package-info'), // 添加获取 package.json 信息的接口
  getProcessVersions: () => ipcRenderer.invoke('get-process-versions'), // 添加获取 process.versions 的接口
  sendRendererError: (errorInfo) => ipcRenderer.send('renderer-error', errorInfo),

  // ModelInfoCacheService related APIs
  clearModelInfoMemoryCache: () => ipcRenderer.invoke('clearModelInfoMemoryCache'),
  clearModelInfoDiskCache: () => ipcRenderer.invoke('clearModelInfoDiskCache'),
  getModelInfoCacheStats: () => ipcRenderer.invoke('getModelInfoCacheStats'),

  // Add API to get blocked tags from config
  getBlockedTags: () => ipcRenderer.invoke('get-blocked-tags'),
  
  // Add API for cleaning up userData directories
  cleanupUserData: (options = {}) => ipcRenderer.invoke('cleanup-user-data', options),
});

// 也将API暴露给window.electronAPI，便于在更多地方使用
contextBridge.exposeInMainWorld('electronAPI', {
  clearImageCache: () => ipcRenderer.invoke('clear-image-cache'),
  getCacheStats: () => ipcRenderer.invoke('get-cache-stats'),
  cleanupUserData: (options = {}) => ipcRenderer.invoke('cleanup-user-data', options) // Add cleanup function to electronAPI too
});

console.log('[Preload] API exposed successfully.');