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
   * @param {ModelInfoCacheService} modelInfoCacheService - The cache service instance.
   */
  constructor(config, modelInfoCacheService, configService) {
    super(config, configService);
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
    const effectiveSupportedExts = this.configService.getSupportedExtensions();   


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
        log.debug(`[LocalDataSource InitAllSource walk] 读取目录: ${currentDir}, 相对路径: ${relativePath}`);
        const modelFiles = files.filter(f => f.isFile() && effectiveSupportedExts.some(ext => f.name.toLowerCase().endsWith(ext.toLowerCase())));
        log.debug(`[LocalDataSource InitAllSource walk] 过滤出当前目录中支持的模型文件: ${JSON.stringify(modelFiles, null, 2)}`);
        const modelsInCurrentDir = [];

        // 使用纯 async/await 串行处理模型文件
        for (const modelFile of modelFiles) {
          log.debug(`[LocalDataSource InitAllSource walk] Awaiting direct processing for: ${modelFile.name} in directory ${currentDir}`);
          // Directly await the file processing logic (IIFE or separate async function)
          await (async () => {
            log.debug(`[LocalDataSource InitAllSource walk] ENTERED direct async processing for: ${modelFile.name}`);
            const modelFilePath = path.join(currentDir, modelFile.name); 
            const relativeModelFilePath = path.relative(rootPath, modelFilePath); 
            const associatedJsonPath = modelFilePath.substring(0, modelFilePath.lastIndexOf('.')) + '.json'; 
            
            log.debug(`[LocalDataSource InitAllSource walk] Processing model file: ${modelFilePath}`); 
            let modelJsonInfo; 
            let jsonFileStats; 
            try {
              log.debug(`[LocalDataSource InitAllSource walk] Attempting to getFileStats for: ${associatedJsonPath}`); 
              jsonFileStats = await this.getFileStats(associatedJsonPath);
              log.debug(`[LocalDataSource InitAllSource walk] Completed getFileStats for: ${associatedJsonPath}. Stats: ${JSON.stringify(jsonFileStats)}`); 
            } catch (e) {
              log.warn(`[LocalDataSource InitAllSource] 无法获取关联JSON的统计信息: ${associatedJsonPath}`, e.message); 
              jsonFileStats = null;
            }
            log.debug(`[LocalDataSource InitAllSource walk] Attempting to _getJsonInfo for: ${associatedJsonPath}`); 
            modelJsonInfo = await this._getJsonInfo(associatedJsonPath, jsonFileStats);
            log.debug(`[LocalDataSource InitAllSource walk] Completed _getJsonInfo for: ${associatedJsonPath}. Has modelJsonInfo: ${!!modelJsonInfo}`); 
            const sourceConfig = { id: sourceId }; 
            log.debug(`[LocalDataSource InitAllSource walk] Attempting to parseSingleModelFile for: ${modelFilePath}`); 
            const modelObj = await parseSingleModelFile(modelFilePath, effectiveSupportedExts, sourceConfig, true, modelJsonInfo, jsonFileStats);
            log.debug(`[LocalDataSource InitAllSource walk] Completed parseSingleModelFile for: ${modelFilePath}. Has modelObj: ${!!modelObj}`); 
            if (modelObj) {
              modelObj.relativePath = relativePath.replace(/\\/g, '/');
              log.debug(`[InitAllSource walk] Model: ${modelObj.name}, Assigned relativePath: '${modelObj.relativePath}' (from walk's current relativePath: '${relativePath}')`);
              allModels.push(modelObj); 
              this.addfilterOptionsByModelObj(modelObj);
              modelsInCurrentDir.push(modelObj.file); 
            }
          })(); // End of IIFE for file processing
          log.debug(`[LocalDataSource InitAllSource walk] COMPLETED direct awaited processing for: ${modelFile.name} in directory ${currentDir}`);
        }

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

        // 使用纯 async/await 串行递归处理子目录
        for (const subDir of subDirs) {
          const subDirPath = path.join(currentDir, subDir.name); 
          const subDirRelativePath = relativePath ? `${relativePath}/${subDir.name}` : subDir.name; 
          log.debug(`[LocalDataSource InitAllSource walk] Awaiting direct walk for subdirectory: ${subDir.name}`);
          await walk(subDirPath, subDirRelativePath); // Directly await recursive call
          log.debug(`[LocalDataSource InitAllSource walk] COMPLETED direct walk for subdirectory: ${subDir.name}`);
        }
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
    this.modelsByDirectoryMap = modelsByDirectory;
    
    // 返回初始化结果
    const dirCacheCount = this._getAllPathsFromTree(this.directoryStructureCache).length;
    log.info(`[LocalDataSource InitAllSource] Caching complete. allModelsCache.length=${this.allModelsCache.length}, directoryStructureCache.dirCount=${dirCacheCount}, modelsByDirectory.size=${this.modelsByDirectoryMap.size}`);
    return {
      allModels,
      directoryStructure,
      modelsByDirectory
    };
  }

  async _getJsonInfo(jsonPath, currentMetadata) {
    const l2Rusult =  this.modelInfoCacheService.getDataFromCache(
      CacheDataType.MODEL_JSON_INFO,
      this.config.id,
      jsonPath,
      currentMetadata
    );

    if (!l2Rusult){

        try {
          const jsonContent = await fs.promises.readFile(jsonPath, 'utf-8'); // 读取JSON文件内容

          const modelJsonInfo = JSON.parse(jsonContent); // 解析JSON内容
          this.modelInfoCacheService.setDataToCache(
            CacheDataType.MODEL_JSON_INFO,
            this.config.id,
            jsonPath,
            modelJsonInfo,
            currentMetadata,
            'local'
          );
          return modelJsonInfo; 

        } catch (e) {
          if (e.code !== 'ENOENT') {
            log.warn(`[LocalDataSource InitAllSource] 读取/解析JSON时出错 ${jsonPath}: ${e.message}`); // 读取或解析JSON出错（非文件不存在错误），记录警告
          }
          return null;
      }
    }
    return l2Rusult;
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

  /**
   * 将内部目录树结构转换为前端可用的树结构
   * @param {Object} node - 内部目录树节点
   * @param {Map} modelCountMap - 每个目录的模型数量映射
   * @returns {Object} 转换后的节点
   * @private
   */
  _convertDirectoryNode(node, modelCountMap = null) {
    if (!node) return null;

    const result = {
      name: node.name || '全部', // Use '全部' for root node
      path: node.path || '/',
    };

    // 添加模型数量（如果可用）
    if (modelCountMap) {
      const count = modelCountMap.get(result.path);
      if (count) {
        result.count = count;
      }
    }

    // 添加子节点（如果有）
    if (node.children && node.children.length > 0) {
      result.children = node.children
        .map(child => this._convertDirectoryNode(child, modelCountMap))
        .filter(Boolean); // 过滤掉null
    }

    return result;
  }

  /**
   * 计算每个目录的模型数量
   * @returns {Map<string, number>} 目录路径到模型数量的映射
   * @private
   */
  _calculateDirectoryModelCounts() {
    const modelCountMap = new Map();
    
    // 首先计算每个实际目录中的模型数量
    for (const [dir, models] of this.modelsByDirectoryMap.entries()) {
      modelCountMap.set(dir, models.length);
    }
    
    // 然后，计算包含子目录模型的总数
    const paths = this._getAllPathsFromTree();
    for (const path of paths) {
      let totalCount = modelCountMap.get(path) || 0;
      
      // 添加所有子目录的模型数量
      for (const [dir, models] of this.modelsByDirectoryMap.entries()) {
        if (dir !== path && dir.startsWith(path + '/')) {
          totalCount += models.length;
        }
      }
      
      if (totalCount > 0) {
        modelCountMap.set(path, totalCount);
      }
    }
    
    return modelCountMap;
  }

  async listSubdirectories() {
    log.debug(`[LocalDataSource] listSubdirectories: 转换目录树结构`);
    
    if (!this.allModelsCache || this.allModelsCache.length === 0) {
      await this.InitAllSource();
    }
    
    // 计算每个目录的模型数量
    const modelCountMap = this._calculateDirectoryModelCounts();
    
    // 创建一个根节点，表示"全部"
    const rootNode = this._convertDirectoryNode(this.directoryStructureCache, modelCountMap);
    
    // 为根节点添加模型总数
    rootNode.count = this.allModelsCache.length;
    
    return [rootNode]; // 返回包含根节点的数组
  }



  /**
   * Lists models from the local file system.
   * @param {string|null} [directory=null] - The subdirectory to list models from. Relative to the source's root path.
   * @param {object} sourceConfig - The configuration for the current source (used for sourceId).
   * @param {string[]} [supportedExts=[]] - Array of supported model file extensions.
   * @param {boolean} [showSubdirectory=true] - Whether to include models from subdirectories.
   * @returns {Promise<Array<object>>} A promise that resolves to an array of model objects.
   */
  async listModels(directory = null, showSubdirectory = true) {
    if (!this.allModelsCache ||this.allModelsCache.length === 0) {
      await this.InitAllSource();
    }
    if (!directory || directory === ""){
      directory = "/";
    }
    const normalizedDirectory = directory.replace(/\\/g, '/');

    if (normalizedDirectory === '/' && showSubdirectory === true) {
      return [...this.allModelsCache];
    }


    const rootNams = this.modelsByDirectoryMap.get(normalizedDirectory) || [];
    log.info(`[LocalDataSource] [listModels] Listing models from directory: ${normalizedDirectory}`);

    const uniqueNames = new Set([...rootNams]);
    if (showSubdirectory === true){
      for (const [key, names] of this.modelsByDirectoryMap) {
        if (key.startsWith(normalizedDirectory + "/")) {
          const subPath = key.slice((normalizedDirectory + "/").length);
          if (subPath && !subPath.includes("/")) {
            names.forEach(name => uniqueNames.add(name));
          }
        }
      }

    }

    const result = this.allModelsCache.filter(model =>
      model && model.file && uniqueNames.has(model.file));

    if (!result) return [];
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
    if (!this.allModelsCache || this.allModelsCache.length === 0) {
      await this.InitAllSource();
    }

    const fileName = modelFilePath.replace(/\\/g, '/');
    const foundItem = this.allModelsCache.find(item => item && item.file === fileName);
    log.info(`[LocalDataSource] 找到模型: name=${fileName} foundItem=${JSON.stringify(foundItem, null, 2)} `);

    return foundItem ? foundItem : null;
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
    const fileName = filePath.replace(/\\/g, '/'); 

    try {
      const dirPath = path.dirname(fileName);
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

      await fs.promises.writeFile(fileName, dataToWrite, 'utf-8');
      const duration = Date.now() - startTime;
      log.info(`[LocalDataSource] 成功写入模型 JSON: ${fileName}, 耗时: ${duration}ms`);

      // --- Update allModelsCache ---
      try {
        const newJsonData = JSON.parse(dataToWrite);
        const modelNameWithoutExt = path.basename(fileName, '.json');
        
        const relativeJsonPath = path.relative(this.config.path, fileName).replace(/\\/g, '/');
        let relativeDirOfJson = path.dirname(relativeJsonPath);
        if (relativeDirOfJson === '.') {
          relativeDirOfJson = ''; // Consistent with how relativePath is stored for root models
        }

        const newJsonFileStats = await this.getFileStats(fileName);

        // --- Update L2 Cache (MODEL_JSON_INFO) ---
        if (this.modelInfoCacheService && this.config.id && newJsonFileStats) {
          try {
            log.info(`[LocalDataSource writeModelJson] Updating L2 Cache (MODEL_JSON_INFO) for: ${relativeJsonPath}`);
            this.modelInfoCacheService.setDataToCache(
              CacheDataType.MODEL_JSON_INFO,
              this.config.id,
              relativeJsonPath, // Using relativeJsonPath as pathIdentifier
              newJsonData,
              newJsonFileStats,
              'local'
            );
            log.debug(`[LocalDataSource writeModelJson] Successfully updated L2 Cache for: ${relativeJsonPath}`);
          } catch (l2CacheError) {
            log.error(`[LocalDataSource writeModelJson] Error updating L2 Cache (MODEL_JSON_INFO) for ${relativeJsonPath}: ${l2CacheError.message}`, l2CacheError.stack);
          }
        } else {
          if (!this.modelInfoCacheService) log.warn('[LocalDataSource writeModelJson] modelInfoCacheService is not available for L2 cache update.');
          if (!this.config.id) log.warn('[LocalDataSource writeModelJson] config.id is missing for L2 cache update.');
          if (!newJsonFileStats) log.warn('[LocalDataSource writeModelJson] newJsonFileStats is not available for L2 cache update.');
        }


        const modelIndex = this.allModelsCache.findIndex(model => {
          if(model.jsonPath === fileName) return true;
          return false;

        });

        if (modelIndex !== -1) {
          const modelToUpdate = this.allModelsCache[modelIndex];
          log.info(`[LocalDataSource writeModelJson] Updating model in allModelsCache: ${modelToUpdate.file}`);

          const fullModelFilePath = modelToUpdate.file;
          const effectiveSupportedExts = this.configService.getSupportedExtensions()||[]; 
          
          try {
            const updatedModelObject = await parseSingleModelFile(
              fullModelFilePath,
              effectiveSupportedExts,
              this.config,
              true, // scanForJson - though we are providing it
              newJsonData, // Provide the new JSON data directly
              newJsonFileStats // Provide the new JSON file stats
            );

            if (updatedModelObject) {
              updatedModelObject.relativePath = modelToUpdate.relativePath;
              this.allModelsCache[modelIndex] = updatedModelObject;
              log.info(`[LocalDataSource writeModelJson] Successfully re-parsed and updated model in allModelsCache: ${updatedModelObject.file}`);
            } else {
              log.warn(`[LocalDataSource writeModelJson] Re-parsing model ${fullModelFilePath} after JSON update returned null. Cache for this model might be inconsistent until next InitAllSource.`);
            }
          } catch (parseError) {
            log.error(`[LocalDataSource writeModelJson] Error re-parsing model ${fullModelFilePath} after JSON update: ${parseError.message}`, parseError.stack);
          }
        } else {
          log.info(`[LocalDataSource writeModelJson] Model for JSON ${fileName} not found in allModelsCache. It will be processed by the next InitAllSource if it's a new model or its corresponding model file is found.`);
        }
      } catch (cacheUpdateError) {
        log.error(`[LocalDataSource writeModelJson] Error updating allModelsCache for ${fileName}: ${cacheUpdateError.message}`, cacheUpdateError.stack);
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error(`[LocalDataSource] 写入模型 JSON 时出错: ${fileName}, 耗时: ${duration}ms`, error.message, error.stack);
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
        metadata_lastModified_ms: stats.mtimeMs,
        fileSize: stats.size,
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


}

module.exports = {
  LocalDataSource
};