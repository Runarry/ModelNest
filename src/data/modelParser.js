const log = require('electron-log');
const fs = require('fs').promises; // 使用 promises API
const fsSync = require('fs'); // 保留 sync API 用于可能需要的场景，但此任务中尽量避免
const path = require('path');

// 解析本地模型目录，返回标准模型对象数组
async function parseLocalModels(dir, supportedExtensions, sourceConfig = {}, ignorExtSupport = false, showSubdirectoryModels = true) { // 添加 showSubdirectoryModels 参数
  // sourceId 将在 parseSingleModelFile 内部处理
  log.debug(`[modelParser] 解析目录: ${dir}, 支持扩展名: ${supportedExtensions}, showSubdirectoryModels: ${showSubdirectoryModels}`); // 更新日志
  try {
    await fs.stat(dir); // 异步检查目录是否存在和可访问
  } catch (statError) {
    if (statError.code === 'ENOENT') {
      log.warn(`[modelParser] 目录不存在: ${dir}`);
    } else {
      log.error(`[modelParser] 访问目录失败: ${dir}`, statError.message, statError.stack);
    }
    return [];
  }
 
  let filesInDir;
  try {
      filesInDir = await fs.readdir(dir); // 异步读取目录
      log.debug(`[modelParser] 目录 ${dir} 中的条目:`, filesInDir); // 更清晰的日志
  } catch (readError) {
      log.error(`[modelParser] 读取目录失败: ${dir}`, readError.message, readError.stack);
      return []; // Return empty array if directory cannot be read
  }
  const models = [];
 
  for (const itemName of filesInDir) { // 重命名 modelFileName 为 itemName 更通用
    const itemFullPath = path.join(dir, itemName);
    let stats;
    try {
      stats = await fs.stat(itemFullPath); // 获取条目状态
    } catch (statError) {
      // 如果无法获取状态 (例如权限问题，或者文件在读取目录后被删除)
      log.warn(`[modelParser] 无法获取文件/目录状态: ${itemFullPath}. 错误: ${statError.message}`);
      continue; // 跳过此条目
    }

    if (stats.isDirectory()) {
      // 如果是目录
      if (showSubdirectoryModels) {
        log.debug(`[modelParser] 发现子目录，将递归解析: ${itemFullPath}`);
        const subDirModels = await parseLocalModels(
          itemFullPath,
          supportedExtensions,
          sourceConfig,
          ignorExtSupport,
          showSubdirectoryModels // 传递当前的 showSubdirectoryModels 值
        );
        if (subDirModels && subDirModels.length > 0) {
          models.push(...subDirModels);
        }
      } else {
        log.debug(`[modelParser] 发现子目录，但 showSubdirectoryModels 为 false，跳过: ${itemFullPath}`);
        // 不从此子目录收集模型，也不递归进入
      }
    } else if (stats.isFile()) {
      // 如果是文件，则尝试解析为模型
      log.debug(`[modelParser] 发现文件，尝试解析为模型: ${itemFullPath}`);
      // parseSingleModelFile 会检查扩展名是否受支持
      // 传递 filesInDir 以避免重复读取目录
      const modelObj = await parseSingleModelFile(itemFullPath, supportedExtensions, sourceConfig, ignorExtSupport, null, null, filesInDir);
      if (modelObj) {
        models.push(modelObj);
      }
    } else {
      // 既不是文件也不是目录 (例如符号链接，虽然 fs.stat 会解析符号链接)
      // 或者其他类型的文件系统对象，通常我们只关心文件和目录
      log.debug(`[modelParser] 跳过非文件、非目录的条目: ${itemFullPath}`);
    }
  }
  log.debug(`[modelParser] 目录 ${dir} 解析完成，找到模型数量: ${models.length}`); // 更新日志
  return models;
}
// 新增：查找模型图片的辅助函数
async function findImageForModel(dir, modelNameWithoutExt, filesInDir) {
  let imageFullPath = '';
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
  const commonImageSubdirectories = ['preview', 'previews', 'image', 'images', 'cover', 'covers', 'thumb', 'thumbnail', 'thumbnails'];

  // 1. 在模型文件同级目录查找图片
  log.debug(`[modelParser findImageForModel] Searching for image for ${modelNameWithoutExt} in directory ${dir}`);
  for (const ext of imageExtensions) {
    const potentialImageName = `${modelNameWithoutExt}${ext}`;
    const actualImageFileInDir = filesInDir.find(f => f.toLowerCase() === potentialImageName.toLowerCase());
    if (actualImageFileInDir) {
      imageFullPath = path.join(dir, actualImageFileInDir);
      log.debug(`[modelParser findImageForModel] Found image for ${modelNameWithoutExt} at same level: ${imageFullPath}`);
      break;
    }
  }

  // 2. 如果在同级目录未找到，则在预定义的子目录中查找
  if (!imageFullPath) {
    log.debug(`[modelParser findImageForModel] Image for ${modelNameWithoutExt} not found in same directory. Searching in subdirectories: ${commonImageSubdirectories.join(', ')}`);
    for (const subDirName of commonImageSubdirectories) {
      const subDirPath = path.join(dir, subDirName);
      try {
        const subDirStat = await fs.stat(subDirPath);
        if (subDirStat.isDirectory()) {
          log.debug(`[modelParser findImageForModel] Checking subdirectory ${subDirPath} for image of ${modelNameWithoutExt}`);
          const filesInSubDir = await fs.readdir(subDirPath);
          for (const ext of imageExtensions) {
            const potentialImageName = `${modelNameWithoutExt}${ext}`;
            const actualImageFileInSubDir = filesInSubDir.find(f => f.toLowerCase() === potentialImageName.toLowerCase());
            if (actualImageFileInSubDir) {
              imageFullPath = path.join(subDirPath, actualImageFileInSubDir);
              log.debug(`[modelParser findImageForModel] Found image for ${modelNameWithoutExt} in subdirectory: ${imageFullPath}`);
              break;
            }
          }
        }
      } catch (e) {
        if (e.code === 'ENOENT') {
          // log.debug(`[modelParser findImageForModel] Image subdirectory ${subDirPath} not found for ${modelNameWithoutExt}.`);
        } else {
          log.warn(`[modelParser findImageForModel] Error accessing image subdirectory ${subDirPath} for ${modelNameWithoutExt}: ${e.message}`);
        }
      }
      if (imageFullPath) {
        break;
      }
    }
  }

  if (!imageFullPath) {
      log.debug(`[modelParser findImageForModel] No image found for ${modelNameWithoutExt} after checking same level and subdirectories.`);
  }
  return imageFullPath;
}

