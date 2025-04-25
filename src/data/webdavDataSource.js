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

  async listSubdirectories() {
    await this.ensureInitialized();
    const basePath = this.config.basePath || '/'; // Use configured base path or default to root
    try {
      const items = await this.client.getDirectoryContents(basePath, { deep: false }); // Get only top-level items
      return items
        .filter(item =>
          item.type === 'directory' &&
          item.basename !== '.' && // Explicitly exclude . and ..
          item.basename !== '..'
        )
        .map(item => item.basename); // Return just the directory name
    } catch (error) {
      console.error(`[WebDavDataSource] Error listing subdirectories in ${basePath}:`, error);
      // Handle cases like 404 Not Found gracefully
      if (error.response && error.response.status === 404) {
        return []; // Directory doesn't exist, return empty list
      }
      throw error; // Re-throw other errors
    }
  }

  async listModels(directory = null) { // Add directory parameter
    await this.ensureInitialized();
    const supportedExtensions = this.config.supportedExtensions || [];
    const basePath = this.config.basePath || '/'; // Use configured base path or default to root

    // Construct the starting path, ensuring correct joining with '/'
    let startPath = basePath;
    if (directory) {
      // Avoid double slashes if basePath is '/'
      startPath = basePath === '/' ? `/${directory}` : `${basePath}/${directory}`;
    }

    let allModels = [];
    const walk = async (dir) => {
      try {
        const items = await this.client.getDirectoryContents(dir);

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
            (f.filename.endsWith(`${base}.png`) || f.filename.endsWith(`${base}.jpg`)|| f.filename.endsWith(`${base}.jpeg`)));
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
    
    // Check if start path exists before walking
    try {
      await this.client.stat(startPath);
    } catch (error) {
      if (error.response && error.response.status === 404) {
        console.warn(`[WebDavDataSource] Directory not found: ${startPath}`);
        return []; // Directory doesn't exist
      }
      console.error(`[WebDavDataSource] Error accessing start path ${startPath}:`, error);
      throw error; // Re-throw other errors
    }

    await walk(startPath); // Start walking from the determined path
    return allModels;
  }

  async readModelDetail(jsonPath) {
    await this.ensureInitialized();
    if (!jsonPath) {
      return {};
    }
    
    try {
      const content = await this.client.getFileContents(jsonPath);
      const detail = JSON.parse(content.toString());
      return detail;
    } catch (e) {
      console.error('[WebDavDataSource] Error reading model detail:', e);
      return {};
    }
  }

  async getImageData(imagePath) {
    await this.ensureInitialized();
    if (!imagePath) {
      return null;
    }
    
    try {
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