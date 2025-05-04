/**
 * 
 * 功能简介：
 *   - 通过本地模型文件（如 .safetensors/.ckpt）的 SHA256 哈希，自动查询 Civitai 公共API，获取该模型的详细信息。
 *   - 返回内容包含：模型类型、模型ID、模型名称、基础模型、训练关键词、描述、封面图片、标签（tags）、所有模型版本信息等。
 *   - 采用 electron-log 做日志输出，适合 Electron 主进程或Node环境集成。

 */

const crypto = require('crypto');
const fs = require('fs');
const axios = require('axios');
const log = require('electron-log');

/**
 * 计算本地文件的 SHA256 哈希
 * @param {string} filePath - 文件路径
 * @returns {Promise<string>} - 计算得到的十六进制哈希字符串
 */
function calcFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * 通过模型文件HASH获取Civitai模型详细信息（含tags和所有版本）
 * @param {string} filePath - 模型文件路径
 * @returns {Promise<Object|null>} - 返回模型信息对象，未找到时返回null
 *   {
 *     modelType,     // 模型类型，如 "Checkpoint"、"LORA" 等
 *     modelId,       // 模型ID
 *     modelName,     // 模型名称
 *     baseModel,     // 基础模型
 *     trainedWords,  // 训练关键词数组
 *     description,   // 版本描述
 *     image,         // 封面图片URL
 *     tags,          // 标签数组
 *     modelVersions  // 模型所有版本数组，每项含id/name/description等
 *   }
 */
async function getCivitaiModelInfoWithTagsAndVersions(filePath) {
  // 1. 计算模型文件哈希
  const hash = await calcFileHash(filePath);
  log.info(`[Civitai] 文件 [${filePath}] 的 SHA256 为: ${hash}`);

  // 2. 查询模型版本信息（by hash）
  let versionData;
  try {
    const resp = await axios.get(`https://civitai.com/api/v1/model-versions/by-hash/${hash}`);
    versionData = resp.data;
    log.info(`[Civitai] 通过哈希获取到模型版本信息: modelId=${versionData.modelId}`);
    if (!versionData || !versionData.modelId) return null;
  } catch (err) {
    log.error(`[Civitai] 通过哈希查询模型版本信息失败: ${err.message}`);
    throw err;
  }

  // 3. 主模型信息、标签和所有版本
  const model = versionData.model || {};
  const images = versionData.images || [];
  let tags = [];
  let modelVersions = [];
  try {
    const resp = await axios.get(`https://civitai.com/api/v1/models/${versionData.modelId}`);
    const modelData = resp.data;
    tags = modelData.tags || [];
    // 格式化所有模型版本数组
    modelVersions = (modelData.modelVersions || []).map(v => ({
      id: v.id,
      name: v.name,
      baseModel: v.baseModel,
      description: v.description,
      trainedWords: v.trainedWords,
      images: v.images && v.images.length > 0 ? v.images.map(img => img.url.startsWith('http') ? img.url : `https://civitai.com${img.url}`) : [],
      downloadUrl: v.downloadUrl,
    }));
    log.info(`[Civitai] 获取模型主信息成功，共有版本数: ${modelVersions.length}`);
  } catch (e) {
    log.warn(`[Civitai] 获取模型主信息或 tags/versions 失败: ${e.message}`);
  }

  // 4. 结果结构
  return {
    modelType: model.type || null,
    modelId: versionData.modelId,
    modelName: model.name || versionData.name || null,
    baseModel: versionData.baseModel || null,
    trainedWords: versionData.trainedWords || [],
    description: versionData.description || null,
    image: images.length > 0 ? (images[0].url.startsWith('http') ? images[0].url : `https://civitai.com${images[0].url}`) : null,
    tags,
    modelVersions,
  };
}

/**
 * 命令行测试入口
 * 用法: node civitaiInfo.js your_model_file.safetensors
 */
if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    log.error('用法: node civitaiInfo.js your_model_file.safetensors');
    process.exit(1);
  }
  getCivitaiModelInfoWithTagsAndVersions(filePath)
    .then(info => {
      if (info) {
        log.info('模型信息:\n' + JSON.stringify(info, null, 2));
      } else {
        log.warn('未找到该模型信息。');
      }
    })
    .catch(err => {
      log.error('出错: ' + err.message);
    });
}

// 导出主要方法供 Electron 其他模块调用
module.exports = { getCivitaiModelInfoWithTagsAndVersions };