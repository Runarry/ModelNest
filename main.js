// 定义 __DEV__ 常量，用于区分开发和生产环境
const __DEV__ = process.env.IS_DEV_MODE === 'true';
const { app, BrowserWindow, ipcMain, dialog } = require('electron'); // Add dialog here
const { autoUpdater } = require('electron-updater'); // Import autoUpdater
const path = require('path');
const fs = require('fs');

const imageCache = require('./src/common/imageCache');
const os = require('os');
const crypto = require('crypto');
const log = require('electron-log');

const { initializeModelLibraryIPC } = require('./src/ipc/modelLibraryIPC.js'); // Import the model library IPC initializer
const { initializeAppIPC } = require('./src/ipc/appIPC.js'); // Import the app IPC initializer
let mainWindow; // Declare mainWindow globally

// 创建主窗口 (TODO: Modify to accept services and pass webContents to updateService)
function createWindow(services) {
  log.info('[Lifecycle] 创建主窗口');
  mainWindow = new BrowserWindow({ // Assign to mainWindow
    width: 1270,
    height: 800,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));
  // 在开发模式下打开 DevTools
  if (__DEV__) {
    mainWindow.webContents.openDevTools();
  }
  mainWindow.on('closed', () => {
    log.info('[Lifecycle] 主窗口已关闭');
  });
}

