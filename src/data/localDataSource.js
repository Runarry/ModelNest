const { parseLocalModels, parseModelDetailFromJsonContent, parseSingleModelFile, findImageForModel } = require('./modelParser'); // 导入新函数及 parseSingleModelFile
const fs = require('fs');
const path = require('path');
const log = require('electron-log');
const crypto = require('crypto'); // 引入 crypto 模块
const DataSource = require('./baseDataSource'); // 导入新的基类

// 本地数据源实现
class LocalDataSource extends DataSource {
  constructor(config, modelInfoCacheService) { // 新增：modelInfoCacheService 参数
    super(config);
    this.modelInfoCacheService = modelInfoCacheService; // 新增：存储缓存服务实例
    // 确保 this.config.id 存在，用于缓存键
    if (!this.config || !this.config.id) {
      log.error('[LocalDataSource] Constructor: config.id is missing. Cache functionality might be impaired.');
      // 可以选择抛出错误或设置一个默认的无效ID，以便后续操作能识别问题
      // throw new Error('LocalDataSource requires a config object with an id property.');
    }
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
    const currentSourceId = this.config.id; // Use sourceId from this.config
    const normalizedDirectory = directory ? path.normalize(directory) : ''; // Normalize for cache key consistency
    const cacheKey = `listModels:${currentSourceId}:${normalizedDirectory}:showSubDir=${showSubdirectory}:exts=${supportedExts.join(',')}`;

    log.info(`[LocalDataSource] 开始列出模型. Root: ${root}, Directory: ${normalizedDirectory}, SourceId: ${currentSourceId}, SupportedExts: ${Array.isArray(supportedExts) ? supportedExts.join(',') : ''}, ShowSubDir: ${showSubdirectory}. CacheKey: ${cacheKey}`);

    if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
      const l1Hit = this.modelInfoCacheService.getFromL1(cacheKey, 'listModels');
      if (l1Hit && l1Hit.data && l1Hit.directoryContentHash) {
        log.debug(`[LocalDataSource] L1 cache hit for listModels: ${cacheKey}. Verifying hash...`);
        const currentDirectoryHash = await this.getDirectoryContentMetadataDigest(normalizedDirectory, supportedExts, showSubdirectory);
        if (currentDirectoryHash && currentDirectoryHash === l1Hit.directoryContentHash) {
          log.info(`[LocalDataSource] L1 cache valid (hash matched) for listModels: ${cacheKey}. Returning cached data. Duration: ${Date.now() - startTime}ms`);
          return l1Hit.data; // Return deep cloned data from cache service
        }
        log.info(`[LocalDataSource] L1 cache hash mismatch for listModels: ${cacheKey}. Cached: ${l1Hit.directoryContentHash}, Current: ${currentDirectoryHash}. Proceeding to fetch.`);
      } else if (l1Hit) {
        log.debug(`[LocalDataSource] L1 cache hit for listModels: ${cacheKey}, but data or hash is missing. Proceeding to fetch.`);
      } else {
        log.debug(`[LocalDataSource] L1 cache miss for listModels: ${cacheKey}. Proceeding to fetch.`);
      }
    } else {
      log.debug(`[LocalDataSource] Cache service not available or disabled for listModels. Proceeding to fetch directly.`);
    }

    const startPath = directory ? path.join(root, normalizedDirectory) : root;

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
    // Ensure sourceConfig passed to walk uses this.config for consistency if sourceConfig param is not the primary one.
    // However, the original logic uses the passed sourceConfig, so we maintain that for now.
    // If sourceConfig is primarily for ID, and this.config.id is the true source ID, adjust accordingly.
    // For now, assume sourceConfig parameter is correctly providing the necessary context for parseLocalModels.
    await walk(startPath, sourceConfig, supportedExts, showSubdirectory);

