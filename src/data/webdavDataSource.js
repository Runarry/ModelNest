const DataSource = require('./baseDataSource'); // 导入新的基类
const { CacheDataType } = require('../services/constants/cacheConstants');
const {createWebDavModelObject } = require('./modelParser'); // 导入 createWebDavModelObject
const path = require('path');
const log = require('electron-log'); // 添加 electron-log 导入
const crypto = require('crypto'); // 引入 crypto 模块
const pLimit = require('p-limit').default; // 引入 p-limit

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


class WebDavDataSource extends DataSource {
  constructor(config, modelInfoCacheService) { // Renamed to modelInfoCacheService for consistency
    super(config); // Calls base class constructor with the config

    // Store the subDirectory, remove trailing slash if present, default to empty string
    this.subDirectory = (config.subDirectory || '').replace(/\/$/, '');
    log.info(`[WebDavDataSource][${this.config.id}] Initialized with subDirectory: '${this.subDirectory}'`);
    this._allItemsCache = []; // 初始化 allItems 缓存为数组
    this._lastRefreshedFromRootPath = null; // 跟踪上次从根路径刷新的时间或标识
    this.initialized = this.initClient(config);
    this.modelInfoCacheService = modelInfoCacheService; // Store cache service instance
    this.logger = log.scope(`DataSource:WebDAV:${this.config.id}`); // Logger specific to this instance
  }


