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
export const listModels = api.listModels;
export const listSubdirectories = api.listSubdirectories;
export const saveModel = api.saveModel;

export const clearImageCache = api.clearImageCache;
export const getAppVersion = api.getAppVersion;
// You might also export the entire api object if needed,
// but exporting individual functions is generally preferred for clarity.
// export default api;