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
let services = null; // Declare services globally

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
  services = await initializeServices(); // Assign to the global services variable
  log.info('[Main] 所有服务已初始化');

  // 使用 services.configService 获取配置来设置日志级别
  const appConfig = await services.configService.getConfig();
  let level = 'warn'; // Default level
  if (process.env.LOG_LEVEL){
    level = process.env.LOG_LEVEL;
     log.warn(`LOG_LEVEL from env: ${process.env.LOG_LEVEL}` )
  }
  if (appConfig && typeof appConfig.logLevel === 'string') {
    level = appConfig.logLevel;

  } 

  log.level = level; // 设置主日志级别，影响所有 transports
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
// Pass webContents to UpdateService after window creation
  if (mainWindow && services && services.updateService) {
    services.updateService.setWebContents(mainWindow.webContents);
    log.info('[Main] mainWindow.webContents passed to UpdateService.');
  } else {
    log.error('[Main] Failed to pass webContents to UpdateService: mainWindow or services not available.');
  }

  // --- Electron Updater Logic is now handled by UpdateService ---
  // The UpdateService will be initialized along with other services.
  // IPC handlers below will delegate actions to the UpdateService.
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


app.on('window-all-closed', async function () { // Ensure the function is async
  log.info('[Lifecycle] 所有窗口已关闭');
  if (process.platform !== 'darwin') {
    try {
      // 清理图片缓存 (通过 ImageService)
      if (services && services.imageService) {
          await services.imageService.cleanupCache(); // Call the service method
      } else {
          log.warn('[Lifecycle] Services or ImageService not available during window-all-closed.');
      }

      // WebDAV 缓存清理逻辑暂时忽略 (根据指令)
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