// 解析单个本地模型文件，返回标准模型对象
// 新增 preloadedFilesInDir 参数以避免重复读取目录
async function parseSingleModelFile(modelFullPath, supportedExtensions, sourceConfig = {}, ignorExtSupport = false, preloadedModelJsonInfo = null, preloadedJsonFileStats = null, preloadedFilesInDir = null) {
  const sourceId = sourceConfig.id || 'local';
  log.debug(`[modelParser] 解析单个模型文件: ${modelFullPath}, 支持扩展名: ${supportedExtensions}, sourceId: ${sourceId}, preloadedModelJsonInfo: ${!!preloadedModelJsonInfo}, preloadedFilesInDir: ${!!preloadedFilesInDir}`);

  try {
    await fs.stat(modelFullPath); // 异步检查文件是否存在和可访问
  } catch (statError) {
    if (statError.code === 'ENOENT') {
      log.warn(`[modelParser] 模型文件不存在: ${modelFullPath}`);
    } else {
      log.error(`[modelParser] 访问模型文件失败: ${modelFullPath}`, statError.message, statError.stack);
    }
    return null; // 如果文件无法访问，则返回 null
  }

  const dir = path.dirname(modelFullPath);
  const modelFileName = path.basename(modelFullPath);
  let filesInDir = preloadedFilesInDir; // 优先使用预加载的目录内容

  // 仅当未预加载时才读取目录
  if (!filesInDir) {
    try {
      filesInDir = await fs.readdir(dir); // 异步读取目录
      log.debug(`[modelParser] 读取模型所在目录文件:`, filesInDir);
    } catch (readError) {
      log.error(`[modelParser] 读取模型所在目录失败: ${dir}`, readError.message, readError.stack);
      return null; // 如果目录无法读取，则返回 null
    }
  } else {
    log.debug(`[modelParser] 使用预加载的模型所在目录文件:`, filesInDir);
  }

  const modelFileExt = path.extname(modelFileName).toLowerCase();
  if (!ignorExtSupport) {
    if (!supportedExtensions.includes(modelFileExt)) {
      log.debug(`[modelParser] 不支持的模型文件扩展名: ${modelFileExt} for file ${modelFullPath}`);
      return null; // 如果扩展名不支持，则返回 null
    }
  }

  const modelNameWithoutExt = path.basename(modelFileName, modelFileExt);
  
  // 使用新的辅助函数查找图片
  const imageFullPath = await findImageForModel(dir, modelNameWithoutExt, filesInDir);
  
  const jsonFileName = filesInDir.find(f => f === `${modelNameWithoutExt}.json`) || '';
  const jsonFullPath = jsonFileName ? path.join(dir, jsonFileName) : '';

  let modelObj = {};
  let parsedJsonData = {}; // 用于存储解析后的 JSON 对象

  if (preloadedModelJsonInfo) {
    log.debug(`[modelParser] 使用预加载的 modelJsonInfo for ${modelFullPath}`);
    parsedJsonData = preloadedModelJsonInfo;
  } else if (jsonFullPath) {
    try {
      const jsonFileContentString = await fs.readFile(jsonFullPath, 'utf-8');
      parsedJsonData = _parseJsonContentToRawInfo(jsonFileContentString);
    } catch (e) {
      log.error(`[modelParser] 读取或解析模型 JSON 文件失败: ${jsonFullPath}`, e.message, e.stack);
      // parsedJsonData 保持 {}
    }
  }
  
  const modelFileInfo = {
    name: modelNameWithoutExt,
    file: modelFullPath,
    jsonPath: jsonFullPath,
    ext: modelFileExt // 传递模型文件扩展名用于 modelType 推断
  };

  // 调用 parseModelDetailFromJsonContent，传递已解析的 JSON 对象
  // sourceId 用于填充 modelBaseInfo.sourceId
  modelObj = parseModelDetailFromJsonContent(parsedJsonData, sourceId, modelFileInfo);
  
  // 确保顶层 image 路径被正确设置
  modelObj.image = imageFullPath;
  
  log.debug(`[modelParser] 单个模型文件解析完成: ${modelFullPath}`);
  return modelObj;
}

