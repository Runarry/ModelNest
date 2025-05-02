const { parseLocalModels, parseModelDetailFromJsonContent } = require('./modelParser'); // 导入新函数
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
    const startTime = Date.now();
    const root = this.config.path;
    log.info(`[LocalDataSource] 开始列出子目录: ${root}`);
    try {
      // Check existence using access
      await fs.promises.access(root);
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      const duration = Date.now() - startTime;
      log.info(`[LocalDataSource] 列出子目录完成: ${root}, 耗时: ${duration}ms, 找到 ${entries.filter(e => e.isDirectory()).length} 个子目录`);
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);

    } catch (error) {
      const duration = Date.now() - startTime;
      // If directory doesn't exist (ENOENT), return empty array, otherwise log error
      if (error.code === 'ENOENT') {
        log.warn(`[LocalDataSource] 列出子目录失败 (目录不存在): ${root}, 耗时: ${duration}ms`);
        return [];
      }
      log.error(`[LocalDataSource] 列出子目录时出错: ${root}, 耗时: ${duration}ms`, error.message, error.stack);
      return [];
    }
  }

  async listModels(directory = null, supportedExts = []) { // 添加 supportedExts 参数
    const startTime = Date.now();
    const root = this.config.path;
    const startPath = directory ? path.join(root, directory) : root; // 确定起始路径
    // 不再从 config 读取，直接使用传入的 supportedExts
    // const supportedExtensions = this.config.supportedExtensions || [];
    log.info(`[LocalDataSource] 开始列出模型. Root: ${root}, Directory: ${directory}, Calculated startPath: ${startPath}, SupportedExts: ${supportedExts}`); // 修改日志，添加 supportedExts

    try {
      // Check existence using access
      await fs.promises.access(startPath);
    } catch (error) {
      const duration = Date.now() - startTime;
      if (error.code === 'ENOENT') {
        log.warn(`[LocalDataSource] 列出模型失败 (目录不存在): ${startPath}, 耗时: ${duration}ms`);
        return [];
      }
      log.error(`[LocalDataSource] 访问模型目录时出错: ${startPath}, 耗时: ${duration}ms`, error.message, error.stack);
      return []; // Return empty on other access errors too
    }

    let allModels = [];
    // Make walk async, pass supportedExts explicitly
    const walk = async (dir, currentSupportedExts) => { // 参数名改为 currentSupportedExts 避免遮蔽
      try {
        // Use async readdir
        const files = await fs.promises.readdir(dir, { withFileTypes: true });
        // Assuming parseLocalModels remains synchronous. If it becomes async, add await.
        const modelObjs = await parseLocalModels(dir, currentSupportedExts); // 使用传入的 currentSupportedExts
        allModels = allModels.concat(modelObjs);

        // Use for...of loop for async iteration
        for (const f of files) {
          if (f.isDirectory()) {
            // Await the recursive call, passing currentSupportedExts
            await walk(path.join(dir, f.name), currentSupportedExts); // 传递 currentSupportedExts
          }
        }
      } catch (error) {
        // Handle errors, especially ENOENT (directory not found) which might occur
        // if a directory is deleted between readdir and the recursive walk call.
        if (error.code === 'ENOENT') {
             log.warn(`[LocalDataSource] 遍历时目录不存在 (可能已被删除): ${dir}`);
        } else {
             log.error(`[LocalDataSource] 遍历目录时出错: ${dir}`, error.message, error.stack);
        }
        // Continue walking other directories even if one fails
      }
    };

    log.debug(`[LocalDataSource] 开始递归遍历模型目录: ${startPath} with exts: ${supportedExts}`);
    await walk(startPath, supportedExts); // 在初始调用时传递 supportedExts
    const duration = Date.now() - startTime;
    log.info(`[LocalDataSource] 列出模型完成: ${startPath}, 耗时: ${duration}ms, 找到 ${allModels.length} 个模型`);
    return allModels;
  }
  async readModelDetail(jsonPath) {
    const startTime = Date.now();
    if (!jsonPath) {
        log.warn('[LocalDataSource] readModelDetail 调用时 jsonPath 为空');
        return {};
    }
    log.debug(`[LocalDataSource] 开始读取模型详情: ${jsonPath}`);
    try {
      // Check existence using access before reading
      await fs.promises.access(jsonPath);
      const jsonContent = await fs.promises.readFile(jsonPath, 'utf-8');
      const detail = parseModelDetailFromJsonContent(jsonContent, jsonPath); // 使用新函数解析
      const duration = Date.now() - startTime;
      // 日志级别调整为 debug，因为成功读取不一定是 info 级别事件
      log.debug(`[LocalDataSource] 读取并解析模型详情成功: ${jsonPath}, 耗时: ${duration}ms`);
      return detail;
    } catch (error) {
      const duration = Date.now() - startTime;
      // If file doesn't exist (ENOENT) or cannot be accessed, return empty object
      if (error.code === 'ENOENT') {
        log.warn(`[LocalDataSource] 读取模型详情失败 (文件不存在): ${jsonPath}, 耗时: ${duration}ms`);
        return {};
      }
      // Log other errors (parsing errors, permission errors, etc.)
      log.error(`[LocalDataSource] 读取模型详情时出错: ${jsonPath}, 耗时: ${duration}ms`, error.message, error.stack);
      return {};
    }
  }
}

module.exports = {
  DataSource,
  LocalDataSource
};