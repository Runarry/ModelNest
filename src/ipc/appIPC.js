const { ipcMain, BrowserWindow, app } = require('electron');
const log = require('electron-log');
const imageCache = require('../common/imageCache'); // 直接导入 imageCache
const { WebDavDataSource } = require('../data/webdavDataSource'); // 导入 WebDavDataSource

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
      // --- BEGIN WebDAV SubDirectory Validation ---
      if (newConfig && newConfig.modelSources && Array.isArray(newConfig.modelSources)) {
        log.info('[IPC] 开始验证 WebDAV 子目录...');
        for (const source of newConfig.modelSources) {
          // 检查是否是需要验证的 WebDAV 源
          if (source.type === 'webdav' && source.subDirectory && typeof source.subDirectory === 'string' && source.subDirectory.startsWith('/')) {
            log.info(`[IPC] 验证 WebDAV 源 "${source.name}" 的子目录: ${source.subDirectory}`);
            let tempDataSource = null;
            try {
              // 创建临时实例进行验证 (假设构造函数和方法已更新以处理 subDirectory)
              tempDataSource = new WebDavDataSource({
                id: `validation-${Date.now()}`,
                name: `validation-${source.name}`,
                type: 'webdav',
                url: source.url,
                username: source.username,
                password: source.password,
                subDirectory: source.subDirectory,
                readOnly: true // 验证不应写入
              });

              // 尝试访问子目录的根路径 (依赖 WebDavDataSource 内部实现)
              // 使用 stat('/') 作为检查方法，假设它会检查 subDirectory + '/'
              await tempDataSource.stat('/');
              log.info(`[IPC] WebDAV 源 "${source.name}" 子目录 ${source.subDirectory} 验证成功`);

            } catch (validationError) {
              log.error(`[IPC] WebDAV 源 "${source.name}" 子目录 ${source.subDirectory} 验证失败:`, validationError);
              // 抛出更具体的错误给渲染进程
              throw new Error(`WebDAV 源 "${source.name}" 的子目录 "${source.subDirectory}" 验证失败: ${validationError.message || '无法访问或不存在'}`);
            } finally {
               // 清理临时客户端 (如果需要)
               if (tempDataSource && typeof tempDataSource.disconnect === 'function') {
                   await tempDataSource.disconnect();
               }
            }
          }
        }
        log.info('[IPC] 所有 WebDAV 子目录验证完成 (如果需要)');
      }
      // --- END WebDAV SubDirectory Validation ---

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
      await services.imageService.clearCache();
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
      await services.modelInfoCacheService.clearMemoryCache();
      log.info('[IPC] ModelInfo Memory Cache cleared successfully.');
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
      await services.modelInfoCacheService.clearDiskCache();
      log.info('[IPC] ModelInfo Disk Cache cleared successfully.');
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
      
      // Clear modelJsonInfo cache
      const modelInfoCacheKey = `model_info:${sourceId}:${resourcePath}`; // Assuming resourcePath is normalized_json_path
      await services.modelInfoCacheService.clearEntry(modelInfoCacheKey, 'modelJsonInfo');
      log.info(`[IPC] Cleared model_info cache for key: ${modelInfoCacheKey}`);

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


  // --- End ModelInfoCacheService IPC Handlers ---

  log.info('[IPC] App IPC Handlers 初始化完成');
}

module.exports = { initializeAppIPC };
