const DataSource = require('./baseDataSource'); // 导入新的基类
const { parseModelDetailFromJsonContent, createWebDavModelObject } = require('./modelParser'); // 导入 createWebDavModelObject
const path = require('path');
const log = require('electron-log'); // 添加 electron-log 导入

class WebDavDataSource extends DataSource {
  constructor(config,modelInfoCacheService) {
    super(config); // Calls base class constructor with the config

    // Store the subDirectory, remove trailing slash if present, default to empty string
    this.subDirectory = (config.subDirectory || '').replace(/\/$/, '');
    log.info(`[WebDavDataSource][${this.config.id}] Initialized with subDirectory: '${this.subDirectory}'`);
    this._allItemsCache = []; // 初始化 allItems 缓存为数组
    this._lastRefreshedFromRootPath = null; // 跟踪上次从根路径刷新的时间或标识
    this.initialized = this.initClient(config);
    this.cacheServer = modelInfoCacheService;
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
   * Recursively populates this._allItemsCache (Array) with relative file paths.
   * @param {string} basePathToScan The fully resolved path on the server to start listing from.
   */
  async _populateAllItemsCache(basePathToScan) {
    const sourceId = this.config.id;
    log.info(`[WebDavDataSource][${sourceId}] Starting to populate _allItemsCache (Array) from: ${basePathToScan}`);
    this._allItemsCache = []; // Ensure starting with an empty array

    const queue = [basePathToScan];
    const visited = new Set();
    const sourceRoot = this._resolvePath('/'); // Get the resolved root of the WebDAV source

    while (queue.length > 0) {
      const currentPath = queue.shift();
      if (visited.has(currentPath)) {
        continue;
      }
      visited.add(currentPath);

      let itemsInDir = [];
      try {
        itemsInDir = await this.client.getDirectoryContents(currentPath, { deep: false, details: true });

        if (!Array.isArray(itemsInDir)) {
          log.warn(`[WebDavDataSource][${sourceId}] _populateAllItemsCache: getDirectoryContents for ${currentPath} did not return an array. Received: ${typeof itemsInDir}.`);
          if (typeof itemsInDir === 'object' && itemsInDir !== null) {
            if (Array.isArray(itemsInDir.data)) { itemsInDir = itemsInDir.data; }
            else if (Array.isArray(itemsInDir.items)) { itemsInDir = itemsInDir.items; }
            else if (Array.isArray(itemsInDir.files)) { itemsInDir = itemsInDir.files; }
            else { throw new Error('Received object, but could not find expected array property.'); }
          } else { throw new Error(`Received unexpected non-array, non-object type: ${typeof itemsInDir}.`); }
          if (!Array.isArray(itemsInDir)) { throw new Error('Failed to extract array from object.'); }
        }
      } catch (error) {
        log.error(`[WebDavDataSource][${sourceId}] _populateAllItemsCache: Error fetching directory contents for ${currentPath}:`, error.message, error.stack, error.response?.status);
        if (error.response && (error.response.status === 404 || error.response.status === 403)) {
          log.warn(`[WebDavDataSource][${sourceId}] _populateAllItemsCache: Skipping inaccessible directory: ${currentPath} (Status: ${error.response.status})`);
        }
        continue;
      }

      for (const item of itemsInDir) {
        if (item.basename === '.' || item.basename === '..') continue;

        if (item.type === 'file') {
          let relativeFilePath = item.filename;
          if (relativeFilePath.startsWith(sourceRoot)) {
            relativeFilePath = relativeFilePath.substring(sourceRoot.length);
            // If sourceRoot itself is '/', item.filename like '/file.txt' becomes 'file.txt'
            // If sourceRoot is '/dir/', item.filename like '/dir/file.txt' becomes 'file.txt'
            // This logic ensures paths are relative to the effective root of the source.
            if (sourceRoot === '/' && item.filename.startsWith('/')) { // Handles root being literally '/'
                 // No change needed if sourceRoot is '/', substring(sourceRoot.length) already handles it.
            } else if (sourceRoot.endsWith('/') && relativeFilePath.startsWith('/')) { // Avoid double slash if sourceRoot ends with / and relative starts with /
                relativeFilePath = relativeFilePath.substring(1);
            }
          } else {
            log.warn(`[WebDavDataSource][${sourceId}] _populateAllItemsCache: File ${item.filename} does not start with source root ${sourceRoot}. Storing full path as fallback, but this might be an issue.`);
          }
          this._allItemsCache.push(relativeFilePath);
        } else if (item.type === 'directory') {
          if (item.filename && !visited.has(item.filename)) {
            queue.push(item.filename);
          }
        }
      }
    }
    log.info(`[WebDavDataSource][${sourceId}] _populateAllItemsCache complete. Found ${this._allItemsCache.length} file paths.`);
  }
 
  /**
   * Non-recursively lists all files starting from a given base path using a queue.
   * This method NO LONGER populates the old Map-based _allItemsCache.
   * It returns a flat array of all file stat objects found for the given scope.
   * @param {string} basePathToScan The fully resolved path on the server to start listing from.
   * @param {boolean} scanSubdirectories If true, will scan subdirectories.
   * @returns {Promise<Array<object>>} A promise resolving to a flat array of all file stat objects found.
   */
  async _recursiveListAllFiles(basePathToScan, scanSubdirectories = true) {
    const sourceId = this.config.id;
    log.debug(`[WebDavDataSource][${sourceId}] _recursiveListAllFiles: Path: ${basePathToScan}, ScanSubdirs: ${scanSubdirectories}`);
    const allFilesFound = [];
    const queue = [basePathToScan];
    const visited = new Set(); // To avoid processing the same directory multiple times if symlinks or weird structures exist
 
    while (queue.length > 0) {
      const currentPath = queue.shift();
      if (visited.has(currentPath)) {
        continue;
      }
      visited.add(currentPath);
 
      let itemsInDir = [];
      try {
        itemsInDir = await this.client.getDirectoryContents(currentPath, { deep: false, details: true });
 
        if (!Array.isArray(itemsInDir)) {
          log.warn(`[WebDavDataSource][${sourceId}] _recursiveListAllFiles: getDirectoryContents for ${currentPath} did not return an array. Received: ${typeof itemsInDir}.`);
          // Attempt to recover if it's a common wrapper object
          if (typeof itemsInDir === 'object' && itemsInDir !== null) {
            if (Array.isArray(itemsInDir.data)) { itemsInDir = itemsInDir.data; }
            else if (Array.isArray(itemsInDir.items)) { itemsInDir = itemsInDir.items; }
            else if (Array.isArray(itemsInDir.files)) { itemsInDir = itemsInDir.files; }
            else { throw new Error('Received object, but could not find expected array property.'); }
          } else { throw new Error(`Received unexpected non-array, non-object type: ${typeof itemsInDir}.`); }
          if (!Array.isArray(itemsInDir)) { throw new Error('Failed to extract array from object.');}
        }
        // REMOVED: this._allItemsCache.set(currentPath, itemsInDir); // No longer populates the old Map cache
 
      } catch (error) {
        log.error(`[WebDavDataSource][${sourceId}] _recursiveListAllFiles: Error fetching directory contents for ${currentPath}:`, error.message, error.stack, error.response?.status);
        if (error.response && (error.response.status === 404 || error.response.status === 403)) {
          log.warn(`[WebDavDataSource][${sourceId}] Skipping inaccessible directory: ${currentPath} (Status: ${error.response.status})`);
        }
        continue; // Skip to next in queue
      }

      for (const item of itemsInDir) {
        if (item.basename === '.' || item.basename === '..') continue;

        if (item.type === 'file') {
          allFilesFound.push(item);
        } else if (item.type === 'directory' && scanSubdirectories) {
          // item.filename should be the fully resolved path
          if (item.filename && !visited.has(item.filename)) {
            queue.push(item.filename);
          }
        }
      }
    }
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

  async _buildModelEntry(modelFile, passedAllItemsInDir, passedSourceId, passedResolvedBasePath, preFetchedJsonContentsMap = new Map()) {
    const startTime = Date.now();
    await this.ensureInitialized(); // Ensure client is ready

    // Validate modelFile
    if (!modelFile || !modelFile.filename || typeof modelFile.filename !== 'string') {
      log.error(`[WebDavDataSource][_buildModelEntry] Invalid modelFile (or modelFile.filename) provided.`);
      return null;
    }

    let currentSourceId = passedSourceId || this.config.id;
    let currentAllItemsInDir = passedAllItemsInDir;
    let currentResolvedBasePath = passedResolvedBasePath;

    // modelFile.filename is expected to be the fully resolved path on the server
    const modelFileDir = path.posix.dirname(modelFile.filename);

    // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 开始处理模型文件 ${modelFile.filename}. Passed params: allItemsInDir? ${!!passedAllItemsInDir}, resolvedBasePath? ${!!passedResolvedBasePath}, sourceId? ${!!passedSourceId}`); // Removed: Too verbose

    // currentAllItemsInDir is initialized from passedAllItemsInDir (line 317)
    // If passedAllItemsInDir was null or undefined, currentAllItemsInDir will be null/undefined, triggering the fetch.
    if (currentAllItemsInDir === null || typeof currentAllItemsInDir === 'undefined') {
      log.info(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: allItemsInDir not provided for ${modelFile.filename}. Fetching directory contents for ${modelFileDir}.`);
      try {
        const fetchedItems = await this.client.getDirectoryContents(modelFileDir, { deep: false, details: true });
        if (!Array.isArray(fetchedItems)) {
          log.warn(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: getDirectoryContents for ${modelFileDir} did not return an array. Received: ${typeof fetchedItems}.`);
          if (typeof fetchedItems === 'object' && fetchedItems !== null) {
            if (Array.isArray(fetchedItems.data)) { currentAllItemsInDir = fetchedItems.data; }
            else if (Array.isArray(fetchedItems.items)) { currentAllItemsInDir = fetchedItems.items; }
            else if (Array.isArray(fetchedItems.files)) { currentAllItemsInDir = fetchedItems.files; }
            else { throw new Error('Received object from getDirectoryContents, but could not find expected array property.'); }
          } else { throw new Error(`Received unexpected non-array, non-object type from getDirectoryContents: ${typeof fetchedItems}.`); }
          if (!Array.isArray(currentAllItemsInDir)) { throw new Error('Failed to extract array from object returned by getDirectoryContents.');}
        } else {
          currentAllItemsInDir = fetchedItems;
        }
        // Removed: log.debug for fetched items count
        // Removed: _allItemsCache.set logic as _allItemsCache is now an array of paths, not a map of directory contents.
      } catch (error) {
        log.error(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Error fetching directory contents for ${modelFileDir}:`, error.message, error.stack, error.response?.status);
        return null; // Cannot proceed without directory items
      }
    }
    // If currentAllItemsInDir was provided (e.g. from listModels), it's used directly.
    // If it was fetched, it's now populated.
    // If passedAllItemsInDir was an empty array [], it would be used, and the fetch block above skipped.

    // 确保 currentResolvedBasePath 已设置
    if (!currentResolvedBasePath || currentResolvedBasePath === null) {
      currentResolvedBasePath = this._resolvePath('/');
      // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Calculated/ensured resolvedBasePath: ${currentResolvedBasePath}`); // Removed: Too verbose
    }

    const modelFileBase = path.posix.basename(modelFile.filename, path.posix.extname(modelFile.filename));
    let imageFile = null;
    let jsonFile = null;

    if (Array.isArray(currentAllItemsInDir)) {
      for (const item of currentAllItemsInDir) {
        if (item.type === 'file' && item.filename && typeof item.filename === 'string' && path.posix.dirname(item.filename) === modelFileDir) {
          const itemBase = path.posix.basename(item.filename, path.posix.extname(item.filename));
          const itemExt = path.posix.extname(item.filename).toLowerCase();

          if (itemBase === modelFileBase) {
            if (/\.(png|jpe?g|webp|gif)$/i.test(itemExt)) {
              if (!imageFile) {
                imageFile = item;
                // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 找到关联图片 ${item.filename} for ${modelFile.filename}`); // Removed: Too verbose
              }
            } else if (itemExt === '.json') {
              if (!jsonFile) {
                jsonFile = item;
                // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 找到关联 JSON ${item.filename} for ${modelFile.filename}`); // Removed: Too verbose
              }
            }
          }
        }
      }
    } else {
      log.warn(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: currentAllItemsInDir is not an array for ${modelFile.filename}. Skipping file association.`);
    }


    let modelJsonInfo = {};
    if (jsonFile) {
      // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 尝试读取 JSON 文件 ${jsonFile.filename}`); // Removed: Too verbose
      try {
        let jsonContent;
        if (preFetchedJsonContentsMap.has(jsonFile.filename)) {
          jsonContent = preFetchedJsonContentsMap.get(jsonFile.filename);
          if (jsonContent === null) { // Explicitly null means prefetch failed
            log.warn(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Pre-fetch for JSON ${jsonFile.filename} failed. Will attempt individual fetch.`);
            // Fall through to individual fetch
          } else {
            // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 使用预取的 JSON 内容 ${jsonFile.filename}`); // Removed: Too verbose
          }
        }

        // If not pre-fetched or pre-fetch failed (jsonContent is null or undefined)
        if (jsonContent === undefined || jsonContent === null) {
          // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: ${jsonContent === null ? '预取失败，' : ''}尝试单独读取 JSON 文件 ${jsonFile.filename}`); // Removed: Too verbose
          jsonContent = await this.client.getFileContents(jsonFile.filename, { format: 'text' });
          // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 成功单独读取 JSON ${jsonFile.filename}`); // Removed: Too verbose
        }
        
        if (typeof jsonContent === 'string') {
          modelJsonInfo = JSON.parse(jsonContent);
          // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 成功解析 JSON ${jsonFile.filename}`); // Removed: Too verbose
        } else {
          // This case should ideally not be hit if prefetch stores null for failure and individual fetch throws error
           log.warn(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: JSON content for ${jsonFile.filename} was not a string after fetch attempts. Content:`, jsonContent);
        }

      } catch (error) {
        log.error(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 读取或解析 JSON 文件 ${jsonFile.filename} 时出错:`, error.message, error.stack, error.response?.status);
        // modelJsonInfo 保持为 {}
      }
    } else {
      // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 模型 ${modelFile.filename} 没有关联的 JSON 文件`); // Removed: Too verbose
    }

    try {
      const modelObj = createWebDavModelObject(
        modelFile,
        imageFile,
        jsonFile,
        modelJsonInfo,
        currentSourceId,
        currentResolvedBasePath
      );
      const duration = Date.now() - startTime;
      // log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 为 ${modelFile.filename} 创建模型对象完成, 耗时: ${duration}ms`); // Removed: Too verbose
      return modelObj;
    } catch (error) {
      log.error(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 调用 createWebDavModelObject 时出错 for ${modelFile.filename}:`, error.message, error.stack);
      return null;
    }
  }

  async listModels(directory = null, sourceConfig, supportedExts = [], showSubdirectory = true) {
    const startTime = Date.now();
    await this.ensureInitialized();
    const sourceId = sourceConfig ? sourceConfig.id : this.config.id;

    const relativeRequestDir = directory ? (directory.startsWith('/') ? directory : `/${directory}`) : '/';
    const resolvedRequestDir = this._resolvePath(relativeRequestDir); // The directory user wants to list
    const resolvedRootOfSource = this._resolvePath('/'); // The absolute root of this WebDAV source configuration

    // 需求：当 directory=null 且 showSubdirectory=false 时，用户期望“全部”视图能递归显示 WebDAV 根目录及所有子目录下的所有模型文件。
    // 兼容此场景：当 directory=null 且 showSubdirectory=false 时，自动将 showSubdirectory 设为 true，递归返回所有模型文件。
    if (directory === null && showSubdirectory === false) {
      log.info(`[WebDavDataSource][${sourceId}] '全部' 视图 (directory is null and showSubdirectory is false), 自动将 showSubdirectory 设置为 true 以递归显示所有模型。`);
      showSubdirectory = true;
    }

    log.info(`[WebDavDataSource][${sourceId}] ListModels request. RelativeDir: '${directory}', ResolvedRequestDir: '${resolvedRequestDir}', ResolvedSourceRoot: '${resolvedRootOfSource}', ShowSubDir: ${showSubdirectory}`);

    let allItemsFlatList = [];

    const isEffectivelyRootRequest = resolvedRequestDir === resolvedRootOfSource;
 
    log.debug(`[WebDavDataSource][${sourceId}] isEffectivelyRootRequest: ${isEffectivelyRootRequest}. _allItemsCache (Array) length: ${this._allItemsCache.length}. Last refresh path: ${this._lastRefreshedFromRootPath}`);
 
    // If effectively a root request, or cache (Array) is empty, or last refresh was for a different root path
    if (isEffectivelyRootRequest || this._allItemsCache.length === 0 || this._lastRefreshedFromRootPath !== resolvedRootOfSource) {
      log.info(`[WebDavDataSource][${sourceId}] Refreshing _allItemsCache (Array) from root: ${resolvedRootOfSource}. Reason: isRoot=${isEffectivelyRootRequest}, cacheEmpty=${this._allItemsCache.length === 0}, lastRefreshMismatch=${this._lastRefreshedFromRootPath !== resolvedRootOfSource}`);
      
      await this._populateAllItemsCache(resolvedRootOfSource); // Populate the new array cache
      this._lastRefreshedFromRootPath = resolvedRootOfSource;
      // log.info(`[WebDavDataSource][${sourceId}] _allItemsCache (Array) refreshed. Contains ${this._allItemsCache.length} file paths.`); // _populateAllItemsCache logs this

      // Now, get the list of file *objects* for the current request's scope using _recursiveListAllFiles
      // _recursiveListAllFiles no longer populates the old Map cache.
      if (isEffectivelyRootRequest) {
        // If the request is for the root, _recursiveListAllFiles operates on the root.
        // The 'showSubdirectory' parameter determines if it's recursive for file objects.
        allItemsFlatList = await this._recursiveListAllFiles(resolvedRootOfSource, showSubdirectory);
      } else {
        // If the cache refresh was triggered (e.g., cache empty) by a non-root request,
        // _recursiveListAllFiles should operate on the originally requested directory.
        allItemsFlatList = await this._recursiveListAllFiles(resolvedRequestDir, showSubdirectory);
      }
      log.info(`[WebDavDataSource][${sourceId}] After _allItemsCache (Array) refresh, _recursiveListAllFiles fetched ${allItemsFlatList.length} file objects for path '${isEffectivelyRootRequest ? resolvedRootOfSource : resolvedRequestDir}' (showSubdir: ${showSubdirectory})`);

      // Note: The old logic for filtering allItemsFlatList based on _allItemsCache.get() when showSubdirectory=false
      // is problematic now because _allItemsCache is an array of paths, not a map of directory contents.
      // _recursiveListAllFiles when called with scanSubdirectories=false should correctly return only direct files.
      // If isEffectivelyRootRequest && !showSubdirectory, _recursiveListAllFiles(resolvedRootOfSource, false) handles this.
      // If !isEffectivelyRootRequest, _recursiveListAllFiles(resolvedRequestDir, showSubdirectory) handles this.
      // The logic within _recursiveListAllFiles (scanSubdirectories param) now controls the depth of file objects returned.

    } else {
      // _allItemsCache (Array) is populated and up-to-date for the source root.
      // We still need to get file *objects* for the specific resolvedRequestDir and showSubdirectory scope.
      log.info(`[WebDavDataSource][${sourceId}] Using existing _allItemsCache (Array) which has ${this._allItemsCache.length} paths. Fetching file objects for request path: ${resolvedRequestDir}.`);
      allItemsFlatList = await this._recursiveListAllFiles(resolvedRequestDir, showSubdirectory);
      log.info(`[WebDavDataSource][${sourceId}] Retrieved ${allItemsFlatList.length} file objects from ${resolvedRequestDir} (showSubdirectory: ${showSubdirectory}) using _recursiveListAllFiles (_allItemsCache (Array) was warm).`);
    }
    
    // At this point, allItemsFlatList should contain the relevant file *objects* based on resolvedRequestDir and showSubdirectory.
    // The _allItemsCache is populated (either fully from root, or incrementally if we change _recursiveListAllFiles later).

    const modelFileItems = allItemsFlatList.filter(item =>
      item.type === 'file' && supportedExts.some(ext => item.filename.endsWith(ext)) // item.filename is resolved
    );

    log.info(`[WebDavDataSource][${sourceId}] 从 ${allItemsFlatList.length} 个总项目中筛选出 ${modelFileItems.length} 个潜在模型文件.`);
    // if (modelFileItems.length > 0) {
      // log.debug(`[WebDavDataSource][${sourceId}] 筛选出的模型文件示例:`, modelFileItems.slice(0, 5).map(f => f.filename)); // Removed: Too verbose
    // }


    // 收集所有潜在的 JSON 文件路径以进行批量预取
    const potentialJsonFilePaths = new Set();
    if (Array.isArray(allItemsFlatList)) {
      modelFileItems.forEach(modelFile => {
        const modelFileDir = path.posix.dirname(modelFile.filename);
        const modelFileBase = path.posix.basename(modelFile.filename, path.posix.extname(modelFile.filename));
        
        // 在同一目录中查找同名的 .json 文件
        // modelFileDir is the resolved path of the directory containing the modelFile
        // Filter allItemsFlatList (which contains file objects) to get files in the same directory as modelFile
        const itemsInDir = allItemsFlatList.filter(item => path.posix.dirname(item.filename) === modelFileDir);

        // itemsInDir will always be an array from filter.
        itemsInDir.forEach(item => { // item here is a file object from allItemsFlatList
          if (item.type === 'file') { // No need for path.posix.dirname(item.filename) === modelFileDir check again
            const itemBase = path.posix.basename(item.filename, path.posix.extname(item.filename));
            const itemExt = path.posix.extname(item.filename).toLowerCase();
            if (itemBase === modelFileBase && itemExt === '.json') {
              potentialJsonFilePaths.add(item.filename); // item.filename is already resolved
            }
          }
        });
        if (itemsInDir.length === 0 && modelFileItems.some(mf => path.posix.dirname(mf.filename) === modelFileDir)) {
           // Log a warning if the directory was expected to have items (e.g., the modelFile itself) but filter returned empty.
           // This specific log might be too noisy or not perfectly accurate without more context on allItemsFlatList's state.
           // For now, the original warning about cache miss is removed as it's not applicable.
           // A general check for itemsInDir being empty might be useful if an associated JSON file is critical.
        }
      });
    }
    
    const uniqueJsonFilePaths = Array.from(potentialJsonFilePaths);
    let preFetchedJsonContentsMap = new Map();
    if (uniqueJsonFilePaths.length > 0) {
      log.info(`[WebDavDataSource][${sourceId}] 发现 ${uniqueJsonFilePaths.length} 个唯一的 JSON 文件需要预取.`);
      preFetchedJsonContentsMap = await this._batchFetchJsonContents(uniqueJsonFilePaths);
      log.info(`[WebDavDataSource][${sourceId}] 完成 ${uniqueJsonFilePaths.length} 个 JSON 文件的批量预取，获取到 ${preFetchedJsonContentsMap.size} 个结果 (部分可能为null).`);
    } else {
      log.info(`[WebDavDataSource][${sourceId}] 没有找到需要预取的 JSON 文件.`);
    }

    const allModels = [];
    const modelBuildPromises = [];

    for (const modelFile of modelFileItems) {
      const modelFileDir = path.posix.dirname(modelFile.filename); // modelFile.filename is resolved
      // _buildModelEntry expects items from the *specific directory* of the model file.
      // Filter allItemsFlatList to get files in the same directory as modelFile.
      const itemsInModelDirFromCache = allItemsFlatList.filter(item => path.posix.dirname(item.filename) === modelFileDir);

      if (!itemsInModelDirFromCache || itemsInModelDirFromCache.length === 0) {
        // Log if no items are found in the model's directory from allItemsFlatList, which might be unexpected.
        log.warn(`[WebDavDataSource][${sourceId}] No items found in allItemsFlatList for directory ${modelFileDir} when preparing to build model entry for ${modelFile.filename}.`);
      }

      // log.debug(`[WebDavDataSource][${sourceId}] 为模型 ${modelFile.filename} 准备构建条目. 其所在目录 ${modelFileDir} 中的项目将从缓存或传入列表获取.`); // Removed: Too verbose
      
      modelBuildPromises.push(
        this._buildModelEntry(modelFile, itemsInModelDirFromCache || [], sourceId, resolvedRootOfSource, preFetchedJsonContentsMap)
      );
    }
    
    log.info(`[WebDavDataSource][${sourceId}] 开始并行构建 ${modelBuildPromises.length} 个模型条目.`);
    const settledModelEntries = await Promise.allSettled(modelBuildPromises);

    settledModelEntries.forEach(result => {
      if (result.status === 'fulfilled' && result.value) {
        allModels.push(result.value);
        // log.debug(`[WebDavDataSource][${sourceId}] 成功构建模型条目: ${result.value.name} (${result.value.path})`); // Removed: Too verbose
      } else if (result.status === 'fulfilled' && !result.value) {
        // _buildModelEntry returned null (e.g., createWebDavModelObject failed)
        // Error already logged in _buildModelEntry
        log.warn(`[WebDavDataSource][${sourceId}] _buildModelEntry 返回 null，跳过一个模型条目.`);
      } else if (result.status === 'rejected') {
        log.error(`[WebDavDataSource][${sourceId}] 构建模型条目时发生未捕获的错误:`, result.reason);
      }
    });

    const duration = Date.now() - startTime;
    log.info(`[WebDavDataSource][${sourceId}] 列出模型完成 (新逻辑): ${resolvedRequestDir}, 耗时: ${duration}ms, 成功构建 ${allModels.length} 个模型 (总共尝试 ${modelFileItems.length} 个)`);
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

    log.info(`[WebDavDataSource readModelDetail][${currentSourceId}] Entry. Identifier: '${identifier}'`);

    const modelFileStat = await this._statIfExists(modelFileName);

    if (!modelFileStat) {
      log.error(`[WebDavDataSource readModelDetail][${currentSourceId}] Critical: Model file '${modelFileName}' (from identifier '${identifier}') not found or inaccessible.`); // Corrected variable name
      return {};
    }

    // Now call _buildModelEntry.
    // modelFileStat already contains the resolved filename.
    // Pass null for allItemsInDir and resolvedBasePath to trigger their dynamic fetching/calculation within _buildModelEntry.
    // For readModelDetail, we don't have a preFetchedJsonContentsMap readily available unless we decide to fetch it here.
    // For now, it will default to an empty Map, and _buildModelEntry will fetch JSON individually.
    const modelDetail = await this._buildModelEntry(modelFileStat, null, currentSourceId, null /* preFetchedJsonContentsMap is defaulted */);

    const duration = Date.now() - startTime;
    if (modelDetail && modelDetail.name) {
      log.info(`[WebDavDataSource readModelDetail][${currentSourceId}] Successfully processed model detail for: '${modelDetail.fileName || identifier}'. Duration: ${duration}ms.`);
      // log.debug(`[WebDavDataSource readModelDetail][${currentSourceId}] Result detail:`, JSON.stringify(modelDetail, null, 2)); // Kept commented
      return modelDetail;
    } else {
      log.warn(`[WebDavDataSource readModelDetail][${currentSourceId}] Failed to get sufficient model detail for identifier: '${identifier}' using _buildModelEntry. Duration: ${duration}ms. Returning empty object.`);
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