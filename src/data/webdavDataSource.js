const DataSource = require('./baseDataSource'); // 导入新的基类
const { CacheDataType } = require('../services/constants/cacheConstants');
const {createWebDavModelObject } = require('./modelParser'); // 导入 createWebDavModelObject
const path = require('path');
const log = require('electron-log'); // 添加 electron-log 导入
const crypto = require('crypto'); // 引入 crypto 模块

/**
 * Parses a WebDAV lastmod timestamp string into milliseconds.
 * @param {string | undefined | null} lastmodStr - The lastmod string from WebDAV.
 * @returns {number | null} Timestamp in milliseconds, or null if input is invalid.
 * @private
 */
function _parseWebDavTimestamp(lastmodStr) {
  if (!lastmodStr) return null;
  const date = new Date(lastmodStr);
  if (isNaN(date.getTime())) {
    log.warn(`[WebDavDataSourceUtils] Invalid date string for lastmod: ${lastmodStr}`);
    return null;
  }
  return date.getTime();
}


/**
 * Represents a WebDAV data source for models.
 * @extends DataSource
 */
class WebDavDataSource extends DataSource {
  /**
   * Creates an instance of WebDavDataSource.
   * @param {object} config - The configuration object for this data source.
   * @param {string} config.id - The unique ID of this data source.
   * @param {string} config.url - The WebDAV server URL.
   * @param {string} config.username - The WebDAV username.
   * @param {string} config.password - The WebDAV password.
   * @param {string} [config.subDirectory=''] - The subdirectory within the WebDAV server.
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
    
    // Store the subDirectory, remove trailing slash if present, default to empty string
    this.subDirectory = (config.subDirectory || '').replace(/\/$/, '');
    log.info(`[WebDavDataSource][${this.config.id}] Initialized with subDirectory: '${this.subDirectory}'`);
    
    // 内部缓存
    this._allItemsCache = [];
    this._lastRefreshedFromRootPath = null;
    
    this.initialized = this.initClient(config);
    this.logger = log.scope(`DataSource:WebDAV:${this.config.id}`);
    
    if (!this.config || !this.config.id) {
      log.error('[WebDavDataSource] Constructor: config.id is missing. Cache functionality might be impaired.');
    }
  }


  /**
   * 从 JSON 文件获取信息
   * @param {string} jsonPath - JSON 文件路径
   * @param {object} currentMetadata - 当前元数据
   * @returns {Promise<object|null>} JSON 信息对象或 null
   * @private
   */
  async _getJsonInfo(jsonPath, currentMetadata) {
    const l2Result = this.modelInfoCacheService.getDataFromCache(
      CacheDataType.MODEL_JSON_INFO,
      this.config.id,
      jsonPath,
      currentMetadata
    );

    if (!l2Result) {
      try {
        const jsonContent = await this.client.getFileContents(jsonPath, { format: 'text' });
        const modelJsonInfo = JSON.parse(jsonContent);
        
        this.modelInfoCacheService.setDataToCache(
          CacheDataType.MODEL_JSON_INFO,
          this.config.id,
          jsonPath,
          modelJsonInfo,
          currentMetadata,
          'webdav'
        );
        
        return modelJsonInfo;
      } catch (e) {
        if (e.response && e.response.status !== 404) {
          this.logger.warn(`[WebDavDataSource InitAllSource] 读取/解析JSON时出错 ${jsonPath}: ${e.message}`);
        }
        return null;
      }
    }
    
    return l2Result;
  }