// 步骤 A: 解析原始 JSON 内容 (modelJsonInfo)
function _parseJsonContentToRawInfo(jsonContentString) {
  try {
    return JSON.parse(jsonContentString);
  } catch (e) {
    log.error(`[modelParser] _parseJsonContentToRawInfo: 解析 JSON 内容失败`, e.message, e.stack);
    return {}; // 返回空对象表示解析失败
  }
}

// 修改：从已解析的 JSON 对象和文件信息解析模型详情
// modelFileInfo: { name: string (不含扩展名), file: string (完整路径), jsonPath: string (完整路径), ext: string (模型文件扩展名) }
function parseModelDetailFromJsonContent(parsedJsonInfo, sourceIdentifier, modelFileInfo) {
  log.debug(`[ModelParser parseModelDetailFromJsonContent] Entry. parsedJsonInfo (keys: ${parsedJsonInfo ? Object.keys(parsedJsonInfo).join(', ') : 'null/undefined'}), sourceIdentifier: ${sourceIdentifier}, modelFileInfo:`, JSON.stringify(modelFileInfo));
  // const modelJsonInfo = _parseJsonContentToRawInfo(jsonContentString); // No longer needed, parsedJsonInfo is the object
  const modelJsonInfo = parsedJsonInfo || {}; // Ensure modelJsonInfo is an object
  log.debug('[ModelParser parseModelDetailFromJsonContent] Using provided parsedJsonInfo:', modelJsonInfo ? Object.keys(modelJsonInfo) : 'null/undefined');

  const modelBaseInfo = {
    name: modelFileInfo.name,
    file: modelFileInfo.file,
    jsonPath: modelFileInfo.jsonPath,
    sourceId: sourceIdentifier, // 假设 sourceIdentifier 是 sourceId
    // image 的生成需要依赖文件列表，这里暂时留空或基于约定
    // 例如: image: modelFileInfo.file.replace(path.extname(modelFileInfo.file), '.png')
    // 但更可靠的做法是在调用处根据实际存在的图片文件来确定
    image: '', // 调用者应根据实际情况填充
    modelType: '',
    baseModel: '',
  };
  log.debug('[ModelParser parseModelDetailFromJsonContent] modelBaseInfo.name:', modelBaseInfo.name);
  log.debug('[ModelParser parseModelDetailFromJsonContent] modelBaseInfo.file:', modelBaseInfo.file);
  log.debug('[ModelParser parseModelDetailFromJsonContent] modelBaseInfo.jsonPath:', modelBaseInfo.jsonPath);
  log.debug('[ModelParser parseModelDetailFromJsonContent] modelFileInfo.ext (for modelType inference):', modelFileInfo.ext);


  // 处理 modelType
  if (modelJsonInfo.modelType && typeof modelJsonInfo.modelType === 'string') {
    modelBaseInfo.modelType = modelJsonInfo.modelType.trim();
  } else if (modelFileInfo.ext) { // 从文件扩展名推断
    modelBaseInfo.modelType = modelFileInfo.ext.replace('.', '').toUpperCase();
  } else {
    modelBaseInfo.modelType = 'UNKNOWN'; // 默认值
  }
  log.debug('[ModelParser parseModelDetailFromJsonContent] modelBaseInfo.modelType (after processing):', modelBaseInfo.modelType);

  // 处理 baseModel (兼容 basic)
  let rawBaseModel = modelJsonInfo.baseModel || modelJsonInfo.basic;
  if (rawBaseModel && typeof rawBaseModel === 'string') {
    modelBaseInfo.baseModel = rawBaseModel.trim();
  } else {
    modelBaseInfo.baseModel = ''; // 默认值或根据文件名等推断
  }
  log.debug('[ModelParser parseModelDetailFromJsonContent] modelBaseInfo.baseModel (after processing):', modelBaseInfo.baseModel);
  
  // 其他可能从 modelJsonInfo 提取并处理后放入 modelBaseInfo 的字段
  // 例如：description, triggerWord, tags (如果它们也需要 trim 或其他处理)
  // 为了保持 modelJsonInfo 的原始性，这些字段如果顶层需要，也应在这里处理
  modelBaseInfo.description = (modelJsonInfo.description || '').toString(); // 确保是字符串
  modelBaseInfo.triggerWord = (modelJsonInfo.triggerWord || '').toString();
  modelBaseInfo.tags = Array.isArray(modelJsonInfo.tags) ? modelJsonInfo.tags : [];

  const modelObj = {
    ...modelBaseInfo,
    modelJsonInfo: modelJsonInfo, // 嵌套原始 JSON 数据
  };
  log.debug('[ModelParser parseModelDetailFromJsonContent] Returning modelObj:', JSON.stringify(modelObj, null, 2));
  return modelObj;
}


