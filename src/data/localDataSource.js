const pLimit = require('p-limit').default;
const { parseSingleModelFile } = require('./modelParser');
const fs = require('fs');
const path = require('path');
const log = require('electron-log');
const crypto = require('crypto');
const DataSource = require('./baseDataSource');
const { CacheDataType } = require('../services/constants/cacheConstants'); 


/**
 * Represents a local data source for models.
 * @extends DataSource
 */
class LocalDataSource extends DataSource {
  /**
   * Creates an instance of LocalDataSource.
   * @param {object} config - The configuration object for this data source.
   * @param {string} config.id - The unique ID of this data source.
   * @param {string} config.path - The root path of this data source.
   * @param {string[]} [config.supportedExts=['.safetensors', '.ckpt']] - Supported model file extensions.
   * @param {ModelInfoCacheService} modelInfoCacheService - The cache service instance.
   */
  constructor(config, modelInfoCacheService) {
    super(config);
    this.modelInfoCacheService = modelInfoCacheService;
    // 缓存
    this.allModelsCache = [];
    this.directoryStructureCache = [];
    this.modelsByDirectoryMap = new Map();
    if (!this.config || !this.config.id) {
      log.error('[LocalDataSource] Constructor: config.id is missing. Cache functionality might be impaired.');
    }

  }

  async InitAllSource(){
    const startTime = Date.now();
    const rootPath = this.config.path;
    const sourceId = this.config.id;
    log.info(`[LocalDataSource InitAllSource] 开始初始化所有数据源: ${rootPath}, SourceId: ${sourceId}`);

    // 确定支持的文件扩展名
    let effectiveSupportedExts;
    if (this.config && this.config.supportedExts && this.config.supportedExts.length > 0) {
      effectiveSupportedExts = this.config.supportedExts;
    } else {
      effectiveSupportedExts = ['.safetensors', '.ckpt', '.pt', '.pth', '.bin'];
      log.warn(`[LocalDataSource InitAllSource] 未提供或配置 supportedExts，使用默认值: ${effectiveSupportedExts.join(', ')}`);
    }

    // 设置并发限制
    const limit = pLimit(8);

    // 初始化返回数据
    let allModels = [];
    let directoryStructure = []; // 完整目录结构（只包含文件夹）
    let modelsByDirectory = new Map(); // 目录与模型名称的映射

    try {
      await fs.promises.access(rootPath);
    } catch (error) {
      const duration = Date.now() - startTime;
      if (error.code === 'ENOENT') {
        log.warn(`[LocalDataSource InitAllSource] 目录不存在: ${rootPath}. 耗时: ${duration}ms`);
        return { allModels: [], directoryStructure: [], modelsByDirectory: new Map() };
      }
      log.error(`[LocalDataSource InitAllSource] 访问模型目录时出错: ${rootPath}. 耗时: ${duration}ms`, error.message, error.stack);
      return { allModels: [], directoryStructure: [], modelsByDirectory: new Map() };
    }

    // 递归遍历目录
    const walk = async (currentDir, relativePath = '') => {
      try {
        const files = await fs.promises.readdir(currentDir, { withFileTypes: true });
        
        // 处理当前目录中的模型文件
        const modelFiles = files.filter(f => f.isFile() && effectiveSupportedExts.some(ext => f.name.toLowerCase().endsWith(ext.toLowerCase())));
        
        // 当前目录的模型名称列表
        const modelsInCurrentDir = [];

        // 并发处理模型文件
        await Promise.all(modelFiles.map(modelFile => limit(async () => {
          const modelFilePath = path.join(currentDir, modelFile.name);
          const relativeModelFilePath = path.relative(rootPath, modelFilePath);
          const associatedJsonPath = modelFilePath.substring(0, modelFilePath.lastIndexOf('.')) + '.json';
          
          let modelJsonInfo;
          let jsonFileStats;

          try {
            jsonFileStats = await this.getFileStats(associatedJsonPath);
          } catch (e) {
            log.warn(`[LocalDataSource InitAllSource] 无法获取关联JSON的统计信息: ${associatedJsonPath}`, e.message);
            jsonFileStats = null;
          }

          if (jsonFileStats) {
            try {
              const jsonContent = await fs.promises.readFile(associatedJsonPath, 'utf-8');
              modelJsonInfo = JSON.parse(jsonContent);
            } catch (e) {
              if (e.code !== 'ENOENT') {
                log.warn(`[LocalDataSource InitAllSource] 读取/解析JSON时出错 ${associatedJsonPath}: ${e.message}`);
              }
              modelJsonInfo = null;
            }
          }
          
          const sourceConfig = { id: sourceId };
          const modelObj = await parseSingleModelFile(modelFilePath, effectiveSupportedExts, sourceConfig, true, modelJsonInfo, jsonFileStats);
          
          if (modelObj) {
            allModels.push(modelObj);
            modelsInCurrentDir.push(modelObj.name);
          }
        })));

        // 如果当前目录有模型，添加到映射中
        if (modelsInCurrentDir.length > 0) {
          const dirKey = relativePath || '/'; // 根目录用 '/' 表示
          modelsByDirectory.set(dirKey, modelsInCurrentDir);
        }

        // 处理子目录
        const subDirs = files.filter(f => f.isDirectory());
        
        // 将子目录添加到目录结构中
        for (const subDir of subDirs) {
          const subDirRelativePath = relativePath ? `${relativePath}/${subDir.name}` : subDir.name;
          directoryStructure.push(subDirRelativePath);
        }

        // 并发递归处理子目录
        await Promise.all(subDirs.map(subDir => limit(async () => {
          const subDirPath = path.join(currentDir, subDir.name);
          const subDirRelativePath = relativePath ? `${relativePath}/${subDir.name}` : subDir.name;
          await walk(subDirPath, subDirRelativePath);
        })));
      } catch (error) {
        if (error.code === 'ENOENT') {
          log.warn(`[LocalDataSource InitAllSource] 遍历过程中目录不存在: ${currentDir}`);
        } else {
          log.error(`[LocalDataSource InitAllSource] 遍历目录时出错: ${currentDir}`, error.message, error.stack);
        }
      }
    };

    // 从根目录开始遍历
    await walk(rootPath);

    const duration = Date.now() - startTime;
    log.info(`[LocalDataSource InitAllSource] 完成. 路径: ${rootPath}, 耗时: ${duration}ms, 找到 ${allModels.length} 个模型, ${directoryStructure.length} 个目录`);
    
    this.allModelsCache = allModels;
    this.directoryStructureCache = directoryStructure;
    this.modelsByDirectoryCache = modelsByDirectory;
    return {
      allModels,
      directoryStructure,
      modelsByDirectory
    };
  }

