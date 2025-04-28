const { app, BrowserWindow, ipcMain, dialog } = require('electron'); // Add dialog here
const { autoUpdater } = require('electron-updater'); // Import autoUpdater
const path = require('path');
const fs = require('fs');
const { LocalDataSource } = require('./src/data/dataSource');
const { WebDavDataSource } = require('./src/data/webdavDataSource');
const imageCache = require('./src/common/imageCache');
const os = require('os');
const crypto = require('crypto');

let mainWindow; // Declare mainWindow globally
let config = null;

// 加载配置文件 (异步)
async function loadConfig() {
  const configPath = path.join(process.cwd(), 'config.json');
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
      console.log('config.json 不存在，使用默认配置。');
    } else {
      console.error('加载或解析 config.json 失败:', error);
    }
    config = { modelSources: [], supportedExtensions: [] };
  }
}

// 创建主窗口
function createWindow() {
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
  mainWindow.webContents.openDevTools();
}

app.whenReady().then(async () => { // 改为 async 回调
  await loadConfig(); // 等待配置加载完成

  // 配置加载完成后再设置 imageCache
  if (config && config.imageCache) {
    imageCache.setConfig(config.imageCache);
  } else {
    imageCache.setConfig({});
  }

  createWindow();

  // --- Electron Updater Logic ---
  console.log('[Updater] Initializing...');

  // Optional: Configure logging
  autoUpdater.logger = require("electron-log");
  autoUpdater.logger.transports.file.level = "info";
  console.log('[Updater] Logger configured.');

  // Helper function to send status to renderer
  const sendUpdateStatus = (status, ...args) => {
    if (mainWindow && mainWindow.webContents) {
      console.log(`[Updater] Sending status to renderer: ${status}`, args);
      mainWindow.webContents.send('updater.onUpdateStatus', status, ...args);
    } else {
      console.warn('[Updater] Cannot send status, mainWindow is not available.');
    }
  };

  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus('checking');
  });
  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus('available', info);
  });
  autoUpdater.on('update-not-available', (info) => {
    sendUpdateStatus('not-available', info);
  });
  autoUpdater.on('error', (err) => {
    sendUpdateStatus('error', err.message);
    console.error('[Updater] Update error:', err);
  });
  autoUpdater.on('download-progress', (progressObj) => {
    sendUpdateStatus('downloading', progressObj);
  });
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus('downloaded', info);
    // Optional: Prompt user to restart, or rely on manual trigger from renderer
    // dialog.showMessageBox({
    //   type: 'info',
    //   title: '发现新版本',
    //   message: '已下载新版本，是否立即重启并安装？',
    //   buttons: ['立即重启', '稍后重启']
    // }).then(({ response }) => {
    //   if (response === 0) {
    //     autoUpdater.quitAndInstall();
    //   }
    // });
  });

  // Check for updates after a delay (e.g., 3 seconds)
  setTimeout(() => {
    console.log('[Updater] Checking for updates and notifying...');
    autoUpdater.checkForUpdatesAndNotify().catch(err => {
      console.error('[Updater] checkForUpdatesAndNotify error:', err);
      // Optionally send an error status if check fails immediately
      sendUpdateStatus('error', `自动检查更新失败: ${err.message}`);
    });
  }, 3000);

  console.log('[Updater] Initialization complete.');
// --- Updater IPC Handlers ---
  ipcMain.handle('updater.checkForUpdate', async () => {
    console.log('[Updater IPC] Received checkForUpdate request.');
    try {
      sendUpdateStatus('checking'); // Notify renderer immediately
      const result = await autoUpdater.checkForUpdates();
      console.log('[Updater IPC] checkForUpdates result:', result);
      // Note: The actual status updates are sent via the event listeners above.
      // This handler primarily triggers the check. We might return the result if needed.
      return result; // Contains updateInfo and cancellationToken
    } catch (error) {
      console.error('[Updater IPC] Error during checkForUpdates:', error);
      sendUpdateStatus('error', `手动检查更新失败: ${error.message}`); // Send error status
      throw error; // Re-throw error to be caught by invoke in renderer
    }
  });

  ipcMain.handle('updater.quitAndInstall', () => {
    console.log('[Updater IPC] Received quitAndInstall request.');
    try {
      autoUpdater.quitAndInstall();
    } catch (error) {
      console.error('[Updater IPC] Error during quitAndInstall:', error);
      // It might be too late to send IPC messages here if quitting fails early
    }
  });
  // --- End Updater IPC Handlers ---
  // --- End Electron Updater Logic ---


  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // 监听保存模型请求
  ipcMain.handle('saveModel', async (event, model) => {
    try {
      if (!model.jsonPath) throw new Error('模型JSON路径不存在');
      // 合并必要字段和extra字段
      const saveData = Object.assign({}, model.extra || {}, {
        modelType: model.type,
        description: model.description,
        triggerWord: model.triggerWord
      });
      const data = JSON.stringify(saveData, null, 2);
      await fs.promises.writeFile(model.jsonPath, data, 'utf-8');
      return { success: true };
    } catch (error) {
      console.error('保存模型失败:', error);
      throw error;
    }
  });
});



