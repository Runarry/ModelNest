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
const TurndownService = require('turndown');

const turndownService = new TurndownService();

/**
 * 计算本地文件的 SHA256 哈希
 * @param {string} filePath - 文件路径
 * @returns {Promise<string>} - 计算得到的十六进制哈希字符串
 */
async function calcFileHash(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  // 使用 for await...of 处理异步流，更简洁
  try {
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    return hash.digest('hex');
  } catch (error) {
    // 捕获流读取错误
    console.error('Error calculating file hash:', error);
    throw error; // 重新抛出错误，以便调用者处理
  }
}

/**
 * 通过模型文件HASH获取Civitai模型详细信息（含tags和所有版本）
 * @param {string} filePath - 模型文件路径
 * @returns {Promise<Object|null>} - 返回模型信息对象，未找到时返回null
 */
async function getCivitaiModelInfoWithTagsAndVersions(filePath) {
  // 1. 计算模型文件哈希
  const hash = await calcFileHash(filePath);
  log.info(`[Util:CivitaiCrawler] Calculated SHA256 for file [${filePath}]: ${hash}`);

  // 2. 查询模型版本信息（by hash）
  let modelId;
  let id;
  try {
    const resp = await axios.get(`https://civitai.com/api/v1/model-versions/by-hash/${hash}`);
    const versionData = resp.data;
    id = versionData.id;
    modelId = versionData.modelId;
    log.info(`[Util:CivitaiCrawler] Successfully fetched model version info by hash: modelId=${modelId}`);
    if (!versionData.id || !versionData.modelId) return null;
  } catch (err) {
    log.error(`[Util:CivitaiCrawler] Failed to fetch model version info by hash ${hash}: ${err.message}`);
    throw err;
  }

  // 3. 主模型信息、标签和所有版本

  let modelVersionInfo = null;
  let modelInfo = null;
  try {
    const resp = await axios.get(`https://civitai.com/api/v1/models/${modelId}`);
    const modelData = resp.data;
    modelInfo = modelData;

    modelVersionInfo = modelData.modelVersions.find(item => item.id === id) || null;

    log.info(`[Util:CivitaiCrawler] Successfully fetched main model info for modelId=${modelId}.`);
  } catch (e) {
    log.warn(`[Util:CivitaiCrawler] Failed to fetch main model info or tags/versions for modelId=${modelId}: ${e.message}`);
  }
  
  let desc = turndownService.turndown( modelInfo.description) || null;
  const images = modelVersionInfo.images || [];
  const imagePrompts = images.map(image => {
    const prompt = image?.meta?.prompt || '';
    const negativePrompt = image?.meta?.negativePrompt || '';
    let promptString = '';
    if (prompt) {
      promptString += `prompt: ${prompt}`;
    }
    if (negativePrompt) {
      if (promptString) { // 如果 prompt 也存在，则添加换行符
          promptString += '\n\n';
      }
      promptString += `negativePrompt: ${negativePrompt}`;
    }
    return promptString;
  }).filter(Boolean); // 过滤掉 prompt 和 negativePrompt 都为空的条目


  
  let trainedWords = (modelVersionInfo.trainedWords || []).join(", ");

  // 4. 结果结构
  return {
    modelId: modelId,
    modelVersionId : id || null,
    modelName:  modelInfo.name || null,
    modelVer: modelVersionInfo.name || null,

    modelType: modelInfo.type || null,

    baseModel: modelVersionInfo.baseModel || null,
    triggerWord: trainedWords,
    description: desc || "",

    fromUrl:`https://civitai.com/models/${modelId}?modelVersionId=${id}`,
    from:`Civita`,
    versionDescription: modelVersionInfo.description||null,
    tags: modelInfo.tags,
    examplePrompt:imagePrompts || [],
    image: images.length > 0 ? (images[0].url.startsWith('http') ? images[0].url : `https://civitai.com${images[0].url}`) : null,

  };
}

/**
 * 命令行测试入口
 * 用法: node civitaiInfo.js your_model_file.safetensors
 */
if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    log.error('[Util:CivitaiCrawler] Usage: node civitai-model-info-crawler.js your_model_file.safetensors');
    process.exit(1);
  }
  getCivitaiModelInfoWithTagsAndVersions(filePath)
    .then(info => {
      if (info) {
        log.info('[Util:CivitaiCrawler] Model info found:\n' + JSON.stringify(info, null, 2));
      } else {
        log.warn('[Util:CivitaiCrawler] Model info not found for this file.');
      }
    })
    .catch(err => {
      log.error('[Util:CivitaiCrawler] Error occurred: ' + err.message);
    });
}

// 导出主要方法供 Electron 其他模块调用
module.exports = { getCivitaiModelInfoWithTagsAndVersions };