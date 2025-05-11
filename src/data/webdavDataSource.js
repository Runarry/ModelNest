const DataSource = require('./baseDataSource'); // 导入新的基类
const { parseModelDetailFromJsonContent, createWebDavModelObject } = require('./modelParser'); // 导入 createWebDavModelObject
const path = require('path');
const log = require('electron-log'); // 添加 electron-log 导入
const crypto = require('crypto'); // 引入 crypto 模块

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
    // this._l1Cache = new Map(); // L1 cache will be managed by modelInfoCacheService if available
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

  /**
   * Resolves a relative path against the configured subDirectory.
   * @param {string} relativePath - The path relative to the subDirectory (e.g., '/', '/models', '/models/image.png').
   * @returns {string} The fully resolved path for the WebDAV client (e.g., '/dav/root/models/image.png').
   */
  _resolvePath(relativePath) {
    // Ensure relativePath starts with '/' if not empty or already starting with '/'
    const normalizedRelative = relativePath && relativePath !== '/' && !relativePath.startsWith('/')
      ? `/${relativePath}`
      : relativePath || '/'; // Default to '/' if empty or null

    // If no subDirectory is configured, return the normalized relative path directly
    if (!this.subDirectory) {
      return normalizedRelative;
    }

    // Handle root path relative to subDirectory
    if (normalizedRelative === '/') {
      // Return subDirectory path, ensuring it ends with a slash if it's not just '/'
      return this.subDirectory === '/' ? '/' : `${this.subDirectory}/`;
    }

    // Join subDirectory and the relative path (which already starts with '/')
    const fullPath = `${this.subDirectory}${normalizedRelative}`;

    // Basic normalization: remove double slashes, but be careful not to remove the leading one if subDirectory was empty
    const cleanedPath = fullPath.replace(/\/{2,}/g, '/');

    // log.debug(`[WebDavDataSource][${this.config.id}] _resolvePath: '${relativePath}' -> '${cleanedPath}' (subDir: '${this.subDirectory}')`); // Kept commented out as per original
    return cleanedPath;
  }

  async listSubdirectories() {
    const startTime = Date.now();
    await this.ensureInitialized();
    // List subdirectories relative to the resolved root path
    const resolvedBasePath = this._resolvePath('/');
    log.info(`[WebDavDataSource][${this.config.id}] 开始列出子目录: ${resolvedBasePath}`);
    try {
      const items = await this.client.getDirectoryContents(resolvedBasePath, { deep: false }); // Get only top-level items
      const subdirs = items
        .filter(item =>
          item.type === 'directory' &&
          item.basename !== '.' && // Explicitly exclude . and ..
          item.basename !== '..'
        )
        .map(item => item.basename); // Return just the directory name
      const duration = Date.now() - startTime;
      log.info(`[WebDavDataSource][${this.config.id}] 列出子目录完成: ${resolvedBasePath}, 耗时: ${duration}ms, 找到 ${subdirs.length} 个子目录`);
      return subdirs;
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error(`[WebDavDataSource][${this.config.id}] 列出子目录时出错: ${resolvedBasePath}, 耗时: ${duration}ms`, error.message, error.stack, error.response?.status);
      // Handle cases like 404 Not Found gracefully
      if (error.response && error.response.status === 404) {
        log.warn(`[WebDavDataSource][${this.config.id}] 列出子目录失败 (目录不存在): ${resolvedBasePath}, 耗时: ${duration}ms`);
        return []; // Directory doesn't exist, return empty list
      }
      throw error; // Re-throw other errors
    }
  }

  /**
   * Helper method to recursively traverse directory items using a queue.
   * @param {string} basePathToScan The fully resolved path on the server to start listing from.
   * @param {Function} itemHandlerAsync Async callback function to process each item: (item, currentWebdavPath, sourceId, sourceRoot) => Promise<void>.
   * @param {boolean} processSubdirectories If true, will scan subdirectories.
   * @param {string} sourceId The ID of the data source for logging.
   * @param {string} [sourceRoot] The resolved root path of the WebDAV source, optional.
   * @returns {Promise<void>}
   * @private
   */
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
        // itemsInDir is now rawContents. The result of getDirectoryContents will be stored in rawContents.
        const rawContents = await this.client.getDirectoryContents(currentPath, { deep: false, details: true });
        // actualContents 会在下面根据 rawContents 重新赋值

        if (Array.isArray(rawContents)) {
          actualContents = rawContents;
        } else if (rawContents && typeof rawContents === 'object' && rawContents.filename) {
          // Handle case where a single file/directory object is returned.
          log.debug(`[WebDavDataSource][${sourceId}] _traverseDirectoryItems: getDirectoryContents for ${currentPath} returned a single item object, wrapping in array.`);
          actualContents = [rawContents];
        } else if (rawContents && typeof rawContents === 'object' && Object.keys(rawContents).length === 0) {
          // Handle case where an empty object is returned (e.g., representing an empty directory).
          log.debug(`[WebDavDataSource][${sourceId}] _traverseDirectoryItems: getDirectoryContents for ${currentPath} returned an empty object, treating as empty directory.`);
          actualContents = [];
        } else if (rawContents && typeof rawContents === 'object' && rawContents !== null) {
          // Attempt to extract array from common wrapper object properties.
          let extractedFromArrayWrapper = false;
          if (Array.isArray(rawContents.data)) { actualContents = rawContents.data; extractedFromArrayWrapper = true; }
          else if (Array.isArray(rawContents.items)) { actualContents = rawContents.items; extractedFromArrayWrapper = true; }
          else if (Array.isArray(rawContents.files)) { actualContents = rawContents.files; extractedFromArrayWrapper = true; }
          
          if (extractedFromArrayWrapper) {
            log.warn(`[WebDavDataSource][${sourceId}] _traverseDirectoryItems: getDirectoryContents for ${currentPath} returned an object, but an array was successfully extracted from one of its properties (data, items, or files).`);
          } else {
            log.warn(`[WebDavDataSource][${sourceId}] _traverseDirectoryItems: getDirectoryContents for ${currentPath} returned an object that is not a single item and from which an array could not be extracted. Received:`, rawContents, ". Treating as empty.");
            actualContents = []; // Treat as empty if no array could be extracted
          }
        } else {
          // Handle other unexpected non-array types.
          log.warn(`[WebDavDataSource][${sourceId}] _traverseDirectoryItems: getDirectoryContents for ${currentPath} returned unexpected non-array type. Received: ${typeof rawContents}. Value:`, rawContents, ". Treating as empty.");
          actualContents = [];
        }
      } catch (error) {
        log.error(`[WebDavDataSource][${sourceId}] _traverseDirectoryItems: Error fetching directory contents for ${currentPath}:`, error.message, error.stack, error.response?.status);
        if (error.response && (error.response.status === 404 || error.response.status === 403)) {
          log.warn(`[WebDavDataSource][${sourceId}] _traverseDirectoryItems: Skipping inaccessible directory: ${currentPath} (Status: ${error.response.status})`);
        }
        continue; // Skip to next in queue
      }

      for (const item of actualContents) {
        if (item.basename === '.' || item.basename === '..') continue;

        // Call the item handler for the item.
        // The handler itself will decide what to do based on item.type or other conditions.
        await itemHandlerAsync(item, currentPath, sourceId, sourceRoot);

        if (item.type === 'directory' && processSubdirectories) {
          // item.filename should be the fully resolved path
          if (item.filename && !visited.has(item.filename)) {
            queue.push(item.filename);
          }
        }
      }
    }
  }

  /**
   * Recursively populates this._allItemsCache (Array) with relative file paths.
   * Uses the _traverseDirectoryItems helper for the traversal logic.
   * @param {string} basePathToScan The fully resolved path on the server to start listing from.
   */
  async _populateAllItemsCache(basePathToScan) {
    const sourceId = this.config.id;
    log.info(`[WebDavDataSource][${sourceId}] Starting to populate _allItemsCache (Array of file objects) from: ${basePathToScan}`);
    this._allItemsCache = []; // Ensure starting with an empty array
    const sourceRoot = this._resolvePath('/'); // Get the resolved root of the WebDAV source

    const itemHandler = async (item, _currentWebdavPath, currentSourceId, currentSourceRoot) => {
      // _currentWebdavPath is available if needed, but not used directly here for relativePath calculation
      if (item.type === 'file') {
        let relativeFilePath = item.filename; // item.filename is the full resolved path
        if (item.filename.startsWith(currentSourceRoot)) {
          relativeFilePath = item.filename.substring(currentSourceRoot.length);
          // Normalize: if currentSourceRoot is '/foo/' and item.filename is '/foo/bar.txt', relativeFilePath becomes 'bar.txt'
          // if currentSourceRoot is '/foo' and item.filename is '/foo/bar.txt', relativeFilePath becomes '/bar.txt'
          // We want relative paths to not start with '/', e.g., 'bar.txt' or 'subdir/bar.txt'
          if (relativeFilePath.startsWith('/')) {
            relativeFilePath = relativeFilePath.substring(1);
          }
        } else {
          log.warn(`[WebDavDataSource][${currentSourceId}] _populateAllItemsCache/itemHandler: File ${item.filename} does not start with source root ${currentSourceRoot}. Using basename as relativePath fallback.`);
          relativeFilePath = item.basename; // Fallback, might not be unique or correct for subdirs
        }
        
        this._allItemsCache.push({
          // item itself contains: filename, basename, type, size, lastmod, etag
          ...item,
          relativePath: relativeFilePath // Add our calculated relativePath
        });
      }
      // Directory queuing is handled by _traverseDirectoryItems itself.
    };

    await this._traverseDirectoryItems(basePathToScan, itemHandler, true, sourceId, sourceRoot);
    log.info(`[WebDavDataSource][${sourceId}] _populateAllItemsCache complete. Found ${this._allItemsCache.length} file objects.`);
  }
 
  /**
   * Lists all files starting from a given base path using a queue, optionally scanning subdirectories.
   * Uses the _traverseDirectoryItems helper for the traversal logic.
   * This method returns a flat array of all file stat objects found.
   * @param {string} basePathToScan The fully resolved path on the server to start listing from.
   * @param {boolean} scanSubdirectories If true, will scan subdirectories.
   * @returns {Promise<Array<object>>} A promise resolving to a flat array of all file stat objects found.
   */
  async _recursiveListAllFiles(basePathToScan, scanSubdirectories = true) {
    const sourceId = this.config.id;
    log.debug(`[WebDavDataSource][${sourceId}] _recursiveListAllFiles: Path: ${basePathToScan}, ScanSubdirs: ${scanSubdirectories}`);
    const allFilesFound = [];
  
    const itemHandler = async (item, _currentWebdavPath, _currentSourceId, _currentSourceRoot) => {
      if (item.type === 'file') {
        allFilesFound.push(item);
      }
      // Directory queuing is handled by _traverseDirectoryItems itself if scanSubdirectories is true.
    };
  
    // The third argument to _traverseDirectoryItems is processSubdirectories
    await this._traverseDirectoryItems(basePathToScan, itemHandler, scanSubdirectories, sourceId, null);
    log.debug(`[WebDavDataSource][${sourceId}] _recursiveListAllFiles from ${basePathToScan} complete. Found ${allFilesFound.length} file objects.`);
    return allFilesFound;
  }

  /**
   * Recursively retrieves items from the cache starting from dirPath.
   * @param {string} dirPath The starting directory path (resolved).
   * @param {Map<string, Array<object>>} cache The cache to use (this._allItemsCache).
   * @param {Set<string>} visitedDirs Tracks visited directories to prevent infinite loops.
   * @returns {Array<object>} A flat list of all items (files and directories) under dirPath.
   */
  _getRecursiveItemsFromCache(dirPath, cache, visitedDirs = new Set()) {
    if (!cache || !cache.has(dirPath) || visitedDirs.has(dirPath)) {
      if (visitedDirs.has(dirPath)) log.warn(`[WebDavDataSource][_getRecursiveItemsFromCache] Circular reference or re-visit detected for ${dirPath}`);
      return [];
    }
    visitedDirs.add(dirPath);

    const itemsInCurrentDir = cache.get(dirPath) || [];
    let allItems = [...itemsInCurrentDir]; // Start with items in the current directory

    for (const item of itemsInCurrentDir) {
      if (item.type === 'directory' && item.filename) {
        // item.filename is the resolved path of the subdirectory
        const subDirItems = this._getRecursiveItemsFromCache(item.filename, cache, visitedDirs);
        allItems = allItems.concat(subDirItems);
      }
    }
    return allItems;
  }

  /**
   * Batch fetches content for multiple JSON files.
   * @param {string[]} jsonFilePaths - An array of fully resolved paths to JSON files.
   * @returns {Promise<Map<string, string|null>>} A map where keys are file paths and values are file contents (string) or null if fetching failed.
   */
  async _batchFetchJsonContents(jsonFilePaths) {
    const startTime = Date.now();
    await this.ensureInitialized();
    const sourceId = this.config.id;
    const resultsMap = new Map();

    if (!jsonFilePaths || jsonFilePaths.length === 0) {
      // log.debug(`[WebDavDataSource][${sourceId}] _batchFetchJsonContents: No JSON file paths provided.`); // Removed: Can be inferred from subsequent logs if needed
      return resultsMap;
    }

    log.info(`[WebDavDataSource][${sourceId}] _batchFetchJsonContents: Starting batch fetch for ${jsonFilePaths.length} JSON files.`);

    const fetchPromises = jsonFilePaths.map(filePath =>
      this.client.getFileContents(filePath, { format: 'text' })
        .then(content => ({ status: 'fulfilled', path: filePath, value: content }))
        .catch(error => ({ status: 'rejected', path: filePath, reason: error }))
    );

    const settledResults = await Promise.allSettled(fetchPromises);

    settledResults.forEach(result => {
      if (result.status === 'fulfilled' && result.value.status === 'fulfilled') {
        resultsMap.set(result.value.path, result.value.value);
        // log.debug(`[WebDavDataSource][${sourceId}] _batchFetchJsonContents: Successfully fetched ${result.value.path}`); // Removed: Too verbose, one per file
      } else if (result.status === 'fulfilled' && result.value.status === 'rejected') {
        // This case handles errors caught within the individual fetchPromises' .catch
        resultsMap.set(result.value.path, null); // Mark as failed to fetch
        log.error(`[WebDavDataSource][${sourceId}] _batchFetchJsonContents: Failed to fetch ${result.value.path}:`, result.value.reason.message, result.value.reason.response?.status);
      } else if (result.status === 'rejected') {
        // This case handles errors if Promise.allSettled itself has an issue with a promise (less common here)
        // We need to know which path failed if possible, but result.reason might not contain it directly.
        // For now, we assume the inner catch handles path association.
        log.error(`[WebDavDataSource][${sourceId}] _batchFetchJsonContents: A promise in batch fetch was rejected unexpectedly:`, result.reason);
      }
    });

    const duration = Date.now() - startTime;
    log.info(`[WebDavDataSource][${sourceId}] _batchFetchJsonContents: Finished batch fetch. ${resultsMap.size} results (some might be null for failures). Duration: ${duration}ms`);
    return resultsMap;
  }

  async _buildModelEntry(modelFile, passedSourceId, passedResolvedBasePath, preFetchedJsonContentsMap = new Map()) {
    const startTime = Date.now();
    await this.ensureInitialized(); // Ensure client is ready

    // Validate modelFile (which is now an object from _allItemsCache)
    if (!modelFile || !modelFile.filename || typeof modelFile.filename !== 'string' || !modelFile.relativePath || typeof modelFile.relativePath !== 'string') {
      log.error(`[WebDavDataSource][_buildModelEntry] Invalid modelFile provided (missing filename or relativePath). modelFile: ${JSON.stringify(modelFile)}`);
      return null;
    }

    let currentSourceId = passedSourceId || this.config.id;
    // currentAllItemsInDir is no longer used as a parameter for fetching, it's derived from _allItemsCache
    let currentResolvedBasePath = passedResolvedBasePath || this._resolvePath('/');


    // modelFile.filename is the fully resolved path on the server
    // modelFile.relativePath is relative to the source's root

    // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 开始处理模型文件 ${modelFile.filename} (relative: ${modelFile.relativePath})`);

    const modelFileDirRelative = path.posix.dirname(modelFile.relativePath);
    // Ensure modelFileDirRelative is not '.' if modelFile.relativePath is a root file like 'file.txt'
    // path.posix.dirname('file.txt') is '.', path.posix.dirname('/file.txt') is '/'
    // Our relativePath does not start with '/', so dirname will be '.' for root files.
    const searchDirRelative = modelFileDirRelative === '.' ? '' : modelFileDirRelative;


    const modelFileBaseOriginal = path.posix.basename(modelFile.relativePath, path.posix.extname(modelFile.relativePath));
    
    let associatedJsonFile = null;
    let associatedImageFile = null;
    let previewImageFile = null; // For .preview.png

    const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

    for (const cachedItem of this._allItemsCache) {
      // Compare directories based on relative paths
      const cachedItemDirRelative = path.posix.dirname(cachedItem.relativePath);
      const normalizedCachedItemDir = cachedItemDirRelative === '.' ? '' : cachedItemDirRelative;

      if (normalizedCachedItemDir === searchDirRelative) {
        const itemBase = path.posix.basename(cachedItem.relativePath, path.posix.extname(cachedItem.relativePath));
        const itemExt = path.posix.extname(cachedItem.relativePath).toLowerCase();

        if (itemBase === modelFileBaseOriginal) {
          if (imageExtensions.includes(itemExt)) {
            if (!associatedImageFile) associatedImageFile = cachedItem; // Take the first one found
          } else if (itemExt === '.json') {
            if (!associatedJsonFile) associatedJsonFile = cachedItem;
          }
        } else if (itemBase === `${modelFileBaseOriginal}.preview` && imageExtensions.includes(itemExt)) {
           if (!previewImageFile) previewImageFile = cachedItem; // Found a .preview.ext image
        }
      }
    }

    const imageFileToUse = previewImageFile || associatedImageFile; // Prioritize .preview.ext
    const jsonFileToUse = associatedJsonFile;

    // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: For ${modelFile.relativePath} - Found JSON: ${jsonFileToUse?.relativePath}, Image: ${imageFileToUse?.relativePath}`);
    
    let modelJsonInfo = {};
    if (jsonFileToUse) {
      // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Attempting to read JSON file ${jsonFileToUse.filename} (relative: ${jsonFileToUse.relativePath})`);
      try {
        let jsonContent;
        // jsonFileToUse.filename is the resolved path
        if (preFetchedJsonContentsMap.has(jsonFileToUse.filename)) {
          jsonContent = preFetchedJsonContentsMap.get(jsonFileToUse.filename);
          if (jsonContent === null) { // Explicitly null means prefetch failed
            log.warn(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Pre-fetch for JSON ${jsonFileToUse.filename} failed. Will attempt individual fetch.`);
            // Fall through to individual fetch
          } else {
            // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Using pre-fetched JSON content for ${jsonFileToUse.filename}`);
          }
        }

        // If not pre-fetched or pre-fetch failed (jsonContent is null or undefined)
        if (jsonContent === undefined || jsonContent === null) {
          // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: ${jsonContent === null ? 'Pre-fetch failed, ' : ''}attempting individual read for JSON file ${jsonFileToUse.filename}`);
          jsonContent = await this.client.getFileContents(jsonFileToUse.filename, { format: 'text' });
          // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Successfully read JSON individually: ${jsonFileToUse.filename}`);
        }
        
        if (typeof jsonContent === 'string') {
          modelJsonInfo = JSON.parse(jsonContent);
          // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Successfully parsed JSON for ${jsonFileToUse.filename}`);
        } else {
           log.warn(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: JSON content for ${jsonFileToUse.filename} was not a string after fetch attempts. Content:`, jsonContent);
        }

      } catch (error) {
        log.error(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Error reading or parsing JSON file ${jsonFileToUse.filename}:`, error.message, error.stack, error.response?.status);
        // modelJsonInfo remains {}
      }
    } else {
      // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Model ${modelFile.filename} has no associated JSON file.`);
    }

    try {
      const modelObj = createWebDavModelObject(
        modelFile, // This is the full modelFile object from _allItemsCache
        imageFileToUse, // This is also a full object from _allItemsCache, or null
        jsonFileToUse,  // This is also a full object from _allItemsCache, or null
        modelJsonInfo,
        currentSourceId,
        currentResolvedBasePath // This is the resolved root of the source
      );
      const duration = Date.now() - startTime;
      // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Model object created for ${modelFile.filename}, Duration: ${duration}ms`);
      return modelObj;
    } catch (error) {
      log.error(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 调用 createWebDavModelObject 时出错 for ${modelFile.filename}:`, error.message, error.stack);
      return null;
    }
  }

  /**
   * Ensures _allItemsCache is populated if needed.
   * @param {string} resolvedRootOfSource - The resolved root path of the WebDAV source.
   */
  async _populateAllItemsCacheIfNeeded(resolvedRootOfSource) {
    const sourceId = this.config.id;
    // If cache is empty, or last refresh was for a different root path, or if it's a root request (which often implies a desire for fresh data)
    // For WebDAV, _allItemsCache is crucial, so ensure it's populated based on the source's root.
    if (this._allItemsCache.length === 0 || this._lastRefreshedFromRootPath !== resolvedRootOfSource) {
      log.info(`[WebDavDataSource][${sourceId}] _populateAllItemsCacheIfNeeded: Refreshing _allItemsCache from root: ${resolvedRootOfSource}. Reason: cacheEmpty=${this._allItemsCache.length === 0}, lastRefreshMismatch=${this._lastRefreshedFromRootPath !== resolvedRootOfSource}`);
      await this._populateAllItemsCache(resolvedRootOfSource); // Populates with file objects
      this._lastRefreshedFromRootPath = resolvedRootOfSource;
    } else {
      log.debug(`[WebDavDataSource][${sourceId}] _populateAllItemsCacheIfNeeded: Using existing _allItemsCache with ${this._allItemsCache.length} items, last refreshed from ${this._lastRefreshedFromRootPath}.`);
    }
  }

  async listModels(directory = null, sourceConfig, supportedExts = [], showSubdirectory = true) {
    const startTime = Date.now();
    await this.ensureInitialized();
    const currentSourceId = sourceConfig ? sourceConfig.id : this.config.id;

    // Normalize directory for cache key consistency (e.g., null or empty string for root)
    const normalizedDirectory = directory ? path.posix.normalize(directory) : '';
    const cacheKey = `listModels:${currentSourceId}:${normalizedDirectory}:showSubDir=${showSubdirectory}:exts=${supportedExts.join(',')}`;

    log.info(`[WebDavDataSource][${currentSourceId}] ListModels request. Directory: '${normalizedDirectory}', ShowSubDir: ${showSubdirectory}. CacheKey: ${cacheKey}`);

    const resolvedRootOfSource = this._resolvePath('/'); // The absolute root of this WebDAV source configuration

    // --- L1 Cache Check (via modelInfoCacheService) ---
    if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
      const l1Hit = this.modelInfoCacheService.getFromL1(cacheKey, 'listModels');
      if (l1Hit && l1Hit.data && l1Hit.cacheDigest) {
        log.debug(`[WebDavDataSource][${currentSourceId}] L1 cache hit for listModels: ${cacheKey}. Verifying digest...`);
        // Ensure _allItemsCache is up-to-date before generating current digest for validation
        await this._populateAllItemsCacheIfNeeded(resolvedRootOfSource);
        const currentDigest = this._getCacheDigest();
        if (currentDigest && currentDigest === l1Hit.cacheDigest) {
          log.info(`[WebDavDataSource][${currentSourceId}] L1 cache valid (digest matched) for listModels: ${cacheKey}. Returning cached data. Duration: ${Date.now() - startTime}ms`);
          return l1Hit.data; // Return deep cloned data from cache service
        }
        log.info(`[WebDavDataSource][${currentSourceId}] L1 cache digest mismatch for listModels: ${cacheKey}. Cached: ${l1Hit.cacheDigest}, Current: ${currentDigest}. Proceeding to fetch.`);
      } else if (l1Hit) {
        log.debug(`[WebDavDataSource][${currentSourceId}] L1 cache hit for listModels: ${cacheKey}, but data or digest is missing. Proceeding to fetch.`);
      } else {
        log.debug(`[WebDavDataSource][${currentSourceId}] L1 cache miss for listModels: ${cacheKey}. Proceeding to fetch.`);
      }
    } else {
      log.debug(`[WebDavDataSource][${currentSourceId}] Cache service not available or disabled for listModels. Proceeding to fetch directly.`);
    }

    // --- Cache Miss or Invalid: Proceed with original logic ---
    const relativeRequestDir = directory ? (directory.startsWith('/') ? directory : `/${directory}`) : '/';
    const resolvedRequestDir = this._resolvePath(relativeRequestDir);

    if (directory === null && showSubdirectory === false) {
      log.info(`[WebDavDataSource][${currentSourceId}] '全部' 视图 (directory is null and showSubdirectory is false), 自动将 showSubdirectory 设置为 true 以递归显示所有模型。`);
      showSubdirectory = true;
    }
    // Log has been moved up

    // Ensure _allItemsCache is populated. This might have been done during L1 check.
    await this._populateAllItemsCacheIfNeeded(resolvedRootOfSource);
    
    let allItemsFlatList = [];
    // Calculate the relative path of the requested directory for filtering _allItemsCache
    let relativeRequestDirForFiltering = resolvedRequestDir;
    if (resolvedRequestDir.startsWith(resolvedRootOfSource)) {
        relativeRequestDirForFiltering = resolvedRequestDir.substring(resolvedRootOfSource.length);
        if (relativeRequestDirForFiltering.startsWith('/')) {
            relativeRequestDirForFiltering = relativeRequestDirForFiltering.substring(1);
        }
    }
    // if relativeRequestDirForFiltering is empty string, it means resolvedRequestDir is same as resolvedRootOfSource

    allItemsFlatList = this._allItemsCache.filter(cachedItem => {
      if (showSubdirectory) {
        return relativeRequestDirForFiltering === '' || cachedItem.relativePath.startsWith(relativeRequestDirForFiltering);
      } else {
        const itemDirRelative = path.posix.dirname(cachedItem.relativePath);
        const normalizedItemDir = itemDirRelative === '.' ? '' : itemDirRelative;
        return normalizedItemDir === relativeRequestDirForFiltering;
      }
    });

    log.info(`[WebDavDataSource][${currentSourceId}] Filtered _allItemsCache. ${allItemsFlatList.length} items for request path '${resolvedRequestDir}' (relative: '${relativeRequestDirForFiltering}', showSubDir: ${showSubdirectory})`);

    const modelFileItems = allItemsFlatList.filter(item =>
      item.type === 'file' && supportedExts.some(ext => item.filename.endsWith(ext))
    );

    log.info(`[WebDavDataSource][${currentSourceId}] From ${allItemsFlatList.length} items, filtered to ${modelFileItems.length} potential model files.`);

    const potentialJsonFileFullPaths = new Set();
    if (Array.isArray(modelFileItems)) {
      modelFileItems.forEach(modelFile => {
        const modelFileDirRelative = path.posix.dirname(modelFile.relativePath);
        const searchDirRelative = modelFileDirRelative === '.' ? '' : modelFileDirRelative;
        const modelFileBase = path.posix.basename(modelFile.relativePath, path.posix.extname(modelFile.relativePath));
        
        for (const cachedItem of this._allItemsCache) {
          const cachedItemDirRelative = path.posix.dirname(cachedItem.relativePath);
          const normalizedCachedItemDir = cachedItemDirRelative === '.' ? '' : cachedItemDirRelative;
          if (normalizedCachedItemDir === searchDirRelative) {
            const itemBase = path.posix.basename(cachedItem.relativePath, path.posix.extname(cachedItem.relativePath));
            const itemExt = path.posix.extname(cachedItem.relativePath).toLowerCase();
            if (itemBase === modelFileBase && itemExt === '.json') {
              potentialJsonFileFullPaths.add(cachedItem.filename);
              break;
            }
          }
        }
      });
    }
    
    const uniqueJsonFilePaths = Array.from(potentialJsonFileFullPaths);
    let preFetchedJsonContentsMap = new Map();
    if (uniqueJsonFilePaths.length > 0) {
      log.info(`[WebDavDataSource][${currentSourceId}] Found ${uniqueJsonFilePaths.length} unique JSON files to pre-fetch.`);
      preFetchedJsonContentsMap = await this._batchFetchJsonContents(uniqueJsonFilePaths);
      log.info(`[WebDavDataSource][${currentSourceId}] Batch pre-fetch complete for ${uniqueJsonFilePaths.length} JSON files. Got ${preFetchedJsonContentsMap.size} results.`);
    } else {
      log.info(`[WebDavDataSource][${currentSourceId}] No JSON files found to pre-fetch.`);
    }

    const allModels = [];
    const modelBuildPromises = [];

    for (const modelFile of modelFileItems) {
      modelBuildPromises.push(
        this._buildModelEntry(modelFile, currentSourceId, resolvedRootOfSource, preFetchedJsonContentsMap)
      );
    }
    
    log.info(`[WebDavDataSource][${currentSourceId}] 开始并行构建 ${modelBuildPromises.length} 个模型条目.`);
    const settledModelEntries = await Promise.allSettled(modelBuildPromises);

    settledModelEntries.forEach(result => {
      if (result.status === 'fulfilled' && result.value) {
        allModels.push(result.value);
      } else if (result.status === 'fulfilled' && !result.value) {
        log.warn(`[WebDavDataSource][${currentSourceId}] _buildModelEntry 返回 null，跳过一个模型条目.`);
      } else if (result.status === 'rejected') {
        log.error(`[WebDavDataSource][${currentSourceId}] 构建模型条目时发生未捕获的错误:`, result.reason);
      }
    });

    // --- Store to L1 Cache (via modelInfoCacheService) ---
    if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
      // _allItemsCache should be up-to-date at this point from _populateAllItemsCacheIfNeeded
      const currentDigest = this._getCacheDigest();
      if (currentDigest) {
        log.info(`[WebDavDataSource][${currentSourceId}] Storing listModels result to L1 cache. Key: ${cacheKey}, Digest: ${currentDigest}`);
        this.modelInfoCacheService.setToL1(cacheKey, allModels, 'listModels', { cacheDigest: currentDigest });
      } else {
        log.warn(`[WebDavDataSource][${currentSourceId}] Could not generate cache digest. listModels result not cached for key: ${cacheKey}`);
      }
    }

    const duration = Date.now() - startTime;
    log.info(`[WebDavDataSource][${currentSourceId}] 列出模型完成: ${resolvedRequestDir}, 耗时: ${duration}ms, 成功构建 ${allModels.length} 个模型 (总共尝试 ${modelFileItems.length} 个)`);
    return allModels;
  }

  async _statIfExists(relativePath) {
    if (!relativePath || typeof relativePath !== 'string' || relativePath.trim() === '') {
      log.warn(`[WebDavDataSource][${this.config.id}] _statIfExists: Invalid relativePath provided: '${relativePath}'`); // Changed to warn
      return null;
    }
    const resolvedPath = this._resolvePath(relativePath);
    try {
      const statResult = await this.client.stat(resolvedPath);
      // log.debug(`[WebDavDataSource][${this.config.id}] _statIfExists: Successfully statted ${resolvedPath} (relative: ${relativePath})`); // Removed: Too verbose
      return statResult;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        // log.debug(`[WebDavDataSource][${this.config.id}] _statIfExists: File not found at ${resolvedPath} (relative: ${relativePath})`); // Removed: Not an error, expected outcome for this function
      } else {
        log.warn(`[WebDavDataSource][${this.config.id}] _statIfExists: Error stating file ${resolvedPath} (relative: ${relativePath})`, error.message, error.response?.status);
      }
      return null;
    }
  }

  async readModelDetail(identifier, modelFileName, passedSourceId) { // modelFileName is not strictly needed if identifier is the primary key
    const startTime = Date.now();
    await this.ensureInitialized();
    const currentSourceId = passedSourceId || this.config.id;

    log.info(`[WebDavDataSource readModelDetail][${currentSourceId}] Entry. Identifier: '${identifier}', modelFileName (relative path): '${modelFileName}'`);

    // Ensure _allItemsCache is populated. If listModels hasn't been called, this might be an issue.
    // A robust solution might involve checking cache status and populating if necessary.
    // For now, assume cache is populated from prior listModels or initialization.
    if (this._allItemsCache.length === 0 && this._lastRefreshedFromRootPath === null) {
        log.warn(`[WebDavDataSource readModelDetail][${currentSourceId}] _allItemsCache is empty. Attempting to populate.`);
        // This implies readModelDetail might need to know the source's root to populate.
        // This could be complex if called standalone. For now, rely on prior population.
        // A simple fix: if cache is empty, try to populate from root.
        const resolvedRootOfSource = this._resolvePath('/');
        await this._populateAllItemsCache(resolvedRootOfSource);
        this._lastRefreshedFromRootPath = resolvedRootOfSource;
        if (this._allItemsCache.length === 0) {
             log.error(`[WebDavDataSource readModelDetail][${currentSourceId}] Critical: _allItemsCache still empty after attempted population. Cannot find model file '${modelFileName}'.`);
             return {};
        }
    }
    
    let normalizedModelFileName = modelFileName;
    if (normalizedModelFileName && normalizedModelFileName.startsWith('/')) {
      normalizedModelFileName = normalizedModelFileName.substring(1);
    }
    const modelFileObject = this._allItemsCache.find(item => item.relativePath === normalizedModelFileName);

    if (!modelFileObject) {
      log.error(`[WebDavDataSource readModelDetail][${currentSourceId}] Critical: Model file '${modelFileName}' not found in _allItemsCache (identifier: '${identifier}').`);
      return {};
    }

    // log.debug(`[WebDavDataSource readModelDetail][${currentSourceId}] Found modelFileObject in cache:`, modelFileObject);

    // _buildModelEntry expects the modelFile object, sourceId, resolvedBasePath (root of source), and optional preFetchedJson.
    // We don't have preFetchedJsonContentsMap here, so _buildModelEntry will fetch JSON individually if needed.
    const resolvedRootOfSource = this._resolvePath('/'); // Needed by _buildModelEntry for context
    const modelDetail = await this._buildModelEntry(modelFileObject, currentSourceId, resolvedRootOfSource, new Map());

    const duration = Date.now() - startTime;
    if (modelDetail && modelDetail.name) {
      log.info(`[WebDavDataSource readModelDetail][${currentSourceId}] Successfully processed model detail for: '${modelDetail.fileName || identifier}'. Duration: ${duration}ms.`);
      // log.debug(`[WebDavDataSource readModelDetail][${currentSourceId}] Result detail:`, JSON.stringify(modelDetail, null, 2));
      return modelDetail;
    } else {
      log.warn(`[WebDavDataSource readModelDetail][${currentSourceId}] Failed to get sufficient model detail for identifier: '${identifier}' (modelFile: ${modelFileName}) using _buildModelEntry. Duration: ${duration}ms. Returning empty object.`);
      return {};
    }
  }

  async getImageData(relativePath) {
    const startTime = Date.now();
    await this.ensureInitialized();
    if (!relativePath) {
      log.warn(`[WebDavDataSource][${this.config.id}] getImageData 调用时 relativePath 为空`);
      return null;
    }
    const resolvedPath = this._resolvePath(relativePath);
    // log.debug(`[WebDavDataSource][${this.config.id}] 开始获取图片数据: ${resolvedPath} (relative: ${relativePath})`); // Removed: Too verbose
    try {
      const content = await this.client.getFileContents(resolvedPath);

      // log.debug(`[WebDavDataSource][${this.config.id}] 获取图片数据成功: ${resolvedPath}, 大小: ${content.length} bytes`); // Removed: Too verbose
      return {
        path: relativePath, // Return the original relative path
        data: content,
        // Determine mimeType from relativePath extension
        mimeType: (() => {
          let mime = 'application/octet-stream'; // Default mime type
          const ext = path.posix.extname(relativePath).slice(1).toLowerCase();
          if (ext) {
            const knownImageTypes = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'];
            if (knownImageTypes.includes(ext)) {
              mime = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
              if (ext === 'svg') mime = 'image/svg+xml';
            }
          }
          // log.debug(`[WebDavDataSource][${this.config.id}] Determined mimeType for ${relativePath}: ${mime}`); // Removed: Too verbose
          return mime;
        })() // Use determined mimeType
      };
    } catch (e) {
      const duration = Date.now() - startTime;
      log.error(`[WebDavDataSource][${this.config.id}] 获取图片数据时出错: ${resolvedPath}, 耗时: ${duration}ms`, e.message, e.stack, e.response?.status);
      if (e.response && e.response.status === 404) {
        log.warn(`[WebDavDataSource][${this.config.id}] 获取图片数据失败 (文件不存在): ${resolvedPath}, 耗时: ${duration}ms`);
      }
      return null;
    }
  }
  async writeModelJson(relativePath, dataToWrite) { // dataToWrite is now a JSON string
    const startTime = Date.now();
    await this.ensureInitialized();
    const sourceId = this.config.id;

    if (!relativePath) {
      log.error(`[WebDavDataSource][${sourceId}] writeModelJson called with empty relativePath.`);
      throw new Error('Relative path cannot be empty for WebDAV write.');
    }
    if (typeof dataToWrite !== 'string') {
      log.error(`[WebDavDataSource][${sourceId}] writeModelJson called with dataToWrite not a string.`);
      throw new Error('Data to write must be a string for WebDAV model JSON.');
    }

    const resolvedPath = this._resolvePath(relativePath);
    log.info(`[WebDavDataSource][${sourceId}] Attempting to write model JSON to WebDAV: ${resolvedPath} (relative: ${relativePath})`);

    try {
      const resolvedDirPath = path.posix.dirname(resolvedPath);
      try {
        await this.client.stat(resolvedDirPath);
        // log.debug(`[WebDavDataSource][${sourceId}] Parent directory ${resolvedDirPath} exists.`); // Removed: Too verbose
      } catch (statError) {
        if (statError.response && statError.response.status === 404) {
          log.info(`[WebDavDataSource][${sourceId}] Parent directory ${resolvedDirPath} does not exist, attempting to create...`);
          await this.client.createDirectory(resolvedDirPath, { recursive: true });
          log.info(`[WebDavDataSource][${sourceId}] Successfully created directory ${resolvedDirPath}`);
        } else {
          log.error(`[WebDavDataSource][${sourceId}] Error checking directory ${resolvedDirPath}:`, statError.message, statError.stack, statError.response?.status);
          throw statError;
        }
      }

      // dataToWrite is already a JSON string
      await this.client.putFileContents(resolvedPath, dataToWrite, { overwrite: true });
      const duration = Date.now() - startTime;
      log.info(`[WebDavDataSource][${this.config.id}] Successfully wrote model JSON to WebDAV: ${resolvedPath}, 耗时: ${duration}ms`);

      // --- Cache Invalidation Logic ---
      log.info(`[WebDavDataSource][${sourceId}] Invalidating cache due to JSON write: ${relativePath}`);
      // 1. Clear internal _allItemsCache to force refresh on next listModels
      this._allItemsCache = [];
      this._lastRefreshedFromRootPath = null;
      log.debug(`[WebDavDataSource][${sourceId}] Cleared _allItemsCache due to JSON write.`);

      // 2. Invalidate L1/L2 listModels cache for this source
      if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
        try {
          // Invalidate all listModels caches for this source.
          // The most straightforward way is to use invalidateListModelsCacheForDirectory with an empty relative path,
          // assuming the service handles this as clearing all for the source or at least the root.
          await this.modelInfoCacheService.invalidateListModelsCacheForDirectory(sourceId, '');
          log.info(`[WebDavDataSource][${sourceId}] Requested invalidation of all listModels caches for source due to JSON write.`);
        } catch (cacheError) {
          log.error(`[WebDavDataSource][${sourceId}] Error invalidating listModels cache after JSON write:`, cacheError);
        }
      }
      // If readModelDetail had its own L1/L2 cache for individual models, those would also need invalidation here.
      // e.g., find the L1 key for the model associated with this JSON and delete it.

    } catch (error) {
      const duration = Date.now() - startTime;
      log.error(`[WebDavDataSource][${this.config.id}] Failed to write model JSON to WebDAV: ${resolvedPath}, 耗时: ${duration}ms`, error.message, error.stack, error.response?.status);
      // Re-throw the error for the interface to handle
      throw error;
    }
  }

  /**
   * Gets stat information for a file or directory. Used for validation.
   * @param {string} relativePath - The path relative to the subDirectory.
   * @returns {Promise<object>} A promise resolving to the stat object from the webdav client.
   * @throws Will throw an error if the path doesn't exist or is inaccessible.
   */
  async stat(relativePath) {
    const startTime = Date.now();
    await this.ensureInitialized();
    if (relativePath === undefined || relativePath === null) {
      log.error(`[WebDavDataSource][${this.config.id}] stat called with invalid relativePath: ${relativePath}`);
      throw new Error('Relative path cannot be null or undefined for stat.');
    }
    const resolvedPath = this._resolvePath(relativePath);
    // log.debug(`[WebDavDataSource][${this.config.id}] Attempting to stat path: ${resolvedPath} (relative: ${relativePath})`); // Removed: Too verbose
    try {
      const stats = await this.client.stat(resolvedPath);
      const duration = Date.now() - startTime;
      // log.debug(`[WebDavDataSource][${this.config.id}] Successfully stat path: ${resolvedPath}, 耗时: ${duration}ms`); // Removed: Too verbose
      return stats;
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error(`[WebDavDataSource][${this.config.id}] Failed to stat path: ${resolvedPath}, 耗时: ${duration}ms`, error.message, error.stack, error.response?.status);
      throw error; // Re-throw for validation logic
    }
  }

  /**
   * Calculates a digest for the current state of _allItemsCache.
   * This is used for validating L1/L2 cache for listModels.
   * @returns {string|null} A SHA256 hash string or null if cache is empty.
   */
  _getCacheDigest() {
    const sourceId = this.config.id;
    if (!this._allItemsCache || this._allItemsCache.length === 0) {
      log.warn(`[WebDavDataSource][${sourceId}] _getCacheDigest: _allItemsCache is empty. Cannot generate digest.`);
      return null;
    }

    const metadataItems = [];
    // Sort items by relativePath to ensure consistent hash
    const sortedCache = [...this._allItemsCache].sort((a, b) => {
      if (a.relativePath < b.relativePath) return -1;
      if (a.relativePath > b.relativePath) return 1;
      return 0;
    });

    for (const item of sortedCache) {
      // Use properties that indicate change: relativePath, size, lastmod, etag
      // Ensure all parts are strings to avoid issues with undefined/null in join
      const path = String(item.relativePath || '');
      const size = String(item.size || '0');
      const lastmod = String(item.lastmod || '0');
      const etag = String(item.etag || '');
      metadataItems.push(`${path}:${size}:${lastmod}:${etag}`);
    }

    if (metadataItems.length === 0) {
      // This case should ideally not be hit if _allItemsCache has items,
      // but as a fallback, provide a consistent hash for "empty relevant metadata".
      log.debug(`[WebDavDataSource][${sourceId}] _getCacheDigest: No metadata items collected from _allItemsCache, returning empty string hash.`);
      return crypto.createHash('sha256').update('').digest('hex');
    }

    const metadataString = metadataItems.join('|');
    const hash = crypto.createHash('sha256').update(metadataString).digest('hex');
    log.debug(`[WebDavDataSource][${sourceId}] _getCacheDigest: Generated digest ${hash} from ${metadataItems.length} items in _allItemsCache.`);
    return hash;
  }

  /**
   * Clears all caches associated with this data source.
   * This includes the internal _allItemsCache and any L1/L2 entries
   * managed by modelInfoCacheService for this source.
   */
  async clearCache() {
    const sourceId = this.config.id;
    log.info(`[WebDavDataSource][${sourceId}] Clearing all caches for data source.`);

    // 1. Clear internal item cache
    this._allItemsCache = [];
    this._lastRefreshedFromRootPath = null;
    log.debug(`[WebDavDataSource][${sourceId}] Internal _allItemsCache cleared.`);

    // 2. Clear L1/L2 caches via modelInfoCacheService
    if (this.modelInfoCacheService && this.modelInfoCacheService.isInitialized && this.modelInfoCacheService.isEnabled) {
      log.debug(`[WebDavDataSource][${sourceId}] Attempting to clear L1/L2 caches via modelInfoCacheService.`);
      // Invalidate listModels cache entries for this source.
      // Passing an empty string for relativeDirPath should target the root and, by extension, all listModels caches for this source if the service supports prefix invalidation.
      // Or, the service might have a more direct method like clearAllCacheForSource(sourceId).
      // For now, using invalidateListModelsCacheForDirectory with an empty path to signify root.
      try {
        // For listModels, we cached based on directory, showSubDir, and exts.
        // A simple approach is to tell the cache service to remove all 'listModels' type entries for this sourceId.
        // If modelInfoCacheService has a method like `clearEntriesByPrefixAndType(sourceId, 'listModels', 'listModels:' + sourceId)`, that would be ideal.
        // Lacking that, `invalidateListModelsCacheForDirectory(sourceId, '')` is the closest existing pattern from LocalDataSource for directory-based listModels.
        // This might need a more robust implementation in modelInfoCacheService itself.
        // For now, we'll assume it can handle broad invalidation for a source or we log the need.
        
        // Attempt to clear all listModels cache entries for this source.
        // This relies on modelInfoCacheService to correctly interpret an empty directory path
        // as a request to clear all listModels for the source, or at least the root.
        await this.modelInfoCacheService.invalidateListModelsCacheForDirectory(sourceId, ''); // For root
        // Potentially, one might need to iterate known directories if the above is not recursive/prefix-based.
        // However, for a generic "clear all", this is a reasonable first step.
        // Also, other cache types (like individual model details if they were cached, though not implemented here for L1/L2 yet) would need similar clearing.
        log.info(`[WebDavDataSource][${sourceId}] Requested invalidation of listModels caches via modelInfoCacheService.`);

        // If there were other types of L1/L2 entries specific to WebDavDataSource (e.g., for readModelDetail if it used L1/L2),
        // they would need to be cleared here too, likely by iterating known keys or using specific service methods.
        // Since readModelDetail in WebDAV currently reconstructs from _allItemsCache and doesn't use L1/L2 via modelInfoCacheService,
        // clearing listModels cache (which indirectly affects _allItemsCache population) is the primary concern.

      } catch (error) {
        log.error(`[WebDavDataSource][${sourceId}] Error during modelInfoCacheService cache clearing:`, error);
      }
    } else {
      log.info(`[WebDavDataSource][${sourceId}] modelInfoCacheService not available or disabled, skipping L1/L2 cache clearing.`);
    }
    log.info(`[WebDavDataSource][${sourceId}] Cache clearing process complete.`);
  }

  /**
   * Disconnects the WebDAV client if necessary.
   * (Note: The 'webdav' library client doesn't explicitly require disconnect)
   */
  async disconnect() {
    // If the client library had a disconnect method, call it here.
    log.info(`[WebDavDataSource][${this.config.id}] Disconnect called (no-op for current library).`);
    // Example: if (this.client && this.client.disconnect) await this.client.disconnect();
    this.initialized = Promise.reject(new Error('Client disconnected')); // Mark as uninitialized
  }
}

module.exports = {
  WebDavDataSource
};