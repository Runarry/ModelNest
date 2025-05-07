/**
 * API Bridge Module
 *
 * This module acts as an intermediary for accessing Electron APIs exposed
 * via contextBridge on `window.api`. Instead of accessing `window.api`
 * directly throughout the renderer process, components should import
 * the required functions from this module. This improves testability
 * and reduces coupling to the global `window` object.
 */

// Check if window.api exists to prevent errors if preload script hasn't run
const api = window.api || {};

// Export specific functions found on window.api
// Based on usage analysis in other renderer files.
// Add more functions here if they are exposed and needed.

export const getModelImage = api.getModelImage;
export const logMessage = api.logMessage;
/**
 * 包装 openFolderDialog，添加日志，便于调试路径返回问题
 * @param  {...any} args
 * @returns {Promise<any>}
 */
export const openFolderDialog = async (...args) => {
  const result = await api.openFolderDialog(...args);
  logMessage('debug', '[Settings] browseLocalFolder result:', result);
  return result;
};
export const getConfig = api.getConfig;
export const saveConfig = api.saveConfig;
export const onUpdateStatus = api.onUpdateStatus; // Likely an event listener registration
export const checkForUpdate = api.checkForUpdate;
export const quitAndInstall = api.quitAndInstall;
export const downloadUpdate = api.downloadUpdate; // <-- 添加下载更新函数
export const listModels = api.listModels;
export const listSubdirectories = api.listSubdirectories;
export const saveModel = api.saveModel;

export const clearImageCache = api.clearImageCache;
export const getAppVersion = api.getAppVersion;
export const getPackageInfo = api.getPackageInfo; // 导出 getPackageInfo
export const getAllSourceConfigs = api.getAllSourceConfigs;
// You might also export the entire api object if needed,
// but exporting individual functions is generally preferred for clarity.
// export default api;
// --- Model Crawl APIs ---

/**
 * Starts the model crawl process for a given source and directory.
 * @param {string} sourceId - The ID of the data source.
 * @param {string} directory - The directory to crawl.
 * @returns {Promise&lt;void&gt;}
 */
export const startCrawl = async (sourceId, directory) => {
  logMessage('info', `[API Bridge] Starting crawl for source: ${sourceId}, directory: ${directory}`);
  try {
    await api.startCrawl(sourceId, directory);
    logMessage('info', `[API Bridge] Crawl started successfully for source: ${sourceId}`);
  } catch (error) {
    logMessage('error', `[API Bridge] Error starting crawl for source: ${sourceId}`, error);
    throw error; // Re-throw the error after logging
  }
};

/**
 * Pauses the current crawl process.
 * @returns {Promise&lt;void&gt;}
 */
export const pauseCrawl = async () => {
  logMessage('info', '[API Bridge] Pausing crawl');
  try {
    await api.pauseCrawl();
    logMessage('info', '[API Bridge] Crawl paused successfully');
  } catch (error) {
    logMessage('error', '[API Bridge] Error pausing crawl', error);
    throw error;
  }
};

/**
 * Resumes a paused crawl process.
 * @returns {Promise&lt;void&gt;}
 */
export const resumeCrawl = async () => {
  logMessage('info', '[API Bridge] Resuming crawl');
  try {
    await api.resumeCrawl();
    logMessage('info', '[API Bridge] Crawl resumed successfully');
  } catch (error) {
    logMessage('error', '[API Bridge] Error resuming crawl', error);
    throw error;
  }
};

/**
 * Cancels the current crawl process.
 * @returns {Promise&lt;void&gt;}
 */
export const cancelCrawl = async () => {
  logMessage('info', '[API Bridge] Cancelling crawl');
  try {
    await api.cancelCrawl();
    logMessage('info', '[API Bridge] Crawl cancelled successfully');
  } catch (error) {
    logMessage('error', '[API Bridge] Error cancelling crawl', error);
    throw error;
  }
};

/**
 * Gets the current status of the crawl process.
 * @returns {Promise&lt;object&gt;} - The crawl status object.
 */
export const getCrawlStatus = async () => {
  logMessage('debug', '[API Bridge] Getting crawl status');
  try {
    const status = await api.getCrawlStatus();
    logMessage('debug', '[API Bridge] Crawl status received:', status);
    return status;
  } catch (error) {
    logMessage('error', '[API Bridge] Error getting crawl status', error);
    throw error;
  }
};

/**
 * Registers a listener for crawl status updates.
 * Directly exports the function from the exposed API.
 */
export const onCrawlStatusUpdate = api.onCrawlStatusUpdate;

/**
 * Removes a listener for crawl status updates.
 * Directly exports the function from the exposed API.
 */
export const removeCrawlStatusUpdateListener = api.removeCrawlStatusUpdateListener;

export const getImageCacheSize = api.getImageCacheSize;
export const getProcessVersions = api.getProcessVersions; // 添加 getProcessVersions
export const getFilterOptions = api.getFilterOptions;