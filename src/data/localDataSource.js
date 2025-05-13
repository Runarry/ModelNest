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
    this.directoryStructureCache = {
      name: "root",
      path: "",
      children: []
    };
    this.modelsByDirectoryMap = new Map();
    if (!this.config || !this.config.id) {
      log.error('[LocalDataSource] Constructor: config.id is missing. Cache functionality might be impaired.');
    }

  }

  /**
   * 初始化所有本地数据源。
   * 遍历配置的根目录，查找支持的模型文件，并解析其信息。
   * 同时构建目录结构和目录与模型的映射关系。
   * @returns {Promise<{allModels: Array, directoryStructure: Array, modelsByDirectory: Map}>} 包含所有模型、目录结构和目录与模型映射的对象。
   */
  async InitAllSource(){
    const startTime = Date.now(); // 记录开始时间
    const rootPath = this.config.path; // 获取配置的根目录路径
    const sourceId = this.config.id; // 获取数据源ID
    log.info(`[LocalDataSource InitAllSource] 开始初始化所有数据源: ${rootPath}, SourceId: ${sourceId}`); // 记录初始化开始日志

    // 确定支持的文件扩展名
    let effectiveSupportedExts;
    if (this.config && this.config.supportedExts && this.config.supportedExts.length > 0) {
      effectiveSupportedExts = this.config.supportedExts; // 使用配置中指定的支持扩展名
    } else {
      effectiveSupportedExts = ['.safetensors', '.ckpt', '.pt', '.pth', '.bin']; // 如果未配置，使用默认扩展名
      log.warn(`[LocalDataSource InitAllSource] 未提供或配置 supportedExts，使用默认值: ${effectiveSupportedExts.join(', ')}`); // 记录使用默认值的警告
    }

    // 设置并发限制，限制同时处理的文件或目录数量
    const limit = pLimit(8);

    // 初始化用于存储结果的数据结构
    let allModels = []; // 存储所有找到的模型对象
    let directoryStructure = {
      name: "root",
      path: "",
      children: []
    }; // 存储完整的目录结构（树形结构）
    let modelsByDirectory = new Map(); // 存储目录与其中模型名称列表的映射关系

    // 检查根目录是否存在且可访问
    try {
      await fs.promises.access(rootPath);
    } catch (error) {
      const duration = Date.now() - startTime; // 计算耗时
      if (error.code === 'ENOENT') {
        log.warn(`[LocalDataSource InitAllSource] 目录不存在: ${rootPath}. 耗时: ${duration}ms`); // 目录不存在，记录警告并返回空结果
        return { allModels: [], directoryStructure: [], modelsByDirectory: new Map() };
      }
      log.error(`[LocalDataSource InitAllSource] 访问模型目录时出错: ${rootPath}. 耗时: ${duration}ms`, error.message, error.stack); // 访问目录出错，记录错误并返回空结果
      return { allModels: [], directoryStructure: [], modelsByDirectory: new Map() };
    }

    // 定义递归遍历目录的异步函数
    const walk = async (currentDir, relativePath = '') => {
      try {
        // 读取当前目录下的文件和子目录
        const files = await fs.promises.readdir(currentDir, { withFileTypes: true });
        
        // 过滤出当前目录中支持的模型文件
        const modelFiles = files.filter(f => f.isFile() && effectiveSupportedExts.some(ext => f.name.toLowerCase().endsWith(ext.toLowerCase())));
        
        // 存储当前目录中的模型名称
        const modelsInCurrentDir = [];

        // 使用并发限制处理模型文件
        await Promise.all(modelFiles.map(modelFile => limit(async () => {
          const modelFilePath = path.join(currentDir, modelFile.name); // 构建模型文件的完整路径
          const relativeModelFilePath = path.relative(rootPath, modelFilePath); // 构建模型文件的相对路径
          const associatedJsonPath = modelFilePath.substring(0, modelFilePath.lastIndexOf('.')) + '.json'; // 构建关联JSON文件的路径
          
          let modelJsonInfo; // 存储从JSON文件解析的模型信息
          let jsonFileStats; // 存储关联JSON文件的统计信息

          // 尝试获取关联JSON文件的统计信息
          try {
            jsonFileStats = await this.getFileStats(associatedJsonPath);
          } catch (e) {
            log.warn(`[LocalDataSource InitAllSource] 无法获取关联JSON的统计信息: ${associatedJsonPath}`, e.message); // 获取统计信息失败，记录警告
            jsonFileStats = null;
          }

          // 如果成功获取到JSON文件统计信息，则尝试读取和解析JSON文件
          if (jsonFileStats) {
            try {
              const jsonContent = await fs.promises.readFile(associatedJsonPath, 'utf-8'); // 读取JSON文件内容
              modelJsonInfo = JSON.parse(jsonContent); // 解析JSON内容
            } catch (e) {
              if (e.code !== 'ENOENT') {
                log.warn(`[LocalDataSource InitAllSource] 读取/解析JSON时出错 ${associatedJsonPath}: ${e.message}`); // 读取或解析JSON出错（非文件不存在错误），记录警告
              }
              modelJsonInfo = null; // 解析失败，模型信息设为null
            }
          }
          
          const sourceConfig = { id: sourceId }; // 构建数据源配置对象
          // 解析单个模型文件，获取模型对象
          const modelObj = await parseSingleModelFile(modelFilePath, effectiveSupportedExts, sourceConfig, true, modelJsonInfo, jsonFileStats);
          
          // 如果成功解析出模型对象，则添加到结果列表中
          if (modelObj) {
            // 确保 modelObj 有 relativePath 属性，与 listModels 中的筛选逻辑对应
            // relativePath 是当前 modelObj 所在的目录相对于 rootPath 的路径
            modelObj.relativePath = relativePath.replace(/\\/g, '/');
            log.debug(`[InitAllSource walk] Model: ${modelObj.name}, Assigned relativePath: '${modelObj.relativePath}' (from walk's current relativePath: '${relativePath}')`);
            allModels.push(modelObj); // 添加到所有模型列表
            modelsInCurrentDir.push(modelObj.name); // 添加到当前目录的模型名称列表
          }
        })));

        // 如果当前目录有模型，添加到目录与模型名称的映射中
        if (modelsInCurrentDir.length > 0) {
          const dirKey = relativePath || '/'; // 根目录用 '/' 表示作为key
          modelsByDirectory.set(dirKey, modelsInCurrentDir); // 设置目录与模型名称列表的映射
        }

        // 过滤出当前目录下的子目录
        const subDirs = files.filter(f => f.isDirectory());
        
        // 将子目录添加到目录结构树中
        for (const subDir of subDirs) {
          const subDirRelativePath = relativePath ? `${relativePath}/${subDir.name}` : subDir.name; // 构建子目录的相对路径
          
          // 创建子目录节点
          const subDirNode = {
            name: subDir.name,
            path: subDirRelativePath,
            children: []
          };
          
          // 将子目录节点添加到当前目录的children中
          this._addNodeToDirectoryTree(directoryStructure, relativePath, subDirNode);
        }

        // 使用并发限制递归处理子目录
        await Promise.all(subDirs.map(subDir => limit(async () => {
          const subDirPath = path.join(currentDir, subDir.name); // 构建子目录的完整路径
          const subDirRelativePath = relativePath ? `${relativePath}/${subDir.name}` : subDir.name; // 构建子目录的相对路径
          await walk(subDirPath, subDirRelativePath); // 递归调用walk函数处理子目录
        })));
      } catch (error) {
        // 遍历目录时出错处理
        if (error.code === 'ENOENT') {
          log.warn(`[LocalDataSource InitAllSource] 遍历过程中目录不存在: ${currentDir}`); // 遍历过程中目录不存在，记录警告
        } else {
          log.error(`[LocalDataSource InitAllSource] 遍历目录时出错: ${currentDir}`, error.message, error.stack); // 其他遍历目录错误，记录错误
        }
      }
    };

    // 从根目录开始遍历
    await walk(rootPath);

    const duration = Date.now() - startTime; // 计算总耗时
    const dirCount = this._getAllPathsFromTree(directoryStructure).length;
    log.info(`[LocalDataSource InitAllSource] 完成. 路径: ${rootPath}, 耗时: ${duration}ms, 找到 ${allModels.length} 个模型, ${dirCount} 个目录`); // 记录完成日志，包括耗时、模型数量和目录数量
    
    // 缓存结果
    this.allModelsCache = allModels;
    this.directoryStructureCache = directoryStructure;
    this.modelsByDirectoryCache = modelsByDirectory;
    
    // 返回初始化结果
    const dirCacheCount = this._getAllPathsFromTree(this.directoryStructureCache).length;
    log.info(`[LocalDataSource InitAllSource] Caching complete. allModelsCache.length=${this.allModelsCache.length}, directoryStructureCache.dirCount=${dirCacheCount}, modelsByDirectoryCache.size=${this.modelsByDirectoryCache.size}`);
    return {
      allModels,
      directoryStructure,
      modelsByDirectory
    };
  }


  /**
   * 将节点添加到目录树的正确位置
   * @param {object} tree - 目录树
   * @param {string} parentPath - 父目录路径
   * @param {object} node - 要添加的节点
   * @private
   */
  _addNodeToDirectoryTree(tree, parentPath, node) {
    if (!parentPath || parentPath === '') {
      // 如果父路径为空，直接添加到根节点的children
      tree.children.push(node);
      return;
    }
    
    // 分割父路径，找到正确的父节点
    const pathParts = parentPath.split('/');
    let currentNode = tree;
    
    // 遍历路径部分，找到父节点
    for (const part of pathParts) {
      const found = currentNode.children.find(child => child.name === part);
      if (found) {
        currentNode = found;
      } else {
        // 如果找不到父节点，说明树结构有问题
        log.warn(`[LocalDataSource] 在目录树中找不到父节点: ${part} in ${parentPath}`);
        return;
      }
    }
    
    // 将节点添加到找到的父节点的children中
    currentNode.children.push(node);
  }
  
  /**
   * 从目录树中获取所有路径（扁平化）
   * @param {object} node - 当前节点
   * @param {Array} result - 结果数组
   * @private
   */
  _getAllPathsFromTree(node = null, result = []) {
    if (!node) {
      node = this.directoryStructureCache;
    }
    
    if (node.path !== '') {
      result.push(node.path);
    }
    
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        this._getAllPathsFromTree(child, result);
      }
    }
    
    return result;
  }
  
  /**
   * 根据路径从目录树中获取节点
   * @param {string} path - 要查找的路径
   * @returns {object|null} 找到的节点或null
   * @private
   */
  _getNodeByPath(path) {
    if (!path || path === '' || path === '/') {
      return this.directoryStructureCache;
    }
    
    const pathParts = path.split('/');
    let currentNode = this.directoryStructureCache;
    
    for (const part of pathParts) {
      if (!currentNode.children) {
        return null;
      }
      
      const found = currentNode.children.find(child => child.name === part);
      if (!found) {
        return null;
      }
      
      currentNode = found;
    }
    
    return currentNode;
  }

  async listSubdirectories() {
    const paths = this._getAllPathsFromTree();
    log.debug(`[LocalDataSource] listSubdirectories: paths=${paths}`);
    return paths;
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
    let normalizedDirectory = directory ? path.normalize(directory) : '';
    // 统一路径分隔符为 /，与 InitAllSource 中的 relativePath 保持一致
    normalizedDirectory = normalizedDirectory.replace(/\\/g, '/');
    if (normalizedDirectory.endsWith('/') && normalizedDirectory.length > 1) {
      normalizedDirectory = normalizedDirectory.slice(0, -1);
    }
    // 将 '.' 视作根目录，与 InitAllSource 中 relativePath='' 的处理保持一致
    if (normalizedDirectory === '.') {
      normalizedDirectory = '';
    }

    // 确定有效的支持扩展名
    let effectiveSupportedExts;
    if (supportedExts && supportedExts.length > 0) {
      effectiveSupportedExts = supportedExts;
    } else if (this.config && this.config.supportedExts && this.config.supportedExts.length > 0) {
      effectiveSupportedExts = this.config.supportedExts;
    } else {
      effectiveSupportedExts = ['.safetensors', '.ckpt', '.pt', '.pth', '.bin'];
      log.warn(`[LocalDataSource listModels] 未提供或配置 supportedExts，使用默认值: ${effectiveSupportedExts.join(', ')}`);
    }

    const pathIdentifier = this._generateListModelsPathIdentifier(normalizedDirectory, showSubdirectory, effectiveSupportedExts);
    log.info(`[LocalDataSource listModels] 根路径: ${rootPath}, 目录: ${normalizedDirectory}, 数据源ID: ${sourceId}, 路径标识符: ${pathIdentifier}`);

    // 检查内存缓存是否已初始化
    if (!this.allModelsCache || this.allModelsCache.length === 0 ) {
      log.info(`[LocalDataSource listModels] 内存缓存未初始化，正在调用 InitAllSource 初始化缓存`);
      const cacheResult = await this.InitAllSource();
      this.allModelsCache = cacheResult.allModels;
      this.directoryStructureCache = cacheResult.directoryStructure;
      this.modelsByDirectoryCache = cacheResult.modelsByDirectory;
      
      if (!this.allModelsCache || this.allModelsCache.length === 0) {
        log.warn(`[LocalDataSource listModels] 初始化缓存失败或未找到模型，返回空数组`);
        return [];
      }
      // 在所有筛选逻辑开始前，打印缓存的实际状态
      log.debug(`[LocalDataSource listModels] After cache init check. allModelsCache.length=${this.allModelsCache?.length || 0}, modelsByDirectoryCache.size=${this.modelsByDirectoryCache?.size || 0}`);
    }

    // 检查目录是否存在
    const startPath = directory ? path.join(rootPath, normalizedDirectory) : rootPath;
    try {
      await fs.promises.access(startPath);
    } catch (error) {
      const duration = Date.now() - startTime;
      if (error.code === 'ENOENT') {
        log.warn(`[LocalDataSource listModels] 目录不存在: ${startPath}. 耗时: ${duration}ms`);
        return [];
      }
      log.error(`[LocalDataSource listModels] 访问模型目录时出错: ${startPath}. 耗时: ${duration}ms`, error.message, error.stack);
      return [];
    }

    // 从内存缓存中筛选模型
    let result = [];
    const dirKey = normalizedDirectory || '/'; // 根目录用 '/' 表示, normalizedDirectory 已经处理过分隔符

    // 打印缓存信息，帮助调试
    const dirCacheCount = this._getAllPathsFromTree().length;
    log.debug(`[LocalDataSource listModels] 缓存信息: allModelsCache.length=${this.allModelsCache?.length || 0}, directoryStructureCache.dirCount=${dirCacheCount}, modelsByDirectoryCache.size=${this.modelsByDirectoryCache?.size || 0}`);
    if (this.modelsByDirectoryCache) {
      const keys = Array.from(this.modelsByDirectoryCache.keys());
      log.debug(`[LocalDataSource listModels] modelsByDirectoryCache 目录键 (${keys.length}个): ${keys.slice(0, 10).join('; ')}${keys.length > 10 ? '...' : ''}`);
    }
    log.debug(`[LocalDataSource listModels] 查询目录键: '${dirKey}', 在缓存中是否存在: ${this.modelsByDirectoryCache?.has(dirKey)}`);
    
    if (showSubdirectory) {
      // 如果包含子目录，则需要从所有模型中筛选
      if (normalizedDirectory === '' || normalizedDirectory === null || normalizedDirectory=== "./") {
        // 如果是根目录，直接返回所有模型
        result = [...this.allModelsCache];
      } else {
        // 筛选出指定目录及其子目录下的所有模型
        // 使用与 InitAllSource 相同的路径处理逻辑
        const dirPrefix = normalizedDirectory + '/';
        result = this.allModelsCache.filter(model => {
          // model.relativePath 是在 InitAllSource 中计算的，已经使用了 / 分隔符
          const modelRelativePath = model.relativePath || '';
          
          const isMatch = (normalizedDirectory === '') ? true : (modelRelativePath === normalizedDirectory || modelRelativePath.startsWith(dirPrefix));
          log.debug(`[listModels filter SBD=true] Model: ${model.name}, modelRelPath: '${modelRelativePath}', normDir: '${normalizedDirectory}', dirPrefix: '${dirPrefix}', Match: ${isMatch}`);
          
          if (normalizedDirectory === '') { // 根目录，包含所有子目录
            return true; // allModelsCache 已经是该数据源下的所有模型
          }
          return modelRelativePath === normalizedDirectory || modelRelativePath.startsWith(dirPrefix);
        });
      }
    } else {
      // 如果不包含子目录，则只返回当前目录下的模型
      if (this.modelsByDirectoryCache && this.modelsByDirectoryCache.has(dirKey)) {
        // 从目录映射中获取当前目录下的模型名称
        const modelNames = this.modelsByDirectoryCache.get(dirKey);
        // 根据名称从所有模型中筛选出对应的模型对象
        result = this.allModelsCache.filter(model => {
          // 确保模型不仅名称匹配，其相对路径也与当前查询的目录键匹配
          // dirKey 已经是用 / 分隔的 normalizedDirectory
          const modelRelPathNormalized = (model.relativePath || '').replace(/\\/g, '/');
          const isMatch = modelNames.includes(model.name) && modelRelPathNormalized === dirKey;
          log.debug(`[listModels filter SBD=false] Model: ${model.name}, modelRelPathNorm: '${modelRelPathNormalized}', dirKey: '${dirKey}', NameMatch: ${modelNames.includes(model.name)}, PathMatch: ${modelRelPathNormalized === dirKey}, OverallMatch: ${isMatch}`);
          return isMatch;
        });
      }
    }

    // 根据支持的扩展名筛选
    log.debug(`[listModels] Before extension filter, result.length: ${result.length}`);
    if (result.length > 0 && result[0]) {
      log.debug(`[listModels] First model before ext filter: Name: ${result[0].name}, Filename: ${result[0].filename}`);
    }

    if (effectiveSupportedExts && effectiveSupportedExts.length > 0) {
      log.debug(`[listModels] Applying extension filter. effectiveSupportedExts: ${effectiveSupportedExts.join(',')}`);
      result = result.filter(model => {
        const modelFileFullPath = model.file || ''; // 使用 model.file 获取完整路径
        const modelFilenameForLog = path.basename(modelFileFullPath); // 用于日志记录
        const ext = path.extname(modelFileFullPath).toLowerCase(); // 从完整路径获取扩展名
        const isSupported = effectiveSupportedExts.some(supportedExt => supportedExt.toLowerCase() === ext);
        log.debug(`[listModels ext_filter] Model: ${model.name}, FileFullPath: '${modelFileFullPath}', FilenameForLog: '${modelFilenameForLog}', Ext: '${ext}', Supported: ${isSupported}`);
        return isSupported;
      });
      log.debug(`[listModels] After extension filter, result.length: ${result.length}`);
    }

    const duration = Date.now() - startTime;
    log.info(`[LocalDataSource listModels] 完成。路径: ${normalizedDirectory}, 耗时: ${duration}ms, 找到 ${result.length} 个模型`);
    
    // 如果启用了外部缓存服务，也将结果存入外部缓存
    if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled && sourceId) {
      const currentContentHash = await this.getDirectoryContentMetadataDigest(normalizedDirectory, effectiveSupportedExts, showSubdirectory);
      if (currentContentHash) {
        log.info(`[LocalDataSource listModels] 将 MODEL_LIST 存入外部缓存。路径标识符: ${pathIdentifier}, 哈希: ${currentContentHash}`);
        await this.modelInfoCacheService.setDataToCache(
          CacheDataType.MODEL_LIST,
          sourceId,
          pathIdentifier,
          result,
          { contentHash: currentContentHash },
          'local' // sourceTypeForTTL
        );
      }
    }

    return result;
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