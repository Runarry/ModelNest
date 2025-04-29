const { DataSource } = require('./dataSource');
const path = require('path');
const log = require('electron-log'); // 添加 electron-log 导入

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
    const startTime = Date.now();
    await this.ensureInitialized();
    const basePath = this.config.basePath || '/'; // Use configured base path or default to root
    log.info(`[WebDavDataSource] 开始列出子目录: ${basePath}`);
    try {
      const items = await this.client.getDirectoryContents(basePath, { deep: false }); // Get only top-level items
      const subdirs = items
        .filter(item =>
          item.type === 'directory' &&
          item.basename !== '.' && // Explicitly exclude . and ..
          item.basename !== '..'
        )
        .map(item => item.basename); // Return just the directory name
      const duration = Date.now() - startTime;
      log.info(`[WebDavDataSource] 列出子目录完成: ${basePath}, 耗时: ${duration}ms, 找到 ${subdirs.length} 个子目录`);
      return subdirs;
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error(`[WebDavDataSource] 列出子目录时出错: ${basePath}, 耗时: ${duration}ms`, error.message, error.stack, error.response?.status);
      // Handle cases like 404 Not Found gracefully
      if (error.response && error.response.status === 404) {
        log.warn(`[WebDavDataSource] 列出子目录失败 (目录不存在): ${basePath}, 耗时: ${duration}ms`);
        return []; // Directory doesn't exist, return empty list
      }
      throw error; // Re-throw other errors
    }
  }

  async listModels(directory = null) { // Add directory parameter
    const startTime = Date.now();
    await this.ensureInitialized();
    const supportedExtensions = this.config.supportedExtensions || [];
    const basePath = this.config.basePath || '/'; // Use configured base path or default to root

    // Construct the starting path, ensuring correct joining with '/'
    let startPath = basePath;
    if (directory) {
      // Avoid double slashes if basePath is '/'
      startPath = basePath === '/' ? `/${directory}` : `${basePath}/${directory}`;
    }
    log.info(`[WebDavDataSource] 开始列出模型: ${startPath}`);

    let allModels = [];
    const walk = async (dir) => {
      log.debug(`[WebDavDataSource] 正在遍历 WebDAV 目录: ${dir}`);
      try {
        const items = await this.client.getDirectoryContents(dir);
        log.debug(`[WebDavDataSource] 目录 ${dir} 包含 ${items.length} 个项目`);

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
            log.debug(`[WebDavDataSource] 发现 JSON 文件: ${jsonFile.filename}`);
            try {
              const content = await this.client.getFileContents(jsonFile.filename);
              detail = JSON.parse(content.toString());
              log.debug(`[WebDavDataSource] 成功读取并解析 JSON: ${jsonFile.filename}`);
            } catch (e) {
              log.error(`[WebDavDataSource] 读取或解析 JSON 文件时出错: ${jsonFile?.filename}`, e.message, e.stack, e.response?.status);
            }
          } else {
              log.debug(`[WebDavDataSource] 模型 ${base} 未找到对应的 JSON 文件`);
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
        log.error(`[WebDavDataSource] 遍历 WebDAV 目录时出错: ${dir}`, error.message, error.stack, error.response?.status);
        // 根据错误类型决定是否继续，例如 404 可能表示目录不存在
        if (error.response && error.response.status === 404) {
            log.warn(`[WebDavDataSource] 遍历时目录不存在 (可能已被删除): ${dir}`);
        }
        // 可以选择不抛出错误，让遍历继续处理其他目录
      }
    };
    
    // Check if start path exists before walking
    try {
      log.debug(`[WebDavDataSource] 检查起始路径是否存在: ${startPath}`);
      await this.client.stat(startPath);
      log.debug(`[WebDavDataSource] 起始路径存在: ${startPath}`);
    } catch (error) {
      const duration = Date.now() - startTime;
      if (error.response && error.response.status === 404) {
        log.warn(`[WebDavDataSource] 列出模型失败 (起始目录不存在): ${startPath}, 耗时: ${duration}ms`);
        return []; // Directory doesn't exist
      }
      log.error(`[WebDavDataSource] 访问起始路径时出错: ${startPath}, 耗时: ${duration}ms`, error.message, error.stack, error.response?.status);
      throw error; // Re-throw other errors
    }

    log.debug(`[WebDavDataSource] 开始递归遍历 WebDAV 目录: ${startPath}`);
    await walk(startPath); // Start walking from the determined path
    const duration = Date.now() - startTime;
    log.info(`[WebDavDataSource] 列出模型完成: ${startPath}, 耗时: ${duration}ms, 找到 ${allModels.length} 个模型`);
    return allModels;
  }

  async readModelDetail(jsonPath) {
    const startTime = Date.now();
    await this.ensureInitialized();
    if (!jsonPath) {
      log.warn('[WebDavDataSource] readModelDetail 调用时 jsonPath 为空');
      return {};
    }
    log.debug(`[WebDavDataSource] 开始读取模型详情: ${jsonPath}`);
    try {
      const content = await this.client.getFileContents(jsonPath);
      const detail = JSON.parse(content.toString());
      const duration = Date.now() - startTime;
      log.debug(`[WebDavDataSource] 读取模型详情成功: ${jsonPath}, 耗时: ${duration}ms`);
      return detail;
    } catch (e) {
      const duration = Date.now() - startTime;
      log.error(`[WebDavDataSource] 读取模型详情时出错: ${jsonPath}, 耗时: ${duration}ms`, e.message, e.stack, e.response?.status);
      if (e.response && e.response.status === 404) {
          log.warn(`[WebDavDataSource] 读取模型详情失败 (文件不存在): ${jsonPath}, 耗时: ${duration}ms`);
      }
      return {};
    }
  }

  async getImageData(imagePath) {
    const startTime = Date.now();
    await this.ensureInitialized();
    if (!imagePath) {
      log.warn('[WebDavDataSource] getImageData 调用时 imagePath 为空');
      return null;
    }
    log.debug(`[WebDavDataSource] 开始获取图片数据: ${imagePath}`);
    try {
      const content = await this.client.getFileContents(imagePath);
      const duration = Date.now() - startTime;
      log.debug(`[WebDavDataSource] 获取图片数据成功: ${imagePath}, 大小: ${content.length} bytes, 耗时: ${duration}ms`);
      return {
        path: imagePath,
        data: content,
        mimeType: 'image/png' // TODO: Consider determining mime type from response headers if available
      };
    } catch (e) {
      const duration = Date.now() - startTime;
      log.error(`[WebDavDataSource] 获取图片数据时出错: ${imagePath}, 耗时: ${duration}ms`, e.message, e.stack, e.response?.status);
       if (e.response && e.response.status === 404) {
          log.warn(`[WebDavDataSource] 获取图片数据失败 (文件不存在): ${imagePath}, 耗时: ${duration}ms`);
      }
      return null;
    }
  }
}

module.exports = {
  WebDavDataSource
};