const { parseLocalModels, parseModelDetailFromJsonContent, parseSingleModelFile } = require('./modelParser'); // 导入新函数及 parseSingleModelFile
const fs = require('fs');
const path = require('path');
const log = require('electron-log');
const crypto = require('crypto'); // 引入 crypto 模块
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

  async listModels(directory = null, sourceConfig, supportedExts = [], showSubdirectory = true) {
    const startTime = Date.now();
    const root = this.config.path; // Root path for this data source instance
    const startPath = directory ? path.join(root, directory) : root;
    log.info(`[LocalDataSource] 开始列出模型. Root: ${root}, Directory: ${directory}, StartPath: ${startPath}, SourceId: ${sourceConfig ? sourceConfig.id : 'N/A'}, SupportedExts: ${Array.isArray(supportedExts) ? supportedExts.join(',') : ''}, ShowSubDir: ${showSubdirectory}`);

    try {
      await fs.promises.access(startPath);
    } catch (error) {
      const duration = Date.now() - startTime;
      if (error.code === 'ENOENT') {
        log.warn(`[LocalDataSource] 列出模型失败 (目录不存在): ${startPath}, 耗时: ${duration}ms`);
        return [];
      }
      log.error(`[LocalDataSource] 访问模型目录时出错: ${startPath}, 耗时: ${duration}ms`, error.message, error.stack);
      return [];
    }

    let allModels = [];
    const walk = async (dir, currentSourceConfig, currentSupportedExts, currentShowSubdirectory) => {
      try {
        const files = await fs.promises.readdir(dir, { withFileTypes: true });
        // Call parseLocalModels, passing sourceConfig
        // parseLocalModels now needs sourceConfig to get sourceId
        const modelObjs = await parseLocalModels(dir, currentSupportedExts, currentSourceConfig);
        allModels = allModels.concat(modelObjs);

        if (currentShowSubdirectory) { // Control recursion based on showSubdirectory
          for (const f of files) {
            if (f.isDirectory()) {
              // Pass all relevant parameters in recursive call
              await walk(path.join(dir, f.name), currentSourceConfig, currentSupportedExts, currentShowSubdirectory);
            }
          }
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
             log.warn(`[LocalDataSource] 遍历时目录不存在 (可能已被删除): ${dir}`);
        } else {
             log.error(`[LocalDataSource] 遍历目录时出错: ${dir}`, error.message, error.stack);
        }
      }
    };

    log.debug(`[LocalDataSource] 开始递归遍历模型目录: ${startPath} with exts: ${Array.isArray(supportedExts) ? supportedExts.join(',') : ''}, showSubDir: ${showSubdirectory}`);
    // Initial call to walk, passing all necessary parameters
    await walk(startPath, sourceConfig, supportedExts, showSubdirectory);
    const duration = Date.now() - startTime;
    log.info(`[LocalDataSource] 列出模型完成: ${startPath}, 耗时: ${duration}ms, 找到 ${allModels.length} 个模型`);
    return allModels;
  }
  async readModelDetail(jsonPath, modelFilePath, sourceId) {
    const startTime = Date.now();
    // Log entry with all original parameters for context.
    // jsonPath is kept for interface compatibility and logging, though not directly used by parseSingleModelFile.
    log.debug(`[LocalDataSource readModelDetail] Entry. jsonPath: ${jsonPath}, modelFilePath: ${modelFilePath}, sourceId: ${sourceId}`);

    if (!modelFilePath) {
        log.warn(`[LocalDataSource readModelDetail] Called with empty modelFilePath.`);
        const duration = Date.now() - startTime;
        log.debug(`[LocalDataSource readModelDetail] Exiting due to empty modelFilePath. 耗时: ${duration}ms`);
        return {}; // Consistent with original error return
    }
    if (!sourceId) {
        log.warn(`[LocalDataSource readModelDetail] Called with empty sourceId for modelFilePath: ${modelFilePath}.`);
        const duration = Date.now() - startTime;
        log.debug(`[LocalDataSource readModelDetail] Exiting due to empty sourceId. 耗时: ${duration}ms`);
        return {}; // Consistent with original error return
    }


    try {
      const sourceConfigForParser = { id: sourceId };
      
      log.debug(`[LocalDataSource readModelDetail] Calling parseSingleModelFile with modelFilePath: "${modelFilePath}", supportedExts: ${JSON.stringify(this.config.supportedExts)}, sourceConfig: ${JSON.stringify(sourceConfigForParser)}`);

      // Call parseSingleModelFile from modelParser.js
      // It expects: modelFullPath, supportedExtensions, sourceConfig
      const modelDetail = await parseSingleModelFile(
        modelFilePath,
        [],
        sourceConfigForParser,
        true
      );

      const duration = Date.now() - startTime;
      if (modelDetail) {
        // parseSingleModelFile logs its own success/failure details internally.
        log.debug(`[LocalDataSource readModelDetail] Successfully processed model detail for: "${modelFilePath}" using parseSingleModelFile. 耗时: ${duration}ms. Result keys: ${Object.keys(modelDetail).join(', ')}`);
        return modelDetail;
      } else {
        // parseSingleModelFile returned null, indicating an issue (e.g., file not found, unsupported extension, read error).
        // parseSingleModelFile should have logged the specific reason.
        log.warn(`[LocalDataSource readModelDetail] parseSingleModelFile returned null for: "${modelFilePath}". Check modelParser logs for details. 耗时: ${duration}ms`);
        return {}; // Consistent with original error return, callers might expect an object.
      }
    } catch (error) {
      // This catch block is for unexpected errors *from the call to parseSingleModelFile* itself,
      // or from the surrounding logic in readModelDetail if any.
      // parseSingleModelFile is designed to catch its internal errors and return null.
      const duration = Date.now() - startTime;
      log.error(`[LocalDataSource readModelDetail] Unexpected error processing model detail for: "${modelFilePath}". 耗时: ${duration}ms`, error.message, error.stack);
      return {}; // Consistent error return
    }
  }
