const log = require('electron-log');
const fs = require('fs').promises; // 使用 promises API
const fsSync = require('fs'); // 保留 sync API 用于可能需要的场景，但此任务中尽量避免
const path = require('path');

// 解析本地模型目录，返回标准模型对象数组
async function parseLocalModels(dir, supportedExtensions, sourceConfig = {}) { // 改为 async 函数, 添加 sourceConfig
  const sourceId = sourceConfig.id || 'local'; // 从 sourceConfig 获取 id，或默认为 'local'
  log.debug(`[modelParser] 解析目录: ${dir}, 支持扩展名: ${supportedExtensions}, sourceId: ${sourceId}`);
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
 
  let filesInDir; // 重命名以避免与 modelFileInfo.file 混淆
  try {
      filesInDir = await fs.readdir(dir); // 异步读取目录
      log.debug(`[modelParser] 目录文件:`, filesInDir);
  } catch (readError) {
      log.error(`[modelParser] 读取目录失败: ${dir}`, readError.message, readError.stack);
      return []; // Return empty array if directory cannot be read
  }
  const models = [];
 
  for (const modelFileName of filesInDir) {
    const modelFileExt = path.extname(modelFileName).toLowerCase();
    if (supportedExtensions.includes(modelFileExt)) {
      const modelNameWithoutExt = path.basename(modelFileName, modelFileExt);
      const modelFullPath = path.join(dir, modelFileName);
      
      // 查找同名图片和 json
      const imageName = filesInDir.find(f => f === `${modelNameWithoutExt}.png` || f === `${modelNameWithoutExt}.jpg` || f === `${modelNameWithoutExt}.jpeg` || f === `${modelNameWithoutExt}.gif` || f === `${modelNameWithoutExt}.webp`) || '';
      const imageFullPath = imageName ? path.join(dir, imageName) : '';
      
      const jsonFileName = filesInDir.find(f => f === `${modelNameWithoutExt}.json`) || '';
      const jsonFullPath = jsonFileName ? path.join(dir, jsonFileName) : '';

      let modelObj = {};
      let jsonContent = '{}'; // 默认为空JSON字符串

      if (jsonFullPath) {
        try {
          jsonContent = await fs.readFile(jsonFullPath, 'utf-8');
        } catch (e) {
          log.error(`[modelParser] 读取模型 JSON 文件失败: ${jsonFullPath}`, e.message, e.stack);
          // jsonContent 保持 '{}'
        }
      }
      
      const modelFileInfo = {
        name: modelNameWithoutExt,
        file: modelFullPath,
        jsonPath: jsonFullPath,
        ext: modelFileExt // 传递模型文件扩展名用于 modelType 推断
      };

      // 调用新的 parseModelDetailFromJsonContent
      // sourceId 用于填充 modelBaseInfo.sourceId
      modelObj = parseModelDetailFromJsonContent(jsonContent, sourceId, modelFileInfo);
      
      // 确保顶层 image 路径被正确设置
      modelObj.image = imageFullPath;
      
      // 旧的 extra 字段现在由 modelJsonInfo 替代，但如果需要保留 extra 结构，可以这样做：
      // modelObj.extra = modelObj.modelJsonInfo; // 或者只包含部分原始信息

      models.push(modelObj);
    }
  }
  log.debug(`[modelParser] 解析完成，模型数量: ${models.length}`);
  return models;
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

// 修改：从 JSON 内容和文件信息解析模型详情
// modelFileInfo: { name: string (不含扩展名), file: string (完整路径), jsonPath: string (完整路径), ext: string (模型文件扩展名) }
function parseModelDetailFromJsonContent(jsonContent, sourceIdentifier, modelFileInfo) {
  const modelJsonInfo = _parseJsonContentToRawInfo(jsonContent);

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

  // 处理 modelType
  if (modelJsonInfo.modelType && typeof modelJsonInfo.modelType === 'string') {
    modelBaseInfo.modelType = modelJsonInfo.modelType.trim();
  } else if (modelFileInfo.ext) { // 从文件扩展名推断
    modelBaseInfo.modelType = modelFileInfo.ext.replace('.', '').toUpperCase();
  } else {
    modelBaseInfo.modelType = 'UNKNOWN'; // 默认值
  }

  // 处理 baseModel (兼容 basic)
  let rawBaseModel = modelJsonInfo.baseModel || modelJsonInfo.basic;
  if (rawBaseModel && typeof rawBaseModel === 'string') {
    modelBaseInfo.baseModel = rawBaseModel.trim();
  } else {
    modelBaseInfo.baseModel = ''; // 默认值或根据文件名等推断
  }
  
  // 其他可能从 modelJsonInfo 提取并处理后放入 modelBaseInfo 的字段
  // 例如：description, triggerWord, tags (如果它们也需要 trim 或其他处理)
  // 为了保持 modelJsonInfo 的原始性，这些字段如果顶层需要，也应在这里处理
  modelBaseInfo.description = (modelJsonInfo.description || '').toString(); // 确保是字符串
  modelBaseInfo.triggerWord = (modelJsonInfo.triggerWord || '').toString();
  modelBaseInfo.tags = Array.isArray(modelJsonInfo.tags) ? modelJsonInfo.tags : [];


  return {
    ...modelBaseInfo,
    modelJsonInfo: modelJsonInfo, // 嵌套原始 JSON 数据
  };
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
function createWebDavModelObject(modelFileItem, imageFileItem, jsonFileItem, modelJsonInfo, sourceId, resolvedBasePath) {
  // modelFileItem: { filename: string, basename: string, size: number, lastmod: string, ... }
  // imageFileItem: { filename: string, ... } (optional)
  // jsonFileItem: { filename: string, ... } (optional)
  // modelJsonInfo: 原始 JSON 解析结果
  // sourceId: string
  // resolvedBasePath: string (用于计算相对路径)

  const modelFileFullPath = modelFileItem.filename;
  const modelFileRelativePath = _getRelativePath(modelFileFullPath, resolvedBasePath);
  const modelFileExt = path.posix.extname(modelFileRelativePath).toLowerCase();
  const modelNameWithoutExt = path.posix.basename(modelFileRelativePath, modelFileExt);

  const imageFileRelativePath = imageFileItem ? _getRelativePath(imageFileItem.filename, resolvedBasePath) : '';
  const jsonFileRelativePath = jsonFileItem ? _getRelativePath(jsonFileItem.filename, resolvedBasePath) : '';
  
  const modelBaseInfo = {
    name: modelNameWithoutExt,
    file: modelFileRelativePath,
    jsonPath: jsonFileRelativePath,
    sourceId: sourceId,
    image: imageFileRelativePath,
    modelType: '', // 将在下面处理
    baseModel: '', // 将在下面处理
    description: (modelJsonInfo.description || '').toString(),
    triggerWord: (modelJsonInfo.triggerWord || '').toString(),
    tags: Array.isArray(modelJsonInfo.tags) ? modelJsonInfo.tags : [],
    size: modelFileItem.size,
    lastModified: modelFileItem.lastmod ? new Date(modelFileItem.lastmod) : undefined, // 确保 lastmod 存在
  };

  // 处理 modelType
  if (modelJsonInfo.modelType && typeof modelJsonInfo.modelType === 'string') {
    modelBaseInfo.modelType = modelJsonInfo.modelType.trim();
  } else {
    modelBaseInfo.modelType = modelFileExt.replace('.', '').toUpperCase() || 'UNKNOWN';
  }

  // 处理 baseModel (兼容 basic)
  let rawBaseModel = modelJsonInfo.baseModel || modelJsonInfo.basic;
  if (rawBaseModel && typeof rawBaseModel === 'string') {
    modelBaseInfo.baseModel = rawBaseModel.trim();
  } else {
    modelBaseInfo.baseModel = ''; // 默认值
  }

  return {
    ...modelBaseInfo,
    modelJsonInfo: modelJsonInfo,
  };
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
  parseModelDetailFromJsonContent, // 导出新函数
  createWebDavModelObject, // 导出新创建的函数
  prepareModelDataForSaving, // 导出用于保存模型数据的函数
  _getRelativePath // 导出辅助函数
};