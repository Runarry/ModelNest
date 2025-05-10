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
        log.warn(`[WebDavDataSource][${sourceId}] getDirectoryContents (deep: false) did not return an array for ${resolvedCurrentPath}. Received: ${typeof items}. Content:`, JSON.stringify(items));
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

  async _buildModelEntry(modelFile, passedAllItemsInDir, passedSourceId, passedResolvedBasePath) {
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

    if (!currentAllItemsInDir || currentAllItemsInDir === null || !currentResolvedBasePath || currentResolvedBasePath === null) {
      log.info(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: allItemsInDir or resolvedBasePath not provided (or null) for ${modelFile.filename}. Fetching/Calculating.`);
      
      if (!currentResolvedBasePath || currentResolvedBasePath === null) {
        currentResolvedBasePath = this._resolvePath('/');
        log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Calculated resolvedBasePath: ${currentResolvedBasePath}`);
      }

      if (!currentAllItemsInDir || currentAllItemsInDir === null) {
        try {
          log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Fetching directory contents for ${modelFileDir}`);
          const fetchedItems = await this.client.getDirectoryContents(modelFileDir, { deep: false, details: true });
          
          // Normalize fetchedItems similar to _recursiveListAllFiles
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
        } catch (error) {
          log.error(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: Error fetching directory contents for ${modelFileDir}:`, error.message, error.stack, error.response?.status);
          return null; // Cannot proceed without directory items
        }
      }
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
        // jsonFile.filename is already a resolved path from getDirectoryContents
        const jsonContent = await this.client.getFileContents(jsonFile.filename, { format: 'text' });
        modelJsonInfo = JSON.parse(jsonContent);
        log.debug(`[WebDavDataSource][${currentSourceId}] _buildModelEntry: 成功读取并解析 JSON ${jsonFile.filename}`);
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

    const relativeStartPath = directory ? (directory.startsWith('/') ? directory : `/${directory}`) : '/';
    const resolvedStartPath = this._resolvePath(relativeStartPath);
    const resolvedBasePath = this._resolvePath('/'); // Base path for the source, used in createWebDavModelObject

    log.info(`[WebDavDataSource][${sourceId}] 开始列出模型 (新逻辑). SubDir: '${this.subDirectory}', RelativeDir: '${directory}', ResolvedStartPath: ${resolvedStartPath}, SupportedExts: ${Array.isArray(supportedExts) ? supportedExts.join(',') : ''}, ShowSubDir: ${showSubdirectory}`);

    let allItems = [];
    try {
      log.info(`[WebDavDataSource][${sourceId}] 开始递归列出所有文件项: ${resolvedStartPath}, ShowSubDir: ${showSubdirectory}`);
      allItems = await this._recursiveListAllFiles(resolvedStartPath, showSubdirectory);
      log.info(`[WebDavDataSource][${sourceId}] 递归列出文件项完成: ${resolvedStartPath}, 共找到 ${allItems.length} 个项`);
      if (allItems.length > 0) {
        log.debug(`[WebDavDataSource][${sourceId}] _recursiveListAllFiles 返回的部分项目示例:`, allItems.slice(0, 5).map(item => ({ filename: item.filename, type: item.type })));
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

    const modelFileItems = allItems.filter(item =>
      item.type === 'file' && supportedExts.some(ext => item.filename.endsWith(ext))
    );

    log.info(`[WebDavDataSource][${sourceId}] 从 ${allItems.length} 个总项目中筛选出 ${modelFileItems.length} 个潜在模型文件.`);
    if (modelFileItems.length > 0) {
      log.debug(`[WebDavDataSource][${sourceId}] 筛选出的模型文件示例:`, modelFileItems.slice(0, 5).map(f => f.filename));
    }


    const allModels = [];
    const modelBuildPromises = [];

    for (const modelFile of modelFileItems) {
      const modelFileDir = path.posix.dirname(modelFile.filename);
      // 从 allItems 中筛选出与当前 modelFile 同目录的所有文件和文件夹
      // 注意: _recursiveListAllFiles 返回的已经是扁平化的文件列表，所以这里主要是为了传递给 _buildModelEntry
      // _buildModelEntry 内部会再次确认目录是否匹配
      const allItemsInDirForModel = allItems.filter(item => path.posix.dirname(item.filename) === modelFileDir);

      log.debug(`[WebDavDataSource][${sourceId}] 为模型 ${modelFile.filename} 准备构建条目, 其所在目录 ${modelFileDir} 中有 ${allItemsInDirForModel.length} 个项目.`);
      
      // 直接调用并收集 Promise，后续并行处理
      modelBuildPromises.push(
        this._buildModelEntry(modelFile, allItemsInDirForModel, sourceId, resolvedBasePath)
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

  async readModelDetail(identifier, modelFileName, sourceId) {
    const startTime = Date.now();
    await this.ensureInitialized();
    const currentSourceId = sourceId;

    log.info(`[WebDavDataSource readModelDetail][${currentSourceId}] Entry. Identifier: '${identifier}'`);

    if (!identifier || typeof identifier !== 'string' || identifier.trim() === '') {
      log.error(`[WebDavDataSource readModelDetail][${currentSourceId}] Identifier is empty or invalid. Cannot proceed.`);
      return {};
    }

    let modelFileRelativePath;
    let jsonFileRelativePath;
    let modelFileBaseName; // Basename of the model file, e.g., "model" (without ext)
    let modelFileExt;      // Extension of the model file, e.g., ".safetensors"
    // const modelFileNameWithExt; // Basename with extension, e.g., "model.safetensors"

    const identifierExt = path.posix.extname(identifier).toLowerCase();
    const identifierBaseNameWithoutExt = path.posix.basename(identifier, identifierExt);
    const identifierDir = path.posix.dirname(identifier);

    const supportedModelExts = Array.isArray(this.config.supportedExts) && this.config.supportedExts.length > 0
      ? this.config.supportedExts
      : ['.safetensors', '.ckpt', '.pt', '.bin', '.pth', '.lora', '.onnx']; // Default if not configured

    if (identifierExt === '.json') {
      jsonFileRelativePath = identifier;
      modelFileBaseName = identifierBaseNameWithoutExt;
      // Try to find the corresponding model file
      for (const ext of supportedModelExts) {
        const potentialModelPath = path.posix.join(identifierDir, `${modelFileBaseName}${ext}`);
        const stat = await this._statIfExists(potentialModelPath);
        if (stat) {
          modelFileRelativePath = potentialModelPath;
          modelFileExt = ext;
          break;
        }
      }
      if (!modelFileRelativePath) {
        log.error(`[WebDavDataSource readModelDetail][${currentSourceId}] JSON path '${identifier}' provided, but no corresponding model file found with supported extensions.`);
        return {};
      }
    } else if (supportedModelExts.includes(identifierExt)) {
      modelFileRelativePath = identifier;
      modelFileExt = identifierExt;
      modelFileBaseName = identifierBaseNameWithoutExt;
      jsonFileRelativePath = path.posix.join(identifierDir, `${modelFileBaseName}.json`);
    } else {
      log.error(`[WebDavDataSource readModelDetail][${currentSourceId}] Identifier '${identifier}' is not a recognized model file extension nor a .json file.`);
      return {};
    }

    log.debug(`[WebDavDataSource readModelDetail][${currentSourceId}] Determined paths: Model='${modelFileRelativePath}', JSON='${jsonFileRelativePath || 'N/A'}'`);

    let modelJsonInfo = {};
    let jsonSucceeded = false;
    let jsonFileStat = null;
    let jsonContentStringForParser = ''; // Store the string content for the parser

    if (jsonFileRelativePath) {
      const resolvedJsonPath = this._resolvePath(jsonFileRelativePath);
      log.debug(`[WebDavDataSource readModelDetail][${currentSourceId}] Attempting to read JSON: ${resolvedJsonPath}`);
      try {
        jsonFileStat = await this._statIfExists(jsonFileRelativePath);
        if (jsonFileStat) {
          jsonContentStringForParser = await this.client.getFileContents(resolvedJsonPath, { format: 'text' });
          log.debug(`[WebDavDataSource readModelDetail][${currentSourceId}] JSON content (length: ${jsonContentStringForParser.length}): ${jsonContentStringForParser.substring(0, 200)}${jsonContentStringForParser.length > 200 ? '...' : ''}`);
          modelJsonInfo = JSON.parse(jsonContentStringForParser);
          jsonSucceeded = true;
        } else {
          log.info(`[WebDavDataSource readModelDetail][${currentSourceId}] JSON file ${jsonFileRelativePath} (resolved: ${resolvedJsonPath}) not found.`);
        }
      } catch (e) {
        log.warn(`[WebDavDataSource readModelDetail][${currentSourceId}] Failed to read or parse JSON file ${resolvedJsonPath}:`, e.message, e.response?.status);
        // modelJsonInfo remains {}, jsonSucceeded is false, jsonContentStringForParser remains empty
      }
    }

    const modelFileStat = await this._statIfExists(modelFileRelativePath);
    if (!modelFileStat) {
      log.error(`[WebDavDataSource readModelDetail][${currentSourceId}] Critical: Model file '${modelFileRelativePath}' not found or inaccessible.`);
      return {};
    }

    let coverImageRelativePath = '';
    let imageFileStat = null;
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

    if (jsonSucceeded && modelJsonInfo && typeof modelJsonInfo === 'object') {
      const modelDir = path.posix.dirname(modelFileRelativePath);
      let imagePathFromJson = null;

      if (modelJsonInfo.images && Array.isArray(modelJsonInfo.images) && modelJsonInfo.images.length > 0) {
        const firstImageInfo = modelJsonInfo.images[0];
        if (firstImageInfo && typeof firstImageInfo.url === 'string') {
          imagePathFromJson = firstImageInfo.url;
        }
      } else if (typeof modelJsonInfo.cover_image_url === 'string') {
        imagePathFromJson = modelJsonInfo.cover_image_url;
      } else if (typeof modelJsonInfo.image === 'string') {
        imagePathFromJson = modelJsonInfo.image;
      }


      if (imagePathFromJson) {
        let potentialCoverPath = '';
        if (imagePathFromJson.startsWith('http://') || imagePathFromJson.startsWith('https://')) {
          log.warn(`[WebDavDataSource readModelDetail][${currentSourceId}] Image path from JSON is an external URL, cannot use for cover: ${imagePathFromJson}`);
        } else if (imagePathFromJson.startsWith('/')) {
          potentialCoverPath = imagePathFromJson;
        } else {
          potentialCoverPath = path.posix.join(modelDir, imagePathFromJson);
        }

        if (potentialCoverPath) {
          const stat = await this._statIfExists(potentialCoverPath);
          if (stat) {
            coverImageRelativePath = potentialCoverPath;
            imageFileStat = stat;
            log.info(`[WebDavDataSource readModelDetail][${currentSourceId}] Found cover image from JSON: ${coverImageRelativePath}`);
          } else {
            log.warn(`[WebDavDataSource readModelDetail][${currentSourceId}] Image path from JSON '${imagePathFromJson}' (resolved to '${potentialCoverPath}') not found.`);
          }
        }
      }
    }

    if (!coverImageRelativePath) {
      const modelDir = path.posix.dirname(modelFileRelativePath);
      for (const imgExt of imageExtensions) {
        const potentialImagePath = path.posix.join(modelDir, `${modelFileBaseName}${imgExt}`);
        const stat = await this._statIfExists(potentialImagePath);
        if (stat) {
          coverImageRelativePath = potentialImagePath;
          imageFileStat = stat;
          log.info(`[WebDavDataSource readModelDetail][${currentSourceId}] Found cover image by convention: ${coverImageRelativePath}`);
          break;
        }
      }
    }

    let detail = {};
    const modelFileInfoForParser = {
      name: modelFileBaseName,
      file: modelFileRelativePath,
      jsonPath: jsonFileRelativePath || '',
      ext: modelFileExt,
    };

    if (jsonSucceeded && jsonContentStringForParser) {
      detail = parseModelDetailFromJsonContent(jsonContentStringForParser, currentSourceId, modelFileInfoForParser);
    } else {
      // JSON failed, was empty, or content string is not available.
      // Initialize detail with basic info that parseModelDetailFromJsonContent would set.
      detail = {
        name: modelFileBaseName,
        file: modelFileRelativePath,
        jsonPath: jsonFileRelativePath || '',
        sourceId: currentSourceId,
        image: '', // Will be set later
        modelType: modelFileExt.replace('.', '').toUpperCase() || 'UNKNOWN',
        baseModel: '',
        description: '',
        triggerWord: '',
        tags: [],
        modelJsonInfo: {}, // No valid JSON info
      };
      log.info(`[WebDavDataSource readModelDetail][${currentSourceId}] JSON not available or failed. Initializing detail with basic model file info.`);
    }

    detail.id = `${currentSourceId}_${modelFileRelativePath.replace(/[.\/\\]/g, '_')}`;
    detail.name = modelFileBaseName; // Already set by parser or above
    detail.fileName = path.posix.basename(modelFileRelativePath);
    detail.sourceId = currentSourceId;
    detail.path = modelFileRelativePath; // Already set
    detail.jsonPath = jsonFileRelativePath || ''; // Already set

    detail.coverImage = coverImageRelativePath || '';

    if (modelFileStat) {
      detail.fileSize = modelFileStat.size;
      detail.lastModified = modelFileStat.lastmod ? new Date(modelFileStat.lastmod).getTime() : undefined;
    }

    // Ensure modelType is robustly set if parser didn't or if no JSON
    if (!detail.modelType || detail.modelType === 'UNKNOWN') {
      detail.modelType = modelFileExt.replace('.', '').toUpperCase() || 'UNKNOWN';
    }
    // Ensure other fields have defaults if not from JSON or parser
    detail.baseModel = detail.baseModel || '';
    detail.description = detail.description || '';
    detail.triggerWord = detail.triggerWord || '';
    detail.tags = Array.isArray(detail.tags) ? detail.tags : [];
    // modelJsonInfo is set by parser or to {} if no JSON
    detail.modelJsonInfo = (jsonSucceeded && Object.keys(modelJsonInfo).length > 0) ? modelJsonInfo : {};


    const duration = Date.now() - startTime;
    if (Object.keys(detail).length > 0 && detail.name) {
      log.info(`[WebDavDataSource readModelDetail][${currentSourceId}] Successfully processed model detail for: '${detail.fileName}'. Duration: ${duration}ms.`);
      // log.debug(`[WebDavDataSource readModelDetail][${currentSourceId}] Result detail:`, JSON.stringify(detail, null, 2));
    } else {
      log.warn(`[WebDavDataSource readModelDetail][${currentSourceId}] Failed to get sufficient model detail for identifier: '${identifier}'. Duration: ${duration}ms. Returning empty object.`);
      return {};
    }
    return detail;
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
      const duration = Date.now() - startTime;
      log.debug(`[WebDavDataSource][${this.config.id}] 获取图片数据成功: ${resolvedPath}, 大小: ${content.length} bytes, 耗时: ${duration}ms`);
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