const fs = require('fs');
const path = require('path');

// 解析本地模型目录，返回标准模型对象数组
function parseLocalModels(dir, supportedExtensions) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir);
  const models = [];

  // 调试输出当前目录和文件列表
  console.log('[ModelNest][parseLocalModels] dir:', dir, 'files:', files);

  // 只处理一级目录
  files.forEach(file => {
    const ext = path.extname(file).toLowerCase();
    if (supportedExtensions.includes(ext)) {
      const base = path.basename(file, ext);
      // 查找同名图片和 json
      // 精确匹配图片和json文件
      const image = files.find(f => f === `${base}.png` || f === `${base}.jpg` ) || '';
      const jsonFile = files.find(f => f === `${base}.json`) || '';
      let detail = {};
      if (jsonFile) {
        try {
          detail = JSON.parse(fs.readFileSync(path.join(dir, jsonFile), 'utf-8'));
        } catch (e) {
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
      console.log('[ModelNest][parseLocalModels] found model:', modelObj);
      models.push(modelObj);
    }
  });
  return models;
}

module.exports = {
  parseLocalModels
};