    if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
      const currentDirectoryHash = await this.getDirectoryContentMetadataDigest(normalizedDirectory, supportedExts, showSubdirectory);
      if (currentDirectoryHash) {
        log.info(`[LocalDataSource] Storing listModels result to L1 cache. Key: ${cacheKey}, Hash: ${currentDirectoryHash}`);
        this.modelInfoCacheService.setToL1(cacheKey, allModels, 'listModels', { directoryContentHash: currentDirectoryHash });
      } else {
        log.warn(`[LocalDataSource] Could not generate directory hash for ${normalizedDirectory}. listModels result not cached for key: ${cacheKey}`);
      }
    }

    const duration = Date.now() - startTime;
    log.info(`[LocalDataSource] 列出模型完成: ${startPath}, 耗时: ${duration}ms, 找到 ${allModels.length} 个模型`);
    return allModels;
  }
  async readModelDetail(jsonPath, modelFilePath, sourceIdFromCaller) { // Renamed sourceId to sourceIdFromCaller for clarity
    const startTime = Date.now();
    const currentSourceId = this.config.id; // Primary sourceId for caching

    // Validate inputs
    if (!modelFilePath) {
      log.warn(`[LocalDataSource readModelDetail] Called with empty modelFilePath.`);
      return {};
    }
    if (!currentSourceId) { // Check this.config.id
        log.error(`[LocalDataSource readModelDetail] this.config.id is missing. Cannot proceed with caching. ModelFilePath: ${modelFilePath}`);
        // Fallback to direct parsing without cache, or return error. For now, proceed but log heavily.
        // Or, use sourceIdFromCaller if this.config.id is truly unavailable, but this indicates a config issue.
    }
    // Log if sourceIdFromCaller differs from this.config.id, as this.config.id is used for cache keys.
    if (sourceIdFromCaller && currentSourceId !== sourceIdFromCaller) {
        log.warn(`[LocalDataSource readModelDetail] sourceIdFromCaller (${sourceIdFromCaller}) differs from this.config.id (${currentSourceId}). Using this.config.id for caching. ModelFilePath: ${modelFilePath}`);
    }
    // Use currentSourceId for all cache operations and parsing context.
    const effectiveSourceId = currentSourceId || sourceIdFromCaller; // Fallback if this.config.id is somehow null
    if (!effectiveSourceId) {
        log.error(`[LocalDataSource readModelDetail] Effective sourceId is missing. Cannot reliably read model detail. ModelFilePath: ${modelFilePath}`);
        return {};
    }

    log.debug(`[LocalDataSource readModelDetail] Entry. modelFilePath: ${modelFilePath}, effectiveSourceId: ${effectiveSourceId}, (original jsonPath: ${jsonPath})`);

    // Determine the path of the .json file associated with the modelFilePath for L2 caching and validation
    let associatedJsonPath;
    if (path.extname(modelFilePath).toLowerCase() === '.json') {
      associatedJsonPath = modelFilePath;
    } else {
      // This logic mirrors how parseSingleModelFile finds the .json file.
      associatedJsonPath = modelFilePath.substring(0, modelFilePath.lastIndexOf('.')) + '.json';
    }
    log.debug(`[LocalDataSource readModelDetail] Associated JSON path for L2/validation: ${associatedJsonPath}`);

    const l1CacheKey = `modelObj:${effectiveSourceId}:${modelFilePath}`;
    const l2CacheKey = `modelJsonInfo:${effectiveSourceId}:${associatedJsonPath}`; // L2 key is based on the JSON file path

    // --- L1 Cache Check (Full Model Object) ---
    if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
      const l1Hit = this.modelInfoCacheService.getFromL1(l1CacheKey, 'modelJsonInfo'); // Type 'modelJsonInfo' implies sourceJsonStats check
      if (l1Hit && l1Hit.data) {
        log.debug(`[LocalDataSource readModelDetail] L1 cache hit for key: ${l1CacheKey}. Validating...`);
        const statsForValidation = await this.getFileStats(associatedJsonPath); // Validate against the JSON file's stats
        if (statsForValidation && l1Hit.sourceJsonStats &&
            statsForValidation.mtimeMs === l1Hit.sourceJsonStats.mtimeMs &&
            statsForValidation.size === l1Hit.sourceJsonStats.size) {
          log.info(`[LocalDataSource readModelDetail] L1 cache valid for key: ${l1CacheKey}. Returning cached data. Duration: ${Date.now() - startTime}ms`);
          return l1Hit.data;
        }
        log.info(`[LocalDataSource readModelDetail] L1 cache invalid (stats mismatch or missing) for key: ${l1CacheKey}. Proceeding.`);
      } else {
        log.debug(`[LocalDataSource readModelDetail] L1 cache miss for key: ${l1CacheKey}.`);
      }
    }

    // --- L2 Cache Check (Parsed JSON Content) ---
    if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
      const l2Result = await this.modelInfoCacheService.getModelJsonInfoFromL2(l2CacheKey);
      if (l2Result && l2Result.modelJsonInfo) {
        log.debug(`[LocalDataSource readModelDetail] L2 cache hit for key: ${l2CacheKey}. Validating...`);
        const statsForValidation = await this.getFileStats(associatedJsonPath);
        if (statsForValidation && l2Result.sourceJsonStats &&
            statsForValidation.mtimeMs === l2Result.sourceJsonStats.mtimeMs &&
            statsForValidation.size === l2Result.sourceJsonStats.size) {
          log.info(`[LocalDataSource readModelDetail] L2 cache valid for key: ${l2CacheKey}. Reconstructing model object.`);
          
          // Reconstruct modelFileInfo for parseModelDetailFromJsonContent
          const modelFileExt = path.extname(modelFilePath).toLowerCase();
          const modelNameWithoutExt = path.basename(modelFilePath, modelFileExt);
          const fileInfoForReconstruction = {
            name: modelNameWithoutExt,
            file: modelFilePath,
            jsonPath: associatedJsonPath, // This is the path of the JSON content we got from L2
            ext: modelFileExt
          };
          
          // parseModelDetailFromJsonContent expects a JSON string, but L2 returns an object.
          // For now, stringify then let it parse. Ideally, parseModelDetailFromJsonContent would accept an object.
          // OR, we directly use the object if parseModelDetailFromJsonContent's main job is parsing and then structuring.
          // The current parseModelDetailFromJsonContent does: JSON.parse -> then structures.
          // So, we can call a modified version or directly structure here.
          // To avoid modifying modelParser for now, we stringify.
          // UPDATE: modelParser.js's parseModelDetailFromJsonContent takes jsonContentString.
          // _parseJsonContentToRawInfo is JSON.parse.
          // So, we must stringify the object from L2.
          let reconstructedModelDetail;
          try {
            reconstructedModelDetail = parseModelDetailFromJsonContent(
              JSON.stringify(l2Result.modelJsonInfo), // Stringify object from L2
              effectiveSourceId,
              fileInfoForReconstruction
            );
            // parseSingleModelFile also adds the top-level 'image' based on files in dir.
            // We need to replicate that or ensure parseModelDetailFromJsonContent handles it if possible.
            // For now, this might miss the top-level 'image' if not in modelJsonInfo.
            // Let's find the image again, similar to parseSingleModelFile
             const dirOfModel = path.dirname(modelFilePath);
             try {
                const filesInDir = await fs.promises.readdir(dirOfModel); // 使用 fs.promises.readdir
                // 使用从 modelParser 导入的 findImageForModel 函数
                reconstructedModelDetail.image = await findImageForModel(dirOfModel, modelNameWithoutExt, filesInDir);
             } catch (readdirError) {
                log.warn(`[LocalDataSource readModelDetail] Could not re-read directory ${dirOfModel} to find image for L2-reconstructed object: ${readdirError.message}`);
                reconstructedModelDetail.image = ''; // Default if error
             }

          } catch (e) {
             log.error(`[LocalDataSource readModelDetail] Error reconstructing model from L2 data for ${modelFilePath}: ${e.message}`, e);
             // Fall through to full parse if reconstruction fails
          }

          if (reconstructedModelDetail) {
            log.info(`[LocalDataSource readModelDetail] Successfully reconstructed model from L2 data for ${modelFilePath}. Caching to L1.`);
            this.modelInfoCacheService.setToL1(l1CacheKey, reconstructedModelDetail, 'modelJsonInfo', { sourceJsonStats: statsForValidation });
            const duration = Date.now() - startTime;
            log.debug(`[LocalDataSource readModelDetail] Exiting after L2 hit and L1 set. 耗时: ${duration}ms`);
            return reconstructedModelDetail;
          }
        }
        log.info(`[LocalDataSource readModelDetail] L2 cache invalid (stats mismatch or missing) for key: ${l2CacheKey}. Proceeding.`);
      } else {
        log.debug(`[LocalDataSource readModelDetail] L2 cache miss for key: ${l2CacheKey}.`);
      }
    }

    // --- Cache Miss or Invalid: Perform Full Parse ---
    log.debug(`[LocalDataSource readModelDetail] L1 and L2 miss/invalid. Calling parseSingleModelFile for: "${modelFilePath}"`);
    let modelDetail;
    try {
      const sourceConfigForParser = { id: effectiveSourceId };
      modelDetail = await parseSingleModelFile(
        modelFilePath,
        [], // supportedExtensions - parseSingleModelFile has its own logic or can be passed this.config.supportedExts
        sourceConfigForParser,
        true // ignorExtSupport - assuming true as per original call
      );

      if (modelDetail) {
        log.debug(`[LocalDataSource readModelDetail] Successfully parsed by parseSingleModelFile: "${modelFilePath}"`);
        // modelDetail.jsonPath is the actual path of the JSON file used (could be modelFilePath itself or associated .json)
        // modelDetail.modelJsonInfo is the parsed JSON object
        const actualJsonPathUsedByParser = modelDetail.jsonPath || associatedJsonPath; // Prefer actual from parser if available
        const jsonContentObjectForL2 = modelDetail.modelJsonInfo;

        if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled && actualJsonPathUsedByParser && jsonContentObjectForL2) {
          const actualJsonFileStats = await this.getFileStats(actualJsonPathUsedByParser);
          if (actualJsonFileStats) {
            const finalL2CacheKey = `modelJsonInfo:${effectiveSourceId}:${actualJsonPathUsedByParser}`;
            log.info(`[LocalDataSource readModelDetail] Storing to L2 cache. Key: ${finalL2CacheKey}`);
            await this.modelInfoCacheService.setModelJsonInfoToL2(finalL2CacheKey, jsonContentObjectForL2, actualJsonFileStats);

            log.info(`[LocalDataSource readModelDetail] Storing to L1 cache. Key: ${l1CacheKey}`);
            this.modelInfoCacheService.setToL1(l1CacheKey, modelDetail, 'modelJsonInfo', { sourceJsonStats: actualJsonFileStats });
          } else {
            log.warn(`[LocalDataSource readModelDetail] Could not get stats for ${actualJsonPathUsedByParser}. Cache not updated for ${modelFilePath}.`);
          }
        }
        const duration = Date.now() - startTime;
        log.debug(`[LocalDataSource readModelDetail] Exiting after full parse. 耗时: ${duration}ms`);
        return modelDetail;
      } else {
        log.warn(`[LocalDataSource readModelDetail] parseSingleModelFile returned null for: "${modelFilePath}".`);
        const duration = Date.now() - startTime;
        log.debug(`[LocalDataSource readModelDetail] Exiting after failed parse. 耗时: ${duration}ms`);
        return {};
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error(`[LocalDataSource readModelDetail] Unexpected error processing model detail for: "${modelFilePath}". 耗时: ${duration}ms`, error.message, error.stack);
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

      // --- Cache Invalidation Logic ---
      if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
        const sourceId = this.config.id;
        if (!sourceId) {
          log.error(`[LocalDataSource writeModelJson] Cache Invalidation: sourceId (this.config.id) is missing. Cannot invalidate cache for ${filePath}.`);
          // Early exit from cache invalidation if sourceId is missing
        } else {
          log.info(`[LocalDataSource writeModelJson] Invalidating cache for updated JSON file: ${filePath}`);

          // 1. Invalidate L2 cache for this JSON file
          const l2Key = `modelJsonInfo:${sourceId}:${filePath}`;
          log.debug(`[LocalDataSource writeModelJson] Invalidating L2 cache with key: ${l2Key}`);
          await this.modelInfoCacheService.invalidateL2(l2Key, 'modelJsonInfo');

          // 2. Invalidate L1 cache for the corresponding model object(s)
          // The JSON file (filePath) might correspond to a model file (e.g., modelName.safetensors)
          const modelNameWithoutExt = path.basename(filePath, '.json');
          const dirOfJson = path.dirname(filePath);
          
          // Attempt to find corresponding model files based on supported extensions
          // This assumes supportedExts is available, e.g., from this.config.supportedExts
          // If this.config.supportedExts is not directly available here, this part might need adjustment
          // or supportedExts needs to be passed or retrieved.
          // For now, let's assume it's accessible via this.config or a default list.
          const supportedExts = this.config.supportedExts || ['.safetensors', '.ckpt', '.pt', '.pth', '.bin']; // Fallback if not in config
          
          for (const ext of supportedExts) {
            const potentialModelFilePath = path.join(dirOfJson, `${modelNameWithoutExt}${ext}`);
            // Check if this potential model file actually exists before creating L1 key,
            // or just try to delete (deleteFromL1 handles non-existent keys gracefully).
            // For simplicity, we'll just try to delete.
            const l1ModelObjKey = `modelObj:${sourceId}:${potentialModelFilePath}`;
            log.debug(`[LocalDataSource writeModelJson] Attempting to invalidate L1 model object cache with key: ${l1ModelObjKey}`);
            this.modelInfoCacheService.deleteFromL1(l1ModelObjKey);
          }
          // Also, if the filePath itself could be an L1 key (e.g. if a .json file is treated as a primary model file)
          const l1DirectJsonKey = `modelObj:${sourceId}:${filePath}`;
          log.debug(`[LocalDataSource writeModelJson] Attempting to invalidate L1 direct JSON object cache with key: ${l1DirectJsonKey}`);
          this.modelInfoCacheService.deleteFromL1(l1DirectJsonKey);


          // 3. Invalidate L1 listModels cache for the directory
          const directoryPath = path.dirname(filePath);
          let relativeDirPath = path.relative(this.config.path, directoryPath);
          // Ensure relativeDirPath is in a format consistent with listModels cache keys (e.g., no leading slash if root, normalized separators)
          relativeDirPath = relativeDirPath.replace(/\\/g, '/'); // Normalize to forward slashes
          if (relativeDirPath === '.') relativeDirPath = ''; // For root directory

          log.debug(`[LocalDataSource writeModelJson] Invalidating L1 listModels cache for directory: ${relativeDirPath} (Source: ${sourceId})`);
          // This will clear all listModels cache entries starting with "listModels:sourceId:relativeDirPath"
          // This should cover different showSubDir and exts combinations due to prefix matching.
          await this.modelInfoCacheService.invalidateListModelsCacheForDirectory(sourceId, relativeDirPath);
          
          log.info(`[LocalDataSource writeModelJson] Cache invalidation complete for ${filePath}.`);
        }
      } else {
        log.debug(`[LocalDataSource writeModelJson] Cache service not available or disabled. Skipping cache invalidation for ${filePath}.`);
      }

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