  async InitAllSource() {
    const startTime = Date.now();
    await this.ensureInitialized();
    const sourceId = this.config.id;
    this.logger.info(`[WebDavDataSource InitAllSource] 开始初始化所有数据源: ${sourceId}`);

    // 确定支持的文件扩展名
    let effectiveSupportedExts;
    if (this.config && this.config.supportedExts && this.config.supportedExts.length > 0) {
      effectiveSupportedExts = this.config.supportedExts;
    } else {
      effectiveSupportedExts = ['.safetensors', '.ckpt', '.pt', '.pth', '.bin'];
      this.logger.warn(`[WebDavDataSource InitAllSource] 未提供或配置 supportedExts，使用默认值: ${effectiveSupportedExts.join(', ')}`);
    }

    // 初始化返回数据
    let allModels = [];
    let directoryStructure = []; // 完整目录结构（只包含文件夹）
    let modelsByDirectory = new Map(); // 目录与模型名称的映射

    // 获取根路径
    const resolvedRootOfSource = this._resolvePath('/');
    this.logger.info(`[WebDavDataSource InitAllSource] 解析后的根路径: ${resolvedRootOfSource}`);

    // 确保 _allItemsCache 已填充
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
    
    // 将目录集合转换为数组（排除根目录'/'，因为它是隐含的）
    directoryStructure = Array.from(dirSet).filter(dir => dir !== '/').sort();
    
    // 设置并发限制
    const limit = pLimit(8);
    
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
    
    // 并发构建模型条目
    const modelBuildPromises = [];
    
    for (const modelFile of modelFileItems) {
      modelBuildPromises.push(limit(() =>
        this._buildModelEntry(modelFile, sourceId, resolvedRootOfSource, preFetchedJsonContentsMap)
      ));
    }
    
    const settledModelEntries = await Promise.allSettled(modelBuildPromises);
    
    // 处理模型构建结果
    for (const result of settledModelEntries) {
      if (result.status === 'fulfilled' && result.value) {
        const modelObj = result.value;
        allModels.push(modelObj);
        
        // 获取模型所在的目录
        const modelDir = path.posix.dirname(modelObj.relativePath || modelObj.fileName);
        const dirKey = modelDir === '.' ? '/' : modelDir;
        
        // 将模型添加到对应目录的映射中
        if (!modelsByDirectory.has(dirKey)) {
          modelsByDirectory.set(dirKey, []);
        }
        modelsByDirectory.get(dirKey).push(modelObj.name);
      }
    }
    
    const duration = Date.now() - startTime;
    this.logger.info(`[WebDavDataSource InitAllSource] 完成. 耗时: ${duration}ms, 找到 ${allModels.length} 个模型, ${directoryStructure.length} 个目录`);
    
    return {
      allModels,
      directoryStructure,
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

  async listSubdirectories() {
    const startTime = Date.now();
    await this.ensureInitialized();
    const resolvedBasePath = this._resolvePath('/');
    this.logger.info(`开始列出子目录: ${resolvedBasePath}`);
    try {
      const items = await this.client.getDirectoryContents(resolvedBasePath, { deep: false }); 
      const subdirs = items
        .filter(item =>
          item.type === 'directory' &&
          item.basename !== '.' && 
          item.basename !== '..'
        )
        .map(item => item.basename); 
      const duration = Date.now() - startTime;
      this.logger.info(`列出子目录完成: ${resolvedBasePath}, 耗时: ${duration}ms, 找到 ${subdirs.length} 个子目录`);
      return subdirs;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`列出子目录时出错: ${resolvedBasePath}, 耗时: ${duration}ms`, error.message, error.stack, error.response?.status);
      if (error.response && error.response.status === 404) {
        this.logger.warn(`列出子目录失败 (目录不存在): ${resolvedBasePath}, 耗时: ${duration}ms`);
        return []; 
      }
      throw error; 
    }
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
 
  async _batchFetchJsonContents(jsonFilePaths) {
    const startTime = Date.now();
    await this.ensureInitialized();
    const sourceId = this.config.id;
    const resultsMap = new Map();

    if (!jsonFilePaths || jsonFilePaths.length === 0) {
      return resultsMap;
    }

    this.logger.info(`_batchFetchJsonContents: Starting batch fetch for ${jsonFilePaths.length} JSON files.`);

    // 新增并发限制
    const limit = pLimit(8);

    const fetchPromises = jsonFilePaths.map(filePath => limit(async () => {
      try {
        const content = await this.client.getFileContents(filePath, { format: 'text' });
        return { status: 'fulfilled', path: filePath, value: content };
      } catch (error) {
        return { status: 'rejected', path: filePath, reason: error };
      }
    }));

    const results = await Promise.all(fetchPromises); // Use Promise.all as limit handles concurrency

    results.forEach(result => {
      if (result.status === 'fulfilled') {
        resultsMap.set(result.path, result.value);
      } else { // status === 'rejected'
        resultsMap.set(result.path, null);
        this.logger.error(`_batchFetchJsonContents: Failed to fetch ${result.path}:`, result.reason.message, result.reason.response?.status);
      }
    });

    const duration = Date.now() - startTime;
    this.logger.info(`_batchFetchJsonContents: Finished batch fetch. ${resultsMap.size} results (some might be null for failures). Duration: ${duration}ms`);
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

    let modelJsonInfo = {};
    if (jsonFileToUse) {
      const associatedJsonPath = jsonFileToUse.relativePath; // This is the pathIdentifier for MODEL_JSON_INFO
      const currentJsonFileMetadata = {
        fileSize: jsonFileToUse.size,
        metadata_lastModified_ms: _parseWebDavTimestamp(jsonFileToUse.lastmod),
        etag: jsonFileToUse.etag || null,
      };

      // Try to get from L2 cache
      let cachedJsonInfo;
      if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
        cachedJsonInfo = await this.modelInfoCacheService.getDataFromCache(
          CacheDataType.MODEL_JSON_INFO,
          currentSourceId,
          associatedJsonPath,
          currentJsonFileMetadata
        );
      }

      if (cachedJsonInfo) {
        this.logger.debug(`_buildModelEntry: L2 cache hit for MODEL_JSON_INFO: ${associatedJsonPath}`);
        modelJsonInfo = cachedJsonInfo;
      } else {
        this.logger.debug(`_buildModelEntry: L2 cache miss/invalid for MODEL_JSON_INFO: ${associatedJsonPath}. Fetching from source.`);
        try {
          let jsonContent;
          if (preFetchedJsonContentsMap.has(jsonFileToUse.filename)) {
            jsonContent = preFetchedJsonContentsMap.get(jsonFileToUse.filename);
            if (jsonContent === null) { 
              this.logger.warn(`_buildModelEntry: Pre-fetch for JSON ${jsonFileToUse.filename} failed. Will attempt individual fetch.`);
            }
          }

          if (jsonContent === undefined || jsonContent === null) {
            jsonContent = await this.client.getFileContents(jsonFileToUse.filename, { format: 'text' });
          }
          
          if (typeof jsonContent === 'string') {
            modelJsonInfo = JSON.parse(jsonContent);
            // Store to L2 cache
            if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
              // Re-fetch metadata just in case it changed between listing and reading, though unlikely for batch.
              // For simplicity, we use the metadata we already have.
              const sourceJsonFileMetadata = {
                fileSize: jsonFileToUse.size, // Assuming size didn't change
                metadata_lastModified_ms: _parseWebDavTimestamp(jsonFileToUse.lastmod), // Use fresh parse
                etag: jsonFileToUse.etag || null,
              };
              await this.modelInfoCacheService.setDataToCache(
                CacheDataType.MODEL_JSON_INFO,
                currentSourceId,
                associatedJsonPath,
                modelJsonInfo, // Store the parsed object
                sourceJsonFileMetadata,
                'webdav' // sourceTypeForTTL
              );
              this.logger.debug(`_buildModelEntry: Stored MODEL_JSON_INFO to L2 for ${associatedJsonPath}`);
            }
          } else {
             this.logger.warn(`_buildModelEntry: JSON content for ${jsonFileToUse.filename} was not a string after fetch attempts. Content:`, jsonContent);
          }
        } catch (error) {
          this.logger.error(`_buildModelEntry: Error reading or parsing JSON file ${jsonFileToUse.filename}:`, error.message, error.stack, error.response?.status);
        }
      }
    } else {
      this.logger.debug(`_buildModelEntry: Model ${modelFile.filename} has no associated JSON file.`);
    }

    try {
      const modelObj = createWebDavModelObject(
        modelFile, 
        imageFileToUse, 
        jsonFileToUse,  
        modelJsonInfo,
        currentSourceId,
        currentResolvedBasePath 
      );
      const duration = Date.now() - startTime;
      this.logger.debug(`_buildModelEntry: Model object created for ${modelFile.filename}, Duration: ${duration}ms`);
      return modelObj;
    } catch (error) {
      this.logger.error(`_buildModelEntry: 调用 createWebDavModelObject 时出错 for ${modelFile.filename}:`, error.message, error.stack);
      return null;
    }
  }