  /**
   * Lists subdirectories in the root path of the data source.
   * @returns {Promise<string[]>} A promise that resolves to an array of subdirectory names.
   */
  async listSubdirectories() {
    const startTime = Date.now();
    const root = this.config.path;
    log.info(`[LocalDataSource] 开始列出子目录: ${root}`);
    try {
      await fs.promises.access(root);
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      const duration = Date.now() - startTime;
      log.info(`[LocalDataSource] 列出子目录完成: ${root}, 耗时: ${duration}ms, 找到 ${entries.filter(e => e.isDirectory()).length} 个子目录`);
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch (error) {
      const duration = Date.now() - startTime;
      if (error.code === 'ENOENT') {
        log.warn(`[LocalDataSource] 列出子目录失败 (目录不存在): ${root}, 耗时: ${duration}ms`);
        return [];
      }
      log.error(`[LocalDataSource] 列出子目录时出错: ${root}, 耗时: ${duration}ms`, error.message, error.stack);
      return [];
    }
  }

  /**
   * Generates a path identifier for listModels cache.
   * @param {string} normalizedDirectory - Normalized directory path.
   * @param {boolean} showSubdirectory - Whether subdirectories are included.
   * @param {string[]} supportedExts - Array of supported extensions.
   * @returns {string} The path identifier.
   * @private
   */
  _generateListModelsPathIdentifier(normalizedDirectory, showSubdirectory, supportedExts) {
    // Ensure directoryPath is normalized (e.g., forward slashes, no trailing slash unless root)
    let dirPath = normalizedDirectory.replace(/\\/g, '/');
    if (dirPath.endsWith('/') && dirPath.length > 1) {
        dirPath = dirPath.slice(0, -1);
    }
    const params = new URLSearchParams();
    params.append('showSubDir', String(showSubdirectory));
    params.append('exts', supportedExts.slice().sort().join(',')); // Sort exts for consistency
    return `${dirPath}?${params.toString()}`;
  }

  /**
   * Lists models from the local file system.
   * @param {string|null} [directory=null] - The subdirectory to list models from. Relative to the source's root path.
   * @param {object} sourceConfig - The configuration for the current source (used for sourceId).
   * @param {string[]} [supportedExts=[]] - Array of supported model file extensions.
   * @param {boolean} [showSubdirectory=true] - Whether to include models from subdirectories.
   * @returns {Promise<Array<object>>} A promise that resolves to an array of model objects.
   */
  async listModels(directory = null, sourceConfig, supportedExts = [], showSubdirectory = true) {
    const startTime = Date.now();
    const rootPath = this.config.path;
    const sourceId = this.config.id;
    const normalizedDirectory = directory ? path.normalize(directory) : '';

    // Determine effective supported extensions
    let effectiveSupportedExts;
    if (supportedExts && supportedExts.length > 0) {
      effectiveSupportedExts = supportedExts;
    } else if (this.config && this.config.supportedExts && this.config.supportedExts.length > 0) {
      effectiveSupportedExts = this.config.supportedExts;
    } else {
      effectiveSupportedExts = ['.safetensors', '.ckpt', '.pt', '.pth', '.bin'];
      log.warn(`[LocalDataSource listModels] No supportedExts provided or configured for source ${sourceId}. Falling back to default: ${effectiveSupportedExts.join(', ')}`);
    }

    const pathIdentifier = this._generateListModelsPathIdentifier(normalizedDirectory, showSubdirectory, effectiveSupportedExts);
    log.info(`[LocalDataSource listModels] Root: ${rootPath}, Directory: ${normalizedDirectory}, SourceId: ${sourceId}, PathIdentifier: ${pathIdentifier}`);

    // 新增并发限制
    const limit = pLimit(8);

    if (!sourceId) {
        log.error('[LocalDataSource listModels] sourceId (this.config.id) is missing. Cannot use cache.');
    }

    if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled && sourceId) {
      const currentContentHash = await this.getDirectoryContentMetadataDigest(normalizedDirectory, effectiveSupportedExts, showSubdirectory);
      if (currentContentHash) {
        const cachedData = await this.modelInfoCacheService.getDataFromCache(
          CacheDataType.MODEL_LIST,
          sourceId,
          pathIdentifier,
          { contentHash: currentContentHash }
        );
        if (cachedData) {
          log.info(`[LocalDataSource listModels] Cache hit for MODEL_LIST. PathIdentifier: ${pathIdentifier}. Duration: ${Date.now() - startTime}ms`);
          return cachedData;
        }
        log.info(`[LocalDataSource listModels] Cache miss or invalid for MODEL_LIST. PathIdentifier: ${pathIdentifier}. Hash: ${currentContentHash}`);
      } else {
        log.warn(`[LocalDataSource listModels] Could not generate contentHash for ${normalizedDirectory}. Proceeding without MODEL_LIST cache check.`);
      }
    }

    const startPath = directory ? path.join(rootPath, normalizedDirectory) : rootPath;
    try {
      await fs.promises.access(startPath);
    } catch (error) {
      const duration = Date.now() - startTime;
      if (error.code === 'ENOENT') {
        log.warn(`[LocalDataSource listModels] Directory does not exist: ${startPath}. Duration: ${duration}ms`);
        return [];
      }
      log.error(`[LocalDataSource listModels] Error accessing model directory: ${startPath}. Duration: ${duration}ms`, error.message, error.stack);
      return [];
    }

    let allModels = [];
    const walk = async (currentDir, currentSourceConfig, currentSupportedExts, currentShowSubdirectory) => {
      try {
        const files = await fs.promises.readdir(currentDir, { withFileTypes: true });
        
        const modelFiles = files.filter(f => f.isFile() && currentSupportedExts.some(ext => f.name.toLowerCase().endsWith(ext.toLowerCase())));

        // 并发受控处理 modelFiles
        await Promise.all(modelFiles.map(modelFile => limit(async () => {
            const modelFilePath = path.join(currentDir, modelFile.name);
            const relativeModelFilePath = path.relative(rootPath, modelFilePath); // For pathIdentifier in MODEL_DETAIL
            const associatedJsonPath = modelFilePath.substring(0, modelFilePath.lastIndexOf('.')) + '.json';
            const relativeAssociatedJsonPath = path.relative(rootPath, associatedJsonPath); // For pathIdentifier in MODEL_JSON_INFO

            let modelJsonInfo;
            let jsonFileStats;

            try {
                jsonFileStats = await this.getFileStats(associatedJsonPath); // getFileStats handles relative/absolute
            } catch (e) {
                log.warn(`[LocalDataSource listModels] Could not get stats for associated JSON: ${associatedJsonPath}`, e.message);
                jsonFileStats = null; // Proceed without stats if JSON doesn't exist or error
            }

            if (jsonFileStats && this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled && sourceId) {
                const currentJsonFileMetadata = {
                    fileSize: jsonFileStats.size,
                    metadata_lastModified_ms: jsonFileStats.mtimeMs,
                    etag: null // Local files don't have etags
                };
                
                modelJsonInfo = await this.modelInfoCacheService.getDataFromCache(
                    CacheDataType.MODEL_JSON_INFO,
                    sourceId,
                    relativeAssociatedJsonPath, // Use relative path for cache key
                    currentJsonFileMetadata
                );

                if (modelJsonInfo) {
                    log.debug(`[LocalDataSource listModels] L2 Cache hit for MODEL_JSON_INFO: ${relativeAssociatedJsonPath}`);
                } else {
                    log.debug(`[LocalDataSource listModels] L2 Cache miss for MODEL_JSON_INFO: ${relativeAssociatedJsonPath}. Reading file.`);
                }
            }
            
            if (!modelJsonInfo && jsonFileStats) { // If L2 miss (or no cache) AND json file exists (stats were found)
                try {
                    const jsonContent = await fs.promises.readFile(associatedJsonPath, 'utf-8');
                    modelJsonInfo = JSON.parse(jsonContent);

                    if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled && sourceId) {
                        const sourceJsonFileMetadata = {
                            fileSize: jsonFileStats.size,
                            metadata_lastModified_ms: jsonFileStats.mtimeMs,
                            etag: null
                        };
                        await this.modelInfoCacheService.setDataToCache(
                            CacheDataType.MODEL_JSON_INFO,
                            sourceId,
                            relativeAssociatedJsonPath,
                            modelJsonInfo,
                            sourceJsonFileMetadata
                        );
                        log.debug(`[LocalDataSource listModels] Set to L2 Cache MODEL_JSON_INFO: ${relativeAssociatedJsonPath}`);
                    }
                } catch (e) {
                    if (e.code !== 'ENOENT') { // ENOENT is fine, means no JSON file
                        log.warn(`[LocalDataSource listModels] Error reading/parsing JSON ${associatedJsonPath}: ${e.message}`);
                    }
                    modelJsonInfo = null; // Ensure it's null if read fails
                }
            }
            
            const modelObj = await parseSingleModelFile(modelFilePath, currentSupportedExts, currentSourceConfig, true, modelJsonInfo, jsonFileStats);
            if (modelObj) {
                allModels.push(modelObj);
            }
        })));

        // 并发受控递归子目录
        if (currentShowSubdirectory) {
          const subDirs = files.filter(f => f.isDirectory());
          await Promise.all(subDirs.map(f =>
            limit(() => walk(path.join(currentDir, f.name), currentSourceConfig, currentSupportedExts, currentShowSubdirectory))
          ));
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
             log.warn(`[LocalDataSource listModels] Directory not found during walk: ${currentDir}`);
        } else {
             log.error(`[LocalDataSource listModels] Error walking directory: ${currentDir}`, error.message, error.stack);
        }
      }
    };

