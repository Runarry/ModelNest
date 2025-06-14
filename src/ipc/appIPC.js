const { ipcMain, BrowserWindow, app } = require('electron');
const log = require('electron-log');
const imageCache = require('../common/imageCache'); // 直接导入 imageCache
const { cleanupUserData } = require('../../scripts/cleanup-handler'); // 导入清理函数

/**
 * 初始化应用级别的 IPC Handlers
 * @param {object} services - 包含所有服务的对象
 */
function initializeAppIPC(services) {
  log.info('[IPC] 初始化 App IPC Handlers...');

  // 获取配置
  ipcMain.handle('getConfig', async () => {
    log.info('[IPC] getConfig 请求');
    try {
      // 直接调用 ConfigService 获取配置
      return await services.configService.getConfig();
    } catch (error) {
      log.error('[IPC] 调用 configService.getConfig 失败:', error);
      // 将错误传递给渲染进程
      throw error;
    }
  });

  // 保存配置
  ipcMain.handle('save-config', async (event, newConfig) => {
    log.info('[IPC] save-config 请求');
    try {
      // 如果验证通过 (或无需验证), 则保存配置
      await services.configService.saveConfig(newConfig);
      log.info('[IPC] 配置已通过 configService 保存');

      // 保存成功后，执行协调逻辑
      // 1. 获取更新后的配置 (虽然 newConfig 就是最新的，但遵循文档示例逻辑从服务获取)
      const updatedConfig = await services.configService.getConfig();
      log.info('[IPC] 已获取更新后的配置');

      // 2. 更新 imageCache 配置 (通过 ImageService)
      if (services.imageService) {
        services.imageService.updateCacheConfig(updatedConfig.imageCache || {});
        log.info('[IPC] ImageCache 配置已通过 imageService 更新');
      } else {
        log.warn('[IPC] imageService 未初始化，无法更新 ImageCache 配置');
      }

      // 3. 通知所有窗口配置已更新
      BrowserWindow.getAllWindows().forEach(win => {
        if (win && win.webContents && !win.isDestroyed()) {
          win.webContents.send('config-updated');
        }
      });
      log.info('[IPC] config-updated 事件已发送至所有窗口');

      // 返回成功状态
      return { success: true };
    } catch (error) {
      log.error('[IPC] 调用 configService.saveConfig 或后续处理失败:', error);
      // 将错误传递给渲染进程
      throw error;
    }
  });

  // 清理图片缓存
  ipcMain.handle('clear-image-cache', async () => {
    log.info('[IPC] clear-image-cache 请求');
    try {
      if (!services.imageService) {
        throw new Error('ImageService 未初始化');
      }
      
      // 调用主清理函数
      await services.imageService.clearCache();
      
      // 尝试再次调用孤立文件清理函数
      try {
        log.info('[IPC] 执行额外的孤立文件清理...');
        await imageCache.cleanOrphanedFiles();
        log.info('[IPC] 孤立文件清理完成');
      } catch (orphanError) {
        log.warn('[IPC] 清理孤立文件时出错:', orphanError);
        // 不中断主流程，继续返回成功
      }
      
      log.info('[IPC] Image cache cleared successfully via ImageService.');
      return { success: true };
    } catch (error) {
      log.error('[IPC] Failed to clear image cache via ImageService:', error);
      return { success: false, error: error.message };
    }
  });

  // 获取应用版本号
  ipcMain.handle('get-app-version', () => {
    log.info('[IPC] get-app-version 请求');
    try {
      const version = app.getVersion();
      log.info(`[IPC] 应用版本号: ${version}`);
      return version;
    } catch (error) {
      log.error('[IPC] 获取应用版本号失败:', error);
      // 返回 null 或根据需要抛出错误
      return null;
    }
  });

  // 获取package.json信息
  ipcMain.handle('get-package-info', () => {
    log.info('[IPC] get-package-info 请求');
    try {
      const packageInfo = require('../../package.json');
      // Include repository and bugs in the destructuring
      const { name, version, description, author, license, repository, bugs } = packageInfo;
      log.info('[IPC] 获取package.json信息成功');
      // Return the additional fields
      return { name, version, description, author, license, repository, bugs };
    } catch (error) {
      log.error('[IPC] 获取package.json信息失败:', error);
      throw error;
    }
  });

  // 获取当前图片缓存大小
  ipcMain.handle('get-image-cache-size', async () => {
    log.info('[IPC] get-image-cache-size 请求');
    try {
      // 调用新的函数获取字节数
      const sizeBytes = await imageCache.getCurrentCacheSizeBytes();
      log.info(`[IPC] 当前图片缓存大小: ${sizeBytes} Bytes`);
      // 返回字节数 (number)
      return sizeBytes;
    } catch (error) {
      log.error('[IPC] 调用 imageCache.getCurrentCacheSizeBytes 失败:', error);
      // 将错误传递给渲染进程
      throw error; // 或者返回一个特定的错误状态
    }
  });

  // 获取图片缓存统计信息
  ipcMain.handle('get-cache-stats', async () => {
    log.info('[IPC] get-cache-stats 请求');
    try {
      // 获取缓存基本统计
      const stats = imageCache.getStats();
      
      // 获取当前缓存大小
      const currentCacheSize = await imageCache.getCurrentCacheSizeBytes();
      
      // 获取最大缓存限制
      const maxCacheSizeMB = imageCache.config.maxCacheSizeMB;
      
      // 合并统计结果
      const fullStats = {
        ...stats,
        currentCacheSize,
        maxCacheSizeMB
      };
      
      log.info(`[IPC] 返回图片缓存统计: ${JSON.stringify(fullStats, null, 2)}`);
      return fullStats;
    } catch (error) {
      log.error('[IPC] 获取图片缓存统计失败:', error.message, error.stack);
      throw error;
    }
  });

  // 手动触发从旧缓存位置迁移
  ipcMain.handle('migrate-image-cache', async () => {
    log.info('[IPC] migrate-image-cache 请求');
    try {
      await imageCache.migrateFromOldCacheLocation();
      log.info('[IPC] 图片缓存迁移完成');
      return { success: true, message: '缓存迁移完成' };
    } catch (error) {
      log.error('[IPC] 图片缓存迁移失败:', error.message, error.stack);
      return { success: false, error: error.message };
    }
  });

  // 手动触发模型信息缓存迁移
  ipcMain.handle('migrate-model-cache', async () => {
    log.info('[IPC] migrate-model-cache 请求');
    try {
      if (!services.modelInfoCacheService) {
        throw new Error('ModelInfoCacheService 未初始化');
      }
      const result = await services.modelInfoCacheService.manualMigrateFromOldLocation();
      log.info('[IPC] 模型信息缓存迁移完成:', result);
      return result;
    } catch (error) {
      log.error('[IPC] 模型信息缓存迁移失败:', error.message, error.stack);
      return { success: false, error: error.message };
    }
  });

  // 获取 process.versions 信息
  ipcMain.handle('get-process-versions', () => {
    log.info('[IPC] get-process-versions 请求');
    try {
      // 直接返回 Node.js 提供的 process.versions 对象
      log.info('[IPC] 返回 process.versions 信息:', process.versions);
      return process.versions;
    } catch (error) {
      log.error('[IPC] 获取 process.versions 失败:', error);
      throw error; // 或者返回 null
    }
  });

  // --- ModelInfoCacheService IPC Handlers ---

  ipcMain.handle('clearModelInfoMemoryCache', async () => {
    log.info('[IPC] clearModelInfoMemoryCache 请求');
    try {
      if (!services.modelInfoCacheService) {
        throw new Error('ModelInfoCacheService 未初始化');
      }
      await services.modelInfoCacheService.clearL1Cache(); // V2: Renamed from clearMemoryCache
      log.info('[IPC] ModelInfo L1 Cache cleared successfully.');
      return { success: true };
    } catch (error) {
      log.error('[IPC] Failed to clear ModelInfo Memory Cache:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('clearModelInfoDiskCache', async () => {
    log.info('[IPC] clearModelInfoDiskCache 请求');
    try {
      if (!services.modelInfoCacheService) {
        throw new Error('ModelInfoCacheService 未初始化');
      }
      await services.modelInfoCacheService.clearAllL2Cache(); // V2: clearDiskCache is now clearAllL2Cache, specific to model_json_info_cache
      log.info('[IPC] ModelInfo L2 Cache (model_json_info_cache) cleared successfully.');
      return { success: true };
    } catch (error) {
      log.error('[IPC] Failed to clear ModelInfo Disk Cache:', error);
      return { success: false, error: error.message };
    }
  });

  // 可选: 获取模型信息缓存统计
  ipcMain.handle('getModelInfoCacheStats', async () => {
    log.info('[IPC] getModelInfoCacheStats 请求');
    try {
      if (!services.modelInfoCacheService) {
        throw new Error('ModelInfoCacheService 未初始化');
      }
      // 假设 modelInfoCacheService 上有 getCacheStats 方法
      if (typeof services.modelInfoCacheService.getCacheStats !== 'function') {
        log.warn('[IPC] modelInfoCacheService.getCacheStats is not implemented.');
        return { success: false, error: 'Stats function not implemented in service.' };
      }
      const stats = await services.modelInfoCacheService.getCacheStats();
      log.info('[IPC] ModelInfo Cache Stats retrieved successfully.');
      return { success: true, stats };
    } catch (error) {
      log.error('[IPC] Failed to get ModelInfo Cache Stats:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('clear-model-cache-by-source', async (event, { sourceId }) => {
    log.info(`[IPC] clear-model-cache-by-source 请求 for sourceId: ${sourceId}`);
    if (!sourceId) {
      log.error('[IPC] clear-model-cache-by-source: sourceId is required.');
      return { success: false, error: 'sourceId is required.' };
    }
    try {
      if (!services.modelInfoCacheService) {
        throw new Error('ModelInfoCacheService 未初始化');
      }
      await services.modelInfoCacheService.clearBySource(sourceId);
      log.info(`[IPC] All model cache for sourceId ${sourceId} cleared successfully.`);
      return { success: true };
    } catch (error) {
      log.error(`[IPC] Failed to clear model cache for sourceId ${sourceId}:`, error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('clear-all-model-info-cache', async () => {
    log.info('[IPC] clear-all-model-info-cache 请求');
    try {
      if (!services.modelInfoCacheService) {
        throw new Error('ModelInfoCacheService 未初始化');
      }
      await services.modelInfoCacheService.clearAll();
      log.info('[IPC] All model info cache (L1 and L2) cleared successfully.');
      return { success: true };
    } catch (error) {
      log.error('[IPC] Failed to clear all model info cache:', error);
      return { success: false, error: error.message };
    }
  });
  
  ipcMain.handle('clear-specific-model-cache', async (event, { sourceId, resourcePath }) => {
    log.info(`[IPC] clear-specific-model-cache 请求 for sourceId: ${sourceId}, resourcePath: ${resourcePath}`);
    if (!sourceId || !resourcePath) {
      log.error('[IPC] clear-specific-model-cache: sourceId and resourcePath are required.');
      return { success: false, error: 'sourceId and resourcePath are required.' };
    }
    try {
      if (!services.modelInfoCacheService) {
        throw new Error('ModelInfoCacheService 未初始化');
      }
      
      // Clear modelJsonInfo cache (L1 and L2 for this specific entry)
      // V2: Key format should align with ModelService/ModelInfoCacheService, e.g., "modelJsonInfo:sourceId:jsonPath"
      const modelJsonInfoCacheKey = `modelJsonInfo:${sourceId}:${resourcePath}`; // Assuming resourcePath is equivalent to jsonPath
      await services.modelInfoCacheService.clearEntry(modelJsonInfoCacheKey, 'modelJsonInfo');
      log.info(`[IPC] Cleared modelJsonInfo (L1 & L2) cache for key: ${modelJsonInfoCacheKey}`);

      // Invalidate listModels cache for the directory
      const directoryPath = path.dirname(resourcePath);
      // Normalize dirPath if necessary, e.g., remove leading/trailing slashes if ModelInfoCacheService expects a specific format
      const normalizedDirPath = directoryPath === '.' ? '' : directoryPath.replace(/^\/+|\/+$/g, '');
      
      await services.modelInfoCacheService.invalidateListModelsCacheForDirectory(sourceId, normalizedDirPath);
      log.info(`[IPC] Invalidated list_models cache for directory: ${normalizedDirPath}, sourceId: ${sourceId}`);
      
      return { success: true };
    } catch (error) {
      log.error(`[IPC] Failed to clear specific model cache for sourceId ${sourceId}, resourcePath ${resourcePath}:`, error);
      return { success: false, error: error.message };
    }
  });


  ipcMain.handle('get-blocked-tags', async () => {
    log.info('[IPC] get-blocked-tags 请求');
    try {
      if (!services.configService) {
        throw new Error('ConfigService 未初始化');
      }
      // 调用 ConfigService 中专门的 getBlockedTags 接口
      const blockedTags = await services.configService.getBlockedTags();
      log.info('[IPC] 获取屏蔽标签列表成功');
      return blockedTags;
    } catch (error) {
      log.error('[IPC] 获取屏蔽标签列表失败:', error);
      throw error; // 将错误传递给渲染进程
    }
  });


  // --- End ModelInfoCacheService IPC Handlers ---

  // 清理用户数据目录
  ipcMain.handle('cleanup-user-data', async (event, options = {}) => {
    log.info('[IPC] cleanup-user-data 请求', options);
    try {
      const userDataPath = app.getPath('userData');
      const { cleanCache = true, cleanLogs = true } = options;
      
      // 调用清理函数
      const result = await cleanupUserData(userDataPath, cleanCache, cleanLogs);
      
      log.info(`[IPC] 用户数据清理结果: ${result.success ? '成功' : '失败'}`);
      return result;
    } catch (error) {
      log.error('[IPC] 清理用户数据目录失败:', error);
      return { 
        success: false, 
        errors: [`清理失败: ${error.message}`] 
      };
    }
  });

  log.info('[IPC] App IPC Handlers 初始化完成');
}

module.exports = { initializeAppIPC };