  async _populateAllItemsCacheIfNeeded(resolvedRootOfSource) {
    const sourceId = this.config.id;
    if (this._allItemsCache.length === 0 || this._lastRefreshedFromRootPath !== resolvedRootOfSource) {
      this.logger.info(`_populateAllItemsCacheIfNeeded: Refreshing _allItemsCache from root: ${resolvedRootOfSource}. Reason: cacheEmpty=${this._allItemsCache.length === 0}, lastRefreshMismatch=${this._lastRefreshedFromRootPath !== resolvedRootOfSource}`);
      await this._populateAllItemsCache(resolvedRootOfSource); 
      this._lastRefreshedFromRootPath = resolvedRootOfSource;
    } else {
      this.logger.debug(`_populateAllItemsCacheIfNeeded: Using existing _allItemsCache with ${this._allItemsCache.length} items, last refreshed from ${this._lastRefreshedFromRootPath}.`);
    }
  }

  async listModels(directory = null, sourceConfig, supportedExts = [], showSubdirectory = true) {
    const startTime = Date.now();
    await this.ensureInitialized();
    const currentSourceId = sourceConfig ? sourceConfig.id : this.config.id;

    // Ensure pathIdDirectoryPart always starts with / or is /
    let pathIdDirectoryPart;
    if (!directory || directory.trim() === '' || directory.trim() === '.' || directory.trim() === '/') {
        pathIdDirectoryPart = '/';
    } else {
        let normDir = path.posix.normalize(directory.trim());
        if (normDir === '.' || normDir === '') { // Should be caught by above, but defensive
            pathIdDirectoryPart = '/';
        } else if (!normDir.startsWith('/')) {
            pathIdDirectoryPart = `/${normDir}`;
        } else {
            pathIdDirectoryPart = normDir;
        }
    }
    // Remove trailing slash if not root
    if (pathIdDirectoryPart !== '/' && pathIdDirectoryPart.endsWith('/')) {
        pathIdDirectoryPart = pathIdDirectoryPart.slice(0, -1);
    }

    // Construct pathIdentifier for MODEL_LIST cache
    const params = new URLSearchParams();
    params.append('showSubDir', String(showSubdirectory));
    params.append('exts', supportedExts.join(','));
    params.sort(); // Ensure consistent order
    const pathIdentifier = `${pathIdDirectoryPart}?${params.toString()}`;
    
    this.logger.info(`ListModels request. Directory: '${directory || '/'}', Normalized PathIdDir: '${pathIdDirectoryPart}', ShowSubDir: ${showSubdirectory}. PathIdentifier: ${pathIdentifier}`);

    const resolvedRootOfSource = this._resolvePath('/'); 

    // --- L1 Cache Check (MODEL_LIST) ---
    if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
      await this._populateAllItemsCacheIfNeeded(resolvedRootOfSource); // Needed for currentDigest
      const currentDigest = this._getCacheDigest();
      const currentModelListMetadata = { contentHash: currentDigest };

      if (currentDigest) {
        const cachedModelList = await this.modelInfoCacheService.getDataFromCache(
          CacheDataType.MODEL_LIST,
          currentSourceId,
          pathIdentifier,
          currentModelListMetadata
        );

        if (cachedModelList) {
          this.logger.info(`L1 cache hit and valid for MODEL_LIST: ${pathIdentifier}. Returning cached data. Duration: ${Date.now() - startTime}ms`);
          return cachedModelList;
        }
        this.logger.info(`L1 cache miss or invalid for MODEL_LIST: ${pathIdentifier}. Proceeding to fetch.`);
      } else {
        this.logger.warn(`Could not generate cache digest. Proceeding to fetch MODEL_LIST without L1 check for: ${pathIdentifier}`);
      }
    } else {
      this.logger.debug(`Cache service not available or disabled for listModels. Proceeding to fetch directly.`);
    }