app.whenReady().then(async () => { // 改为 async 回调
  log.info('[Lifecycle] 应用启动，准备初始化主进程');
  // 日志文件路径配置
  const logsDir = path.join(app.getPath('userData'), 'logs');
  const logFile = path.join(logsDir, 'main.log');
  try {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
      log.info(`[Log] 日志目录已创建: ${logsDir}`);
    }
  } catch (e) {
    // 若目录创建失败，降级为默认路径
    log.error('日志目录创建失败:', e.message, e.stack);
  }
  log.transports.file.resolvePath = () => logFile;
  log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] {text}';
  log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB

  // 配置 electron-log 捕获未处理的异常和拒绝
  log.errorHandler.startCatching({
    showDialog: process.env.NODE_ENV !== 'production' // 只在非生产环境显示对话框
  });
  log.info('[Log] 配置 electron-log 捕获未处理错误');

  // --- Initialize Services ---
  const { initializeServices } = require('./src/services'); // 引入初始化函数
  log.info('[Main] 开始初始化服务...');
  const services = await initializeServices(); // 等待所有服务初始化完成
  log.info('[Main] 所有服务已初始化');

  // 使用 services.configService 获取配置来设置日志级别
  const appConfig = await services.configService.getConfig();
  let level = 'debug'; // Default level
  if (appConfig && typeof appConfig.logLevel === 'string') {
    level = appConfig.logLevel;
  } else if (process.env.LOG_LEVEL) {
    level = process.env.LOG_LEVEL;
  } else if (process.env.BUILD_DEFAULT_LOG_LEVEL) {
    level = process.env.BUILD_DEFAULT_LOG_LEVEL;
  }
  log.transports.file.level = level;
  log.transports.console.level = level;
  log.info(`[Log] 日志级别已根据服务配置设置为: ${level}`);

  // 使用 services.configService 获取配置来设置 imageCache
  imageCache.setConfig(appConfig.imageCache || {});
  log.info('[ImageCache] ImageCache 配置已根据服务设置');

  // 将 services 对象传递给需要它的地方
  // 注意: initializeIPC 和 createWindow 函数本身尚未修改以接收 services
  // 初始化 IPC Handlers，传入 services 对象
  initializeAppIPC(services);
  initializeModelLibraryIPC(services);
  log.info('[IPC] IPC Handlers 已初始化');

  createWindow(services); // TODO: Modify createWindow to accept services and pass webContents to updateService

  // --- Electron Updater Logic with Enhanced Logging ---
  log.info('[Updater] Starting autoUpdater initialization...');
  let sendUpdateStatus; // Declare here to be accessible in catch block if needed
  try {
    // 配置 autoUpdater 日志为 electron-log
    log.info('[Updater] Configuring logger...');
    autoUpdater.logger = log;
    log.info('[Updater] Logger configured successfully.');

    // Helper function to send status to renderer
    sendUpdateStatus = (status, ...args) => {
      // 检查 mainWindow 是否存在且未被销毁
      if (mainWindow && mainWindow.webContents && !mainWindow.isDestroyed()) {
        log.debug(`[Updater] Sending status to renderer: ${status}`, args);
        try {
          mainWindow.webContents.send('updater.onUpdateStatus', status, ...args);
        } catch (sendError) {
          // 捕获发送消息时可能发生的错误 (例如窗口已关闭)
          log.error('[Updater] Error sending status to renderer:', { message: sendError.message, stack: sendError.stack });
        }
      } else {
        log.warn('[Updater] Cannot send status, mainWindow is not available or destroyed.');
      }
    };

    log.info('[Updater] Registering event listeners...');
    autoUpdater.on('checking-for-update', () => {
      log.info('[Updater] Event: checking-for-update');
      sendUpdateStatus('checking');
    });
    autoUpdater.on('update-available', (info) => {
      log.info('[Updater] Event: update-available', info);
      sendUpdateStatus('available', info);
    });
    autoUpdater.on('update-not-available', (info) => {
      log.info('[Updater] Event: update-not-available', info);
      sendUpdateStatus('not-available', info);
    });
    autoUpdater.on('error', (err) => {
      // 记录完整的错误信息，包括堆栈
      log.error('[Updater] Event: error', { message: err.message, stack: err.stack, error: err });
      sendUpdateStatus('error', err && err.message ? err.message : 'Unknown update error');
    });
    autoUpdater.on('download-progress', (progressObj) => {
      // 使用 verbose 级别，避免日志过多，仅在需要详细调试时开启
      log.verbose('[Updater] Event: download-progress', progressObj);
      sendUpdateStatus('downloading', progressObj);
    });
    autoUpdater.on('update-downloaded', (info) => {
      log.info('[Updater] Event: update-downloaded', info);
      sendUpdateStatus('downloaded', info);
    });
    log.info('[Updater] Event listeners registered.');

    // 自动检查更新 (当前被注释掉)
    // log.info('[Updater] Scheduling check for updates (currently disabled)...');
    // setTimeout(() => {
    //   log.info('[Updater] Executing scheduled check for updates...');
    //   try { // 添加 try-catch 以防 checkForUpdatesAndNotify 本身抛出同步错误
    //      autoUpdater.checkForUpdatesAndNotify().catch(err => {
    //        log.error('[Updater] Error during scheduled checkForUpdatesAndNotify:', { message: err.message, stack: err.stack, error: err });
    //        sendUpdateStatus('error', `自动检查更新失败: ${err && err.message}`);
    //      });
    //   } catch (checkError) {
    //       log.error('[Updater] Synchronous error calling checkForUpdatesAndNotify:', { message: checkError.message, stack: checkError.stack });
    //       sendUpdateStatus('error', `自动检查更新调用失败: ${checkError && checkError.message}`);
    //   }
    // }, 3000);

    log.info('[Updater] AutoUpdater initialization finished successfully.');

  } catch (initError) {
    // 捕获初始化块中的任何同步错误
    log.error('[Updater] CRITICAL: Failed during autoUpdater initialization block:', { message: initError.message, stack: initError.stack, error: initError });
    // 尝试通知渲染进程初始化失败
    if (typeof sendUpdateStatus === 'function') {
        sendUpdateStatus('init-error', `Updater 初始化失败: ${initError.message}`);
    } else {
        // 如果 sendUpdateStatus 还未定义（例如在定义它之前出错），则记录警告
        log.warn('[Updater] Cannot send init-error status, sendUpdateStatus function not available.');
    }
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
      // sendUpdateStatus('error', `手动检查更新失败: ${error.message}`); // Keep for now if service doesn't send
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
  // --- End Updater IPC Handlers ---
  // --- End Electron Updater Logic ---

// 移除旧的占位 initializeIPC 函数

app.on('activate', function () {
    log.info('[Lifecycle] 应用激活');
    if (BrowserWindow.getAllWindows().length === 0) createWindow(); // createWindow 应该在 app ready 后调用，这里可能需要调整逻辑，但暂时保留
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


app.on('window-all-closed', async function () {
  log.info('[Lifecycle] 所有窗口已关闭');
  if (process.platform !== 'darwin') {
    try {
      // 清理图片缓存
      await imageCache.clearCache();
      log.info('[Cache] 图片缓存已清理');

      // 清理WebDAV下载缓存目录
      const webdavCacheDir = path.join(process.cwd(), 'cache', 'webdav_images');
      if (fs.existsSync(webdavCacheDir)) {
        const files = await fs.promises.readdir(webdavCacheDir);
        await Promise.all(files.map(file => fs.promises.unlink(path.join(webdavCacheDir, file))));
        log.info(`[Cache] 清理WebDAV下载缓存目录: ${webdavCacheDir}, 删除文件数: ${files.length}`);
      }
    } catch (e) {
      log.error('[Cache] 清理缓存失败:', e.message, e.stack);
    }
    log.info('[Lifecycle] 应用即将退出');
    app.quit();
  }
});

// IPC: 获取子目录列表
// IPC: 获取模型详情
// IPC: 获取模型图片数据

// IPC: 打开文件夹选择对话框
ipcMain.handle('open-folder-dialog', async (event) => {
  // const { dialog } = require('electron'); // Moved import to the top
  const result = await dialog.showOpenDialog(mainWindow, { // Use mainWindow
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
