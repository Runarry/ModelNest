const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { LocalDataSource } = require('./src/data/dataSource');
const { WebDavDataSource } = require('./src/data/webdavDataSource');
const imageCache = require('./src/common/imageCache');
const os = require('os');
const crypto = require('crypto');

let config = null;

// 加载配置文件
function loadConfig() {
  const configPath = path.join(process.cwd(), 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      // 转换本地路径为绝对路径
      if (Array.isArray(config.modelSources)) {
        config.modelSources.forEach(source => {
          if (source.type === 'local' && source.path) {
            source.path = path.isAbsolute(source.path) ? source.path : path.join(process.cwd(), source.path);
          }
        });
      }
    } else {
      config = { modelSources: [], supportedExtensions: [] };
    }
  } catch (error) {
    console.error('加载或解析 config.json 失败:', error);
    config = { modelSources: [], supportedExtensions: [] };
  }
}
if (config && config.imageCache) {
  imageCache.setConfig(config.imageCache);
} else {
  imageCache.setConfig({});
}

// 创建主窗口
function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'src/renderer/index.html'));
  win.webContents.openDevTools();
}

app.whenReady().then(() => {
  loadConfig();
  createWindow();

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