  /**
   * 初始化所有 WebDAV 数据源。
   * 遍历配置的根目录，查找支持的模型文件，并解析其信息。
   * 同时构建目录结构和目录与模型的映射关系。
   * @returns {Promise<{allModels: Array, directoryStructure: Object, modelsByDirectory: Map}>} 包含所有模型、目录结构和目录与模型映射的对象。
   */
  async InitAllSource() {
    const startTime = Date.now();
    await this.ensureInitialized();
    const sourceId = this.config.id;
    this.logger.info(`[WebDavDataSource InitAllSource] 开始初始化所有数据源: ${sourceId}`);

    // 确定支持的文件扩展名
    const effectiveSupportedExts = this.configService.getSupportedExtensions()||[]; 


    // 获取根路径
    const resolvedRootOfSource = this._resolvePath('/');
    this.logger.info(`[WebDavDataSource InitAllSource] 解析后的根路径: ${resolvedRootOfSource}`);

    // Moved declarations to function scope
    let allModels = [];
    let modelsByDirectory = new Map();

    try {
      // Ensure _allItemsCache 已填充
      await this._populateAllItemsCacheIfNeeded(resolvedRootOfSource);
      
      // 收集所有目录
      const dirSet = new Set();
      dirSet.add('/'); // 添加根目录
      
      // 从 _allItemsCache 中提取所有目录路径
      for (const item of this._allItemsCache) {
        if (item.relativePath) {
          const dirPath = path.posix.dirname(item.relativePath);
          if (dirPath !== '/') {
            // 添加当前目录及其所有父目录到目录结构中
            let currentPath = dirPath;
            while (currentPath && currentPath !== '/' && !dirSet.has(currentPath)) {
              dirSet.add(currentPath);
              currentPath = path.posix.dirname(currentPath);
            }
          }
        }
      }
      
      // 构建目录树结构
      // Clear existing children before rebuilding the tree
      this.directoryStructureCache.children = []; 
      for (const dir of dirSet) {
        if (dir !== '/') {
          // 确保目录名不包含 /
          const dirName = path.posix.basename(dir);
          const parentPath = path.posix.dirname(dir);
          
          const dirNode = {
            name: dirName,  // 目录名不应包含 /
            path: dir,      // 完整路径可以包含 /
            children: []
          };
          
          this._addNodeToDirectoryTree(this.directoryStructureCache, parentPath, dirNode);
        }
      }
      
      // 过滤出所有模型文件
      const modelFileItems = this._allItemsCache.filter(item =>
        item.type === 'file' && effectiveSupportedExts.some(ext =>
          item.filename.toLowerCase().endsWith(ext.toLowerCase())
        )
      );
      
      this.logger.info(`[WebDavDataSource InitAllSource] 找到 ${modelFileItems.length} 个潜在模型文件`);
      
      // 预获取所有可能的 JSON 文件内容
      const potentialJsonFileFullPaths = new Set();
      for (const modelFile of modelFileItems) {
        const modelFileDirRelative = path.posix.dirname(modelFile.relativePath);
        const modelFileBase = path.posix.basename(modelFile.relativePath, path.posix.extname(modelFile.relativePath));
        
        for (const cachedItem of this._allItemsCache) {
          const cachedItemDirRelative = path.posix.dirname(cachedItem.relativePath);
          if (cachedItemDirRelative === modelFileDirRelative) {
            const itemBase = path.posix.basename(cachedItem.relativePath, path.posix.extname(cachedItem.relativePath));
            const itemExt = path.posix.extname(cachedItem.relativePath).toLowerCase();
            if (itemBase === modelFileBase && itemExt === '.json') {
              potentialJsonFileFullPaths.add(cachedItem.filename);
              break;
            }
          }
        }
      }
      
      const uniqueJsonFilePaths = Array.from(potentialJsonFileFullPaths);
      let preFetchedJsonContentsMap = new Map();
      
      if (uniqueJsonFilePaths.length > 0) {
        this.logger.info(`[WebDavDataSource InitAllSource] 预获取 ${uniqueJsonFilePaths.length} 个 JSON 文件`);
        preFetchedJsonContentsMap = await this._batchFetchJsonContents(uniqueJsonFilePaths);
      }
      
      // 初始化用于存储结果的数据结构
      allModels = [];
      modelsByDirectory = new Map();

      this.logger.info(`[WebDavDataSource InitAllSource] Sequentially building ${modelFileItems.length} model entries.`);

      for (const modelFile of modelFileItems) {
        this.logger.debug(`[WebDavDataSource InitAllSource] Awaiting _buildModelEntry for: ${modelFile.filename}`);
        try {
          const modelObj = await this._buildModelEntry(modelFile, sourceId, resolvedRootOfSource, preFetchedJsonContentsMap);
          this.logger.debug(`[WebDavDataSource InitAllSource] Completed _buildModelEntry for: ${modelFile.filename}. Has modelObj: ${!!modelObj}`);
          
          if (modelObj) {
            allModels.push(modelObj);
            const modelPath = modelObj.relativePath || modelObj.fileName || modelObj.file || '/';
            const modelDir = path.posix.dirname(modelPath);
            const dirKey = modelDir === '.' ? '/' : modelDir;
            if (!modelsByDirectory.has(dirKey)) {
              modelsByDirectory.set(dirKey, []);
            }
            modelsByDirectory.get(dirKey).push(modelObj.file);
          }
        } catch (buildError) {
          // Log error from _buildModelEntry if it throws and is not caught internally
          this.logger.error(`[WebDavDataSource InitAllSource] Error building model entry for ${modelFile.filename}: ${buildError.message}`, buildError.stack);
        }
      }
      
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`[WebDavDataSource InitAllSource] 初始化过程中出错: ${error.message}, 耗时: ${duration}ms`, error.stack);
      // Return an explicitly empty directory structure
      return { allModels: [], directoryStructure: { name: "root", path: "", children: [] }, modelsByDirectory: new Map() };
    }
    
    const duration = Date.now() - startTime;
    const dirCount = this._getAllPathsFromTree(this.directoryStructureCache).length;
    this.logger.info(`[WebDavDataSource InitAllSource] 完成. 耗时: ${duration}ms, 找到 ${allModels.length} 个模型, ${dirCount} 个目录`);
    
    // 缓存结果
    this.allModelsCache = allModels;
    this.modelsByDirectoryMap = modelsByDirectory;
    
    // 返回初始化结果
    const dirCacheCount = this._getAllPathsFromTree(this.directoryStructureCache).length;
    this.logger.info(`[WebDavDataSource InitAllSource] Caching complete. allModelsCache.length=${this.allModelsCache.length}, directoryStructureCache.dirCount=${dirCacheCount}, modelsByDirectory.size=${this.modelsByDirectoryMap.size}`);
    
    return {
      allModels,
      directoryStructure: this.directoryStructureCache,
      modelsByDirectory
    };
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

  _resolvePath(relativePath) {
    const normalizedRelative = relativePath && relativePath !== '/' && !relativePath.startsWith('/')
      ? `/${relativePath}`
      : relativePath || '/'; 

    if (!this.subDirectory) {
      return normalizedRelative;
    }

    if (normalizedRelative === '/') {
      return this.subDirectory === '/' ? '/' : `${this.subDirectory}/`;
    }

    const fullPath = `${this.subDirectory}${normalizedRelative}`;
    const cleanedPath = fullPath.replace(/\/{2,}/g, '/');
    return cleanedPath;
  }

