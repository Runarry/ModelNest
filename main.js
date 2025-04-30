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

const { initializeModelLibraryIPC } = require('./src/ipc/modelLibraryIPC.js'); // Import the new initializer
const { setConfig, getConfig } = require('./src/configManager.js'); // Import config manager functions

let mainWindow; // Declare mainWindow globally
let config = null; // Keep local config for loading/saving logic in main.js

// 加载配置文件 (异步)
async function loadConfig() {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    // 使用 fs.promises.access 检查文件是否存在
    await fs.promises.access(configPath);
    // 使用 fs.promises.readFile 读取文件
    const configData = await fs.promises.readFile(configPath, 'utf-8');
    config = JSON.parse(configData);
    // 转换本地路径为绝对路径 (在 setConfig 之前完成)
    if (Array.isArray(config.modelSources)) {
      config.modelSources.forEach(source => {
        if (source.type === 'local' && source.path) {
          source.path = path.isAbsolute(source.path) ? source.path : path.join(process.cwd(), source.path);
        }
      });
    }
    setConfig(config); // Update config manager after loading and processing
    log.info('[Config] Loaded config set in configManager');
  } catch (error) {
    // 如果文件不存在或读取/解析失败，则使用默认配置
    if (error.code === 'ENOENT') {
      log.warn('config.json 不存在，使用默认配置。');
    } else {
      log.error('加载或解析 config.json 失败:', error.message, error.stack);
    }
    config = { modelSources: [], supportedExtensions: [] };
    setConfig(config); // Update config manager with default config
    log.warn('[Config] Default config set in configManager');
  }
}

// 创建主窗口
function createWindow() {
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

  await loadConfig(); // 等待配置加载完成
  log.info('[Config] 配置加载完成', config);

  // 日志级别设置：优先 config.json（logLevel），否则环境变量 LOG_LEVEL，否则 'info'
  // 日志级别优先级：config.json（logLevel）> LOG_LEVEL > BUILD_DEFAULT_LOG_LEVEL > 'info'
  let level = 'debug';
  if (config && typeof config.logLevel === 'string') {
    level = config.logLevel;
  } else if (process.env.LOG_LEVEL) {
    level = process.env.LOG_LEVEL;
  } else if (process.env.BUILD_DEFAULT_LOG_LEVEL) {
    level = process.env.BUILD_DEFAULT_LOG_LEVEL;
  }
  log.transports.file.level = level;
  log.transports.console.level = level;
  log.info(`[Log] 日志级别已设置为: ${level}`);

  // 配置 electron-log 捕获未处理的异常和拒绝
  log.errorHandler.startCatching({
    showDialog: process.env.NODE_ENV !== 'production' // 只在非生产环境显示对话框
  });
  log.info('[Log] 配置 electron-log 捕获未处理错误');

  // 配置加载完成后再设置 imageCache
  if (config && config.imageCache) {
    imageCache.setConfig(config.imageCache);
    log.info('[ImageCache] 使用配置文件中的 imageCache 配置');
  } else {
    imageCache.setConfig({});
    log.warn('[ImageCache] 未检测到 imageCache 配置，使用默认值');
  }

  createWindow();

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
    try {
      sendUpdateStatus('checking'); // Notify renderer immediately
      const result = await autoUpdater.checkForUpdates();
      log.info('[Updater IPC] checkForUpdates result:', result ? 'Update check triggered' : 'Update check failed or no result');
      return null; // Avoid cloning error by not returning the complex object
    } catch (error) {
      log.error('[Updater IPC] Error during checkForUpdates:', error.message, error.stack);
      sendUpdateStatus('error', `手动检查更新失败: ${error.message}`);
      throw error;
    }
  });

  ipcMain.handle('updater.quitAndInstall', () => {
    log.info('[Updater IPC] 收到 quitAndInstall 请求');
    try {
      autoUpdater.quitAndInstall();
    } catch (error) {
      log.error('[Updater IPC] Error during quitAndInstall:', error.message, error.stack);
    }
  });
  // --- End Updater IPC Handlers ---
  // --- End Electron Updater Logic ---

  // Initialize Model Library IPC Handlers (no longer needs config passed)
  initializeModelLibraryIPC();


app.on('activate', function () {
    log.info('[Lifecycle] 应用激活');
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
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

 // IPC: 获取配置
log.info('[IPC] Registering handler for getConfig');
ipcMain.handle('getConfig', async () => {
log.info('[IPC getConfig] Received request');
  return config;
});

// IPC: 获取子目录列表
// IPC: 获取模型详情
// IPC: 获取模型图片数据
// IPC: 保存配置
ipcMain.handle('save-config', async (event, newConfig) => {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    // 1. 验证和清理 newConfig (可选但推荐)
    //    - 确保 modelSources 是数组等
    //    - 移除不必要的临时字段（如果渲染进程添加了的话）

    // 2. 写入文件
    const configString = JSON.stringify(newConfig, null, 2); // Pretty print JSON
    await fs.promises.writeFile(configPath, configString, 'utf-8');
    log.info('[Main] Configuration saved successfully to:', configPath);

    // 3. 更新内存中的配置
    //    重新加载或直接赋值，确保路径处理等逻辑一致
    //    简单起见，这里直接赋值，但注意本地路径可能需要重新处理成绝对路径
    config = newConfig;
    // 确保本地路径是绝对路径 (如果 loadConfig 中的逻辑需要保持一致)
    if (Array.isArray(config.modelSources)) {
        config.modelSources.forEach(source => {
          if (source.type === 'local' && source.path && !path.isAbsolute(source.path)) {
            // 注意：这里假设路径是相对于 process.cwd()，如果保存时已经是绝对路径则不需要此步
             source.path = path.join(process.cwd(), source.path);
          }
        });
      }
    setConfig(config); // Update config manager after saving and processing
    log.info('[Config] Saved config updated in configManager');

    // 4. 更新图片缓存配置
    imageCache.setConfig(config.imageCache || {});
    log.info('[Main] Image cache configuration updated.');

    // 5. 通知所有渲染进程配置已更新 (重要!)
     BrowserWindow.getAllWindows().forEach(win => {
       win.webContents.send('config-updated');
     });
     log.info('[Main] Sent config-updated event to all windows.');


    return { success: true };
  } catch (error) {
    log.error('[Main] Failed to save configuration:', error.message, error.stack);
    // 将错误信息传递回渲染进程
    throw new Error(`Failed to save config.json: ${error.message}`);
  }
});

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
