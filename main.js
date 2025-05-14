// 定义 __DEV__ 常量，用于区分开发和生产环境
const __DEV__ = process.env.IS_DEV_MODE === 'true';
const { app, BrowserWindow, ipcMain, dialog } = require('electron'); // Add dialog here
const { autoUpdater } = require('electron-updater'); // Import autoUpdater
const path = require('path');
const fs = require('fs-extra'); // Add fs-extra for file operations

const imageCache = require('./src/common/imageCache');
const os = require('os');
const crypto = require('crypto');
const log = require('electron-log'); // electron-log is still used for direct logging in main.js if needed, and by logger.js
const { initializeLogger } = require('./src/utils/logger'); // Import the logger initializer
const { cleanupUserData } = require('./scripts/cleanup-handler'); // Import cleanup handler

const { initializeModelLibraryIPC } = require('./src/ipc/modelLibraryIPC.js'); // Import the model library IPC initializer
const { initializeAppIPC } = require('./src/ipc/appIPC.js'); // Import the app IPC initializer
const { initializeModelCrawlerIPC } = require('./src/ipc/modelCrawlerIPC.js'); // Import the model crawler IPC initializer
const { createWindow, getMainWindow } = require('./src/utils/windowManager'); // Import window manager
let services = null; // Declare services globally

// 监听应用卸载前的退出事件，用于清理用户数据
app.on('will-quit', async (event) => {
  // 检查是否是卸载过程
  // 由于Electron没有直接的方法判断应用是否正在被卸载，我们使用日志记录作为安全措施
  log.info('[Lifecycle] 应用将要退出，检查是否需要清理用户数据');
  
  // 检测临时标记文件是否存在（卸载进程可能创建此文件）
  try {
    const userDataPath = app.getPath('userData');
    const flagFile = path.join(userDataPath, '.uninstall_cleanup_required');
    
    // 如果标记文件存在，执行清理
    let performCleanup = false;
    try {
      await fs.promises.access(flagFile);
      performCleanup = true;
      log.info('[Cleanup] 检测到卸载标记文件，将执行清理');
    } catch (flagError) {
      // 文件不存在，这可能是正常退出而不是卸载
      log.info('[Cleanup] 未检测到卸载标记，跳过清理');
    }
    
    if (performCleanup) {
      event.preventDefault(); // 暂停退出过程，直到清理完成
      
      log.info('[Cleanup] 开始清理用户数据...');
      // 执行清理
      try {
        const result = await cleanupUserData(userDataPath, true, true);
        if (result.success) {
          log.info('[Cleanup] 用户数据清理成功');
        } else {
          log.warn('[Cleanup] 用户数据清理部分失败:', result.errors);
        }
        
        // 清理完成后，删除标记文件
        try {
          await fs.promises.unlink(flagFile);
          log.info('[Cleanup] 卸载标记文件已删除');
        } catch (unlinkError) {
          log.warn('[Cleanup] 无法删除卸载标记文件:', unlinkError.message);
        }
      } catch (cleanupError) {
        log.error('[Cleanup] 清理用户数据时出错:', cleanupError.message);
      }
      
      // 继续退出应用
      app.quit();
    }
  } catch (error) {
    log.error('[Cleanup] 处理卸载清理时遇到错误:', error.message);
  }
});

