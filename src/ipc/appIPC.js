const { ipcMain, BrowserWindow, app } = require('electron');
const log = require('electron-log');
const { clearCache } = require('../common/imageCache');
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
      // 调用 ConfigService 保存配置
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
      await clearCache();
      log.info('[IPC] Image cache cleared successfully.');
      return { success: true };
    } catch (error) {
      log.error('[IPC] Failed to clear image cache:', error);
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
      const { name, version, description, author, license } = packageInfo;
      log.info('[IPC] 获取package.json信息成功');
      return { name, version, description, author, license };
    } catch (error) {
      log.error('[IPC] 获取package.json信息失败:', error);
      throw error;
    }
  });

  log.info('[IPC] App IPC Handlers 初始化完成');
}

module.exports = { initializeAppIPC };