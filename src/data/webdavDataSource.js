const { DataSource } = require('./dataSource');
const path = require('path');

class WebDavDataSource extends DataSource {
  constructor(config) {
    super(config);
    this.initialized = this.initClient(config);
  }

  async initClient(config) {
    const { createClient } = await import('webdav');
    this.client = createClient(
      config.url,
      {
        username: config.username,
        password: config.password
      }
    );
  }

  async ensureInitialized() {
    await this.initialized;
  }

  async listModels() {
    await this.ensureInitialized();
    const supportedExtensions = this.config.supportedExtensions || [];
    console.log('[WebDavDataSource] Listing models from:', this.config.url);
    
    let allModels = [];
    const walk = async (dir) => {
      try {
        const items = await this.client.getDirectoryContents(dir);
        console.log(`[WebDavDataSource] Found ${items.length} items in ${dir}`);
        
        // 获取当前目录下的模型文件
        const modelFiles = items.filter(item =>
          !item.filename.endsWith('/') &&
          supportedExtensions.some(ext => item.filename.endsWith(ext)));
        
        // 处理每个模型文件
        for (const modelFile of modelFiles) {
          const base = path.basename(modelFile.filename, path.extname(modelFile.filename));
          
          // 查找同名图片和json
          const image = items.find(f =>
            !f.filename.endsWith('/') &&
            (f.filename.endsWith(`${base}.png`) || f.filename.endsWith(`${base}_v2.0.png`)));
          const jsonFile = items.find(f =>
            !f.filename.endsWith('/') &&
            f.filename.endsWith(`${base}.json`));
          
          // 读取json详情
          let detail = {};
          if (jsonFile) {
            try {
              const content = await this.client.getFileContents(jsonFile.filename);
              detail = JSON.parse(content.toString());
            } catch (e) {
              console.error(`[WebDavDataSource] Error reading json ${jsonFile.filename}:`, e);
            }
          }
          
          const modelObj = {
            name: base,
            type: detail.modelType || path.extname(modelFile.filename).replace('.', '').toUpperCase(),
            description: detail.description || '',
            image: image ? image.filename : '',
            file: modelFile.filename,
            jsonPath: jsonFile ? jsonFile.filename : '',
            triggerWord: detail.triggerWord || '',
            size: modelFile.size,
            lastModified: new Date(modelFile.lastmod),
            extra: detail
          };
          console.log('[WebDavDataSource] Found model:', modelObj);
          allModels.push(modelObj);
        }
        
        // 递归处理子目录
        const subDirs = items.filter(item =>
          item.type === 'directory' &&
          !item.filename.endsWith('/.') &&
          !item.filename.endsWith('/..'));
        for (const dir of subDirs) {
          await walk(dir.filename);
        }
      } catch (error) {
        console.error(`[WebDavDataSource] Error walking directory ${dir}:`, error);
      }
    };
    
    await walk('/');
    return allModels;
  }

  async readModelDetail(jsonPath) {
    await this.ensureInitialized();
    if (!jsonPath) {
      console.log('[WebDavDataSource] No jsonPath provided');
      return {};
    }
    
    try {
      console.log('[WebDavDataSource] Reading model detail from:', jsonPath);
      const content = await this.client.getFileContents(jsonPath);
      const detail = JSON.parse(content.toString());
      console.log('[WebDavDataSource] Model detail:', detail);
      return detail;
    } catch (e) {
      console.error('[WebDavDataSource] Error reading model detail:', e);
      return {};
    }
  }

  async getImageData(imagePath) {
    await this.ensureInitialized();
    if (!imagePath) {
      console.log('[WebDavDataSource] No imagePath provided');
      return null;
    }
    
    try {
      console.log('[WebDavDataSource] Reading image from:', imagePath);
      const content = await this.client.getFileContents(imagePath);
      return {
        path: imagePath,
        data: content,
        mimeType: 'image/png'
      };
    } catch (e) {
      console.error('[WebDavDataSource] Error reading image:', e);
      return null;
    }
  }
}

module.exports = {
  WebDavDataSource
};