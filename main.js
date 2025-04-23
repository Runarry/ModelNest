const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { LocalDataSource } = require('./src/data/dataSource');
const { WebDavDataSource } = require('./src/data/webdavDataSource');

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

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

 // IPC: 获取配置
ipcMain.handle('getConfig', async () => {
  return config;
});

// IPC: 获取模型列表
ipcMain.handle('listModels', async (event, { sourceId }) => {
  const source = (config.modelSources || []).find(s => s.id === sourceId);
  if (!source) return [];
  if (source.type === 'local') {
    const ds = new LocalDataSource({ ...source, supportedExtensions: config.supportedExtensions });
    return await ds.listModels();
  } else if (source.type === 'webdav') {
    const ds = new WebDavDataSource({ ...source, supportedExtensions: config.supportedExtensions });
    return await ds.listModels();
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
  if (!source) return null;
  if (source.type === 'local') {
    try {
      const data = await fs.promises.readFile(imagePath);
      return {
        path: imagePath,
        data: data,
        mimeType: 'image/png'
      };
    } catch (e) {
      console.error('读取本地图片失败:', e);
      return null;
    }
  } else if (source.type === 'webdav') {
    const ds = new WebDavDataSource({ ...source, supportedExtensions: config.supportedExtensions });
    return await ds.getImageData(imagePath);
  }
  return null;
});