    // --- Cache Miss or Invalid: Proceed with original logic ---
    // Use the already normalized pathIdDirectoryPart for resolving the request directory
    const resolvedRequestDir = this._resolvePath(pathIdDirectoryPart);

    if (directory === null && showSubdirectory === false) {
      this.logger.info(`'全部' 视图 (directory is null and showSubdirectory is false), 自动将 showSubdirectory 设置为 true 以递归显示所有模型。`);
      showSubdirectory = true;
    }
    
    await this._populateAllItemsCacheIfNeeded(resolvedRootOfSource); // Ensure it's populated if not already
    
    let allItemsFlatList = [];
    // pathIdDirectoryPart is already the "relative to source root, with leading slash" path we need for filtering.
    // e.g. /lora or /
    const relativeRequestDirForFiltering = pathIdDirectoryPart;
    this.logger.debug(`listModels: Filtering with relativeRequestDirForFiltering: '${relativeRequestDirForFiltering}'`);


    allItemsFlatList = this._allItemsCache.filter(cachedItem => {
      // cachedItem.relativePath is now like /lora/model.json or /model.json
      // relativeRequestDirForFiltering is now like /lora or /
      if (showSubdirectory) {
        if (relativeRequestDirForFiltering === '/') { // Requesting root, show all items
          return true;
        }
        // Check if item is in the directory or a subdirectory of it
        // e.g., dir=/lora, item=/lora/file.txt (match) or item=/lora/sub/file.txt (match)
        // Need to ensure /lora matches /lora/file.txt but not /lorax/file.txt
        // So, item path must start with "dir/" OR be exactly "dir" (for a file at that path, though dir is usually for dirs)
        return cachedItem.relativePath.startsWith(`${relativeRequestDirForFiltering}/`) || cachedItem.relativePath === relativeRequestDirForFiltering;
      } else { // Not showing subdirectories, only items directly in the directory
        const itemDirRelative = path.posix.dirname(cachedItem.relativePath); // e.g. /lora or / for root items
        // if cachedItem.relativePath is /file.txt, itemDirRelative is /
        // if cachedItem.relativePath is /lora/file.txt, itemDirRelative is /lora
        return itemDirRelative === relativeRequestDirForFiltering;
      }
    });

