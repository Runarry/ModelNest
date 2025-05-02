const log = require('electron-log');
const fs = require('fs').promises; // 使用 promises API
const fsSync = require('fs'); // 保留 sync API 用于可能需要的场景，但此任务中尽量避免
const path = require('path');

// 解析本地模型目录，返回标准模型对象数组
async function parseLocalModels(dir, supportedExtensions) { // 改为 async 函数
  log.debug(`[modelParser] 解析目录: ${dir}, 支持扩展名: ${supportedExtensions}`);
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

  let files;
  try {
      files = await fs.readdir(dir); // 异步读取目录
      log.debug(`[modelParser] 目录文件:`, files);
  } catch (readError) {
      log.error(`[modelParser] 读取目录失败: ${dir}`, readError.message, readError.stack);
      return []; // Return empty array if directory cannot be read
  }
  const models = [];

  // 调试输出当前目录和文件列表

  // 只处理一级目录 - 改用 for...of 循环以支持 await
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (supportedExtensions.includes(ext)) {
      const base = path.basename(file, ext);
      // 查找同名图片和 json
      // 精确匹配图片和json文件
      const image = files.find(f => f === `${base}.png` || f === `${base}.jpg` || f === `${base}.jpeg` ) || '';
      const jsonFile = files.find(f => f === `${base}.json`) || '';
      let detail = {};
      if (jsonFile) {
        const jsonFullPath = path.join(dir, jsonFile);
        try {
          // 异步读取 JSON 文件
          const jsonContent = await fs.readFile(jsonFullPath, 'utf-8');
          detail = parseModelDetailFromJsonContent(jsonContent, jsonFullPath); // 使用新函数
        } catch (e) {
          // 读取文件本身的错误（例如权限问题或解析错误）
          log.error(`[modelParser] 读取或解析模型 JSON 文件失败: ${jsonFullPath}`, e.message, e.stack);
          detail = {}; // 保持为空对象
        }
      }
      const modelObj = {
        name: base,
        modelType: detail.modelType || ext.replace('.', '').toUpperCase(),
        description: detail.description || '',
        image: image ? path.join(dir, image) : '',
        file: path.join(dir, file),
        jsonPath: jsonFile ? path.join(dir, jsonFile) : '',
        triggerWord: detail.triggerWord || '',
        tags: detail.tags || [],
        extra: detail
      };
      models.push(modelObj);
    }
  }
  log.debug(`[modelParser] 解析完成，模型数量: ${models.length}`);
  return models;
}

// 新增：从 JSON 字符串安全解析模型详情
function parseModelDetailFromJsonContent(jsonContent, sourceIdentifier = '字符串') {
  try {
    return JSON.parse(jsonContent);
  } catch (e) {
    log.error(`[modelParser] 解析来自 "${sourceIdentifier}" 的 JSON 内容失败`, e.message, e.stack);
    return {}; // 返回空对象表示解析失败
  }
}


// 新增：为 WebDAV 数据源创建模型对象
function createWebDavModelObject(modelFileItem, imageFileItem, jsonFileItem, parsedJsonDetail, sourceId) {
  // 从 webdavDataSource.js 移动过来的逻辑，并适配参数
  const base = path.basename(modelFileItem.filename, path.extname(modelFileItem.filename));
  const modelObj = {
    id: `${sourceId}::${modelFileItem.filename}`, // 添加唯一 ID
    sourceId: sourceId, // 添加 sourceId
    name: base,
    modelType: parsedJsonDetail.modelType || path.extname(modelFileItem.filename).replace('.', '').toUpperCase(),
    description: parsedJsonDetail.description || '',
    image: imageFileItem ? imageFileItem.filename : '', // 使用 imageFileItem
    file: modelFileItem.filename,
    jsonPath: jsonFileItem ? jsonFileItem.filename : '', // 使用 jsonFileItem
    triggerWord: parsedJsonDetail.triggerWord || '',
    size: modelFileItem.size, // 使用 modelFileItem
    lastModified: new Date(modelFileItem.lastmod), // 使用 modelFileItem
    extra: parsedJsonDetail // 使用 parsedJsonDetail
  };
  return modelObj;
}


// 准备模型数据用于保存
function prepareModelDataForSaving(existingData, incomingModelData) {
  // 合并数据
  const mergedData = {
    ...existingData,
    ...incomingModelData
  };

  // 清理元数据
  delete mergedData.id;
  delete mergedData.sourceId;
  delete mergedData.jsonPath;
  delete mergedData.name; // 假设 name 不保存在 JSON 中
  delete mergedData.file; // 确保不保存文件路径
  delete mergedData.image; // 确保不保存图像路径

  // 返回清理后的数据
  return mergedData;
}
module.exports = {
  parseLocalModels,
  parseModelDetailFromJsonContent, // 导出新函数
  createWebDavModelObject, // 导出新创建的函数
  prepareModelDataForSaving // 导出用于保存模型数据的函数
};