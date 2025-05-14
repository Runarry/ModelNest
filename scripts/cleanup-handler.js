const fs = require('fs-extra');
const path = require('path');
const log = require('electron-log');

/**
 * Cleans up cache and log directories in the userData path
 * @param {string} userDataPath - Path to the application's userData directory
 * @param {boolean} cleanCache - Whether to clean the cache directory
 * @param {boolean} cleanLogs - Whether to clean the logs directory
 * @returns {Promise<{success: boolean, errors: string[]}>} - Result of the cleanup operation
 */
async function cleanupUserData(userDataPath, cleanCache = true, cleanLogs = true) {
  const errors = [];
  let success = true;

  try {
    log.info('[Cleanup] Starting cleanup of userData directories', { cleanCache, cleanLogs, userDataPath });
    
    // Clean cache directory
    if (cleanCache) {
      const cachePath = path.join(userDataPath, 'cache');
      
      try {
        if (await fs.exists(cachePath)) {
          log.info(`[Cleanup] Removing cache directory: ${cachePath}`);
          await fs.remove(cachePath);
          log.info(`[Cleanup] Successfully removed cache directory`);
        } else {
          log.info(`[Cleanup] Cache directory does not exist: ${cachePath}`);
        }
      } catch (cacheError) {
        success = false;
        const errorMsg = `Failed to clean cache directory: ${cacheError.message}`;
        errors.push(errorMsg);
        log.error(`[Cleanup] ${errorMsg}`, cacheError);
      }
    }
    
    // Clean logs directory
    if (cleanLogs) {
      const logsPath = path.join(userDataPath, 'logs');
      
      try {
        if (await fs.exists(logsPath)) {
          log.info(`[Cleanup] Removing logs directory: ${logsPath}`);
          await fs.remove(logsPath);
          log.info(`[Cleanup] Successfully removed logs directory`);
        } else {
          log.info(`[Cleanup] Logs directory does not exist: ${logsPath}`);
        }
      } catch (logsError) {
        success = false;
        const errorMsg = `Failed to clean logs directory: ${logsError.message}`;
        errors.push(errorMsg);
        log.error(`[Cleanup] ${errorMsg}`, logsError);
      }
    }
    
    log.info(`[Cleanup] Cleanup completed with ${success ? 'success' : 'errors'}`);
    return { success, errors };
  } catch (error) {
    log.error(`[Cleanup] Unexpected error during cleanup: ${error.message}`, error);
    return { 
      success: false, 
      errors: [...errors, `Unexpected error: ${error.message}`]
    };
  }
}

module.exports = {
  cleanupUserData
}; 