    this.logger.info(`Filtered _allItemsCache. ${allItemsFlatList.length} items for request path '${resolvedRequestDir}' (relative: '${relativeRequestDirForFiltering}', showSubDir: ${showSubdirectory})`);

    const modelFileItems = allItemsFlatList.filter(item =>
      item.type === 'file' && supportedExts.some(ext => item.filename.endsWith(ext))
    );

    this.logger.info(`From ${allItemsFlatList.length} items, filtered to ${modelFileItems.length} potential model files.`);

    const potentialJsonFileFullPaths = new Set();
    if (Array.isArray(modelFileItems)) {
      modelFileItems.forEach(modelFile => {
        // modelFile.relativePath is like /lora/model.safetensors
        const modelFileDirRelative = path.posix.dirname(modelFile.relativePath); // /lora
        const modelFileBase = path.posix.basename(modelFile.relativePath, path.posix.extname(modelFile.relativePath)); // model
        
        for (const cachedItem of this._allItemsCache) {
          // cachedItem.relativePath is like /lora/model.json
          const cachedItemDirRelative = path.posix.dirname(cachedItem.relativePath); // /lora
          if (cachedItemDirRelative === modelFileDirRelative) { // Direct comparison
            const itemBase = path.posix.basename(cachedItem.relativePath, path.posix.extname(cachedItem.relativePath));
            const itemExt = path.posix.extname(cachedItem.relativePath).toLowerCase();
            if (itemBase === modelFileBase && itemExt === '.json') {
              potentialJsonFileFullPaths.add(cachedItem.filename); // Add full path for pre-fetch
              break;
            }
          }
        }
      });
    }
    
    const uniqueJsonFilePaths = Array.from(potentialJsonFileFullPaths);
    let preFetchedJsonContentsMap = new Map();
    if (uniqueJsonFilePaths.length > 0) {
      this.logger.info(`Found ${uniqueJsonFilePaths.length} unique JSON files to pre-fetch.`);
      preFetchedJsonContentsMap = await this._batchFetchJsonContents(uniqueJsonFilePaths);
      this.logger.info(`Batch pre-fetch complete for ${uniqueJsonFilePaths.length} JSON files. Got ${preFetchedJsonContentsMap.size} results.`);
    } else {
      this.logger.info(`No JSON files found to pre-fetch.`);
    }

    const modelListResult = [];
    // 新增并发限制
    const limit = pLimit(8);
    const modelBuildPromises = [];

    this.logger.info(`开始使用并发限制 (limit=${8}) 构建 ${modelFileItems.length} 个模型条目.`);
    for (const modelFile of modelFileItems) {
      // _buildModelEntry now handles L2 caching for MODEL_JSON_INFO internally
      // 使用 limit 包裹异步操作
      modelBuildPromises.push(limit(() =>
        this._buildModelEntry(modelFile, currentSourceId, resolvedRootOfSource, preFetchedJsonContentsMap)
      ));
    }
    
    // 等待所有受限的 Promise 完成
    const settledModelEntries = await Promise.allSettled(modelBuildPromises);

    settledModelEntries.forEach(result => {
      if (result.status === 'fulfilled' && result.value) {
        modelListResult.push(result.value);
      } else if (result.status === 'fulfilled' && !result.value) {
        // _buildModelEntry 返回 null 的情况，日志已在 _buildModelEntry 内部记录
        this.logger.debug(`_buildModelEntry returned null, skipping one model entry.`);
      } else if (result.status === 'rejected') {
        this.logger.error(`构建模型条目时发生未捕获的错误 (Promise rejected):`, result.reason);
      }
    });