// 新增：为 WebDAV 数据源创建模型对象
/**
 * Helper function to get the relative path from an absolute path and a base path.
 * Ensures the base path ends with '/' and the relative path starts with '/'.
 * Exported for use by webdavDataSource.
 * @param {string} absolutePath The full path from the WebDAV client.
 * @param {string} basePath The resolved base path (subDirectory root).
 * @returns {string} The path relative to the base path, starting with '/'.
 */
function _getRelativePath(absolutePath, basePath) {
    if (!absolutePath) return '';
    // Ensure base path ends with a slash for correct prefix removal
    const baseWithSlash = basePath.endsWith('/') ? basePath : `${basePath}/`;
    // Check if the absolute path starts with the base path
    if (absolutePath.startsWith(baseWithSlash)) {
        // Remove the base path prefix
        let relative = absolutePath.substring(baseWithSlash.length);
        // Ensure the relative path starts with a slash
        return relative.startsWith('/') ? relative : `/${relative}`;
    } else if (absolutePath === basePath.replace(/\/$/, '')) {
        // Handle case where absolutePath is the base directory itself (without trailing slash)
        return '/';
    } else {
        // If it doesn't start with the base path (shouldn't happen with correct usage),
        // return the original path or log a warning.
        log.warn(`[modelParser] Absolute path "${absolutePath}" does not start with expected base path "${baseWithSlash}". Returning original.`);
        // Fallback: try to return path relative to the root if possible
        return absolutePath.startsWith('/') ? absolutePath : `/${absolutePath}`;
    }
}