app.on('window-all-closed', async function () {
  if (process.platform !== 'darwin') {
    try {
      // 清理图片缓存
      await imageCache.clearCache();

      // 清理WebDAV下载缓存目录
      const webdavCacheDir = path.join(process.cwd(), 'cache', 'webdav_images');
      if (fs.existsSync(webdavCacheDir)) {
        const files = await fs.promises.readdir(webdavCacheDir);
        await Promise.all(files.map(file => fs.promises.unlink(path.join(webdavCacheDir, file))));
        console.log(`[Main] 清理WebDAV下载缓存目录: ${webdavCacheDir}, 删除文件数: ${files.length}`);
      }
    } catch (e) {
      console.error('[Main] 清理缓存失败:', e);
    }
    app.quit();
  }
});

 // IPC: 获取配置
ipcMain.handle('getConfig', async () => {
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
    console.error(`[IPC listModels] Error listing models for source ${sourceId} in directory ${directory}:`, error);
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
    console.error(`[IPC listSubdirectories] Error listing subdirectories for source ${sourceId}:`, error);
    throw error; // 将错误传递给渲染进程
  }
  return [];
});

// IPC: 获取模型详情
ipcMain.handle('getModelDetail', async (event, { sourceId, jsonPath }) => {
  const source = (config.modelSources || []).find(s => s.id === sourceId);
  if (!source) return {};
  if (source.type === 'local') {
    const ds = new LocalDataSource({ ...source, supportedExtensions: config.supportedExtensions });
    return await ds.readModelDetail(jsonPath);
  } else if (source.type === 'webdav') {
    const ds = new WebDavDataSource({ ...source, supportedExtensions: config.supportedExtensions });
    return await ds.readModelDetail(jsonPath);
  }
  return {};
});

// IPC: 获取模型图片数据
ipcMain.handle('getModelImage', async (event, { sourceId, imagePath }) => {
  const source = (config.modelSources || []).find(s => s.id === sourceId);
  if (!source) {
    console.error(`[ImageLoader] 未找到数据源: ${sourceId}`);
    return null;
  }

  try {
    // 统一缓存key生成方式：本地用绝对路径，WebDAV用原始网络路径
    const hashKey = source.type === 'local'
      ? path.resolve(imagePath)
      : imagePath.replace(/\\/g, '/').toLowerCase();
    
    console.log('[ImageLoader] Generated hash key:', hashKey);
    if (source.type === 'webdav') {
      console.log('[ImageLoader] WebDAV source details:', {
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
    console.log('[ImageLoader] Checking cache at:', cachePath);
    try {
      if (fs.existsSync(cachePath)) {
        console.log('[ImageLoader] Cache exists, reading...');
        const stats = fs.statSync(cachePath);
        console.log(`[ImageLoader] Cache file stats: size=${stats.size} bytes, mtime=${stats.mtime}`);
        
        const data = await fs.promises.readFile(cachePath);
        console.log('[ImageLoader] Successfully read cache file');
        return {
          path: cachePath,
          data,
          mimeType: imageCache.config.compressFormat === 'webp' ? 'image/webp' : 'image/jpeg'
        };
      } else {
        console.log('[ImageLoader] Cache does not exist');
      }
    } catch (e) {
      console.error('[ImageLoader] Cache check error:', e);
    }

    // 2. 根据类型处理图片
    let localPath, mimeType = 'image/png';
    if (source.type === 'local') {
      localPath = imagePath;
    } else if (source.type === 'webdav') {
      const ds = new WebDavDataSource({ ...source, supportedExtensions: config.supportedExtensions });
      const imageData = await ds.getImageData(imagePath);
      if (!imageData?.data) {
        console.error(`[ImageLoader] WebDAV图片下载失败: ${imagePath}`);
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
    console.log('[ImageLoader] Calling imageCache.getCompressedImage with:', localPath);
    let compressedPath;
    try {
      compressedPath = await imageCache.getCompressedImage(localPath, hashKey);
      console.log('[ImageLoader] Compressed image path:', compressedPath);
    } catch (e) {
      console.error('[ImageLoader] Image compression failed:', e);
      compressedPath = localPath; // 降级使用原图
    }
    const data = await fs.promises.readFile(compressedPath);
    
    // 4. 清理WebDAV临时文件
    if (source.type === 'webdav' && localPath !== compressedPath) {
      fs.promises.unlink(localPath).catch(e =>
        console.error(`[ImageLoader] 临时文件清理失败: ${localPath}`, e));
    }

    return {
      path: compressedPath,
      data,
      mimeType: compressedPath.endsWith('.webp') ? 'image/webp' :
               compressedPath.endsWith('.jpg') ? 'image/jpeg' : mimeType
    };
  } catch (e) {
    console.error('[ImageLoader] 图片处理流程失败:', e);
    return null;
  }
});
// IPC: 保存配置
ipcMain.handle('save-config', async (event, newConfig) => {
  const configPath = path.join(process.cwd(), 'config.json');
  try {
    // 1. 验证和清理 newConfig (可选但推荐)
    //    - 确保 modelSources 是数组等
    //    - 移除不必要的临时字段（如果渲染进程添加了的话）

    // 2. 写入文件
    const configString = JSON.stringify(newConfig, null, 2); // Pretty print JSON
    await fs.promises.writeFile(configPath, configString, 'utf-8');
    console.log('[Main] Configuration saved successfully to:', configPath);

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
    console.log('[Main] Image cache configuration updated.');

    // 5. 通知所有渲染进程配置已更新 (重要!)
     BrowserWindow.getAllWindows().forEach(win => {
       win.webContents.send('config-updated');
     });
     console.log('[Main] Sent config-updated event to all windows.');


    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to save configuration:', error);
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
    console.log('[Main] Folder selection cancelled.');
    return null;
  } else {
    console.log('[Main] Folder selected:', result.filePaths[0]);
    return result.filePaths[0];
  }
});
