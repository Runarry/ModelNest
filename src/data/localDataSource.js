const { parseLocalModels, parseModelDetailFromJsonContent } = require('./modelParser'); // 导入新函数
const fs = require('fs');
const path = require('path');
const log = require('electron-log');
const DataSource = require('./baseDataSource'); // 导入新的基类

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
/**
   * 获取本地图片文件的 Buffer 数据和 MIME 类型。
   * @param {string} imagePath - 图片文件的完整路径。
   * @returns {Promise<object|null>} 包含 { path, data, mimeType } 的对象，或 null。
   */
  async getImageData(imagePath) {
    const startTime = Date.now();
    log.debug(`[LocalDataSource] GIF_DEBUG: 开始获取图片数据: ${imagePath}`); // GIF_DEBUG: Log input path
    if (!imagePath) {
        log.warn('[LocalDataSource] getImageData 调用时 imagePath 为空');
        return null;
    }
    try {
      // 检查文件是否存在
      await fs.promises.access(imagePath);
      // 读取文件内容
      const fileData = await fs.promises.readFile(imagePath);
      const ext = path.extname(imagePath).slice(1).toLowerCase(); // GIF_DEBUG: Get extension
      const mimeType = `image/${ext}`; // GIF_DEBUG: Generate mimeType
      log.debug(`[LocalDataSource] GIF_DEBUG: Extracted ext='${ext}', Generated mimeType='${mimeType}' for path: ${imagePath}`); // GIF_DEBUG: Log ext and mimeType
      const duration = Date.now() - startTime;
      log.debug(`[LocalDataSource] 读取本地图片成功: ${imagePath}, 大小: ${(fileData.length / 1024).toFixed(1)}KB, 耗时: ${duration}ms`);
      return {
        path: imagePath, // 虽然接口层可能不再直接用，但保留路径信息可能有用
        data: fileData,
        mimeType: mimeType
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      if (error.code === 'ENOENT') {
        log.warn(`[LocalDataSource] 获取图片数据失败 (文件不存在): ${imagePath}, 耗时: ${duration}ms`);
      } else {
        log.error(`[LocalDataSource] 获取图片数据时出错: ${imagePath}, 耗时: ${duration}ms`, error.message, error.stack);
      }
      return null; // 返回 null 表示失败
    }
  }

  /**
   * 将 JSON 字符串写入本地文件系统。
   * @param {string} filePath - 要写入的文件的完整路径。
   * @param {string} dataToWrite - 要写入的 JSON 字符串数据。
   * @returns {Promise<void>} 操作完成时解析的 Promise。
   * @throws {Error} 如果写入失败。
   */
  async writeModelJson(filePath, dataToWrite) {
    const startTime = Date.now();
    log.info(`[LocalDataSource] 开始写入模型 JSON: ${filePath}`);
     if (!filePath) {
        log.error('[LocalDataSource] writeModelJson 调用时 filePath 为空');
        throw new Error('File path cannot be empty for writing model JSON.');
    }
    if (typeof dataToWrite !== 'string') {
        log.error('[LocalDataSource] writeModelJson 调用时 dataToWrite 不是字符串');
        throw new Error('Data to write must be a string.');
    }

    try {
      // 确保目录存在
      const dirPath = path.dirname(filePath);
      try {
        await fs.promises.access(dirPath);
      } catch (accessError) {
        if (accessError.code === 'ENOENT') {
          log.info(`[LocalDataSource] 目录 ${dirPath} 不存在，正在创建...`);
          await fs.promises.mkdir(dirPath, { recursive: true });
        } else {
          log.error(`[LocalDataSource] 访问目录时出错 ${dirPath}:`, accessError);
          throw accessError; // 重新抛出访问错误
        }
      }

      // 写入文件
      await fs.promises.writeFile(filePath, dataToWrite, 'utf-8');
      const duration = Date.now() - startTime;
      log.info(`[LocalDataSource] 成功写入模型 JSON: ${filePath}, 耗时: ${duration}ms`);
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error(`[LocalDataSource] 写入模型 JSON 时出错: ${filePath}, 耗时: ${duration}ms`, error.message, error.stack);
      throw error; // 重新抛出写入错误
    }
  }

  /**
   * 检查文件是否存在。
   * @param {string} filePath - 文件的完整路径。
   * @returns {Promise<boolean>} 如果文件存在则返回 true，否则返回 false。
   */
  async fileExists(filePath) {
    const startTime = Date.now();
    log.debug(`[LocalDataSource] 检查文件是否存在: ${filePath}`);
    if (!filePath) {
        log.warn('[LocalDataSource] fileExists 调用时 filePath 为空');
        return false;
    }
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      const duration = Date.now() - startTime;
      log.debug(`[LocalDataSource] 文件存在: ${filePath}, 耗时: ${duration}ms`);
      return true;
    } catch (error) {
      const duration = Date.now() - startTime;
      if (error.code === 'ENOENT') {
        log.debug(`[LocalDataSource] 文件不存在: ${filePath}, 耗时: ${duration}ms`);
      } else {
        log.error(`[LocalDataSource] 检查文件存在性时出错: ${filePath}, 耗时: ${duration}ms`, error.message, error.stack);
      }
      return false;
    }
  }

  /**
   * 将 Buffer 数据写入本地文件系统。
   * @param {string} filePath - 要写入的文件的完整路径。
   * @param {Buffer} dataBuffer - 要写入的 Buffer 数据。
   * @returns {Promise<void>} 操作完成时解析的 Promise。
   * @throws {Error} 如果写入失败。
   */
  async writeFile(filePath, dataBuffer) {
    const startTime = Date.now();
    log.info(`[LocalDataSource] 开始写入文件: ${filePath}`);
     if (!filePath) {
        log.error('[LocalDataSource] writeFile 调用时 filePath 为空');
        throw new Error('File path cannot be empty for writing file.');
    }
    if (!Buffer.isBuffer(dataBuffer)) {
        log.error('[LocalDataSource] writeFile 调用时 dataBuffer 不是 Buffer');
        throw new Error('Data to write must be a Buffer.');
    }

    try {
      // 确保目录存在
      const dirPath = path.dirname(filePath);
      try {
        await fs.promises.access(dirPath);
      } catch (accessError) {
        if (accessError.code === 'ENOENT') {
          log.info(`[LocalDataSource] 目录 ${dirPath} 不存在，正在创建...`);
          await fs.promises.mkdir(dirPath, { recursive: true });
        } else {
          log.error(`[LocalDataSource] 访问目录时出错 ${dirPath}:`, accessError);
          throw accessError; // 重新抛出访问错误
        }
      }

      // 写入文件
      await fs.promises.writeFile(filePath, dataBuffer);
      const duration = Date.now() - startTime;
      log.info(`[LocalDataSource] 成功写入文件: ${filePath}, 大小: ${(dataBuffer.length / 1024).toFixed(1)}KB, 耗时: ${duration}ms`);
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error(`[LocalDataSource] 写入文件时出错: ${filePath}, 耗时: ${duration}ms`, error.message, error.stack);
      throw error; // 重新抛出写入错误
    }
  }
}

module.exports = {
  LocalDataSource
};