  /**
   * 将节点添加到目录树的正确位置
   * @param {object} tree - 目录树
   * @param {string} parentPath - 父目录路径
   * @param {object} node - 要添加的节点
   * @private
   */
  _addNodeToDirectoryTree(tree, parentPath, node) {
    if (!parentPath || parentPath === '' || parentPath === '/') {
      // 如果父路径为空或根目录，直接添加到根节点的children
      tree.children.push(node);
      return;
    }
    
    // 分割父路径，找到正确的父节点
    const pathParts = parentPath.split('/').filter(part => part !== '');
    let currentNode = tree;
    
    // 遍历路径部分，找到父节点
    for (const part of pathParts) {
      const found = currentNode.children.find(child => child.name === part);
      if (found) {
        currentNode = found;
      } else {
        // 如果找不到父节点，说明树结构有问题
        this.logger.warn(`[WebDavDataSource] 在目录树中找不到父节点: ${part} in ${parentPath}`);
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
    
    const pathParts = path.split('/').filter(part => part !== '');
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
    await this.ensureInitialized();
    
    this.logger.debug(`[WebDavDataSource] listSubdirectories: 转换目录树结构`);
    
    // 确保模型缓存已初始化
    try {
      if (!this._allItemsCache || this._allItemsCache.length === 0) {
        await this.InitAllSource();
      }
    } catch (error) {
      this.logger.error(`[WebDavDataSource] Error initializing source in listSubdirectories:`, error.message, error.stack);
      // Continue even with error, might have partial data
    }
    
    // 计算每个目录的模型数量
    const modelCountMap = this._calculateDirectoryModelCounts();
    
    // 创建一个根节点，表示"全部"
    const rootNode = this._convertDirectoryNode(this.directoryStructureCache, modelCountMap);
    
    // 为根节点添加模型总数，如果有模型缓存
    if (this._allModelsCache && Array.isArray(this._allModelsCache)) {
      rootNode.count = this._allModelsCache.length;
    }
    
    return [rootNode]; // 返回包含根节点的数组
  }

  async _traverseDirectoryItems(basePathToScan, itemHandlerAsync, processSubdirectories = true, sourceId, sourceRoot = null) {
    const queue = [basePathToScan];
    const visited = new Set();

    while (queue.length > 0) {
      const currentPath = queue.shift();
      if (visited.has(currentPath)) {
        continue;
      }
      visited.add(currentPath);

      let actualContents = [];
      try {
        const rawContents = await this.client.getDirectoryContents(currentPath, { deep: false, details: true });
        if (Array.isArray(rawContents)) {
          actualContents = rawContents;
        } else if (rawContents && typeof rawContents === 'object' && rawContents.filename) {
          this.logger.debug(`_traverseDirectoryItems: getDirectoryContents for ${currentPath} returned a single item object, wrapping in array.`);
          actualContents = [rawContents];
        } else if (rawContents && typeof rawContents === 'object' && Object.keys(rawContents).length === 0) {
          this.logger.debug(`_traverseDirectoryItems: getDirectoryContents for ${currentPath} returned an empty object, treating as empty directory.`);
          actualContents = [];
        } else if (rawContents && typeof rawContents === 'object' && rawContents !== null) {
          let extractedFromArrayWrapper = false;
          if (Array.isArray(rawContents.data)) { actualContents = rawContents.data; extractedFromArrayWrapper = true; }
          else if (Array.isArray(rawContents.items)) { actualContents = rawContents.items; extractedFromArrayWrapper = true; }
          else if (Array.isArray(rawContents.files)) { actualContents = rawContents.files; extractedFromArrayWrapper = true; }
          
          if (extractedFromArrayWrapper) {
            this.logger.warn(`_traverseDirectoryItems: getDirectoryContents for ${currentPath} returned an object, but an array was successfully extracted from one of its properties (data, items, or files).`);
          } else {
            this.logger.warn(`_traverseDirectoryItems: getDirectoryContents for ${currentPath} returned an object that is not a single item and from which an array could not be extracted. Received:`, rawContents, ". Treating as empty.");
            actualContents = []; 
          }
        } else {
          this.logger.warn(`_traverseDirectoryItems: getDirectoryContents for ${currentPath} returned unexpected non-array type. Received: ${typeof rawContents}. Value:`, rawContents, ". Treating as empty.");
          actualContents = [];
        }
      } catch (error) {
        this.logger.error(`_traverseDirectoryItems: Error fetching directory contents for ${currentPath}:`, error.message, error.stack, error.response?.status);
        if (error.response && (error.response.status === 404 || error.response.status === 403)) {
          this.logger.warn(`_traverseDirectoryItems: Skipping inaccessible directory: ${currentPath} (Status: ${error.response.status})`);
        }
        continue; 
      }

      for (const item of actualContents) {
        if (item.basename === '.' || item.basename === '..') continue;
        await itemHandlerAsync(item, currentPath, sourceId, sourceRoot);
        if (item.type === 'directory' && processSubdirectories) {
          if (item.filename && !visited.has(item.filename)) {
            queue.push(item.filename);
          }
        }
      }
    }
  }

  async _populateAllItemsCache(basePathToScan) {
    const sourceId = this.config.id;
    this.logger.info(`Starting to populate _allItemsCache (Array of file objects) from: ${basePathToScan}`);
    this._allItemsCache = []; 
    const sourceRoot = this._resolvePath('/'); 

    const itemHandler = async (item, _currentWebdavPath, currentSourceId, currentSourceRoot) => {
      if (item.type === 'file') {
        let relativeFilePath;
        // currentSourceRoot is like /webdav/ or / (always ends with / if not empty)
        // item.filename is like /webdav/lora/model.json or /lora/model.json
        
        if (item.filename === currentSourceRoot.slice(0, -1) && currentSourceRoot !== '/') { // e.g. item.filename is /webdav, currentSourceRoot is /webdav/
             relativeFilePath = '/';
        } else if (item.filename.startsWith(currentSourceRoot)) {
          // tempPath will be like 'lora/model.json' or '' (if item.filename is currentSourceRoot itself, e.g. /webdav/)
          let tempPath = item.filename.substring(currentSourceRoot.length);
          
          if (tempPath === '') { // Item is the root directory itself (represented as a file, unlikely but handle)
            relativeFilePath = '/';
          } else if (tempPath.startsWith('/')) {
            // This implies currentSourceRoot might not have had a trailing slash (which _resolvePath should prevent)
            // or item.filename had double slashes. Normalize by ensuring single leading slash.
            relativeFilePath = tempPath.replace(/^\/+/, '/');
          } else {
            relativeFilePath = `/${tempPath}`; // Prepend slash
          }
        } else {
          // This case should ideally not happen if basePathToScan is currentSourceRoot and traversal is correct.
          // If it does, it means item.filename is outside the expected sourceRoot.
          // We'll form a path relative to the *actual* root of the WebDAV server.
          this.logger.warn(`_populateAllItemsCache/itemHandler: File ${item.filename} does not start with source root ${currentSourceRoot}. Using full path from WebDAV root as relativePath.`);
          if (item.filename.startsWith('/')) {
            relativeFilePath = item.filename;
          } else {
            relativeFilePath = `/${item.filename}`;
          }
        }
        // Final normalization to ensure single leading slash, and not an empty string if it was somehow derived
        if (relativeFilePath === '') relativeFilePath = '/'; // Should be caught by specific checks, but as a safeguard
        else relativeFilePath = relativeFilePath.replace(/^\/+/, '/'); // Ensure single leading slash

        this._allItemsCache.push({
          ...item,
          relativePath: relativeFilePath
        });
      }
    };

    await this._traverseDirectoryItems(basePathToScan, itemHandler, true, sourceId, sourceRoot);
    this.logger.info(`_populateAllItemsCache complete. Found ${this._allItemsCache.length} file objects.`);
  }
 
  async _batchFetchJsonContents(jsonFilePaths = []) {
    const startTime = Date.now();
    await this.ensureInitialized();
    const resultsMap = new Map();

    if (!jsonFilePaths || jsonFilePaths.length === 0) {
      this.logger.info('_batchFetchJsonContents: No JSON file paths provided.');
      return resultsMap;
    }

    this.logger.info(`_batchFetchJsonContents: Starting sequential fetch for ${jsonFilePaths.length} JSON files.`);

    for (const filePath of jsonFilePaths) {
      this.logger.debug(`_batchFetchJsonContents: Fetching ${filePath}`);
      try {
        const content = await this.client.getFileContents(filePath, { format: 'text' });
        resultsMap.set(filePath, content);
        this.logger.debug(`_batchFetchJsonContents: Successfully fetched ${filePath}`);
      } catch (error) {
        resultsMap.set(filePath, null); // Store null on error to indicate attempt
        this.logger.error(`_batchFetchJsonContents: Failed to fetch ${filePath}:`, error.message, error.response?.status);
      }
    }

    const duration = Date.now() - startTime;
    this.logger.info(`_batchFetchJsonContents: Finished sequential fetch. ${resultsMap.size} results processed. Duration: ${duration}ms`);
    return resultsMap;
  }

  /**
   * Builds a single model entry, potentially using L2 cache for JSON info.
   * @param {object} modelFile - The model file object from _allItemsCache.
   * @param {string} currentSourceId - The ID of the current data source.
   * @param {string} currentResolvedBasePath - The resolved root path of the WebDAV source.
   * @param {Map<string, string|null>} [preFetchedJsonContentsMap=new Map()] - Optional map of pre-fetched JSON contents.
   * @returns {Promise<object|null>} The built model object or null if an error occurs.
   * @private
   */
  async _buildModelEntry(modelFile, currentSourceId, currentResolvedBasePath, preFetchedJsonContentsMap = new Map()) {
    const startTime = Date.now();
    await this.ensureInitialized(); 

    if (!modelFile || !modelFile.filename || typeof modelFile.filename !== 'string' || !modelFile.relativePath || typeof modelFile.relativePath !== 'string') {
      this.logger.error(`_buildModelEntry Invalid modelFile provided (missing filename or relativePath). modelFile: ${JSON.stringify(modelFile)}`);
      return null;
    }

    // modelFile.relativePath is now like /lora/model.safetensors or /model.safetensors
    const modelFileDirRelative = path.posix.dirname(modelFile.relativePath); // e.g., /lora or /
    const modelFileBaseOriginal = path.posix.basename(modelFile.relativePath, path.posix.extname(modelFile.relativePath));
    
    let associatedJsonFile = null;
    let associatedImageFile = null;
    let previewImageFile = null;

    const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

    for (const cachedItem of this._allItemsCache) {
      // cachedItem.relativePath is now like /lora/model.json or /lora/preview.png
      const cachedItemDirRelative = path.posix.dirname(cachedItem.relativePath); // e.g. /lora or /

      if (cachedItemDirRelative === modelFileDirRelative) { // Compare directories directly
        const itemBase = path.posix.basename(cachedItem.relativePath, path.posix.extname(cachedItem.relativePath));
        const itemExt = path.posix.extname(cachedItem.relativePath).toLowerCase();

        if (itemBase === modelFileBaseOriginal) {
          if (imageExtensions.includes(itemExt)) {
            if (!associatedImageFile) associatedImageFile = cachedItem;
          } else if (itemExt === '.json') {
            if (!associatedJsonFile) associatedJsonFile = cachedItem;
          }
        } else if (itemBase === `${modelFileBaseOriginal}.preview` && imageExtensions.includes(itemExt)) {
           if (!previewImageFile) previewImageFile = cachedItem;
        }
      }
    }

    const imageFileToUse = previewImageFile || associatedImageFile; 
    const jsonFileToUse = associatedJsonFile;

    let modelJsonInfo = null;
    if (jsonFileToUse) {
      const associatedJsonPath = jsonFileToUse.filename;
      const currentJsonFileMetadata = {
        fileSize: jsonFileToUse.size,
        metadata_lastModified_ms: _parseWebDavTimestamp(jsonFileToUse.lastmod),
        etag: jsonFileToUse.etag || null,
      };

      // 使用 _getJsonInfo 方法获取 JSON 信息
      try {
        // 首先尝试从预获取的内容中获取
        if (preFetchedJsonContentsMap.has(associatedJsonPath)) {
          const jsonContent = preFetchedJsonContentsMap.get(associatedJsonPath);
          if (jsonContent && typeof jsonContent === 'string') {
            try {
              modelJsonInfo = JSON.parse(jsonContent);
              // 存储到缓存
              this.modelInfoCacheService.setDataToCache(
                CacheDataType.MODEL_JSON_INFO,
                currentSourceId,
                jsonFileToUse.relativePath,
                modelJsonInfo,
                currentJsonFileMetadata,
                'webdav'
              );
            } catch (parseError) {
              this.logger.error(`_buildModelEntry: Error parsing pre-fetched JSON for ${associatedJsonPath}:`, parseError.message);
              // Even if parsing fails, we'll still create the model object below with an empty modelJsonInfo
            }
          }
        }

        // 如果预获取的内容不可用，使用 _getJsonInfo 方法
        if (!modelJsonInfo) {
          modelJsonInfo = await this._getJsonInfo(associatedJsonPath, currentJsonFileMetadata);
        }
      } catch (error) {
        this.logger.error(`_buildModelEntry: Error getting JSON info for ${associatedJsonPath}:`, error.message);
        // If getting JSON info fails, we'll create the model with an empty modelJsonInfo
      }
    } else {
      this.logger.debug(`_buildModelEntry: Model ${modelFile.filename} has no associated JSON file.`);
      // No JSON file is associated with this model
    }

    try {
      // Create model object whether or not we have JSON or image files
      const modelObj = createWebDavModelObject(
        modelFile,
        imageFileToUse,
        jsonFileToUse,
        modelJsonInfo || {}, // Use empty object as fallback if modelJsonInfo is null
        currentSourceId,
        currentResolvedBasePath
      );

      this.addfilterOptionsByModelObj(modelObj);
      
      const duration = Date.now() - startTime;
      this.logger.debug(`_buildModelEntry: Model object created for ${modelFile.filename}, Duration: ${duration}ms`);
      return modelObj;
    } catch (error) {
      this.logger.error(`_buildModelEntry: 调用 createWebDavModelObject 时出错 for ${modelFile.filename}:`, error.message, error.stack);
      // Even in case of error, try to create a minimal valid model object for rendering
      try {
        const modelFileRelativePath = modelFile.relativePath;
        const modelFileExt = path.posix.extname(modelFileRelativePath).toLowerCase();
        const modelNameWithoutExt = path.posix.basename(modelFileRelativePath, modelFileExt);
        
        const fallbackModelObj = {
          name: modelNameWithoutExt,
          file: modelFileRelativePath,
          jsonPath: jsonFileToUse ? jsonFileToUse.relativePath : '',
          image: imageFileToUse ? imageFileToUse.relativePath : '',
          sourceId: currentSourceId,
          modelType: modelFileExt.replace('.', '').toUpperCase() || 'UNKNOWN',
          baseModel: '',
          description: '',
          triggerWord: '',
          tags: [],
          size: modelFile.size,
          lastModified: modelFile.lastmod ? new Date(modelFile.lastmod) : undefined,
          modelJsonInfo: {}
        };
        
        this.logger.debug(`_buildModelEntry: Created fallback model object for ${modelFile.filename} after error.`);
        this.addfilterOptionsByModelObj(fallbackModelObj);
        return fallbackModelObj;
      } catch (fallbackError) {
        this.logger.error(`_buildModelEntry: Failed to create fallback model object for ${modelFile.filename}:`, fallbackError.message, fallbackError.stack);
        return null;
      }
    }
  }

  async _populateAllItemsCacheIfNeeded(resolvedRootOfSource) {
    if (this._allItemsCache.length === 0 || this._lastRefreshedFromRootPath !== resolvedRootOfSource) {
      this.logger.info(`_populateAllItemsCacheIfNeeded: Refreshing _allItemsCache from root: ${resolvedRootOfSource}. Reason: cacheEmpty=${this._allItemsCache.length === 0}, lastRefreshMismatch=${this._lastRefreshedFromRootPath !== resolvedRootOfSource}`);
      await this._populateAllItemsCache(resolvedRootOfSource); 
      this._lastRefreshedFromRootPath = resolvedRootOfSource;
    } else {
      this.logger.debug(`_populateAllItemsCacheIfNeeded: Using existing _allItemsCache with ${this._allItemsCache.length} items, last refreshed from ${this._lastRefreshedFromRootPath}.`);
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
   * Lists models from the WebDAV server.
   * @param {string|null} [directory=null] - The subdirectory to list models from. Relative to the source's root path.
   * @param {object} sourceConfig - The configuration for the current source (used for sourceId).
   * @param {string[]} [supportedExts=[]] - Array of supported model file extensions.
   * @param {boolean} [showSubdirectory=true] - Whether to include models from subdirectories.
   * @returns {Promise<Array<object>>} A promise that resolves to an array of model objects.
   */
  async listModels(directory = null, showSubdirectory = true) {
    if (!this.allModelsCache || this.allModelsCache.length === 0) {
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
    this.logger.info(`[WebDavDataSource] [listModels] Listing models from directory: ${normalizedDirectory}`);

    const uniqueNames = new Set([...rootNams]);
    if (showSubdirectory === true){
      for (const [key, names] of this.modelsByDirectoryMap) {
        if (key.startsWith(normalizedDirectory + "/")) {
          names.forEach(name => uniqueNames.add(name));
        }
      }
    }

    const result = this.allModelsCache.filter(model =>
      model && model.file && uniqueNames.has(model.file));

    if (!result) return [];
    return result;
  }

  async _statIfExists(relativePath) {
    if (!relativePath || typeof relativePath !== 'string' || relativePath.trim() === '') {
      this.logger.warn(`_statIfExists: Invalid relativePath provided: '${relativePath}'`); 
      return null;
    }
    const resolvedPath = this._resolvePath(relativePath);
    try {
      const statResult = await this.client.stat(resolvedPath);
      return statResult;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        // Normal case, file not found
      } else {
        this.logger.warn(`_statIfExists: Error stating file ${resolvedPath} (relative: ${relativePath})`, error.message, error.response?.status);
      }
      return null;
    }
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
    this.logger.info(`[WebDavDataSource] 找到模型: name=${fileName} foundItem=${JSON.stringify(foundItem, null, 2)} `);

    return foundItem ? foundItem : null;
  }

  /** Helper to find associated image file, used in readModelDetail */
  _findAssociatedImageFile(modelFileObject, modelFileBase, modelFileDir) {
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
    let associatedImageFile = null;
    let previewImageFile = null;

    for (const cachedItem of this._allItemsCache) {
        const cachedItemDirRelative = path.posix.dirname(cachedItem.relativePath);
        if (cachedItemDirRelative === modelFileDir) {
            const itemBase = path.posix.basename(cachedItem.relativePath, path.posix.extname(cachedItem.relativePath));
            const itemExt = path.posix.extname(cachedItem.relativePath).toLowerCase();

            if (itemBase === modelFileBase && imageExtensions.includes(itemExt)) {
                if (!associatedImageFile) associatedImageFile = cachedItem;
            } else if (itemBase === `${modelFileBase}.preview` && imageExtensions.includes(itemExt)) {
                if (!previewImageFile) previewImageFile = cachedItem;
            }
        }
    }
    return previewImageFile || associatedImageFile;
  }


  async getImageData(relativePath) {
    const startTime = Date.now();
    await this.ensureInitialized();
    if (!relativePath) {
      this.logger.warn(`getImageData 调用时 relativePath 为空`);
      return null;
    }
    const resolvedPath = this._resolvePath(relativePath);
    try {
      const content = await this.client.getFileContents(resolvedPath);
      return {
        path: relativePath, 
        data: content,
        mimeType: (() => {
          let mime = 'application/octet-stream'; 
          const ext = path.posix.extname(relativePath).slice(1).toLowerCase();
          if (ext) {
            const knownImageTypes = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'];
            if (knownImageTypes.includes(ext)) {
              mime = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
              if (ext === 'svg') mime = 'image/svg+xml';
            }
          }
          return mime;
        })() 
      };
    } catch (e) {
      const duration = Date.now() - startTime;
      this.logger.error(`获取图片数据时出错: ${resolvedPath}, 耗时: ${duration}ms`, e.message, e.stack, e.response?.status);
      if (e.response && e.response.status === 404) {
        this.logger.warn(`获取图片数据失败 (文件不存在): ${resolvedPath}, 耗时: ${duration}ms`);
      }
      return null;
    }
  }

  async writeModelJson(relativePath, dataToWrite) {
    this.logger.debug(`[writeModelJson] called with relativePath: ${relativePath}`);

    const startTime = Date.now();
    await this.ensureInitialized();
    const sourceId = this.config.id;
    
    // relativeJsonPath 是相对于数据源根的路径
    const relativeJsonPath = relativePath;

    if (!relativeJsonPath) {
      throw new Error('Relative path cannot be empty for WebDAV write.');
    }
    if (typeof dataToWrite !== 'string') {
      throw new Error('Data to write must be a string for WebDAV model JSON.');
    }

    // 将相对路径转换为 WebDAV 客户端可用的绝对路径
    const absoluteJsonPath = this._resolvePath(relativeJsonPath);
    this.logger.info(`Attempting to write model JSON to WebDAV. Relative: ${relativeJsonPath}, Absolute: ${absoluteJsonPath}`);

    try {
      const absoluteDirPath = path.posix.dirname(absoluteJsonPath);
      try {
        await this.client.stat(absoluteDirPath);
      } catch (statError) {
        if (statError.response && statError.response.status === 404) {
          this.logger.info(`Parent directory ${absoluteDirPath} does not exist, attempting to create...`);
          await this.client.createDirectory(absoluteDirPath, { recursive: true });
          this.logger.info(`Successfully created directory ${absoluteDirPath}`);
        } else {
          this.logger.error(`Error checking directory ${absoluteDirPath}:`, statError.message, statError.stack, statError.response?.status);
          throw statError;
        }
      }

      await this.client.putFileContents(absoluteJsonPath, dataToWrite, { overwrite: true });
      const duration = Date.now() - startTime;
      this.logger.info(`Successfully wrote model JSON to WebDAV. Absolute: ${absoluteJsonPath}, 耗时: ${duration}ms`);

      // --- Update caches ---
      this.logger.debug(`[writeModelJson] Attempting to update caches for ${relativeJsonPath}`);
      try {
        const newJsonData = JSON.parse(dataToWrite);
        this.logger.debug(`[writeModelJson] Parsed new JSON data for ${relativeJsonPath}`);
        
        // --- Update L2 Cache (MODEL_JSON_INFO) ---
        if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
          this.logger.info(`[writeModelJson] Updating L2 caches (MODEL_JSON_INFO) for ${relativeJsonPath}`);
          this.logger.debug(`[writeModelJson] modelInfoCacheService is initialized and enabled.`);
          
          // 1. Update MODEL_JSON_INFO for this file
          const jsonFileStats = {
            fileSize: dataToWrite.length,
            metadata_lastModified_ms: Date.now(),
            etag: null
          };
          
          this.modelInfoCacheService.setDataToCache(
            CacheDataType.MODEL_JSON_INFO,
            sourceId,
            absoluteJsonPath, // 使用绝对路径作为缓存键
            newJsonData,
            jsonFileStats,
            'webdav'
          );
          this.logger.debug(`[writeModelJson] setDataToCache for MODEL_JSON_INFO completed for ${absoluteJsonPath}`);
          
          // 2. Find and update the model in allModelsCache
          this.logger.debug(`[writeModelJson] Attempting to find and update model in allModelsCache for ${relativeJsonPath}`);
          // 由于 allModelsCache 中的 model.jsonPath 现在是相对路径，所以比较时应使用 relativeJsonPath
          let modelIndex = this.allModelsCache.findIndex(model =>
            model.jsonPath === relativeJsonPath // 使用相对路径进行比较
          );
          this.logger.debug(`[writeModelJson] modelIndex in allModelsCache for ${relativeJsonPath}: ${modelIndex}`);
          let modelToUpdate = null;
          let potentialModelFile = null;

          if (modelIndex !== -1) {
            modelToUpdate = this.allModelsCache[modelIndex];
            potentialModelFile = modelToUpdate.file;
            this.logger.debug(`[writeModelJson] Found modelToUpdate in allModelsCache. Path: ${modelToUpdate.relativePath}, File: ${potentialModelFile || 'N/A'}`);
          }
           
          else {
              this.logger.info(`[webDavDataSource writeModelJson] Model for JSON ${relativeJsonPath} not found in allModelsCache by jsonPath. It will be processed by the next InitAllSource if it's a new model or its corresponding model file is found.`);
           }

          if (modelToUpdate && potentialModelFile) {
            this.logger.info(`[writeModelJson] Updating model in allModelsCache: ${modelToUpdate.file || modelToUpdate.relativePath}`);
            
            const modelFileItemFromCache = this._allItemsCache.find(
              item => item.relativePath === potentialModelFile
            );

            if (!modelFileItemFromCache) {
              this.logger.warn(`[writeModelJson] Could not find full model file item in _allItemsCache for relative path: ${potentialModelFile}. Cache might be inconsistent.`);
            } else {
              this.logger.debug(`[writeModelJson] Calling _buildModelEntry for ${modelFileItemFromCache.filename} (relative: ${potentialModelFile})`);
              const updatedModelObj = await this._buildModelEntry(
                modelFileItemFromCache,
                sourceId,
                this._resolvePath('/'),
                new Map() // Pass an empty Map instead of null
              );
              this.logger.debug(`[writeModelJson] _buildModelEntry returned: ${updatedModelObj ? 'object' : 'null'}`);
              if (updatedModelObj) {
                if (modelToUpdate.relativePath) {
                  updatedModelObj.relativePath = modelToUpdate.relativePath;
                  this.logger.debug(`[writeModelJson] Preserved relativePath: ${modelToUpdate.relativePath}`);
                }
                this.allModelsCache[modelIndex] = updatedModelObj;
                this.logger.info(`[writeModelJson] Successfully updated model in allModelsCache for ${relativeJsonPath}`);
              } else {
                this.logger.warn(`[writeModelJson] Re-building model after JSON update returned null for ${relativeJsonPath}. Cache might be inconsistent until next InitAllSource.`);
              }
              this.logger.debug(`[writeModelJson] Attempting to invalidate MODEL_DETAIL cache for ${potentialModelFile}`);
              await this.modelInfoCacheService.invalidateCacheEntry(
                CacheDataType.MODEL_DETAIL,
                sourceId,
                potentialModelFile
              );
              this.logger.debug(`[writeModelJson] Invalidated MODEL_DETAIL cache for ${potentialModelFile}`);
            }
          } else {
            this.logger.warn(`[writeModelJson] Model for JSON ${relativeJsonPath} not found in allModelsCache or potentialModelFile is missing. It will be processed by the next InitAllSource.`);
          }
        } else {
          this.logger.warn(`[writeModelJson] modelInfoCacheService is not available or not enabled. Skipping L2 cache updates for ${relativeJsonPath}. Initialized: ${this.modelInfoCacheService?.isInitialized}, Enabled: ${this.modelInfoCacheService?.isEnabled}`);
        }
      } catch (cacheUpdateError) {
        this.logger.error(`[writeModelJson] Error updating caches for ${relativeJsonPath}: ${cacheUpdateError.message}`, cacheUpdateError.stack, cacheUpdateError);
      }
      
      // Update internal caches
      this.logger.debug(`[writeModelJson] Clearing _allItemsCache and _lastRefreshedFromRootPath for ${this.config.id}`);
      this._allItemsCache = [];
      this._lastRefreshedFromRootPath = null; // Force refresh
      this.logger.debug(`[writeModelJson] Cleared _allItemsCache to ensure fresh contentHash on next listModels after JSON write for ${relativeJsonPath}.`);

    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`Failed to write model JSON to WebDAV: ${absoluteJsonPath}, 耗时: ${duration}ms`, error.message, error.stack, error.response?.status);
      throw error;
    }
  }

  async stat(relativePath) {
    const startTime = Date.now();
    await this.ensureInitialized();
    if (relativePath === undefined || relativePath === null) {
      this.logger.error(`stat called with invalid relativePath: ${relativePath}`);
      throw new Error('Relative path cannot be null or undefined for stat.');
    }
    const resolvedPath = this._resolvePath(relativePath);
    try {
      const stats = await this.client.stat(resolvedPath);
      const duration = Date.now() - startTime;
      return stats;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`Failed to stat path: ${resolvedPath}, 耗时: ${duration}ms`, error.message, error.stack, error.response?.status);
      throw error; 
    }
  }

  _getCacheDigest() {
    const sourceId = this.config.id;
    if (!this._allItemsCache || this._allItemsCache.length === 0) {
      this.logger.warn(`_getCacheDigest: _allItemsCache is empty. Cannot generate digest.`);
      // Return a consistent hash for "empty" to allow caching of empty lists
      return crypto.createHash('sha256').update(`empty:${sourceId}`).digest('hex');
    }

    const metadataItems = [];
    const sortedCache = [...this._allItemsCache].sort((a, b) => {
      if (a.relativePath < b.relativePath) return -1;
      if (a.relativePath > b.relativePath) return 1;
      return 0;
    });

    for (const item of sortedCache) {
      const path = String(item.relativePath || '');
      const size = String(item.size || '0');
      const lastmod = String(item.lastmod || '0'); // lastmod string itself
      const etag = String(item.etag || '');
      metadataItems.push(`${path}:${size}:${lastmod}:${etag}`);
    }

    if (metadataItems.length === 0) {
      this.logger.debug(`_getCacheDigest: No metadata items collected from _allItemsCache, returning empty string hash.`);
      return crypto.createHash('sha256').update('').digest('hex');
    }

    const metadataString = metadataItems.join('|');
    const hash = crypto.createHash('sha256').update(metadataString).digest('hex');
    this.logger.debug(`_getCacheDigest: Generated digest ${hash} from ${metadataItems.length} items in _allItemsCache.`);
    return hash;
  }

  async clearCache() {
    const sourceId = this.config.id;
    this.logger.info(`Clearing all caches for data source.`);

    this._allItemsCache = [];
    this._lastRefreshedFromRootPath = null;
    this.logger.debug(`Internal _allItemsCache cleared.`);

    if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
      this.logger.debug(`Attempting to clear L1/L2 caches via modelInfoCacheService for source: ${sourceId}.`);
      try {
        await this.modelInfoCacheService.clearCacheForSource(sourceId);
        this.logger.info(`Successfully requested cache clearing for source ${sourceId} via modelInfoCacheService.`);
      } catch (error) {
        this.logger.error(`Error during modelInfoCacheService cache clearing for source ${sourceId}:`, error);
      }
    } else {
      this.logger.info(`modelInfoCacheService not available or disabled, skipping L1/L2 cache clearing for source ${sourceId}.`);
    }
    this.logger.info(`Cache clearing process complete for source ${sourceId}.`);
  }

  async disconnect() {
    this.logger.info(`Disconnect called (no-op for current library).`);
    this.initialized = Promise.reject(new Error('Client disconnected')); 
  }
}

module.exports = {
  WebDavDataSource
};

