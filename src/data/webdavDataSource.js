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
async _recursiveListAllFiles(resolvedCurrentPath) {
    const sourceId = this.config.id; // For logging
    log.debug(`[WebDavDataSource][${sourceId}] 递归进入目录: ${resolvedCurrentPath}`);
    let filesFound = [];
    let items = [];

    try {
      // 获取当前目录内容 (非递归), 使用已解析的路径
      items = await this.client.getDirectoryContents(resolvedCurrentPath, { deep: false, details: true });
      log.debug(`[WebDavDataSource][${sourceId}] 在 ${resolvedCurrentPath} 中找到 ${items.length} 个项目`);

      // ---> 添加健壮性检查 <---
      if (!Array.isArray(items)) {
          log.warn(`[WebDavDataSource][${sourceId}] getDirectoryContents (deep: false) did not return an array for ${resolvedCurrentPath}. Received: ${typeof items}. Content:`, JSON.stringify(items)); // Log the object content
          // Attempt to handle common object structures (e.g., if items are in a property)
          if (typeof items === 'object' && items !== null) {
              if (Array.isArray(items.data)) { // Common pattern
                  log.warn(`[WebDavDataSource][${sourceId}] Assuming items are in 'data' property for ${resolvedCurrentPath}.`);
                  items = items.data;
              } else if (Array.isArray(items.items)) { // Another common pattern
                  log.warn(`[WebDavDataSource][${sourceId}] Assuming items are in 'items' property for ${resolvedCurrentPath}.`);
                  items = items.items;
              } else if (Array.isArray(items.files)) { // Another common pattern
                  log.warn(`[WebDavDataSource][${sourceId}] Assuming items are in 'files' property for ${resolvedCurrentPath}.`);
                  items = items.files;
              } else {
                 log.error(`[WebDavDataSource][${sourceId}] Received object from getDirectoryContents for ${resolvedCurrentPath}, but could not find expected array property. Skipping.`);
                 return []; // Still skip if we can't find the array
              }
          } else {
             log.error(`[WebDavDataSource][${sourceId}] Received unexpected non-array, non-object type from getDirectoryContents for ${resolvedCurrentPath}: ${typeof items}. Skipping.`);
             return []; // Skip if not object or array
          }

          // Re-check if we successfully extracted an array
          if (!Array.isArray(items)) {
              log.error(`[WebDavDataSource][${sourceId}] Failed to extract array from object returned by getDirectoryContents for ${resolvedCurrentPath}. Skipping.`);
              return [];
          }
      }
      // ---> 检查结束 <---

    } catch (error) {
      log.error(`[WebDavDataSource][${sourceId}] 递归获取目录内容时出错: ${resolvedCurrentPath}`, error.message, error.stack, error.response?.status);
      // 如果是 404 (目录不存在) 或 403 (无权限)，则跳过此目录
      if (error.response && (error.response.status === 404 || error.response.status === 403)) {
        log.warn(`[WebDavDataSource][${sourceId}] 跳过无法访问的目录: ${resolvedCurrentPath} (状态码: ${error.response.status})`);
        return []; // 返回空数组
      }
      // 对于其他错误，可以选择继续尝试其他分支或抛出错误中止整个过程
      // 这里选择继续，只记录错误
      return []; // 返回空数组，表示此分支失败
      // 或者可以选择抛出错误: throw error;
    }

    const subDirectoryPromises = [];

    for (const item of items) {
      // 忽略 . 和 .. (WebDAV 库通常会处理，但再次检查更安全)
      if (item.basename === '.' || item.basename === '..') {
        continue;
      }

      if (item.type === 'file') {
        // log.debug(`[WebDavDataSource][${sourceId}] 发现文件: ${item.filename}`);
        filesFound.push(item);
      } else if (item.type === 'directory') {
        log.debug(`[WebDavDataSource][${sourceId}] 发现子目录，准备递归: ${item.filename}`);
        // 异步递归调用，收集 Promise. item.filename is already resolved here.
        subDirectoryPromises.push(this._recursiveListAllFiles(item.filename));
      } else {
         log.warn(`[WebDavDataSource][${sourceId}] 发现未知类型项: ${item.filename}, Type: ${item.type}`);
      }
    }

    // 等待所有子目录递归完成
    const subDirectoryResults = await Promise.allSettled(subDirectoryPromises);

    // 合并子目录返回的文件列表
    subDirectoryResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const subDirPath = items.filter(i => i.type === 'directory' && i.basename !== '.' && i.basename !== '..')[index]?.filename || '未知子目录'; // Still resolved path
        log.debug(`[WebDavDataSource][${sourceId}] 子目录 ${subDirPath} 递归成功，找到 ${result.value.length} 个文件`);
        filesFound = filesFound.concat(result.value);
      } else {
        // 记录递归失败的子目录
        const failedDirPath = items.filter(i => i.type === 'directory' && i.basename !== '.' && i.basename !== '..')[index]?.filename || '未知子目录'; // Still resolved path
        log.error(`[WebDavDataSource][${sourceId}] 递归子目录时出错: ${failedDirPath}`, result.reason);
      }
    });

    log.debug(`[WebDavDataSource][${sourceId}] 完成目录递归: ${resolvedCurrentPath}, 共找到 ${filesFound.length} 个文件 (包括子目录)`);
    // 打印前 5 个找到的文件路径，用于调试路径问题
    if (filesFound.length > 0) {
        log.debug(`[WebDavDataSource][${sourceId}] ${resolvedCurrentPath} 返回的部分文件示例:`, filesFound.slice(0, 5).map(f => f.filename));
    }
    return filesFound;
  }
  async listModels(directory = null, supportedExts = []) {
    const startTime = Date.now();
    await this.ensureInitialized();
    const sourceId = this.config.id; // 获取 sourceId

    // Determine the relative starting path
    const relativeStartPath = directory ? (directory.startsWith('/') ? directory : `/${directory}`) : '/';
    // Resolve the starting path for the recursive call
    const resolvedStartPath = this._resolvePath(relativeStartPath);
    // Declare resolvedBasePath here, once for the function scope
    const resolvedBasePath = this._resolvePath('/');

    log.info(`[WebDavDataSource][${sourceId}] 开始列出模型. SubDir: '${this.subDirectory}', RelativeDir: '${directory}', ResolvedStartPath: ${resolvedStartPath}, SupportedExts: ${supportedExts}`);

    let allItems = [];
    try {
        log.info(`[WebDavDataSource][${sourceId}] 开始递归列出文件: ${resolvedStartPath}`);
        allItems = await this._recursiveListAllFiles(resolvedStartPath);
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
      const resolvedBasePathForRelative = this._resolvePath('/'); // Needed for _getRelativePath
      // We need _getRelativePath from modelParser, assuming it will be exported
      const relativeJsonPath = require('./modelParser')._getRelativePath(absoluteJsonPath, resolvedBasePathForRelative);

      return this.client.getFileContents(absoluteJsonPath, { format: 'text' })
        .then(content => ({ status: 'fulfilled', path: relativeJsonPath, content })) // Return relative path
        .catch(error => ({ status: 'rejected', path: relativeJsonPath, reason: error })); // Return relative path
    });

    // 使用 Promise.allSettled 处理所有 Promise
    const jsonResults = await Promise.allSettled(jsonReadPromises);
    const jsonContentMap = new Map(); // Key: jsonPath, Value: parsed detail object

    jsonResults.forEach(result => {
      if (result.status === 'fulfilled' && result.value.status === 'fulfilled') {
        // Promise.allSettled 成功，并且内部的 getFileContents Promise 也成功
        const { path: jsonPath, content } = result.value;
        try {
          const detail = parseModelDetailFromJsonContent(content, jsonPath); // 使用现有解析函数
          jsonContentMap.set(jsonPath, detail);
          log.debug(`[WebDavDataSource][${sourceId}] 成功读取并解析 JSON: ${jsonPath}`);
        } catch (parseError) {
          log.error(`[WebDavDataSource][${sourceId}] 解析 JSON 文件内容时出错: ${jsonPath}`, parseError.message, parseError.stack);
          jsonContentMap.set(jsonPath, {}); // 解析失败也记录空对象
        }
      } else {
        // 处理 getFileContents 失败或 Promise.allSettled 本身的 rejected 状态
        let jsonPath = '未知路径';
        let errorReason = '未知错误';
        if (result.status === 'rejected') {
            // Promise.allSettled 失败 (理论上不太可能，除非 map 内部出错)
            errorReason = result.reason;
        } else { // result.status === 'fulfilled' 但 result.value.status === 'rejected'
            // getFileContents Promise 失败
            jsonPath = result.value.path || jsonPath;
            errorReason = result.value.reason;
        }
        log.error(`[WebDavDataSource][${sourceId}] 读取 WebDAV JSON 文件时出错: ${jsonPath}`, errorReason?.message, errorReason?.stack, errorReason?.response?.status);
        if (jsonPath !== '未知路径') {
            jsonContentMap.set(jsonPath, {}); // 读取失败记录空对象
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
        let detail = {};
        // Use the relative path calculated earlier to look up in the map
        // We need _getRelativePath from modelParser again here
        // Use the resolvedBasePath declared at the beginning of the function
        const relativeJsonPathForLookup = jsonFile ? require('./modelParser')._getRelativePath(jsonFile.filename, resolvedBasePath) : null;

        if (relativeJsonPathForLookup && jsonContentMap.has(relativeJsonPathForLookup)) {
            detail = jsonContentMap.get(relativeJsonPathForLookup);
        } else if (jsonFile) {
            // JSON file exists but wasn't successfully read/parsed (error logged previously)
            log.warn(`[WebDavDataSource][${sourceId}] JSON file ${jsonFile.filename} (relative: ${relativeJsonPathForLookup}) not found or failed to parse in jsonContentMap.`);
            detail = {}; // Ensure default value
        } else {
            // 没有找到关联的 JSON 文件
             log.debug(`[WebDavDataSource][${sourceId}] Model ${modelKey} has no associated JSON file.`);
        }

        // Pass the resolved base path (declared at the start) to the parser function
        const modelObj = createWebDavModelObject(
            modelFile,
            imageFile, // 可能为 undefined
            jsonFile,  // 可能为 undefined
            detail,
            sourceId,   // 使用之前获取的 sourceId
            resolvedBasePath // 使用函数开头的 resolvedBasePath
        );
        allModels.push(modelObj);
    }


    const duration = Date.now() - startTime;
    log.info(`[WebDavDataSource][${sourceId}] 列出模型完成: ${resolvedStartPath}, 耗时: ${duration}ms, 找到 ${allModels.length} 个模型 (通过深度查询)`);
    return allModels;
  }

  async readModelDetail(relativePath) {
    const startTime = Date.now();
    await this.ensureInitialized();
    if (!relativePath) {
      log.warn(`[WebDavDataSource][${this.config.id}] readModelDetail 调用时 relativePath 为空`);
      return {};
    }
    const resolvedPath = this._resolvePath(relativePath);
    log.debug(`[WebDavDataSource][${this.config.id}] 开始读取模型详情: ${resolvedPath} (relative: ${relativePath})`);
    try {
      const jsonContent = await this.client.getFileContents(resolvedPath);
      // Pass the original relative path for context if needed by parser
      const detail = parseModelDetailFromJsonContent(jsonContent.toString(), relativePath);
      const duration = Date.now() - startTime;
      log.debug(`[WebDavDataSource][${this.config.id}] 读取并解析模型详情成功: ${resolvedPath}, 耗时: ${duration}ms`);
      return detail;
    } catch (e) {
      const duration = Date.now() - startTime;
      log.error(`[WebDavDataSource][${this.config.id}] 读取模型详情时出错: ${resolvedPath}, 耗时: ${duration}ms`, e.message, e.stack, e.response?.status);
      if (e.response && e.response.status === 404) {
          log.warn(`[WebDavDataSource][${this.config.id}] 读取模型详情失败 (文件不存在): ${resolvedPath}, 耗时: ${duration}ms`);
      }
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
      const duration = Date.now() - startTime;
      log.debug(`[WebDavDataSource][${this.config.id}] 获取图片数据成功: ${resolvedPath}, 大小: ${content.length} bytes, 耗时: ${duration}ms`);
      return {
        path: relativePath, // Return the original relative path
        data: content,
        mimeType: 'image/png' // TODO: Consider determining mime type from response headers if available
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
async writeModelJson(relativePath, dataToWrite) {
    const startTime = Date.now();
    await this.ensureInitialized();
    if (!relativePath) {
      log.error(`[WebDavDataSource][${this.config.id}] writeModelJson called with empty relativePath.`);
      throw new Error('Relative path cannot be empty for WebDAV write.');
    }
    if (typeof dataToWrite !== 'string') {
        log.error(`[WebDavDataSource][${this.config.id}] writeModelJson called with non-string dataToWrite:`, typeof dataToWrite);
        throw new Error('Invalid data provided for writing (must be a string).');
    }
    const resolvedPath = this._resolvePath(relativePath);
    log.info(`[WebDavDataSource][${this.config.id}] Attempting to write model JSON to WebDAV: ${resolvedPath} (relative: ${relativePath})`);

    try {
      // Extract directory path from the resolved path
      const resolvedDirPath = path.posix.dirname(resolvedPath);

      // Check if directory exists and create if not
      try {
        await this.client.stat(resolvedDirPath);
        log.debug(`[WebDavDataSource][${this.config.id}] Parent directory ${resolvedDirPath} exists.`);
      } catch (statError) {
        // If directory doesn't exist (usually 404), try to create it
        if (statError.response && statError.response.status === 404) {
          log.info(`[WebDavDataSource][${this.config.id}] Parent directory ${resolvedDirPath} does not exist, attempting to create...`);
          // The 'webdav' library supports recursive creation
          await this.client.createDirectory(resolvedDirPath, { recursive: true }); // Explicitly use recursive if available
          log.info(`[WebDavDataSource][${this.config.id}] Successfully created directory ${resolvedDirPath}`);
        } else {
          // Re-throw other stat errors
          log.error(`[WebDavDataSource][${this.config.id}] Error checking directory ${resolvedDirPath}:`, statError.message, statError.stack, statError.response?.status);
          throw statError;
        }
      }

      // Write the file content to the resolved path
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