    await walk(startPath, sourceConfig, effectiveSupportedExts, showSubdirectory);

    if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled && sourceId) {
      const currentContentHash = await this.getDirectoryContentMetadataDigest(normalizedDirectory, effectiveSupportedExts, showSubdirectory);
      if (currentContentHash) {
        log.info(`[LocalDataSource listModels] Storing MODEL_LIST to cache. PathIdentifier: ${pathIdentifier}, Hash: ${currentContentHash}`);
        await this.modelInfoCacheService.setDataToCache(
          CacheDataType.MODEL_LIST,
          sourceId,
          pathIdentifier,
          allModels,
          { contentHash: currentContentHash },
          'local' // sourceTypeForTTL
        );
      }
    }

    const duration = Date.now() - startTime;
    log.info(`[LocalDataSource listModels] Completed. Path: ${startPath}, Duration: ${duration}ms, Found ${allModels.length} models`);
    return allModels;
  }

  /**
   * Reads detailed information for a single model.
   * @param {string} jsonPath - Path to the model's JSON file (may be same as modelFilePath if model is a .json).
   * @param {string} modelFilePath - Path to the model file.
   * @param {string} sourceIdFromCaller - The ID of the data source (passed by caller, may not be used if this.config.id is primary).
   * @returns {Promise<object>} A promise that resolves to the model detail object.
   */
  async readModelDetail(jsonPath, modelFilePath, sourceIdFromCaller) {
    const startTime = Date.now();
    const sourceId = this.config.id;

    if (!modelFilePath) {
      log.warn(`[LocalDataSource readModelDetail] Called with empty modelFilePath.`);
      return {};
    }
    if (!sourceId) {
        log.error(`[LocalDataSource readModelDetail] this.config.id is missing. Cannot proceed with caching. ModelFilePath: ${modelFilePath}`);
    }
    
    const relativeModelFilePath = path.relative(this.config.path, modelFilePath).replace(/\\/g, '/');
    let associatedJsonPath; // Full path
    if (path.extname(modelFilePath).toLowerCase() === '.json') {
      associatedJsonPath = modelFilePath;
    } else {
      associatedJsonPath = modelFilePath.substring(0, modelFilePath.lastIndexOf('.')) + '.json';
    }
    const relativeAssociatedJsonPath = path.relative(this.config.path, associatedJsonPath).replace(/\\/g, '/');

    log.debug(`[LocalDataSource readModelDetail] Entry. ModelFilePath: ${modelFilePath} (Rel: ${relativeModelFilePath}), JsonPath (Rel): ${relativeAssociatedJsonPath}, SourceId: ${sourceId}`);

    if (!this.modelInfoCacheService || !this.modelInfoCacheService.isInitialized || !this.modelInfoCacheService.isEnabled || !sourceId) {
      log.warn('[LocalDataSource readModelDetail] Cache service not available or sourceId missing. Falling back to direct parse.');
      return parseSingleModelFile(modelFilePath, this.config.supportedExts || [], { id: sourceId }, true);
    }

    // --- Step 1: Get current metadata for model and JSON files ---
    let currentModelFileMetadata;
    let currentJsonFileMetadata;
    try {
        const modelFileStats = await this.getFileStats(modelFilePath); // getFileStats expects full or relative path from root
        if (modelFileStats) {
            currentModelFileMetadata = {
                fileSize: modelFileStats.size,
                metadata_lastModified_ms: modelFileStats.mtimeMs,
                etag: null
            };
        }
    } catch (e) { log.warn(`[LocalDataSource readModelDetail] Error getting stats for model file ${modelFilePath}: ${e.message}`); }

    try {
        const jsonFileStats = await this.getFileStats(associatedJsonPath);
        if (jsonFileStats) {
            currentJsonFileMetadata = {
                fileSize: jsonFileStats.size,
                metadata_lastModified_ms: jsonFileStats.mtimeMs,
                etag: null
            };
        }
    } catch (e) { log.warn(`[LocalDataSource readModelDetail] Error getting stats for JSON file ${associatedJsonPath}: ${e.message}`); }


    // --- Step A: Try L1 Cache for MODEL_DETAIL ---
    if (currentModelFileMetadata) {
        const l1ModelDetail = await this.modelInfoCacheService.getDataFromCache(
            CacheDataType.MODEL_DETAIL,
            sourceId,
            relativeModelFilePath,
            currentModelFileMetadata
        );
        if (l1ModelDetail) {
            log.info(`[LocalDataSource readModelDetail] L1 cache hit for MODEL_DETAIL: ${relativeModelFilePath}. Duration: ${Date.now() - startTime}ms`);
            return l1ModelDetail;
        }
    }
    
    // --- Step B: Try L2 Cache for MODEL_JSON_INFO ---
    let modelJsonInfo;
    if (currentJsonFileMetadata) {
        modelJsonInfo = await this.modelInfoCacheService.getDataFromCache(
            CacheDataType.MODEL_JSON_INFO,
            sourceId,
            relativeAssociatedJsonPath,
            currentJsonFileMetadata
        );

        if (modelJsonInfo) {
            log.info(`[LocalDataSource readModelDetail] L2 cache hit for MODEL_JSON_INFO: ${relativeAssociatedJsonPath}`);
            // Build ModelObject from L2 data and model file info
            // This requires parseSingleModelFile to accept pre-parsed JSON and its stats.
            const modelDetail = await parseSingleModelFile(modelFilePath, this.config.supportedExts || [], { id: sourceId }, true, modelJsonInfo, await this.getFileStats(associatedJsonPath));
            if (modelDetail && currentModelFileMetadata) {
                await this.modelInfoCacheService.setDataToCache(
                    CacheDataType.MODEL_DETAIL,
                    sourceId,
                    relativeModelFilePath,
                    modelDetail,
                    currentModelFileMetadata,
                    'local'
                );
                log.info(`[LocalDataSource readModelDetail] Set MODEL_DETAIL to L1 from L2 data: ${relativeModelFilePath}. Duration: ${Date.now() - startTime}ms`);
                return modelDetail;
            }
        }
    }

    // --- Step C: Cache Miss - Full Parse from Source ---
    log.info(`[LocalDataSource readModelDetail] L1/L2 cache miss or invalid. Parsing from source: ${modelFilePath}`);
    const parsedModelDetail = await parseSingleModelFile(modelFilePath, this.config.supportedExts || [], { id: sourceId }, true);

    if (parsedModelDetail) {
        // parsedModelDetail.modelJsonInfo contains the JSON object
        // parsedModelDetail.jsonPath contains the actual JSON path used by parser
        const actualJsonPathUsedByParser = parsedModelDetail.jsonPath || associatedJsonPath;
        const relativeActualJsonPath = path.relative(this.config.path, actualJsonPathUsedByParser).replace(/\\/g, '/');
        const jsonContentObjectForL2 = parsedModelDetail.modelJsonInfo;
        
        let sourceJsonFileMetadataForCache;
        try {
            const stats = await this.getFileStats(actualJsonPathUsedByParser);
            if (stats) {
                 sourceJsonFileMetadataForCache = {
                    fileSize: stats.size,
                    metadata_lastModified_ms: stats.mtimeMs,
                    etag: null
                };
            }
        } catch(e) { log.warn(`[LocalDataSource readModelDetail] Could not get stats for ${actualJsonPathUsedByParser} after parsing.`);}


        if (jsonContentObjectForL2 && sourceJsonFileMetadataForCache) {
            await this.modelInfoCacheService.setDataToCache(
                CacheDataType.MODEL_JSON_INFO,
                sourceId,
                relativeActualJsonPath,
                jsonContentObjectForL2,
                sourceJsonFileMetadataForCache
            );
            log.info(`[LocalDataSource readModelDetail] Set MODEL_JSON_INFO to L2: ${relativeActualJsonPath}`);
        }

        if (currentModelFileMetadata) { // currentModelFileMetadata should be up-to-date for the main model file
             await this.modelInfoCacheService.setDataToCache(
                CacheDataType.MODEL_DETAIL,
                sourceId,
                relativeModelFilePath,
                parsedModelDetail,
                currentModelFileMetadata,
                'local'
            );
            log.info(`[LocalDataSource readModelDetail] Set MODEL_DETAIL to L1: ${relativeModelFilePath}`);
        }
       
        const duration = Date.now() - startTime;
        log.info(`[LocalDataSource readModelDetail] Full parse completed. Duration: ${duration}ms`);
        return parsedModelDetail;
    } else {
        log.warn(`[LocalDataSource readModelDetail] parseSingleModelFile returned null for: ${modelFilePath}`);
        return {};
    }
  }

  /**
   * Gets image data (Buffer and MIME type) for a local image file.
   * @param {string} imagePath - The full path to the image file.
   * @returns {Promise<{path: string, data: Buffer, mimeType: string}|null>} Image data or null if error.
   */
  async getImageData(imagePath) {
    const startTime = Date.now();
    log.debug(`[LocalDataSource] 开始获取图片数据: ${imagePath}`);
    if (!imagePath) {
        log.warn('[LocalDataSource] getImageData 调用时 imagePath 为空');
        return null;
    }
    try {
      await fs.promises.access(imagePath);
      const fileData = await fs.promises.readFile(imagePath);
      const mimeType = `image/${path.extname(imagePath).slice(1).toLowerCase()}`;
      const duration = Date.now() - startTime;
      log.debug(`[LocalDataSource] 读取本地图片成功: ${imagePath}, 大小: ${(fileData.length / 1024).toFixed(1)}KB, 耗时: ${duration}ms`);
      return {
        path: imagePath,
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
      return null;
    }
  }

  /**
   * Writes model JSON data to a local file.
   * @param {string} filePath - The full path to write the JSON file.
   * @param {string} dataToWrite - The JSON string to write.
   * @returns {Promise<void>}
   * @throws {Error} If writing fails.
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
        throw new Error('Data to write must be a string for model JSON.');
    }

    try {
      const dirPath = path.dirname(filePath);
      try {
        await fs.promises.access(dirPath);
      } catch (accessError) {
        if (accessError.code === 'ENOENT') {
          log.info(`[LocalDataSource] 目录 ${dirPath} 不存在，正在创建...`);
          await fs.promises.mkdir(dirPath, { recursive: true });
        } else {
          throw accessError;
        }
      }

      await fs.promises.writeFile(filePath, dataToWrite, 'utf-8');
      const duration = Date.now() - startTime;
      log.info(`[LocalDataSource] 成功写入模型 JSON: ${filePath}, 耗时: ${duration}ms`);

      // --- Cache Invalidation Logic ---
      if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
        const sourceId = this.config.id;
        if (!sourceId) {
          log.error(`[LocalDataSource writeModelJson] Cache Invalidation: sourceId (this.config.id) is missing for ${filePath}.`);
        } else {
          log.info(`[LocalDataSource writeModelJson] Invalidating cache for updated JSON file: ${filePath}`);
          const relativeJsonPath = path.relative(this.config.path, filePath).replace(/\\/g, '/');

          // 1. Invalidate MODEL_JSON_INFO for this JSON file
          await this.modelInfoCacheService.invalidateCacheEntry(CacheDataType.MODEL_JSON_INFO, sourceId, relativeJsonPath);
          log.debug(`[LocalDataSource writeModelJson] Invalidated MODEL_JSON_INFO for: ${relativeJsonPath}`);

          // 2. Invalidate MODEL_DETAIL for corresponding model file(s)
          const modelNameWithoutExt = path.basename(filePath, '.json');
          const dirOfJson = path.dirname(filePath);
          const supportedExts = this.config.supportedExts || ['.safetensors', '.ckpt', '.pt', '.pth', '.bin'];
          
          for (const ext of supportedExts) {
            const potentialModelFilePath = path.join(dirOfJson, `${modelNameWithoutExt}${ext}`);
            const relativeModelFilePath = path.relative(this.config.path, potentialModelFilePath).replace(/\\/g, '/');
            // Check if file exists before invalidating? No, invalidateCacheEntry handles non-existent keys.
            await this.modelInfoCacheService.invalidateCacheEntry(CacheDataType.MODEL_DETAIL, sourceId, relativeModelFilePath);
            log.debug(`[LocalDataSource writeModelJson] Attempted invalidation of MODEL_DETAIL for: ${relativeModelFilePath}`);
          }
          // If the .json file itself could be a model (e.g. for some types of models)
          await this.modelInfoCacheService.invalidateCacheEntry(CacheDataType.MODEL_DETAIL, sourceId, relativeJsonPath);
          log.debug(`[LocalDataSource writeModelJson] Attempted invalidation of MODEL_DETAIL for direct JSON path: ${relativeJsonPath}`);


          // 3. Invalidate MODEL_LIST for the directory
          const directoryPath = path.dirname(filePath);
          let relativeDirPath = path.relative(this.config.path, directoryPath).replace(/\\/g, '/');
          if (relativeDirPath === '.') relativeDirPath = ''; // Root directory

          // We need to invalidate for all combinations of showSubDir and exts that might include this file.
          // The design doc suggests: "If DataSource can precisely construct affected MODEL_LIST pathIdentifier..."
          // This is hard. A simpler approach is to clear all listModels for that directory prefix if precise invalidation is too complex.
          // For now, let's try to be somewhat precise for the common cases.
          // Assuming default supportedExts and showSubdirectory=true are common.
          const listPathIdentifierTrue = this._generateListModelsPathIdentifier(relativeDirPath, true, supportedExts);
          await this.modelInfoCacheService.invalidateCacheEntry(CacheDataType.MODEL_LIST, sourceId, listPathIdentifierTrue);
          log.debug(`[LocalDataSource writeModelJson] Invalidated MODEL_LIST (showSubDir=true) for dir: ${relativeDirPath}, PI: ${listPathIdentifierTrue}`);
          
          const listPathIdentifierFalse = this._generateListModelsPathIdentifier(relativeDirPath, false, supportedExts);
          await this.modelInfoCacheService.invalidateCacheEntry(CacheDataType.MODEL_LIST, sourceId, listPathIdentifierFalse);
          log.debug(`[LocalDataSource writeModelJson] Invalidated MODEL_LIST (showSubDir=false) for dir: ${relativeDirPath}, PI: ${listPathIdentifierFalse}`);
          
          // A more robust but heavier approach would be clearCacheForSource(sourceId) or a prefix based L1 clear.
          // The document mentions: "clearCacheForSource(this.id) (this has a large impact)"
          // Or "rely on next fetch for MODEL_LIST due to contentHash mismatch". This is the safest.
          // The current invalidation of specific pathIdentifiers is a good attempt.
          log.info(`[LocalDataSource writeModelJson] Cache invalidation attempts complete for ${filePath}.`);
        }
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error(`[LocalDataSource] 写入模型 JSON 时出错: ${filePath}, 耗时: ${duration}ms`, error.message, error.stack);
      throw error;
    }
  }

  /**
   * Checks if a file exists.
   * @param {string} filePath - The full path to the file.
   * @returns {Promise<boolean>} True if the file exists, false otherwise.
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
   * Writes Buffer data to a local file.
   * @param {string} filePath - The full path to write the file.
   * @param {Buffer} dataBuffer - The Buffer data to write.
   * @returns {Promise<void>}
   * @throws {Error} If writing fails.
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
      const dirPath = path.dirname(filePath);
      try {
        await fs.promises.access(dirPath);
      } catch (accessError) {
        if (accessError.code === 'ENOENT') {
          log.info(`[LocalDataSource] 目录 ${dirPath} 不存在，正在创建...`);
          await fs.promises.mkdir(dirPath, { recursive: true });
        } else {
          throw accessError;
        }
      }
      await fs.promises.writeFile(filePath, dataBuffer);
      const duration = Date.now() - startTime;
      log.info(`[LocalDataSource] 成功写入文件: ${filePath}, 大小: ${(dataBuffer.length / 1024).toFixed(1)}KB, 耗时: ${duration}ms`);
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error(`[LocalDataSource] 写入文件时出错: ${filePath}, 耗时: ${duration}ms`, error.message, error.stack);
      throw error;
    }
  }

  /**
   * Gets file statistics (mtimeMs, size) for a local file.
   * Handles both absolute paths and paths relative to the data source root.
   * @param {string} filePathInput - The path to the file.
   * @returns {Promise<{mtimeMs: number, size: number}|null>} File stats or null if error/not found.
   */
  async getFileStats(filePathInput) {
    const startTime = Date.now();
    if (!filePathInput) {
      log.warn('[LocalDataSource] getFileStats called with empty filePathInput');
      return null;
    }
    const absoluteFilePath = path.isAbsolute(filePathInput)
      ? filePathInput
      : path.join(this.config.path, filePathInput);
    log.debug(`[LocalDataSource getFileStats] Path: ${absoluteFilePath} (Input: ${filePathInput})`);

    try {
      const stats = await fs.promises.stat(absoluteFilePath);
      const duration = Date.now() - startTime;
      log.debug(`[LocalDataSource getFileStats] Success for: ${absoluteFilePath}. Duration: ${duration}ms`);
      return {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      if (error.code === 'ENOENT') {
        log.debug(`[LocalDataSource getFileStats] File not found: ${absoluteFilePath}. Duration: ${duration}ms`);
      } else {
        log.error(`[LocalDataSource getFileStats] Error for: ${absoluteFilePath}. Duration: ${duration}ms`, error.message, error.stack);
      }
      return null;
    }
  }

  /**
   * Calculates a metadata digest (hash) for the content of a directory.
   * Used for cache invalidation of listModels results.
   * @param {string|null} relativeDirectory - Directory path relative to data source root. Null or empty for root.
   * @param {string[]} supportedExts - Supported model file extensions.
   * @param {boolean} showSubdirectory - Whether to include subdirectories.
   * @returns {Promise<string|null>} SHA256 hash string or null on error.
   */
  async getDirectoryContentMetadataDigest(relativeDirectory, supportedExts, showSubdirectory) {
    const startTime = Date.now();
    const rootPath = this.config.path;
    const targetDirectory = relativeDirectory ? path.join(rootPath, relativeDirectory) : rootPath;

    log.debug(`[LocalDataSource getDirectoryContentMetadataDigest] Dir: ${targetDirectory}, showSubDir: ${showSubdirectory}, exts: ${supportedExts.join(',')}`);

    // 新增并发限制
    const limit = pLimit(8);

    try {
      await fs.promises.access(targetDirectory);
    } catch (error) {
      if (error.code === 'ENOENT') {
        log.warn(`[LocalDataSource getDirectoryContentMetadataDigest] Directory not found: ${targetDirectory}`);
        return null;
      }
      log.error(`[LocalDataSource getDirectoryContentMetadataDigest] Error accessing dir: ${targetDirectory}`, error);
      return null;
    }

    const metadataItems = [];
    const lowerCaseSupportedExts = supportedExts.map(ext => ext.toLowerCase());

    const collectMetadata = async (currentPath) => {
      try {
        const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
        await Promise.all(entries.map(entry => limit(async () => {
          const entryFullPath = path.join(currentPath, entry.name);
          const relativeEntryPath = path.relative(targetDirectory, entryFullPath).replace(/\\/g, '/');

          if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (lowerCaseSupportedExts.includes(ext) || ext === '.json') {
              try {
                const stats = await fs.promises.stat(entryFullPath);
                metadataItems.push(`${relativeEntryPath}:${stats.size}:${stats.mtimeMs}`);
              } catch (statError) {
                if (statError.code !== 'ENOENT') {
                    log.warn(`[LocalDataSource getDirectoryContentMetadataDigest] Could not stat file: ${entryFullPath}`, statError);
                }
              }
            }
          } else if (entry.isDirectory() && showSubdirectory) {
            await collectMetadata(entryFullPath);
          }
        })));
      } catch (readDirError) {
         if (readDirError.code !== 'ENOENT') {
            log.warn(`[LocalDataSource getDirectoryContentMetadataDigest] Error reading dir: ${currentPath}`, readDirError);
         }
      }
    };

    await collectMetadata(targetDirectory);

    if (metadataItems.length === 0) {
      const durationEmpty = Date.now() - startTime;
      log.debug(`[LocalDataSource getDirectoryContentMetadataDigest] No relevant files in ${targetDirectory}. Duration: ${durationEmpty}ms. Returning empty hash.`);
      return crypto.createHash('sha256').update('').digest('hex');
    }

    metadataItems.sort();
    const metadataString = metadataItems.join('|');
    const hash = crypto.createHash('sha256').update(metadataString).digest('hex');

    const duration = Date.now() - startTime;
    log.info(`[LocalDataSource getDirectoryContentMetadataDigest] Calculated for ${targetDirectory}: ${hash}. Items: ${metadataItems.length}. Duration: ${duration}ms`);
    return hash;
  }
}

module.exports = {
  LocalDataSource
};