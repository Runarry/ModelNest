const { parseLocalModels } = require('./modelParser');
const fs = require('fs');
const path = require('path');
const log = require('electron-log');

// 数据源抽象与实现

class DataSource {
  constructor(config) {
    this.config = config;
  }
  async listModels(directory = null) { // 添加 directory 参数
    throw new Error('listModels 未实现');
  }
  async readModelDetail(jsonPath) {
    throw new Error('readModelDetail 未实现');
  }
  async listSubdirectories() { // 添加 listSubdirectories 接口
    throw new Error('listSubdirectories 未实现');
  }
}

// 本地数据源实现
class LocalDataSource extends DataSource {
  constructor(config) {
    super(config);
  }
  async listSubdirectories() {
    const root = this.config.path;
    try {
      // Check existence using access
      await fs.promises.access(root);
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch (error) {
      // If directory doesn't exist (ENOENT), return empty array, otherwise log error
      if (error.code === 'ENOENT') {
        return [];
      }
      log.error(`[LocalDataSource] Error reading subdirectories in ${root}:`, error.message, error.stack);
      return [];
    }
  }

  async listModels(directory = null) { // 添加 directory 参数
    const root = this.config.path;
    const startPath = directory ? path.join(root, directory) : root; // 确定起始路径
    const supportedExtensions = this.config.supportedExtensions || [];

    try {
      // Check existence using access
      await fs.promises.access(startPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        log.warn(`[LocalDataSource] Directory not found: ${startPath}`);
        return [];
      }
      log.error(`[LocalDataSource] Error accessing directory ${startPath}:`, error.message, error.stack);
      return []; // Return empty on other access errors too
    }

    let allModels = [];
    // Make walk async
    const walk = async (dir) => {
      try {
        // Use async readdir
        const files = await fs.promises.readdir(dir, { withFileTypes: true });
        // Assuming parseLocalModels remains synchronous. If it becomes async, add await.
        const modelObjs = parseLocalModels(dir, supportedExtensions);
        allModels = allModels.concat(modelObjs);

        // Use for...of loop for async iteration
        for (const f of files) {
          if (f.isDirectory()) {
            // Await the recursive call
            await walk(path.join(dir, f.name));
          }
        }
      } catch (error) {
        // Handle errors, especially ENOENT (directory not found) which might occur
        // if a directory is deleted between readdir and the recursive walk call.
        if (error.code !== 'ENOENT') { // Ignore 'Not Found' errors if desired, or handle specifically
            log.error(`[LocalDataSource] Error walking directory ${dir}:`, error.message, error.stack);
        }
        // Continue walking other directories even if one fails
      }
    };

    log.debug(`[LocalDataSource] 开始遍历模型目录: ${startPath}`);
    await walk(startPath); // Await the initial call
    log.debug(`[LocalDataSource] 遍历完成，模型数量: ${allModels.length}`);
    return allModels;
  }
  async readModelDetail(jsonPath) {
    if (!jsonPath) return {};
    try {
      // Check existence using access before reading
      await fs.promises.access(jsonPath);
      const data = await fs.promises.readFile(jsonPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      // If file doesn't exist (ENOENT) or cannot be accessed, return empty object
      if (error.code === 'ENOENT') {
        // Optional: Log a warning if the file is expected but not found
        // console.warn(`[LocalDataSource] Model detail file not found: ${jsonPath}`);
        return {};
      }
      // Log other errors (parsing errors, permission errors, etc.)
      log.error(`[LocalDataSource] Error reading model detail ${jsonPath}:`, error.message, error.stack);
      return {};
    }
  }
}

module.exports = {
  DataSource,
  LocalDataSource
};