/**
   * 获取本地图片文件的 Buffer 数据和 MIME 类型。
   * @param {string} imagePath - 图片文件的完整路径。
   * @returns {Promise<object|null>} 包含 { path, data, mimeType } 的对象，或 null。
   */
  async getImageData(imagePath) {
    const startTime = Date.now();
    log.debug(`[LocalDataSource] 开始获取图片数据: ${imagePath}`);
    if (!imagePath) {
        log.warn('[LocalDataSource] getImageData 调用时 imagePath 为空');
        return null;
    }
    try {
      // 检查文件是否存在
      await fs.promises.access(imagePath);
      // 读取文件内容
      const fileData = await fs.promises.readFile(imagePath);
      const mimeType = `image/${path.extname(imagePath).slice(1).toLowerCase()}`;
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
  async writeModelJson(filePath, dataToWrite) { // dataToWrite is now a JSON string
    const startTime = Date.now();
    log.info(`[LocalDataSource] 开始写入模型 JSON: ${filePath}`);
     if (!filePath) {
        log.error('[LocalDataSource] writeModelJson 调用时 filePath 为空');
        throw new Error('File path cannot be empty for writing model JSON.');
    }
    if (typeof dataToWrite !== 'string') {
        log.error('[LocalDataSource] writeModelJson 调用时 dataToWrite 不是字符串');
        throw new Error('Data to write must be a string for model JSON.');
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

      // dataToWrite is already a JSON string, write directly to file
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

  /**
   * Gets file statistics (mtimeMs, size) for a local file.
   * @param {string} relativeFilePath - The path to the file, relative to the data source root.
   * @returns {Promise<{mtimeMs: number, size: number}|null>} File stats or null if error.
   */
  async getFileStats(filePathInput) {
    const startTime = Date.now();
    if (!filePathInput) {
      log.warn('[LocalDataSource] getFileStats called with empty filePathInput');
      return null;
    }
    // If filePathInput is already absolute, use it directly. Otherwise, join with config path.
    const absoluteFilePath = path.isAbsolute(filePathInput)
      ? filePathInput
      : path.join(this.config.path, filePathInput);
    log.debug(`[LocalDataSource] Attempting to get file stats for: ${absoluteFilePath} (input path: ${filePathInput})`);

    try {
      const stats = await fs.promises.stat(absoluteFilePath);
      const duration = Date.now() - startTime;
      log.debug(`[LocalDataSource] Successfully got file stats for: ${absoluteFilePath}, 耗时: ${duration}ms`);
      return {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      if (error.code === 'ENOENT') {
        log.warn(`[LocalDataSource] getFileStats failed (file not found): ${absoluteFilePath}, 耗时: ${duration}ms`);
      } else {
        log.error(`[LocalDataSource] Error getting file stats for: ${absoluteFilePath}, 耗时: ${duration}ms`, error.message, error.stack);
      }
      return null; // Return null on error, as expected by some caching logic
    }
  }

  /**
   * Calculates a metadata digest for the content of a directory.
   * This digest is used for cache invalidation of listModels results.
   * @param {string|null} relativeDirectory - The directory path relative to the data source root. Null or empty for root.
   * @param {string[]} supportedExts - Array of supported model file extensions (e.g., ['.safetensors', '.ckpt']).
   * @param {boolean} showSubdirectory - Whether to include subdirectories in the digest calculation.
   * @returns {Promise<string|null>} A SHA256 hash string representing the directory content metadata, or null if an error occurs or directory is not found.
   */
  async getDirectoryContentMetadataDigest(relativeDirectory, supportedExts, showSubdirectory) {
    const startTime = Date.now();
    const rootPath = this.config.path;
    const targetDirectory = relativeDirectory ? path.join(rootPath, relativeDirectory) : rootPath;

    log.debug(`[LocalDataSource] Calculating content digest for: ${targetDirectory}, showSubDir: ${showSubdirectory}, exts: ${supportedExts.join(',')}`);

    try {
      await fs.promises.access(targetDirectory);
    } catch (error) {
      if (error.code === 'ENOENT') {
        log.warn(`[LocalDataSource] getDirectoryContentMetadataDigest: Directory not found: ${targetDirectory}`);
        return null;
      }
      log.error(`[LocalDataSource] Error accessing directory for digest calculation: ${targetDirectory}`, error);
      return null;
    }

    const metadataItems = [];
    const lowerCaseSupportedExts = supportedExts.map(ext => ext.toLowerCase());

    const collectMetadata = async (currentPath) => {
      try {
        const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
          const entryFullPath = path.join(currentPath, entry.name);
          const relativeEntryPath = path.relative(targetDirectory, entryFullPath).replace(/\\/g, '/'); // Normalize path separators

          if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (lowerCaseSupportedExts.includes(ext) || ext === '.json') {
              try {
                const stats = await fs.promises.stat(entryFullPath);
                metadataItems.push(`${relativeEntryPath}:${stats.size}:${stats.mtimeMs}`);
              } catch (statError) {
                if (statError.code !== 'ENOENT') { // Ignore if file was deleted during processing
                    log.warn(`[LocalDataSource] Could not stat file for digest: ${entryFullPath}`, statError);
                }
              }
            }
          } else if (entry.isDirectory() && showSubdirectory) {
            // For directories, we could add their names or a marker, but problem statement focuses on files.
            // Let's ensure recursive call if showSubdirectory is true.
            await collectMetadata(entryFullPath);
          }
        }
      } catch (readDirError) {
         if (readDirError.code !== 'ENOENT') { // Ignore if directory was deleted
            log.warn(`[LocalDataSource] Error reading directory for digest: ${currentPath}`, readDirError);
         }
      }
    };

    await collectMetadata(targetDirectory);

    if (metadataItems.length === 0) {
      // Consistent hash for an empty (relevant) directory
      const durationEmpty = Date.now() - startTime;
      log.debug(`[LocalDataSource] No relevant files found for digest in ${targetDirectory}. Duration: ${durationEmpty}ms. Returning empty hash.`);
      return crypto.createHash('sha256').update('').digest('hex');
    }

    // Sort items for a consistent hash
    metadataItems.sort();
    const metadataString = metadataItems.join('|');
    const hash = crypto.createHash('sha256').update(metadataString).digest('hex');

    const duration = Date.now() - startTime;
    log.info(`[LocalDataSource] Calculated content digest for ${targetDirectory}: ${hash}. Items: ${metadataItems.length}. Duration: ${duration}ms`);
    return hash;
  }
}

module.exports = {
  LocalDataSource
};