    // --- Store to L1 Cache (MODEL_LIST) ---
    if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
      const currentDigestForStorage = this._getCacheDigest(); // Re-get digest, _allItemsCache should be stable
      if (currentDigestForStorage) {
        const modelListMetadataForCache = { contentHash: currentDigestForStorage };
        this.logger.info(`Storing MODEL_LIST result to L1 cache. PathIdentifier: ${pathIdentifier}, Digest: ${currentDigestForStorage}`);
        await this.modelInfoCacheService.setDataToCache(
          CacheDataType.MODEL_LIST,
          currentSourceId,
          pathIdentifier,
          modelListResult, // Store the final list
          modelListMetadataForCache,
          'webdav' // sourceTypeForTTL
        );
      } else {
        this.logger.warn(`Could not generate cache digest. MODEL_LIST result not cached for PathIdentifier: ${pathIdentifier}`);
      }
    }

    const duration = Date.now() - startTime;
    this.logger.info(`列出模型完成: ${resolvedRequestDir}, 耗时: ${duration}ms, 成功构建 ${modelListResult.length} 个模型 (总共尝试 ${modelFileItems.length} 个)`);
    return modelListResult;
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

  async readModelDetail(identifier, modelFileName, passedSourceId) {
    const startTime = Date.now();
    await this.ensureInitialized();
    const currentSourceId = passedSourceId || this.config.id;
    const modelFileRelativePath = modelFileName; // Assuming modelFileName is the relative path

    this.logger.info(`readModelDetail Entry. Identifier: '${identifier}', ModelFileRelativePath: '${modelFileRelativePath}'`);

    if (!modelFileRelativePath) {
        this.logger.error(`readModelDetail: modelFileRelativePath is required.`);
        return {}; // Or throw error
    }
    
    // Ensure _allItemsCache is populated to find the modelFileObject and its associated JSON file object
    const resolvedRootOfSource = this._resolvePath('/');
    await this._populateAllItemsCacheIfNeeded(resolvedRootOfSource);

    const modelFileObject = this._allItemsCache.find(item => item.relativePath === modelFileRelativePath);

    if (!modelFileObject) {
        this.logger.error(`readModelDetail: Model file '${modelFileRelativePath}' not found in _allItemsCache.`);
        return {};
    }

    // --- Metadata for cache validation ---
    const currentModelFileMetadata = {
        fileSize: modelFileObject.size,
        metadata_lastModified_ms: _parseWebDavTimestamp(modelFileObject.lastmod),
        etag: modelFileObject.etag || null,
    };

    // --- L1 Cache Check (MODEL_DETAIL) ---
    if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
        const cachedModelDetail = await this.modelInfoCacheService.getDataFromCache(
            CacheDataType.MODEL_DETAIL,
            currentSourceId,
            modelFileRelativePath, // pathIdentifier for MODEL_DETAIL
            currentModelFileMetadata
        );
        if (cachedModelDetail) {
            this.logger.info(`L1 cache hit for MODEL_DETAIL: ${modelFileRelativePath}. Duration: ${Date.now() - startTime}ms`);
            return cachedModelDetail;
        }
        this.logger.debug(`L1 cache miss/invalid for MODEL_DETAIL: ${modelFileRelativePath}.`);
    }

    // --- L2 Cache Check (MODEL_JSON_INFO) to build MODEL_DETAIL ---
    // Find associated JSON file from _allItemsCache
    const modelFileDir = path.posix.dirname(modelFileObject.relativePath);
    const modelFileBase = path.posix.basename(modelFileObject.relativePath, path.posix.extname(modelFileObject.relativePath));
    const associatedJsonFileObject = this._allItemsCache.find(item => 
        item.type === 'file' &&
        path.posix.dirname(item.relativePath) === modelFileDir &&
        path.posix.basename(item.relativePath, path.posix.extname(item.relativePath)) === modelFileBase &&
        path.posix.extname(item.relativePath).toLowerCase() === '.json'
    );

    let modelJsonInfo;
    let associatedJsonPath = null;

    if (associatedJsonFileObject) {
        associatedJsonPath = associatedJsonFileObject.relativePath;
        const currentJsonFileMetadata = {
            fileSize: associatedJsonFileObject.size,
            metadata_lastModified_ms: _parseWebDavTimestamp(associatedJsonFileObject.lastmod),
            etag: associatedJsonFileObject.etag || null,
        };

        if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
            modelJsonInfo = await this.modelInfoCacheService.getDataFromCache(
                CacheDataType.MODEL_JSON_INFO,
                currentSourceId,
                associatedJsonPath,
                currentJsonFileMetadata
            );
            if (modelJsonInfo) {
                this.logger.debug(`L2 cache hit for MODEL_JSON_INFO: ${associatedJsonPath} (used for building MODEL_DETAIL).`);
            } else {
                 this.logger.debug(`L2 cache miss/invalid for MODEL_JSON_INFO: ${associatedJsonPath}. Will fetch from source if needed.`);
            }
        }
    }
    
    // --- Fetch from Source if necessary ---
    let builtModelObject;
    if (modelJsonInfo) { // L2 hit for JSON_INFO
        // Build ModelObject using L2 data
        // createWebDavModelObject needs the full file objects for model, image, json
        // We have modelFileObject. We need to find imageFileToUse.
        // jsonFileToUse is associatedJsonFileObject.
        // modelJsonInfo is the parsed content.
        const imageFileToUse = this._findAssociatedImageFile(modelFileObject, modelFileBase, modelFileDir);

        builtModelObject = createWebDavModelObject(
            modelFileObject,
            imageFileToUse,
            associatedJsonFileObject, // This is the object, not just path
            modelJsonInfo, // This is the content from L2
            currentSourceId,
            resolvedRootOfSource
        );
        this.logger.debug(`Built MODEL_DETAIL from L2 MODEL_JSON_INFO for: ${modelFileRelativePath}`);

        // Store newly built ModelObject to L1
        if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled && builtModelObject) {
            await this.modelInfoCacheService.setDataToCache(
                CacheDataType.MODEL_DETAIL,
                currentSourceId,
                modelFileRelativePath,
                builtModelObject,
                currentModelFileMetadata, // Metadata of the main model file
                'webdav'
            );
            this.logger.info(`Stored newly built MODEL_DETAIL (from L2 JSON) to L1 for: ${modelFileRelativePath}`);
        }
    } else { // L1 MODEL_DETAIL miss, L2 MODEL_JSON_INFO miss/invalid or no JSON file
        this.logger.debug(`Fetching MODEL_DETAIL from source for: ${modelFileRelativePath} (L1/L2 miss for components).`);
        // Use _buildModelEntry which handles fetching JSON from source and storing to L2 if missed.
        // _buildModelEntry itself will call createWebDavModelObject.
        // Pass an empty map for preFetchedJsonContentsMap as we are reading a single detail.
        builtModelObject = await this._buildModelEntry(modelFileObject, currentSourceId, resolvedRootOfSource, new Map());

        if (builtModelObject && this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
            // _buildModelEntry would have already stored MODEL_JSON_INFO to L2 if it fetched it.
            // Now store the final MODEL_DETAIL to L1.
            await this.modelInfoCacheService.setDataToCache(
                CacheDataType.MODEL_DETAIL,
                currentSourceId,
                modelFileRelativePath,
                builtModelObject,
                currentModelFileMetadata, // Metadata of the main model file
                'webdav'
            );
            this.logger.info(`Stored fetched MODEL_DETAIL to L1 for: ${modelFileRelativePath}`);
        }
    }

    const duration = Date.now() - startTime;
    if (builtModelObject && builtModelObject.name) {
      this.logger.info(`Successfully processed model detail for: '${builtModelObject.fileName || identifier}'. Duration: ${duration}ms.`);
      return builtModelObject;
    } else {
      this.logger.warn(`Failed to get sufficient model detail for identifier: '${identifier}' (modelFile: ${modelFileRelativePath}). Duration: ${duration}ms. Returning empty object.`);
      return {};
    }
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
    const startTime = Date.now();
    await this.ensureInitialized();
    const sourceId = this.config.id;
    const jsonFilePath = relativePath; // pathIdentifier for MODEL_JSON_INFO

    if (!jsonFilePath) {
      this.logger.error(`writeModelJson called with empty relativePath.`);
      throw new Error('Relative path cannot be empty for WebDAV write.');
    }
    if (typeof dataToWrite !== 'string') {
      this.logger.error(`writeModelJson called with dataToWrite not a string.`);
      throw new Error('Data to write must be a string for WebDAV model JSON.');
    }

    const resolvedPath = this._resolvePath(jsonFilePath);
    this.logger.info(`Attempting to write model JSON to WebDAV: ${resolvedPath} (relative: ${jsonFilePath})`);

    try {
      const resolvedDirPath = path.posix.dirname(resolvedPath);
      try {
        await this.client.stat(resolvedDirPath);
      } catch (statError) {
        if (statError.response && statError.response.status === 404) {
          this.logger.info(`Parent directory ${resolvedDirPath} does not exist, attempting to create...`);
          await this.client.createDirectory(resolvedDirPath, { recursive: true });
          this.logger.info(`Successfully created directory ${resolvedDirPath}`);
        } else {
          this.logger.error(`Error checking directory ${resolvedDirPath}:`, statError.message, statError.stack, statError.response?.status);
          throw statError;
        }
      }

      await this.client.putFileContents(resolvedPath, dataToWrite, { overwrite: true });
      const duration = Date.now() - startTime;
      this.logger.info(`Successfully wrote model JSON to WebDAV: ${resolvedPath}, 耗时: ${duration}ms`);

      // --- Cache Invalidation Logic (as per doc 7.3) ---
      if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
        this.logger.info(`Invalidating caches due to JSON write: ${jsonFilePath}`);

        // 1. Invalidate MODEL_JSON_INFO for this file
        await this.modelInfoCacheService.invalidateCacheEntry(CacheDataType.MODEL_JSON_INFO, sourceId, jsonFilePath);

        // 2. Invalidate MODEL_DETAIL for the associated model
        //    Need to determine modelFilePath from jsonFilePath
        const modelFileBaseName = path.posix.basename(jsonFilePath, '.json');
        const dirName = path.posix.dirname(jsonFilePath);
        
        // Find the corresponding model file in _allItemsCache to get its exact name and extension
        // This assumes _allItemsCache is reasonably up-to-date or repopulated if necessary.
        // For simplicity, we'll try to find a match. A more robust way might involve listing the dir.
        await this._populateAllItemsCacheIfNeeded(this._resolvePath('/')); // Ensure cache is fresh
        
        const potentialModelFile = this._allItemsCache.find(item => 
            item.type === 'file' &&
            path.posix.dirname(item.relativePath) === dirName && // dirName is already like /lora or /
            path.posix.basename(item.relativePath, path.posix.extname(item.relativePath)) === modelFileBaseName &&
            !item.relativePath.endsWith('.json') // Not the json file itself
        );

        if (potentialModelFile) {
            const modelFilePath = potentialModelFile.relativePath;
            await this.modelInfoCacheService.invalidateCacheEntry(CacheDataType.MODEL_DETAIL, sourceId, modelFilePath);
        } else {
            this.logger.warn(`Could not determine associated model file for JSON: ${jsonFilePath} to invalidate MODEL_DETAIL. Manual cache clear might be needed for related model details.`);
        }

        this.logger.info(`Relying on contentHash change for MODEL_LIST invalidation for directory of: ${jsonFilePath}`);
      }
      
      // Crucially, update _allItemsCache so the next _getCacheDigest() is correct.
      this._allItemsCache = [];
      this._lastRefreshedFromRootPath = null; // Force refresh
      this.logger.debug(`Cleared _allItemsCache to ensure fresh contentHash on next listModels after JSON write.`);


    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`Failed to write model JSON to WebDAV: ${resolvedPath}, 耗时: ${duration}ms`, error.message, error.stack, error.response?.status);
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
