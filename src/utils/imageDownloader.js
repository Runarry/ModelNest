const axios = require('axios');
const path = require('path');
const log = require('electron-log');

/**
 * 从 Content-Type 或 URL 推断图片文件扩展名。
 * @param {string} contentType - HTTP 响应的 Content-Type 头。
 * @param {string} imageUrl - 图片的 URL。
 * @returns {string|null} 推断出的扩展名（例如 '.jpg'），如果无法推断则返回 null。
 */
function inferImageExtension(contentType, imageUrl) {
  if (contentType) {
    const mimeType = contentType.split(';')[0].toLowerCase();
    switch (mimeType) {
      case 'image/jpeg':
      case 'image/jpg':
        return '.jpg';
      case 'image/png':
        return '.png';
      case 'image/gif':
        return '.gif';
      case 'image/webp':
        return '.webp';
      case 'image/bmp':
        return '.bmp';
      case 'image/svg+xml':
        return '.svg';
      // 可以根据需要添加更多 MIME 类型
    }
  }

  // 如果 Content-Type 无法推断，尝试从 URL 路径获取
  try {
    const urlPath = new URL(imageUrl).pathname;
    const ext = path.extname(urlPath).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) {
      return ext === '.jpeg' ? '.jpg' : ext; // 统一使用 .jpg
    }
  } catch (e) {
    log.warn(`[ImageDownloader] 解析图片 URL 失败: ${imageUrl}`, e);
  }

  log.warn(`[ImageDownloader] 无法从 Content-Type ('${contentType}') 或 URL ('${imageUrl}') 推断图片扩展名。`);
  return null; // 无法推断
}

/**
 * 下载图片并使用指定的数据源保存。
 * @param {string} imageUrl - 要下载的图片的 URL。
 * @param {string} targetPathWithoutExtension - 保存文件的目标路径（不含扩展名）。
 * @param {import('../data/baseDataSource').DataSource} dataSource - 用于写入文件的数据源实例。
 * @returns {Promise<string|null>} 成功时返回保存的文件完整路径，失败时返回 null。
 */
async function downloadAndSaveImage(imageUrl, targetPathWithoutExtension, dataSource) {
  const startTime = Date.now();
  log.info(`[ImageDownloader] 开始下载图片: ${imageUrl} -> ${targetPathWithoutExtension}.*`);

  if (!imageUrl || !targetPathWithoutExtension || !dataSource) {
    log.error('[ImageDownloader] downloadAndSaveImage 调用参数无效。', { imageUrl, targetPathWithoutExtension, dataSource: !!dataSource });
    return null;
  }

  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer', // 获取二进制数据
      timeout: 30000, // 设置 30 秒超时
      headers: {
        'User-Agent': 'ModelNest/1.0', // 设置 User-Agent
      },
    });

    if (response.status !== 200) {
      log.error(`[ImageDownloader] 下载图片失败，HTTP 状态码: ${response.status}, URL: ${imageUrl}`);
      return null;
    }

    const imageData = Buffer.from(response.data);
    const contentType = response.headers['content-type'];
    // --- 添加日志 ---
    log.debug(`[ImageDownloader] Download successful. Status: ${response.status}, Content-Type: ${contentType}`);
    // --- 结束日志 ---

    // 推断扩展名
    let extension = inferImageExtension(contentType, imageUrl);
    // --- 添加日志 ---
    log.debug(`[ImageDownloader] Inferred extension: ${extension} (from Content-Type: ${contentType}, URL: ${imageUrl})`);
    // --- 结束日志 ---
    if (!extension) {
      log.warn(`[ImageDownloader] 无法推断图片扩展名，将尝试使用 '.jpg' 作为默认扩展名: ${imageUrl}`);
      extension = '.jpg'; // 使用默认扩展名
    }

    const targetPath = `${targetPathWithoutExtension}${extension}`;
    // --- 添加日志 ---
    log.debug(`[ImageDownloader] Attempting to write image data. Target path: ${targetPath}, Data size: ${imageData.length} bytes`);
    // --- 结束日志 ---

    // 调用 dataSource 保存文件
    await dataSource.writeFile(targetPath, imageData);

    const duration = Date.now() - startTime;
    log.info(`[ImageDownloader] 成功下载并保存图片: ${imageUrl} -> ${targetPath}, 大小: ${(imageData.length / 1024).toFixed(1)}KB, 耗时: ${duration}ms`);
    return targetPath; // 返回保存的完整路径

  } catch (error) {
    const duration = Date.now() - startTime;
    if (axios.isAxiosError(error)) {
      log.error(`[ImageDownloader] 下载图片时发生网络错误: ${imageUrl}, 耗时: ${duration}ms`, error.message, error.code, error.config?.url);
    } else if (error.message.includes('Data to write must be a Buffer')) {
        // 这个错误理论上不应该发生，因为我们用了 arraybuffer
        log.error(`[ImageDownloader] 尝试写入非 Buffer 数据 (内部错误): ${targetPathWithoutExtension}, 耗时: ${duration}ms`, error);
    } else if (error.message.includes('File path cannot be empty')) {
        log.error(`[ImageDownloader] 尝试写入空文件路径 (内部错误): ${targetPathWithoutExtension}, 耗时: ${duration}ms`, error);
    }
     else {
      // 可能是 dataSource.writeFile 的错误或其他错误
      log.error(`[ImageDownloader] 下载或保存图片时发生错误: ${imageUrl} -> ${targetPathWithoutExtension}.*, 耗时: ${duration}ms`, error.message, error.stack);
    }
    return null; // 返回 null 表示失败
  }
}

module.exports = {
  downloadAndSaveImage,
};