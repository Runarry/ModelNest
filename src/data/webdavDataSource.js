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

  async listModels(directory = null, sourceConfig, supportedExts = [], showSubdirectory = true) {
    const startTime = Date.now();
    await this.ensureInitialized();
    const sourceId = sourceConfig ? sourceConfig.id : this.config.id; // Prefer sourceConfig.id if available

    const relativeStartPath = directory ? (directory.startsWith('/') ? directory : `/${directory}`) : '/';
    const resolvedStartPath = this._resolvePath(relativeStartPath);
    const resolvedBasePath = this._resolvePath('/');

    log.info(`[WebDavDataSource][${sourceId}] 开始列出模型. SubDir: '${this.subDirectory}', RelativeDir: '${directory}', ResolvedStartPath: ${resolvedStartPath}, SupportedExts: ${Array.isArray(supportedExts) ? supportedExts.join(',') : ''}, ShowSubDir: ${showSubdirectory}, SourceId: ${sourceId}`);

    let allItems = [];
    try {
      log.info(`[WebDavDataSource][${sourceId}] 开始列出文件 (递归受控于 showSubdirectory): ${resolvedStartPath}`);
      allItems = await this._recursiveListAllFiles(resolvedStartPath, showSubdirectory); // Pass showSubdirectory
      log.info(`[WebDavDataSource][${sourceId}] 递归列出文件完成: ${resolvedStartPath}, 共找到 ${allItems.length} 个文件项`);
      // 打印 allItems 的前 5 个元素，检查内容和路径
      if (allItems.length > 0) {
        log.debug(`[WebDavDataSource][${sourceId}] _recursiveListAllFiles 返回的部分项目示例:`, allItems.slice(0, 5).map(item => ({ filename: item.filename, type: item.type, size: item.size, lastmod: item.lastmod })));
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error(`[WebDavDataSource][${sourceId}] 递归列出文件时出错: ${resolvedStartPath}, 耗时: ${duration}ms`, error.message, error.stack, error.response?.status);
      // 检查是否是起始目录不存在
      if (error.response && error.response.status === 404) {
        log.warn(`[WebDavDataSource][${sourceId}] 列出模型失败 (起始目录不存在): ${resolvedStartPath}, 耗时: ${duration}ms`);
        return []; // Directory doesn't exist
      }
      // 对于其他错误，可以选择返回空列表或重新抛出
      // return []; // 或者
      throw error;
    }


    // 使用 Map 按目录组织文件，方便查找关联文件
    // Key: 目录路径 (posix), Value: { files: FileStat[], subDirs: string[] }
    // const directoryMap = new Map(); // 这个 Map 暂时不需要，因为深度查询已获取所有文件

    // 使用 Map 存储模型相关文件路径，Key: 模型基础名 (不含扩展名和路径), Value: { modelFile: FileStat, imageFile?: FileStat, jsonFile?: FileStat }
    const modelFilesMap = new Map();
    // 存储所有找到的 JSON 文件路径以供后续并行读取
    const jsonPathsToRead = [];

    for (const item of allItems) {
      // ---> 日志点 2: 打印每个 item 的信息 <---
      log.debug(`[WebDavDataSource][${sourceId}] 处理项: filename=${item.filename}, basename=${item.basename}, type=${item.type}, size=${item.size}, lastmod=${item.lastmod}`);
      // 忽略根目录本身和可能存在的 . 或 .. 条目 (WebDAV 库通常会自动处理)
      // if (item.filename === startPath || item.basename === '.' || item.basename === '..') {
      //   continue;
      // }

      // 仅处理文件类型
      if (item.type === 'file') {
        const dirname = path.posix.dirname(item.filename);
        const ext = path.posix.extname(item.filename);
        const base = path.posix.basename(item.filename, ext);
        const modelKey = `${dirname}/${base}`; // 使用目录+基础名作为唯一键

        // 检查是否是模型文件
        const isModelFile = supportedExts.some(supportedExt => item.filename.endsWith(supportedExt)); // 直接用 endsWith 匹配
        // ---> 日志点 3: 打印模型文件判断结果 <---
        log.debug(`[WebDavDataSource][${sourceId}] 文件: ${item.filename}, 是否模型文件 (${supportedExts.join(', ')}): ${isModelFile}`);

        if (isModelFile) {
          // ---> 日志点 4: 打印识别到的模型文件和 Key <---
          log.info(`[WebDavDataSource][${sourceId}] 识别到模型文件: ${item.filename}, 生成 Key: ${modelKey}`);
          if (!modelFilesMap.has(modelKey)) {
            modelFilesMap.set(modelKey, { modelFile: item });
          } else {
            // 如果已存在模型文件，可能需要某种策略（例如，更新时间最新的？）
            // 这里简单地覆盖，或者可以记录一个警告
            log.warn(`[WebDavDataSource][${sourceId}] 发现重复的模型文件键，将覆盖: ${modelKey} with ${item.filename}`);
            modelFilesMap.get(modelKey).modelFile = item; // 覆盖
          }
        }
        // 检查是否是可能的封面图片文件
        else if (/\.(png|jpe?g|webp|gif)$/i.test(ext)) { // 扩展图片格式检查
          // --- 修复: 确保 key 存在再添加 imageFile ---
          if (!modelFilesMap.has(modelKey)) {
            modelFilesMap.set(modelKey, {}); // 如果 Key 不存在，先创建空对象
          }
          if (!modelFilesMap.get(modelKey).imageFile) { // 优先保留第一个找到的图片
            modelFilesMap.get(modelKey).imageFile = item;
            log.debug(`[WebDavDataSource][${sourceId}] Associated image ${item.filename} with key ${modelKey}`);
          } else {
            // log.debug(`[WebDavDataSource][${sourceId}] Model ${modelKey} already has an image ${modelFilesMap.get(modelKey).imageFile.filename}, skipping ${item.filename}`);
          }
        }
        // 检查是否是 JSON 文件
        else if (ext === '.json') {
          // --- 修复: 确保 key 存在再添加 jsonFile ---
          if (!modelFilesMap.has(modelKey)) {
            modelFilesMap.set(modelKey, {}); // 如果 Key 不存在，先创建空对象
          }
          if (!modelFilesMap.get(modelKey).jsonFile) { // 优先保留第一个找到的 JSON
            modelFilesMap.get(modelKey).jsonFile = item;
            jsonPathsToRead.push(item.filename); // 添加到待读取列表
            log.debug(`[WebDavDataSource][${sourceId}] Associated JSON ${item.filename} with key ${modelKey}`);
          } else {
            // log.debug(`[WebDavDataSource][${sourceId}] Model ${modelKey} already has a JSON ${modelFilesMap.get(modelKey).jsonFile.filename}, skipping ${item.filename}`);
          }
        }
      } else if (item.type === 'directory') {
        // 可以在这里处理目录信息，如果需要的话
        // log.debug(`[WebDavDataSource][${sourceId}] Found directory: ${item.filename}`);
      }
    }

    // 并行读取所有 JSON 文件内容
    log.info(`[WebDavDataSource][${sourceId}] 开始并行读取 ${jsonPathsToRead.length} 个 JSON 文件`);
    const jsonReadPromises = jsonPathsToRead.map(absoluteJsonPath => {
      // Use the absolute path directly for reading from the server
      log.debug(`[WebDavDataSource][${sourceId}] Preparing to read JSON: ${absoluteJsonPath}`);
      // Calculate the relative path for use as the key and in the result
      // Use the absolute path directly for reading from the server
      // The key for jsonContentMap will be the absolute path for simplicity during this stage
      return this.client.getFileContents(absoluteJsonPath, { format: 'text' })
        .then(content => ({ status: 'fulfilled', absolutePath: absoluteJsonPath, content }))
        .catch(error => ({ status: 'rejected', absolutePath: absoluteJsonPath, reason: error }));
    });

    const jsonResults = await Promise.allSettled(jsonReadPromises);
    const jsonContentMap = new Map(); // Key: absoluteJsonPath, Value: parsed detail object (raw JSON object)

    jsonResults.forEach(result => {
      if (result.status === 'fulfilled' && result.value.status === 'fulfilled') {
        const { absolutePath, content } = result.value;
        try {
          // For listModels, we need the raw JSON object, not the fully parsed model detail yet.
          // modelParser.createWebDavModelObject expects modelJsonInfo (raw JSON data)
          // So, we just parse the string to an object here.
          const rawJsonInfo = JSON.parse(content);
          jsonContentMap.set(absolutePath, rawJsonInfo);
          log.debug(`[WebDavDataSource][${sourceId}] 成功读取并初步解析 JSON (raw): ${absolutePath}`);
        } catch (parseError) {
          log.error(`[WebDavDataSource][${sourceId}] 解析 JSON 文件内容 (raw) 时出错: ${absolutePath}`, parseError.message, parseError.stack);
          jsonContentMap.set(absolutePath, {}); // Store empty object on parse failure
        }
      } else {
        let failedPath = '未知路径';
        let errorReason = '未知错误';
        if (result.status === 'rejected') {
          errorReason = result.reason;
        } else { // result.status === 'fulfilled' but result.value.status === 'rejected'
          failedPath = result.value.absolutePath || failedPath;
          errorReason = result.value.reason;
        }
        log.error(`[WebDavDataSource][${sourceId}] 读取 WebDAV JSON 文件时出错: ${failedPath}`, errorReason?.message, errorReason?.stack, errorReason?.response?.status);
        if (failedPath !== '未知路径') {
          jsonContentMap.set(failedPath, {}); // Store empty object on read failure
        }
      }
    });
    log.info(`[WebDavDataSource][${sourceId}] JSON 文件并行读取完成. 尝试读取: ${jsonPathsToRead.length}, 成功解析或记录失败: ${jsonContentMap.size}`);


    // 构建最终的模型列表
    const allModels = [];
    // ---> 日志点 5: 打印 modelFilesMap 信息 <---
    log.info(`[WebDavDataSource][${sourceId}] 开始构建模型列表. modelFilesMap 大小: ${modelFilesMap.size}`);
    if (modelFilesMap.size > 0) {
      log.debug(`[WebDavDataSource][${sourceId}] modelFilesMap Keys:`, Array.from(modelFilesMap.keys()));
      // 打印 Map 的内容，检查 modelFile 是否正确关联
      const mapContentDebug = {};
      for (const [key, value] of modelFilesMap.entries()) {
        mapContentDebug[key] = {
          modelFile: value.modelFile?.filename,
          imageFile: value.imageFile?.filename,
          jsonFile: value.jsonFile?.filename,
        };
      }
      log.debug(`[WebDavDataSource][${sourceId}] modelFilesMap 内容预览:`, JSON.stringify(mapContentDebug, null, 2));
    }
    for (const [modelKey, files] of modelFilesMap.entries()) {
      // 确保有关联的模型文件才创建对象
      if (!files.modelFile) {
        log.warn(`[WebDavDataSource][${sourceId}] Model key ${modelKey} is missing modelFile, skipping.`);
        continue;
      }

      const { modelFile, imageFile, jsonFile } = files;
      let modelJsonInfo = {}; // This will be the raw JSON object
      // Lookup in jsonContentMap using the absolute path of the jsonFile
      if (jsonFile && jsonContentMap.has(jsonFile.filename)) {
        modelJsonInfo = jsonContentMap.get(jsonFile.filename);
      } else if (jsonFile) {
        log.warn(`[WebDavDataSource][${sourceId}] JSON file ${jsonFile.filename} not found or failed to parse in jsonContentMap.`);
        // modelJsonInfo remains {}
      } else {
        log.debug(`[WebDavDataSource][${sourceId}] Model ${modelKey} has no associated JSON file.`);
        // modelJsonInfo remains {}
      }

      // createWebDavModelObject now expects modelJsonInfo (raw JSON data) as the fourth parameter
      const modelObj = createWebDavModelObject(
        modelFile,        // WebDAV file stat object for the model
        imageFile,        // WebDAV file stat object for the image (optional)
        jsonFile,         // WebDAV file stat object for the JSON (optional)
        modelJsonInfo,    // Raw JSON data object from the .json file
        sourceId,         // Source ID
        resolvedBasePath  // Resolved base path for this source
      );
      allModels.push(modelObj);
    }


    const duration = Date.now() - startTime;
    log.info(`[WebDavDataSource][${sourceId}] 列出模型完成: ${resolvedStartPath}, 耗时: ${duration}ms, 找到 ${allModels.length} 个模型 (通过深度查询)`);
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

  async readModelDetail(identifier, fileName, sourceId) {
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