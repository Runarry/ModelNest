const log = require('electron-log');
const fs = require('fs');
const path = require('path');

// 解析本地模型目录，返回标准模型对象数组
// 解析本地模型目录，返回标准模型对象数组
function parseLocalModels(dir, supportedExtensions) {
  log.debug(`[modelParser] 解析目录: ${dir}, 支持扩展名: ${supportedExtensions}`);
  if (!fs.existsSync(dir)) {
    log.warn(`[modelParser] 目录不存在: ${dir}`);
    return [];
  }
  let files;
  try {
      files = fs.readdirSync(dir);
      log.debug(`[modelParser] 目录文件:`, files);
  } catch (readError) {
      // Task 1: Error Logging
      log.error(`[modelParser] 读取目录失败: ${dir}`, readError.message, readError.stack);
      return []; // Return empty array if directory cannot be read
  }
  const models = [];

  // 调试输出当前目录和文件列表

  // 只处理一级目录
  files.forEach(file => {
    const ext = path.extname(file).toLowerCase();
    if (supportedExtensions.includes(ext)) {
      const base = path.basename(file, ext);
      // 查找同名图片和 json
      // 精确匹配图片和json文件
      const image = files.find(f => f === `${base}.png` || f === `${base}.jpg` || f === `${base}.jpeg` ) || '';
      const jsonFile = files.find(f => f === `${base}.json`) || '';
      let detail = {};
      if (jsonFile) {
        try {
          detail = JSON.parse(fs.readFileSync(path.join(dir, jsonFile), 'utf-8'));
        } catch (e) {
          log.error(`[modelParser] 解析模型 JSON 失败: ${path.join(dir, jsonFile)}`, e.message, e.stack);
          detail = {};
        }
      }
      const modelObj = {
        name: base,
        type: detail.modelType || ext.replace('.', '').toUpperCase(),
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
  });
  log.debug(`[modelParser] 解析完成，模型数量: ${models.length}`);
  return models;
}

module.exports = {
  parseLocalModels
};