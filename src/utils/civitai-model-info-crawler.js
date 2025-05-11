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
    log.error('[Util:CivitaiCrawler] Error calculating file hash:', error);
    throw error; // 重新抛出错误，以便调用者处理
  }
}

/**
 * 通过模型文件HASH或文件路径获取Civitai模型详细信息（含tags和所有版本）
 * @param {string} filePath - 模型文件路径
 * @param {string} [providedHash=null] - 可选的预计算哈希值
 * @returns {Promise<Object|null>} - 返回模型信息对象，未找到时返回null
 */
async function getCivitaiModelInfoWithTagsAndVersions(filePath, providedHash = null) {
  // 1. 获取或计算模型文件哈希
  let hash;
  if (providedHash) {
    hash = providedHash;
    log.info(`[Util:CivitaiCrawler] Using provided SHA256 hash for file [${filePath}]: ${hash}`);
  } else {
    try {
      hash = await calcFileHash(filePath);
      log.info(`[Util:CivitaiCrawler] Calculated SHA256 for file [${filePath}]: ${hash}`);
    } catch (hashError) {
      log.error(`[Util:CivitaiCrawler] Failed to calculate hash for file [${filePath}]:`, hashError);
      throw hashError; // Re-throw hash calculation error
    }
  }

  // 2. 查询模型版本信息（by hash）- 带重试逻辑
  let modelId;
  let id;
  const maxRetries = 3;
  const retryDelay = 2000; // 2 seconds

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const resp = await axios.get(`https://civitai.com/api/v1/model-versions/by-hash/${hash}`);
      const versionData = resp.data;
      id = versionData.id;
      modelId = versionData.modelId;
      log.info(`[Util:CivitaiCrawler] Attempt ${attempt}: Successfully fetched model version info by hash: modelId=${modelId}`);
      if (!versionData.id || !versionData.modelId) {
        log.warn(`[Util:CivitaiCrawler] Attempt ${attempt}: Fetched data but missing id or modelId for hash ${hash}.`);
        return null; // Treat as not found if essential data is missing
      }
      break; // Success, exit retry loop
    } catch (err) {
      if (err.response && err.response.status === 404) {
        log.warn(`[Util:CivitaiCrawler] Attempt ${attempt}: Model version not found on Civitai by hash ${hash}.`);
        if (attempt > maxRetries) {
          log.warn(`[Util:CivitaiCrawler] Max retries (${maxRetries}) reached for hash ${hash}. Giving up.`);
          return null; // Return null after max retries for 404
        }
        log.info(`[Util:CivitaiCrawler] Retrying in ${retryDelay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        // For non-404 errors, log and re-throw immediately
        log.error(`[Util:CivitaiCrawler] Attempt ${attempt}: Failed to fetch model version info by hash ${hash}: ${err.message}`, err);
        throw err; // Re-throw other errors
      }
    }
  }

  // If loop finished without success (should only happen if break wasn't hit, e.g., initial check failed non-404)
  if (!modelId) {
      log.error(`[Util:CivitaiCrawler] Failed to get modelId for hash ${hash} after all attempts.`);
      return null; // Should technically be caught by error throws, but as a safeguard.
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
  
  let desc = "";
  if (modelInfo && typeof modelInfo.description === "string" && modelInfo.description.trim()) {
    desc = turndownService.turndown(modelInfo.description);
  }
  let versionDescription = "";
  if (modelVersionInfo && typeof modelVersionInfo.description === "string" && modelVersionInfo.description.trim()) {
    versionDescription = turndownService.turndown(modelVersionInfo.description);
  }

  const images = modelVersionInfo.images || [];

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
    versionDescription: versionDescription,
    tags: modelInfo.tags,
    images: images, // Ensure images is always an array (possibly empty)

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



module.exports = { calcFileHash, getCivitaiModelInfoWithTagsAndVersions };