// 新增：为 WebDAV 数据源创建模型对象
function createWebDavModelObject(modelFileItem, imageFileItem, jsonFileItem, parsedJsonInfo, sourceId, resolvedBasePath) {
  // modelFileItem: { filename: string, basename: string, size: number, lastmod: string, ... }
  // imageFileItem: { filename: string, ... } (optional)
  // jsonFileItem: { filename: string, ... } (optional)
  // parsedJsonInfo: 原始 JSON 解析结果 (对象)
  // sourceId: string
  // resolvedBasePath: string (用于计算相对路径)

  const modelFileFullPath = modelFileItem.filename;
  const modelFileRelativePath = _getRelativePath(modelFileFullPath, resolvedBasePath);
  const modelFileExt = path.posix.extname(modelFileRelativePath).toLowerCase();
  const modelNameWithoutExt = path.posix.basename(modelFileRelativePath, modelFileExt);

  const imageFileRelativePath = imageFileItem ? _getRelativePath(imageFileItem.filename, resolvedBasePath) : '';
  const jsonFileRelativePath = jsonFileItem ? _getRelativePath(jsonFileItem.filename, resolvedBasePath) : '';
  
  const modelFileInfoForDetail = {
      name: modelNameWithoutExt,
      file: modelFileRelativePath, // WebDAV uses relative paths here
      jsonPath: jsonFileRelativePath,
      ext: modelFileExt
  };

  // 调用已修改的 parseModelDetailFromJsonContent
  // 它现在期望第一个参数是已解析的 JSON 对象
  const modelObjFromDetail = parseModelDetailFromJsonContent(parsedJsonInfo, sourceId, modelFileInfoForDetail);

  // 补充或覆盖 parseModelDetailFromJsonContent 返回对象中的字段
  // (parseModelDetailFromJsonContent 已经处理了 name, file, jsonPath, sourceId, modelType, baseModel, description, triggerWord, tags)
  // 我们需要确保 image, size, lastModified 被正确设置或覆盖
  modelObjFromDetail.image = imageFileRelativePath; // 确保 image 被设置
  modelObjFromDetail.size = modelFileItem.size;
  modelObjFromDetail.lastModified = modelFileItem.lastmod ? new Date(modelFileItem.lastmod) : undefined;
  
  // modelJsonInfo 已经由 parseModelDetailFromJsonContent 嵌套
  // modelObjFromDetail.modelJsonInfo = parsedJsonInfo; // This is already handled inside parseModelDetailFromJsonContent

  return modelObjFromDetail;
}


// 准备模型数据用于保存
function prepareModelDataForSaving(modelObj) {
  // 返回 modelObj.modelJsonInfo 的深拷贝
  // 确保 modelJsonInfo 存在且是一个对象
  if (modelObj && typeof modelObj.modelJsonInfo === 'object' && modelObj.modelJsonInfo !== null) {
    // 深拷贝以防止意外修改原始 modelJsonInfo
    // 注意：JSON.parse(JSON.stringify(obj)) 是一个简单但有限的深拷贝方法，
    // 它不能处理函数、Date对象（会转为ISO字符串）、RegExp、undefined值（会被移除）等。
    // 如果 modelJsonInfo 结构复杂或包含这些类型，需要更健壮的深拷贝库。
    // 鉴于 JSON 文件通常只包含可序列化的数据，此方法在此场景下通常是可接受的。
    try {
      return JSON.parse(JSON.stringify(modelObj.modelJsonInfo));
    } catch (e) {
      log.error('[modelParser] prepareModelDataForSaving: 深拷贝 modelJsonInfo 失败', e.message, e.stack);
      // 如果拷贝失败，返回一个空对象或者原始对象（取决于错误处理策略）
      // 返回空对象更安全，避免潜在的引用问题
      return {};
    }
  }
  // 如果 modelObj.modelJsonInfo 无效，则返回空对象
  log.warn('[modelParser] prepareModelDataForSaving: modelObj.modelJsonInfo 无效或不存在，返回空对象。');
  return {};
}
module.exports = {
  parseLocalModels,
  parseSingleModelFile, // 导出新增的函数
  findImageForModel, // 导出新的图片查找函数
  parseModelDetailFromJsonContent, // 导出新函数
  createWebDavModelObject, // 导出新创建的函数
  prepareModelDataForSaving, // 导出用于保存模型数据的函数
  _getRelativePath // 导出辅助函数
};