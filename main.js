// 定义 __DEV__ 常量，用于区分开发和生产环境
const __DEV__ = process.env.IS_DEV_MODE === 'true';
const { app, BrowserWindow, ipcMain, dialog } = require('electron'); // Add dialog here
const { autoUpdater } = require('electron-updater'); // Import autoUpdater
const path = require('path');
const fs = require('fs');
const { LocalDataSource } = require('./src/data/dataSource');
const { WebDavDataSource } = require('./src/data/webdavDataSource');
const imageCache = require('./src/common/imageCache');
const os = require('os');
const crypto = require('crypto');
const log = require('electron-log');
const { parseLocalModels, parseModelDetailFromJsonContent, prepareModelDataForSaving } = require('./src/data/modelParser'); // 添加导入
const { writeModelJson } = require('./src/data/dataSourceInterface'); // <--- 导入新的接口函数

let mainWindow; // Declare mainWindow globally
let config = null;

// 加载配置文件 (异步)
async function loadConfig() {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    // 使用 fs.promises.access 检查文件是否存在
    await fs.promises.access(configPath);
    // 使用 fs.promises.readFile 读取文件
    const configData = await fs.promises.readFile(configPath, 'utf-8');
    config = JSON.parse(configData);
    // 转换本地路径为绝对路径
    if (Array.isArray(config.modelSources)) {
      config.modelSources.forEach(source => {
        if (source.type === 'local' && source.path) {
          source.path = path.isAbsolute(source.path) ? source.path : path.join(process.cwd(), source.path);
        }
      });
    }
  } catch (error) {
    // 如果文件不存在或读取/解析失败，则使用默认配置
    if (error.code === 'ENOENT') {
      log.warn('config.json 不存在，使用默认配置。');
    } else {
      log.error('加载或解析 config.json 失败:', error.message, error.stack);
    }
    config = { modelSources: [], supportedExtensions: [] };
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
  let level = 'info';
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


  app.on('activate', function () {
    log.info('[Lifecycle] 应用激活');
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // 监听保存模型请求
  ipcMain.handle('saveModel', async (event, model) => {
    log.debug('[IPC saveModel] Received model data from renderer:', JSON.stringify(model, null, 2)); // 添加详细日志，检查前端发送的数据
    log.info('[IPC] saveModel 请求', { jsonPath: model && model.jsonPath });
    try {
      if (!model.jsonPath) throw new Error('模型JSON路径不存在');
      // 1. 读取现有数据
      let existingData = {};
      try {
        const rawData = await fs.promises.readFile(model.jsonPath, 'utf-8');
        existingData = JSON.parse(rawData);
        log.debug(`[IPC saveModel] 成功读取现有模型数据: ${model.jsonPath}`);
      } catch (readError) {
        // 如果文件不存在或无法读取/解析，则从空对象开始合并
        // 但记录一个警告，因为通常文件应该存在
        if (readError.code !== 'ENOENT') {
            log.warn(`[IPC saveModel] 读取现有模型JSON失败 (${model.jsonPath}): ${readError.message}. 将创建新文件或覆盖。`);
        } else {
             log.info(`[IPC saveModel] 现有模型JSON不存在 (${model.jsonPath}). 将创建新文件。`);
        }
        existingData = {}; // 确保从空对象开始
      }

      // 2. 合并数据:
      //    - Start with the existing data from the file.
      //    - Spread the incoming 'model' object from the frontend over it.
      //    - This ensures all fields sent by the frontend (standard and extra)
      //      are included at the top level, overwriting existing values if keys match.
      // 3. 使用 modelParser 准备要写入的数据（合并和清理）
      const finalDataToSave = prepareModelDataForSaving(existingData, model);
      log.debug(`[IPC saveModel] 调用 prepareModelDataForSaving 后准备保存的数据键: ${Object.keys(finalDataToSave)}`);

      // 4. 序列化准备好的数据
      const dataToWrite = JSON.stringify(finalDataToSave, null, 2); // Pretty-print JSON
      log.debug(`[IPC saveModel] 准备写入序列化后的数据到: ${model.jsonPath}`); // Log the exact data being written (removed dataToWrite for brevity)

      // 查找对应的 sourceConfig
      const sourceConfig = (config.modelSources || []).find(s => s.id === model.sourceId);
      if (!sourceConfig) {
          log.error(`[IPC saveModel] 未找到源配置 ID: ${model.sourceId}`);
          throw new Error(`Configuration for source ID ${model.sourceId} not found.`);
      }

      // 使用新的接口函数写入，传入 sourceConfig
      await writeModelJson(sourceConfig, model, dataToWrite);
      log.info('[IPC saveModel] 模型保存成功', { sourceId: model.sourceId, jsonPath: model.jsonPath });
      return { success: true }; // Indicate success back to the renderer
    } catch (error) {
      log.error('[IPC] 保存模型失败:', error.message, error.stack, { model });
      throw error;
    }
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


// 应用初始化函数
async function initializeApp() {
  log.info('[Lifecycle] 应用初始化开始');
  await loadConfig(); // 加载配置
  createWindow(); // 创建窗口
}

app.whenReady().then(initializeApp); // 应用准备就绪后执行初始化


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

// IPC: 获取模型列表
ipcMain.handle('listModels', async (event, { sourceId, directory }) => { // 添加 directory 参数
  const source = (config.modelSources || []).find(s => s.id === sourceId);
  if (!source) return [];
  try { // 添加 try-catch 块
    if (source.type === 'local') {
      const ds = new LocalDataSource({ ...source, supportedExtensions: config.supportedExtensions });
      return await ds.listModels(directory); // 传递 directory
    } else if (source.type === 'webdav') {
      const ds = new WebDavDataSource({ ...source, supportedExtensions: config.supportedExtensions });
      return await ds.listModels(directory); // 传递 directory
    }
  } catch (error) {
    log.error(`[IPC listModels] Error listing models for source ${sourceId} in directory ${directory}:`, error.message, error.stack);
    throw error; // 将错误传递给渲染进程
  }
  return [];
});

// IPC: 获取子目录列表
ipcMain.handle('listSubdirectories', async (event, { sourceId }) => {
  const source = (config.modelSources || []).find(s => s.id === sourceId);
  if (!source) return [];
  try {
    if (source.type === 'local') {
      const ds = new LocalDataSource({ ...source, supportedExtensions: config.supportedExtensions });
      return await ds.listSubdirectories();
    } else if (source.type === 'webdav') {
      const ds = new WebDavDataSource({ ...source, supportedExtensions: config.supportedExtensions });
      return await ds.listSubdirectories();
    }
  } catch (error) {
    log.error(`[IPC listSubdirectories] Error listing subdirectories for source ${sourceId}:`, error.message, error.stack);
    throw error; // 将错误传递给渲染进程
  }
  return [];
});

// IPC: 获取模型详情
ipcMain.handle('getModelDetail', async (event, { sourceId, jsonPath }) => {
  const source = (config.modelSources || []).find(s => s.id === sourceId);
  if (!source) {
      log.warn(`[IPC getModelDetail] 未找到数据源: ${sourceId}`);
      return {};
  }
  try {
    if (source.type === 'local') {
      const ds = new LocalDataSource({ ...source, supportedExtensions: config.supportedExtensions });
      return await ds.readModelDetail(jsonPath);
    } else if (source.type === 'webdav') {
      const ds = new WebDavDataSource({ ...source, supportedExtensions: config.supportedExtensions });
      return await ds.readModelDetail(jsonPath);
    }
  } catch (error) {
    log.error(`[IPC getModelDetail] 获取模型详情失败: sourceId=${sourceId}, jsonPath=${jsonPath}`, error.message, error.stack);
    throw error; // 将错误传递给渲染进程
  }
  log.warn(`[IPC getModelDetail] 未知的数据源类型: ${source.type}`);
  return {};
});

// IPC: 获取模型图片数据
ipcMain.handle('getModelImage', async (event, { sourceId, imagePath }) => {
  const source = (config.modelSources || []).find(s => s.id === sourceId);
  if (!source) {
    log.error(`[ImageLoader] 未找到数据源: ${sourceId}`);
    return null;
  }

  try {
    // 统一缓存key生成方式：本地用绝对路径，WebDAV用原始网络路径
    const hashKey = source.type === 'local'
      ? path.resolve(imagePath)
      : imagePath.replace(/\\/g, '/').toLowerCase();
    
    log.debug('[ImageLoader] Generated hash key:', hashKey);
    if (source.type === 'webdav') {
      log.debug('[ImageLoader] WebDAV source details:', {
        url: source.url,
        imagePath: imagePath,
        sourceId: source.id
      });
    }

    // 计算缓存路径（使用hashKey而非localPath）
    const cacheDir = path.join(process.cwd(), 'cache', 'images');
    const cachePath = path.join(cacheDir,
      crypto.createHash('md5').update(hashKey).digest('hex') +
      (imageCache.config.compressFormat === 'webp' ? '.webp' : '.jpg'));

    // 1. 详细检查缓存状态
    log.debug('[ImageLoader] Checking cache at:', cachePath);
    try {
      if (fs.existsSync(cachePath)) {
        log.debug('[ImageLoader] Cache exists, reading...');
        const stats = fs.statSync(cachePath);
        log.debug(`[ImageLoader] Cache file stats: size=${stats.size} bytes, mtime=${stats.mtime}`);
        
        const data = await fs.promises.readFile(cachePath);
        log.debug('[ImageLoader] Successfully read cache file');
        return {
          path: cachePath,
          data,
          mimeType: imageCache.config.compressFormat === 'webp' ? 'image/webp' : 'image/jpeg'
        };
      } else {
        log.debug('[ImageLoader] Cache does not exist');
      }
    } catch (e) {
      log.error('[ImageLoader] Cache check error:', e.message, e.stack);
    }

    // 2. 根据类型处理图片
    let localPath, mimeType = 'image/png';
    if (source.type === 'local') {
      localPath = imagePath;
    } else if (source.type === 'webdav') {
      const ds = new WebDavDataSource({ ...source, supportedExtensions: config.supportedExtensions });
      const imageData = await ds.getImageData(imagePath);
      if (!imageData?.data) {
        log.error(`[ImageLoader] WebDAV图片下载失败: ${imagePath}`);
        return null;
      }
      
      // 临时保存WebDAV图片
      const tempDir = path.join(process.cwd(), 'cache', 'temp_images');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      localPath = path.join(tempDir, crypto.randomBytes(8).toString('hex') + '.png');
      await fs.promises.writeFile(localPath, imageData.data);
      mimeType = imageData.mimeType || 'image/png';
    }

    // 3. 压缩并缓存图片（带详细日志）
    log.debug('[ImageLoader] Calling imageCache.getCompressedImage with:', localPath);
    let compressedPath;
    try {
      compressedPath = await imageCache.getCompressedImage(localPath, hashKey);
      log.debug('[ImageLoader] Compressed image path:', compressedPath);
    } catch (e) {
      log.error('[ImageLoader] Image compression failed:', e.message, e.stack);
      compressedPath = localPath; // 降级使用原图
    }
    const data = await fs.promises.readFile(compressedPath);
    
    // 4. 清理WebDAV临时文件
    if (source.type === 'webdav' && localPath !== compressedPath) {
      fs.promises.unlink(localPath).catch(e =>
        log.error(`[ImageLoader] 临时文件清理失败: ${localPath}`, e.message, e.stack));
    }

    return {
      path: compressedPath,
      data,
      mimeType: compressedPath.endsWith('.webp') ? 'image/webp' :
               compressedPath.endsWith('.jpg') ? 'image/jpeg' : mimeType
    };
  } catch (e) {
    log.error('[ImageLoader] 图片处理流程失败:', e.message, e.stack);
    return null;
  }
});
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
