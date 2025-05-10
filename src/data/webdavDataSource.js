const DataSource = require('./baseDataSource'); // 导入新的基类
const { parseModelDetailFromJsonContent, createWebDavModelObject } = require('./modelParser'); // 导入 createWebDavModelObject
const path = require('path');
const log = require('electron-log'); // 添加 electron-log 导入

class WebDavDataSource extends DataSource {
  constructor(config) {
    super(config); // Calls base class constructor with the config

    // Store the subDirectory, remove trailing slash if present, default to empty string
    this.subDirectory = (config.subDirectory || '').replace(/\/$/, '');
    log.info(`[WebDavDataSource][${this.config.id}] Initialized with subDirectory: '${this.subDirectory}'`);
    this._allItemsCache = new Map(); // 初始化 allItems 缓存
    this.initialized = this.initClient(config);
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

    // log.debug(`[WebDavDataSource][${this.config.id}] _resolvePath: '${relativePath}' -> '${cleanedPath}' (subDir: '${this.subDirectory}')`);
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
   * Recursively lists all files starting from a given resolved path.
   * @param {string} resolvedCurrentPath The fully resolved path on the server to start listing from.
   * @returns {Promise<Array<object>>} A promise resolving to an array of file stat objects from the webdav client.
   */
  async _recursiveListAllFiles(resolvedCurrentPath, currentShowSubdirectory) {
    const sourceId = this.config.id; // For logging
    log.debug(`[WebDavDataSource][${sourceId}] 尝试列出目录: ${resolvedCurrentPath}, ShowSubDir: ${currentShowSubdirectory}`);
    let filesFound = [];
    let items = [];

    try {
      items = await this.client.getDirectoryContents(resolvedCurrentPath, { deep: false, details: true });
      log.debug(`[WebDavDataSource][${sourceId}] 在 ${resolvedCurrentPath} 中找到 ${items.length} 个项目`);

      if (!Array.isArray(items)) {
       // log.warn(`[WebDavDataSource][${sourceId}] getDirectoryContents (deep: false) did not return an array for ${resolvedCurrentPath}. Received: ${typeof items}. Content:`, JSON.stringify(items));
        if (typeof items === 'object' && items !== null) {
          if (Array.isArray(items.data)) { items = items.data; }
          else if (Array.isArray(items.items)) { items = items.items; }
          else if (Array.isArray(items.files)) { items = items.files; }
          else { log.error(`[WebDavDataSource][${sourceId}] Received object from getDirectoryContents for ${resolvedCurrentPath}, but could not find expected array property. Skipping.`); return []; }
        } else { log.error(`[WebDavDataSource][${sourceId}] Received unexpected non-array, non-object type from getDirectoryContents for ${resolvedCurrentPath}: ${typeof items}. Skipping.`); return []; }
        if (!Array.isArray(items)) { log.error(`[WebDavDataSource][${sourceId}] Failed to extract array from object returned by getDirectoryContents for ${resolvedCurrentPath}. Skipping.`); return []; }
      }
    } catch (error) {
      log.error(`[WebDavDataSource][${sourceId}] 获取目录内容时出错: ${resolvedCurrentPath}`, error.message, error.stack, error.response?.status);
      if (error.response && (error.response.status === 404 || error.response.status === 403)) {
        log.warn(`[WebDavDataSource][${sourceId}] 跳过无法访问的目录: ${resolvedCurrentPath} (状态码: ${error.response.status})`);
      }
      return [];
    }

    const subDirectoryPromises = [];

    for (const item of items) {
      if (item.basename === '.' || item.basename === '..') continue;

      if (item.type === 'file') {
        filesFound.push(item);
      } else if (item.type === 'directory' && currentShowSubdirectory) { // Only recurse if showSubdirectory is true
        log.debug(`[WebDavDataSource][${sourceId}] 发现子目录，准备递归 (if enabled): ${item.filename}`);
        subDirectoryPromises.push(this._recursiveListAllFiles(item.filename, currentShowSubdirectory)); // Pass showSubdirectory
      } else if (item.type === 'directory' && !currentShowSubdirectory) {
        log.debug(`[WebDavDataSource][${sourceId}] 发现子目录，但不递归 (showSubdirectory is false): ${item.filename}`);
      } else {
        log.warn(`[WebDavDataSource][${sourceId}] 发现未知类型项: ${item.filename}, Type: ${item.type}`);
      }
    }

    if (currentShowSubdirectory && subDirectoryPromises.length > 0) { // Only await if recursion was done
      const subDirectoryResults = await Promise.allSettled(subDirectoryPromises);
      subDirectoryResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const subDirPath = items.filter(i => i.type === 'directory' && i.basename !== '.' && i.basename !== '..')[index]?.filename || '未知子目录';
          log.debug(`[WebDavDataSource][${sourceId}] 子目录 ${subDirPath} 递归成功，找到 ${result.value.length} 个文件`);
          filesFound = filesFound.concat(result.value);
        } else {
          const failedDirPath = items.filter(i => i.type === 'directory' && i.basename !== '.' && i.basename !== '..')[index]?.filename || '未知子目录';
          log.error(`[WebDavDataSource][${sourceId}] 递归子目录时出错: ${failedDirPath}`, result.reason);
        }
      });
    }

    log.debug(`[WebDavDataSource][${sourceId}] 完成目录处理: ${resolvedCurrentPath}, 共找到 ${filesFound.length} 个文件 (递归行为受 showSubdirectory 控制)`);
    if (filesFound.length > 0) {
      log.debug(`[WebDavDataSource][${sourceId}] ${resolvedCurrentPath} 返回的部分文件示例:`, filesFound.slice(0, 5).map(f => f.filename));
    }
    return filesFound;
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
      log.debug(`[WebDavDataSource][${sourceId}] _batchFetchJsonContents: No JSON file paths provided.`);
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
        log.debug(`[WebDavDataSource][${sourceId}] _batchFetchJsonContents: Successfully fetched ${result.value.path}`);
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

    log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 开始处理模型文件 ${modelFile.filename}. Passed params: allItemsInDir? ${!!passedAllItemsInDir}, resolvedBasePath? ${!!passedResolvedBasePath}, sourceId? ${!!passedSourceId}`);

    // 尝试从缓存中获取同目录文件
    if (this._allItemsCache && this._allItemsCache.has(modelFileDir)) {
      currentAllItemsInDir = this._allItemsCache.get(modelFileDir);
      log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Cache hit for directory ${modelFileDir}. Found ${currentAllItemsInDir.length} items.`);
    } else {
      log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Cache miss for directory ${modelFileDir}. Passed allItemsInDir is ${passedAllItemsInDir ? 'present' : 'absent'}.`);
      // 如果 passedAllItemsInDir 存在，则使用它 (这主要用于 listModels 首次构建时)
      // 否则，如果缓存未命中且没有传递 allItemsInDir (例如从 readModelDetail 调用)，则需要获取
      if (!passedAllItemsInDir) {
        log.info(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: allItemsInDir not provided and cache miss for ${modelFile.filename}. Fetching directory contents for ${modelFileDir}.`);
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
          log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Fetched ${currentAllItemsInDir.length} items for directory ${modelFileDir}`);
          // 将获取到的数据存入缓存，以备后续同一目录的其他模型使用
          if (this._allItemsCache) { // 确保缓存对象存在
             this._allItemsCache.set(modelFileDir, currentAllItemsInDir);
             log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Stored fetched items for ${modelFileDir} into _allItemsCache.`);
          }
        } catch (error) {
          log.error(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Error fetching directory contents for ${modelFileDir}:`, error.message, error.stack, error.response?.status);
          return null; // Cannot proceed without directory items
        }
      } else {
        // 使用传递的 allItemsInDir (来自 listModels 的初始构建过程)
        currentAllItemsInDir = passedAllItemsInDir;
        log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Using passedAllItemsInDir for ${modelFileDir}. Count: ${currentAllItemsInDir.length}`);
      }
    }

    // 确保 currentResolvedBasePath 已设置
    if (!currentResolvedBasePath || currentResolvedBasePath === null) {
      currentResolvedBasePath = this._resolvePath('/');
      log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Calculated/ensured resolvedBasePath: ${currentResolvedBasePath}`);
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
                log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 找到关联图片 ${item.filename} for ${modelFile.filename}`);
              }
            } else if (itemExt === '.json') {
              if (!jsonFile) {
                jsonFile = item;
                log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 找到关联 JSON ${item.filename} for ${modelFile.filename}`);
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
      log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 尝试读取 JSON 文件 ${jsonFile.filename}`);
      try {
        let jsonContent;
        if (preFetchedJsonContentsMap.has(jsonFile.filename)) {
          jsonContent = preFetchedJsonContentsMap.get(jsonFile.filename);
          if (jsonContent === null) { // Explicitly null means prefetch failed
            log.warn(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Pre-fetch for JSON ${jsonFile.filename} failed. Will attempt individual fetch.`);
            // Fall through to individual fetch
          } else {
            log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 使用预取的 JSON 内容 ${jsonFile.filename}`);
          }
        }

        // If not pre-fetched or pre-fetch failed (jsonContent is null or undefined)
        if (jsonContent === undefined || jsonContent === null) {
          log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: ${jsonContent === null ? '预取失败，' : ''}尝试单独读取 JSON 文件 ${jsonFile.filename}`);
          jsonContent = await this.client.getFileContents(jsonFile.filename, { format: 'text' });
          log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 成功单独读取 JSON ${jsonFile.filename}`);
        }
        
        if (typeof jsonContent === 'string') {
          modelJsonInfo = JSON.parse(jsonContent);
          log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 成功解析 JSON ${jsonFile.filename}`);
        } else {
          // This case should ideally not be hit if prefetch stores null for failure and individual fetch throws error
           log.warn(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: JSON content for ${jsonFile.filename} was not a string after fetch attempts. Content:`, jsonContent);
        }

      } catch (error) {
        log.error(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 读取或解析 JSON 文件 ${jsonFile.filename} 时出错:`, error.message, error.stack, error.response?.status);
        // modelJsonInfo 保持为 {}
      }
    } else {
      log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 模型 ${modelFile.filename} 没有关联的 JSON 文件`);
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
      log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 为 ${modelFile.filename} 创建模型对象完成, 耗时: ${duration}ms`);
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

    // 清空缓存，因为每次调用 listModels 都应重新构建
    this._allItemsCache.clear();
    log.debug(`[WebDavDataSource][${sourceId}] Cleared _allItemsCache for new listModels call.`);

    const relativeStartPath = directory ? (directory.startsWith('/') ? directory : `/${directory}`) : '/';
    const resolvedStartPath = this._resolvePath(relativeStartPath);
    const resolvedBasePath = this._resolvePath('/'); // Base path for the source, used in createWebDavModelObject

    log.info(`[WebDavDataSource][${sourceId}] 开始列出模型 (新逻辑). SubDir: '${this.subDirectory}', RelativeDir: '${directory}', ResolvedStartPath: ${resolvedStartPath}, SupportedExts: ${Array.isArray(supportedExts) ? supportedExts.join(',') : ''}, ShowSubDir: ${showSubdirectory}`);

    let allItemsFlatList = [];
    try {
      log.info(`[WebDavDataSource][${sourceId}] 开始递归列出所有文件项: ${resolvedStartPath}, ShowSubDir: ${showSubdirectory}`);
      allItemsFlatList = await this._recursiveListAllFiles(resolvedStartPath, showSubdirectory);
      log.info(`[WebDavDataSource][${sourceId}] 递归列出文件项完成: ${resolvedStartPath}, 共找到 ${allItemsFlatList.length} 个项`);

      // 构建缓存
      if (allItemsFlatList.length > 0) {
        log.debug(`[WebDavDataSource][${sourceId}] Populating _allItemsCache with ${allItemsFlatList.length} items.`);
        allItemsFlatList.forEach(item => {
          const dir = path.posix.dirname(item.filename);
          if (!this._allItemsCache.has(dir)) {
            this._allItemsCache.set(dir, []);
          }
          this._allItemsCache.get(dir).push(item);
        });
        log.debug(`[WebDavDataSource][${sourceId}] _allItemsCache populated. Cache size: ${this._allItemsCache.size} directories.`);
        // Log a sample from the cache if needed for debugging
        // if (this._allItemsCache.size > 0) {
        //   const firstKey = this._allItemsCache.keys().next().value;
        //   log.debug(`[WebDavDataSource][${sourceId}] Sample cache entry for dir '${firstKey}':`, this._allItemsCache.get(firstKey).slice(0,2).map(i => i.basename));
        // }
      }
      if (allItemsFlatList.length > 0) {
        log.debug(`[WebDavDataSource][${sourceId}] _recursiveListAllFiles 返回的部分项目示例:`, allItemsFlatList.slice(0, 5).map(item => ({ filename: item.filename, type: item.type })));
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error(`[WebDavDataSource][${sourceId}] 递归列出文件项时出错: ${resolvedStartPath}, 耗时: ${duration}ms`, error.message, error.stack, error.response?.status);
      if (error.response && error.response.status === 404) {
        log.warn(`[WebDavDataSource][${sourceId}] 列出模型失败 (起始目录不存在): ${resolvedStartPath}`);
        return [];
      }
      throw error;
    }

    const modelFileItems = allItemsFlatList.filter(item =>
      item.type === 'file' && supportedExts.some(ext => item.filename.endsWith(ext))
    );

    log.info(`[WebDavDataSource][${sourceId}] 从 ${allItemsFlatList.length} 个总项目中筛选出 ${modelFileItems.length} 个潜在模型文件.`);
    if (modelFileItems.length > 0) {
      log.debug(`[WebDavDataSource][${sourceId}] 筛选出的模型文件示例:`, modelFileItems.slice(0, 5).map(f => f.filename));
    }


    // 收集所有潜在的 JSON 文件路径以进行批量预取
    const potentialJsonFilePaths = new Set();
    if (Array.isArray(allItemsFlatList)) {
      modelFileItems.forEach(modelFile => {
        const modelFileDir = path.posix.dirname(modelFile.filename);
        const modelFileBase = path.posix.basename(modelFile.filename, path.posix.extname(modelFile.filename));
        
        // 在同一目录中查找同名的 .json 文件
        const itemsInDir = this._allItemsCache.get(modelFileDir) || [];
        itemsInDir.forEach(item => {
          if (item.type === 'file' && path.posix.dirname(item.filename) === modelFileDir) {
            const itemBase = path.posix.basename(item.filename, path.posix.extname(item.filename));
            const itemExt = path.posix.extname(item.filename).toLowerCase();
            if (itemBase === modelFileBase && itemExt === '.json') {
              potentialJsonFilePaths.add(item.filename); // item.filename is already resolved
            }
          }
        });
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
      const modelFileDir = path.posix.dirname(modelFile.filename);
      const allItemsInDirForModelFromFlatList = this._allItemsCache.get(modelFileDir) || [];

      log.debug(`[WebDavDataSource][${sourceId}] 为模型 ${modelFile.filename} 准备构建条目. 其所在目录 ${modelFileDir} 中的项目将从缓存或传入列表获取.`);
      
      modelBuildPromises.push(
        this._buildModelEntry(modelFile, allItemsInDirForModelFromFlatList, sourceId, resolvedBasePath, preFetchedJsonContentsMap)
      );
    }
    
    log.info(`[WebDavDataSource][${sourceId}] 开始并行构建 ${modelBuildPromises.length} 个模型条目.`);
    const settledModelEntries = await Promise.allSettled(modelBuildPromises);

    settledModelEntries.forEach(result => {
      if (result.status === 'fulfilled' && result.value) {
        allModels.push(result.value);
        log.debug(`[WebDavDataSource][${sourceId}] 成功构建模型条目: ${result.value.name} (${result.value.path})`);
      } else if (result.status === 'fulfilled' && !result.value) {
        // _buildModelEntry returned null (e.g., createWebDavModelObject failed)
        // Error already logged in _buildModelEntry
        log.warn(`[WebDavDataSource][${sourceId}] _buildModelEntry 返回 null，跳过一个模型条目.`);
      } else if (result.status === 'rejected') {
        log.error(`[WebDavDataSource][${sourceId}] 构建模型条目时发生未捕获的错误:`, result.reason);
      }
    });

    const duration = Date.now() - startTime;
    log.info(`[WebDavDataSource][${sourceId}] 列出模型完成 (新逻辑): ${resolvedStartPath}, 耗时: ${duration}ms, 成功构建 ${allModels.length} 个模型 (总共尝试 ${modelFileItems.length} 个)`);
    return allModels;
  }

  async _statIfExists(relativePath) {
    if (!relativePath || typeof relativePath !== 'string' || relativePath.trim() === '') {
      log.debug(`[WebDavDataSource][${this.config.id}] _statIfExists: Invalid relativePath provided: '${relativePath}'`);
      return null;
    }
    const resolvedPath = this._resolvePath(relativePath);
    try {
      const statResult = await this.client.stat(resolvedPath);
      log.debug(`[WebDavDataSource][${this.config.id}] _statIfExists: Successfully statted ${resolvedPath} (relative: ${relativePath})`);
      return statResult;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        log.debug(`[WebDavDataSource][${this.config.id}] _statIfExists: File not found at ${resolvedPath} (relative: ${relativePath})`);
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
      log.error(`[WebDavDataSource readModelDetail][${currentSourceId}] Critical: Model file '${modelFileRelativePath}' (from identifier '${identifier}') not found or inaccessible.`);
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
      // log.debug(`[WebDavDataSource readModelDetail][${currentSourceId}] Result detail:`, JSON.stringify(modelDetail, null, 2));
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
    log.debug(`[WebDavDataSource][${this.config.id}] 开始获取图片数据: ${resolvedPath} (relative: ${relativePath})`);
    try {
      const content = await this.client.getFileContents(resolvedPath);

      log.debug(`[WebDavDataSource][${this.config.id}] 获取图片数据成功: ${resolvedPath}, 大小: ${content.length} bytes`);
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
          log.debug(`[WebDavDataSource][${this.config.id}] Determined mimeType for ${relativePath}: ${mime}`);
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
        log.debug(`[WebDavDataSource][${sourceId}] Parent directory ${resolvedDirPath} exists.`);
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
    log.debug(`[WebDavDataSource][${this.config.id}] Attempting to stat path: ${resolvedPath} (relative: ${relativePath})`);
    try {
      const stats = await this.client.stat(resolvedPath);
      const duration = Date.now() - startTime;
      log.debug(`[WebDavDataSource][${this.config.id}] Successfully stat path: ${resolvedPath}, 耗时: ${duration}ms`);
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