app.whenReady().then(async () => { // 改为 async 回调
  log.info('[Lifecycle] 应用启动，准备初始化主进程');

  // --- Initialize Services ---
  const { initializeServices } = require('./src/services'); // 引入初始化函数
  log.info('[Main] 开始初始化服务...');
  services = await initializeServices(); // Assign to the global services variable
  log.info('[Main] 所有服务已初始化');

  // --- Initialize Logger ---
  await initializeLogger(services.configService); // Initialize logger after services
  log.info('[Main] Logger 已初始化');


  // 使用 services.configService 获取配置来设置 imageCache
  const appConfig = await services.configService.getConfig(); // getConfig needs to be called to get appConfig
  imageCache.setConfig(appConfig.imageCache || {});
  log.info('[ImageCache] ImageCache 配置已根据服务设置');

  // 将 services 对象传递给需要它的地方
  // 初始化 IPC Handlers，传入 services 对象
  initializeAppIPC(services);
  initializeModelLibraryIPC(services);
  log.info('[IPC] IPC Handlers 已初始化');

  const mainWindow = createWindow(__DEV__); // Create window using windowManager and pass __DEV__

  // Initialize IPC handlers that require mainWindow AFTER it's created
  if (mainWindow && services) {
    // Initialize Model Crawler IPC
    initializeModelCrawlerIPC(ipcMain, services, mainWindow);
    log.info('[IPC] Model Crawler IPC Handler 已初始化');

    // Pass webContents to UpdateService
    if (services.updateService) {
      services.updateService.setWebContents(mainWindow.webContents);
      log.info('[Main] mainWindow.webContents passed to UpdateService.');
    } else {
      log.warn('[Main] UpdateService not available when trying to set webContents.');
    }
  } else {
    log.error('[Main] Failed to initialize post-window IPC or pass webContents: mainWindow or services not available.');
  }

// --- Updater IPC Handlers ---
  ipcMain.handle('updater.checkForUpdate', async () => {
    log.info('[Updater IPC] 收到 checkForUpdate 请求');
    // Delegate to UpdateService
    try {
      await services.updateService.checkForUpdates();
      // UpdateService will handle sending status updates via webContents
      return { success: true };
    } catch (error) {
      log.error('[Updater IPC] Error during checkForUpdates via service:', error.message, error.stack);
      // UpdateService should ideally handle sending error status too
      throw error; // Re-throw for the renderer to catch
    }
  });

ipcMain.handle('updater.downloadUpdate', async () => {
    log.info('[Updater IPC] 收到 downloadUpdate 请求');
    // Delegate to UpdateService
    try {
      await services.updateService.downloadUpdate();
      // UpdateService should handle sending status updates
      return { success: true };
    } catch (error) {
      log.error('[Updater IPC] Error during downloadUpdate via service:', error.message, error.stack);
      // UpdateService should ideally handle sending error status too
      throw error; // Re-throw for the renderer to catch
    }
  });
  ipcMain.handle('updater.quitAndInstall', () => {
    log.info('[Updater IPC] 收到 quitAndInstall 请求');
    // Delegate to UpdateService
    try {
      services.updateService.quitAndInstall();
    } catch (error) {
      log.error('[Updater IPC] Error during quitAndInstall via service:', error.message, error.stack);
      // Optionally send an error status back if needed
    }
  });


app.on('activate', function () {
    log.info('[Lifecycle] 应用激活');
    if (BrowserWindow.getAllWindows().length === 0) createWindow(__DEV__);
  });

  // 全局异常处理
  process.on('uncaughtException', (error) => {
    log.error('[Process] 未捕获异常:', error.message, error.stack);
  });
  process.on('unhandledRejection', (reason, promise) => {
    log.error('[Process] 未处理的 Promise 拒绝:', reason && reason.message, reason && reason.stack, reason);
  });
});

// 渲染进程错误日志监听
ipcMain.on('renderer-error', (event, errorInfo) => {
  try {
    log.error('[RendererError] 渲染进程错误上报:', errorInfo && errorInfo.message, errorInfo && errorInfo.stack, errorInfo);
  } catch (e) {
    log.error('[RendererError] 记录渲染进程错误时异常:', e.message, e.stack);
  }
});

// 监听来自渲染进程的通用日志消息
ipcMain.on('log-message', (event, level, message, ...args) => {
  // 使用 electron-log 记录日志
  // log[level] 会调用对应级别的日志方法，如 log.info, log.warn 等
  if (log[level] && typeof log[level] === 'function') {
    log[level](`[Renderer] ${message}`, ...args);
  } else {
    // 如果级别无效，默认使用 info
    log.info(`[Renderer] [${level.toUpperCase()}] ${message}`, ...args);
  }
});


app.on('window-all-closed', async function () { // Ensure the function is async
  log.info('[Lifecycle] 所有窗口已关闭');
  if (process.platform !== 'darwin') {
    try {
      // WebDAV 缓存清理逻辑暂时忽略 (根据指令)
    } catch (e) {
      // 如果有其他清理逻辑失败，仍然记录错误
      log.error('[Lifecycle] 关闭过程中的清理操作失败:', e.message, e.stack);
    }
    log.info('[Lifecycle] 应用即将退出');
    app.quit();
  }
});


// IPC: 打开文件夹选择对话框
ipcMain.handle('open-folder-dialog', async (event) => {
  const result = await dialog.showOpenDialog(getMainWindow(), { // Use getMainWindow()
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    log.info('[Main] Folder selection cancelled.');
    return null;
  } else {
    log.info('[Main] Folder selected:', result.filePaths[0]);
    return result.filePaths[0];
  }
});

// The duplicate handlers are removed, as they're already defined in appIPC.js
