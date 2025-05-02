const { DataSource } = require('./dataSource');
const { parseModelDetailFromJsonContent, createWebDavModelObject } = require('./modelParser'); // 导入 createWebDavModelObject
const path = require('path');
const log = require('electron-log'); // 添加 electron-log 导入

class WebDavDataSource extends DataSource {
  constructor(config) {
    super(config);

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

  async listSubdirectories() {
    const startTime = Date.now();
    await this.ensureInitialized();
    const basePath = this.config.basePath || '/'; // Use configured base path or default to root
    log.info(`[WebDavDataSource] 开始列出子目录: ${basePath}`);
    try {
      const items = await this.client.getDirectoryContents(basePath, { deep: false }); // Get only top-level items
      const subdirs = items
        .filter(item =>
          item.type === 'directory' &&
          item.basename !== '.' && // Explicitly exclude . and ..
          item.basename !== '..'
        )
        .map(item => item.basename); // Return just the directory name
      const duration = Date.now() - startTime;
      log.info(`[WebDavDataSource] 列出子目录完成: ${basePath}, 耗时: ${duration}ms, 找到 ${subdirs.length} 个子目录`);
      return subdirs;
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error(`[WebDavDataSource] 列出子目录时出错: ${basePath}, 耗时: ${duration}ms`, error.message, error.stack, error.response?.status);
      // Handle cases like 404 Not Found gracefully
      if (error.response && error.response.status === 404) {
        log.warn(`[WebDavDataSource] 列出子目录失败 (目录不存在): ${basePath}, 耗时: ${duration}ms`);
        return []; // Directory doesn't exist, return empty list
      }
      throw error; // Re-throw other errors
    }
  }

async _recursiveListAllFiles(currentPath) {
    const sourceId = this.config.id; // For logging
    log.debug(`[WebDavDataSource][${sourceId}] 递归进入目录: ${currentPath}`);
    let filesFound = [];
    let items = [];

    try {
      // 获取当前目录内容 (非递归)
      items = await this.client.getDirectoryContents(currentPath, { deep: false, details: true });
      log.debug(`[WebDavDataSource][${sourceId}] 在 ${currentPath} 中找到 ${items.length} 个项目`);

      // ---> 添加健壮性检查 <---
      if (!Array.isArray(items)) {
          log.warn(`[WebDavDataSource][${sourceId}] getDirectoryContents (deep: false) did not return an array for ${currentPath}. Received: ${typeof items}. Content:`, JSON.stringify(items)); // Log the object content
          // Attempt to handle common object structures (e.g., if items are in a property)
          if (typeof items === 'object' && items !== null) {
              if (Array.isArray(items.data)) { // Common pattern
                  log.warn(`[WebDavDataSource][${sourceId}] Assuming items are in 'data' property for ${currentPath}.`);
                  items = items.data;
              } else if (Array.isArray(items.items)) { // Another common pattern
                  log.warn(`[WebDavDataSource][${sourceId}] Assuming items are in 'items' property for ${currentPath}.`);
                  items = items.items;
              } else if (Array.isArray(items.files)) { // Another common pattern
                  log.warn(`[WebDavDataSource][${sourceId}] Assuming items are in 'files' property for ${currentPath}.`);
                  items = items.files;
              } else {
                 log.error(`[WebDavDataSource][${sourceId}] Received object from getDirectoryContents for ${currentPath}, but could not find expected array property. Skipping.`);
                 return []; // Still skip if we can't find the array
              }
          } else {
             log.error(`[WebDavDataSource][${sourceId}] Received unexpected non-array, non-object type from getDirectoryContents for ${currentPath}: ${typeof items}. Skipping.`);
             return []; // Skip if not object or array
          }

          // Re-check if we successfully extracted an array
          if (!Array.isArray(items)) {
              log.error(`[WebDavDataSource][${sourceId}] Failed to extract array from object returned by getDirectoryContents for ${currentPath}. Skipping.`);
              return [];
          }
      }
      // ---> 检查结束 <---

    } catch (error) {
      log.error(`[WebDavDataSource][${sourceId}] 递归获取目录内容时出错: ${currentPath}`, error.message, error.stack, error.response?.status);
      // 如果是 404 (目录不存在) 或 403 (无权限)，则跳过此目录
      if (error.response && (error.response.status === 404 || error.response.status === 403)) {
        log.warn(`[WebDavDataSource][${sourceId}] 跳过无法访问的目录: ${currentPath} (状态码: ${error.response.status})`);
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
        // 异步递归调用，收集 Promise
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
        const subDirPath = items.filter(i => i.type === 'directory' && i.basename !== '.' && i.basename !== '..')[index]?.filename || '未知子目录';
        log.debug(`[WebDavDataSource][${sourceId}] 子目录 ${subDirPath} 递归成功，找到 ${result.value.length} 个文件`);
        filesFound = filesFound.concat(result.value);
      } else {
        // 记录递归失败的子目录
        const failedDirPath = items.filter(i => i.type === 'directory' && i.basename !== '.' && i.basename !== '..')[index]?.filename || '未知子目录';
        log.error(`[WebDavDataSource][${sourceId}] 递归子目录时出错: ${failedDirPath}`, result.reason);
      }
    });

    log.debug(`[WebDavDataSource][${sourceId}] 完成目录递归: ${currentPath}, 共找到 ${filesFound.length} 个文件 (包括子目录)`);
    // 打印前 5 个找到的文件路径，用于调试路径问题
    if (filesFound.length > 0) {
        log.debug(`[WebDavDataSource][${sourceId}] ${currentPath} 返回的部分文件示例:`, filesFound.slice(0, 5).map(f => f.filename));
    }
    return filesFound;
  }
  async listModels(directory = null, supportedExts = []) {
    const startTime = Date.now();
    await this.ensureInitialized();
    const basePath = this.config.basePath || '/';
    const sourceId = this.config.id; // 获取 sourceId

    let startPath = basePath;
    if (directory) {
      startPath = basePath === '/' ? `/${directory}` : `${basePath}/${directory}`;
    }
    log.info(`[WebDavDataSource][${sourceId}] 开始列出模型. BasePath: ${basePath}, Directory: ${directory}, Calculated startPath: ${startPath}, SupportedExts: ${supportedExts}`);

    let allItems = [];
    try {
        log.info(`[WebDavDataSource][${sourceId}] 开始递归列出文件: ${startPath}`);
        allItems = await this._recursiveListAllFiles(startPath);
        log.info(`[WebDavDataSource][${sourceId}] 递归列出文件完成: ${startPath}, 共找到 ${allItems.length} 个文件项`);
        // 打印 allItems 的前 5 个元素，检查内容和路径
        if (allItems.length > 0) {
            log.debug(`[WebDavDataSource][${sourceId}] _recursiveListAllFiles 返回的部分项目示例:`, allItems.slice(0, 5).map(item => ({ filename: item.filename, type: item.type, size: item.size, lastmod: item.lastmod })));
        }
    } catch (error) {
        const duration = Date.now() - startTime;
        log.error(`[WebDavDataSource][${sourceId}] 递归列出文件时出错: ${startPath}, 耗时: ${duration}ms`, error.message, error.stack, error.response?.status);
         // 检查是否是起始目录不存在
        if (error.response && error.response.status === 404) {
             log.warn(`[WebDavDataSource][${sourceId}] 列出模型失败 (起始目录不存在): ${startPath}, 耗时: ${duration}ms`);
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
    const jsonReadPromises = jsonPathsToRead.map(jsonPath =>
      this.client.getFileContents(jsonPath, { format: 'text' }) // 明确指定文本格式
        .then(content => ({ status: 'fulfilled', path: jsonPath, content }))
        .catch(error => ({ status: 'rejected', path: jsonPath, reason: error }))
    );

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
        if (jsonFile && jsonContentMap.has(jsonFile.filename)) {
            detail = jsonContentMap.get(jsonFile.filename);
        } else if (jsonFile) {
            // JSON 文件存在于 Map 中，但读取/解析失败（已在上面记录错误）
            log.warn(`[WebDavDataSource][${sourceId}] JSON 文件 ${jsonFile.filename} 在读取映射中未找到有效内容，可能读取或解析失败。`);
            detail = {}; // 确保有默认值
        } else {
            // 没有找到关联的 JSON 文件
             log.debug(`[WebDavDataSource][${sourceId}] Model ${modelKey} has no associated JSON file.`);
        }

        const modelObj = createWebDavModelObject(
            modelFile,
            imageFile, // 可能为 undefined
            jsonFile,  // 可能为 undefined
            detail,
            sourceId   // 使用之前获取的 sourceId
        );
        allModels.push(modelObj);
    }


    const duration = Date.now() - startTime;
    log.info(`[WebDavDataSource][${sourceId}] 列出模型完成: ${startPath}, 耗时: ${duration}ms, 找到 ${allModels.length} 个模型 (通过深度查询)`);
    return allModels;
  }

  async readModelDetail(jsonPath) {
    const startTime = Date.now();
    await this.ensureInitialized();
    if (!jsonPath) {
      log.warn('[WebDavDataSource] readModelDetail 调用时 jsonPath 为空');
      return {};
    }
    log.debug(`[WebDavDataSource] 开始读取模型详情: ${jsonPath}`);
    try {
      const jsonContent = await this.client.getFileContents(jsonPath);
      const detail = parseModelDetailFromJsonContent(jsonContent.toString(), jsonPath); // 使用新函数解析
      const duration = Date.now() - startTime;
      log.debug(`[WebDavDataSource] 读取并解析模型详情成功: ${jsonPath}, 耗时: ${duration}ms`);
      return detail;
    } catch (e) {
      const duration = Date.now() - startTime;
      log.error(`[WebDavDataSource] 读取模型详情时出错: ${jsonPath}, 耗时: ${duration}ms`, e.message, e.stack, e.response?.status);
      if (e.response && e.response.status === 404) {
          log.warn(`[WebDavDataSource] 读取模型详情失败 (文件不存在): ${jsonPath}, 耗时: ${duration}ms`);
      }
      return {};
    }
  }

  async getImageData(imagePath) {
    const startTime = Date.now();
    await this.ensureInitialized();
    if (!imagePath) {
      log.warn('[WebDavDataSource] getImageData 调用时 imagePath 为空');
      return null;
    }
    log.debug(`[WebDavDataSource] 开始获取图片数据: ${imagePath}`);
    try {
      const content = await this.client.getFileContents(imagePath);
      const duration = Date.now() - startTime;
      log.debug(`[WebDavDataSource] 获取图片数据成功: ${imagePath}, 大小: ${content.length} bytes, 耗时: ${duration}ms`);
      return {
        path: imagePath,
        data: content,
        mimeType: 'image/png' // TODO: Consider determining mime type from response headers if available
      };
    } catch (e) {
      const duration = Date.now() - startTime;
      log.error(`[WebDavDataSource] 获取图片数据时出错: ${imagePath}, 耗时: ${duration}ms`, e.message, e.stack, e.response?.status);
       if (e.response && e.response.status === 404) {
          log.warn(`[WebDavDataSource] 获取图片数据失败 (文件不存在): ${imagePath}, 耗时: ${duration}ms`);
      }
      return null;
    }
  }
async writeModelJson(filePath, dataToWrite) {
    const startTime = Date.now();
    await this.ensureInitialized();
    if (!filePath) {
      log.error('[WebDavDataSource] writeModelJson called with empty filePath.');
      throw new Error('File path cannot be empty for WebDAV write.');
    }
    if (typeof dataToWrite !== 'string') {
        log.error('[WebDavDataSource] writeModelJson called with non-string dataToWrite:', typeof dataToWrite);
        throw new Error('Invalid data provided for writing (must be a string).');
    }
    log.info(`[WebDavDataSource] Attempting to write model JSON to WebDAV: ${filePath}`);

    try {
      // Extract directory path using posix path separator as WebDAV uses URLs
      const dirPath = path.posix.dirname(filePath);

      // Check if directory exists and create if not
      // Note: Some WebDAV servers might implicitly create directories on PUT,
      // but explicitly checking/creating is safer.
      try {
        await this.client.stat(dirPath);
        log.debug(`[WebDavDataSource] Parent directory ${dirPath} exists.`);
      } catch (statError) {
        // If directory doesn't exist (usually 404), try to create it
        if (statError.response && statError.response.status === 404) {
          log.info(`[WebDavDataSource] Parent directory ${dirPath} does not exist, attempting to create...`);
          // Use { recursive: true } if your webdav client library supports it,
          // otherwise, you might need to create parent directories iteratively.
          // The 'webdav' library used here seems to support recursive creation implicitly
          // when creating a directory path like /a/b/c.
          await this.client.createDirectory(dirPath);
          log.info(`[WebDavDataSource] Successfully created directory ${dirPath}`);
        } else {
          // Re-throw other stat errors
          log.error(`[WebDavDataSource] Error checking directory ${dirPath}:`, statError.message, statError.stack, statError.response?.status);
          throw statError;
        }
      }

      // Write the file content
      await this.client.putFileContents(filePath, dataToWrite, { overwrite: true });
      const duration = Date.now() - startTime;
      log.info(`[WebDavDataSource] Successfully wrote model JSON to WebDAV: ${filePath}, 耗时: ${duration}ms`);
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error(`[WebDavDataSource] Failed to write model JSON to WebDAV: ${filePath}, 耗时: ${duration}ms`, error.message, error.stack, error.response?.status);
      // Re-throw the error for the interface to handle
      throw error;
    }
  }
}

module.exports = {
  WebDavDataSource
};