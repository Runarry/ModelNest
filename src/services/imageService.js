const log = require('electron-log');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dataSourceInterface = require('../data/dataSourceInterface');
const imageCache = require('../common/imageCache');

/**
 * @typedef {import('./dataSourceService')} DataSourceService
 * @typedef {import('../data/dataSource').DataSourceConfig} DataSourceConfig
 * @typedef {import('../data/dataSourceInterface').ImageDataResult} ImageDataResult
 */

class ImageService {
    /**
     * @param {DataSourceService} dataSourceService Instance of DataSourceService.
     */
    constructor(dataSourceService, configService) {
        if (!dataSourceService) {
            throw new Error("ImageService requires a DataSourceService instance.");
        }
        this.dataSourceService = dataSourceService;
        this.configService = configService;
        log.info('[ImageService] Initialized');
    }

    /**
     * 获取模型图片（封面、预览图等），优先使用缓存，否则从数据源获取、处理并缓存。
     * @param {string} libraryId 数据源 ID (原 sourceId)
     * @param {string} imagePath 图片在数据源中的相对路径 (作为 imageName 使用)
     * @returns {Promise<{data: Buffer, mimeType: string} | null>} 包含 Buffer 数据和 mimeType 的对象，或在失败时返回 null
     */
    async getImage(libraryId, imagePath) {
        const startTime = Date.now();
        // 使用 imagePath 作为 imageName，因为它在 libraryId 内是唯一的
        // 确保 imagePath 规范化，例如去除前导/后导斜杠，统一分隔符
        const imageName = imagePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        log.info(`[ImageService] >>> getImage START for libraryId: ${libraryId}, imagePath: ${imagePath}, normalized imageName: ${imageName}`);

        try {
            // 1. 尝试从缓存获取
            const cacheResult = await imageCache.getCache(libraryId, imageName); // Returns { data: Buffer, mimeType: string | null } | null
            log.debug(`[ImageService] imageCache.getCache returned for key: ${libraryId}/${imageName}. Result: ${cacheResult ? `Data: ${cacheResult.data.length} bytes, MimeType: ${cacheResult.mimeType}` : 'null'}`);

            if (cacheResult && cacheResult.data) {
                // 缓存命中
                const mimeType = cacheResult.mimeType || 'application/octet-stream'; // Use cached mimeType or default
   
                const duration = Date.now() - startTime;
                log.info(`[ImageService] Cache HIT for ${libraryId}/${imageName}, Duration: ${duration}ms Using MIME type: ${mimeType}`);
                return { data: cacheResult.data, mimeType: mimeType };
            }

            log.info(`[ImageService] Cache MISS for ${libraryId}/${imageName}. Proceeding to fetch from data source.`);

            // 2. 缓存未命中，从数据源获取原始图片 Buffer
            const sourceConfig = await this.dataSourceService.getSourceConfig(libraryId);
            if (!sourceConfig) {
                log.error(`[ImageService] 未找到数据源配置: ${libraryId}`);
                return null;
            }

            log.debug(`[ImageService] Attempting dataSourceInterface.getImageData for source ${libraryId}, path: ${imagePath}`);
            // 确保 dataSourceInterface.getImageData 返回的是 { data: Buffer | null, mimeType?: string }
            const imageDataResult = await dataSourceInterface.getImageData(sourceConfig, imagePath);
            log.debug(`[ImageService] dataSourceInterface.getImageData returned for ${libraryId}/${imagePath}. Has data: ${!!(imageDataResult && imageDataResult.data)}`);

            if (!imageDataResult || !imageDataResult.data) {

                log.warn(`[ImageService] dataSourceInterface.getImageData returned null or no data for ${libraryId}/${imagePath}. Cannot proceed with caching.`);
                return null; // 图片未找到或读取错误
            }

            // 确认 imageDataResult.data 是 Buffer
            if (!Buffer.isBuffer(imageDataResult.data)) {
                 log.error(`[ImageService] dataSourceInterface.getImageData did not return a Buffer for ${libraryId}/${imagePath}. Type was: ${typeof imageDataResult.data}`);
                 const duration = Date.now() - startTime;
                 log.error(`[ImageService] <<< getImage END (Invalid Source Data Type) for ${libraryId}/${imageName}. Duration: ${duration}ms`);
                 return null;
            }

            const sourceBuffer = imageDataResult.data;
            const originalMimeType = imageDataResult.mimeType;
            log.info(`[ImageService] Successfully fetched source image buffer for ${libraryId}/${imageName}. Size: ${(sourceBuffer.length / 1024).toFixed(1)}KB, Original Mime: ${originalMimeType || 'N/A'}`);


            // 3. 获取缓存格式配置，并决定是否缓存
            let preferredFormat = await this.configService.getSetting('imageCache.preferredFormat'); // 获取首选格式
            if (!preferredFormat) {
                preferredFormat = 'Original'; // 默认值
            }
            log.debug(`[ImageService] Preferred cache format for ${libraryId}/${imageName}: ${preferredFormat}`);

            // 如果首选格式是 'Original'，则直接返回原始数据，不进行缓存
            if (preferredFormat === 'Original') {
                log.info(`[ImageService] Preferred format is 'Original'. Skipping cache for ${libraryId}/${imageName}. Returning source buffer.`);
                return { data: sourceBuffer, mimeType: originalMimeType || 'application/octet-stream' };
            } else {
                // 否则，尝试将原始 Buffer 存入缓存（imageCache.setCache 会进行处理）
                log.debug(`[ImageService] Attempting imageCache.setCache for key: ${libraryId}/${imageName}, source buffer size: ${sourceBuffer.length} bytes, preferredFormat: ${preferredFormat}, originalMimeType: ${originalMimeType}`);
                let processedResult = null; // Variable to hold the result from setCache
                try {
                    // 将获取到的 preferredFormat 和 originalMimeType 传递给 setCache
                    processedResult = await imageCache.setCache(libraryId, imageName, sourceBuffer, preferredFormat, originalMimeType); // Capture the return value
                    log.info(`[ImageService] imageCache.setCache call completed successfully for ${libraryId}/${imageName}`);
                } catch (setCacheError) {
                    log.error(`[ImageService] imageCache.setCache failed for ${libraryId}/${imageName} with format ${preferredFormat}:`, setCacheError.message, setCacheError.stack);
                    // If setCache fails, processedResult will be null, which is handled below
                }

                // 4. 使用 setCache 返回的处理后的图片 Buffer
                log.debug(`[ImageService] Using result from imageCache.setCache for key: ${libraryId}/${imageName}. Result: ${processedResult ? `Data: ${processedResult.data.length} bytes, MimeType: ${processedResult.mimeType}` : 'null'}`);

                if (processedResult && processedResult.data) {
                    // 成功从 setCache 获取处理后的数据
                    const finalMimeType = processedResult.mimeType || 'application/octet-stream'; // 使用处理后的 mimeType 或默认值
                    log.info(`[ImageService] Successfully retrieved processed buffer from setCache for ${libraryId}/${imageName}. Using MIME type: ${finalMimeType}`);
                    return { data: processedResult.data, mimeType: finalMimeType };
                } else {
                    // 如果 setCache 失败或返回 null
                    log.error(`[ImageService] CRITICAL: imageCache.setCache failed or returned null for ${libraryId}/${imageName}.`);
                    // 降级：返回原始 buffer
                    const fallbackMimeType = originalMimeType || 'application/octet-stream';
                    log.warn(`[ImageService] Falling back to returning original source buffer for ${libraryId}/${imageName} due to setCache failure. Using MIME type: ${fallbackMimeType}`);
                    return { data: sourceBuffer, mimeType: fallbackMimeType };
                }
            }

        } catch (error) {
            // 捕获所有可能的错误
            log.error(`[ImageService] UNHANDLED Error during getImage for ${libraryId}/${imageName}:`, error.message, error.stack);
            return null;
        }
    }
/**
     * Updates the configuration for the underlying image cache.
     * @param {object} newCacheConfig - The new configuration object for the image cache.
     * This configuration is passed to `imageCache.setConfig`. Refer to `imageCache.js` for the exact expected format.
     * It typically includes settings like { enabled: boolean, maxSizeMb: number, preferredFormat: string, compressQuality: number }.
     */
    updateCacheConfig(newCacheConfig) {
        log.info('[ImageService] updateCacheConfig called with new config:', newCacheConfig);
        try {
            // Directly call the setConfig method of the imported imageCache module
            imageCache.setConfig(newCacheConfig || {});
            log.info('[ImageService] Image cache configuration updated successfully.');
        } catch (error) {
            log.error('[ImageService] Failed to update image cache configuration:', error);
            // Optionally re-throw or handle the error as needed
            throw error;
        }
    }
    // 移除 cleanupCache 方法，因为它不再被 main.js 调用

    /**
     * 清除图片缓存 (供手动触发等场景使用)
     * @returns {Promise<void>}
     */
    async clearCache() {
        log.info('[ImageService] clearCache called. Clearing image cache...');
        try {
            await imageCache.clearCache();
            log.info('[ImageService] Image cache cleared successfully.');
        } catch (error) {
            log.error('[ImageService] Failed to clear image cache:', error);
            throw error;
        }
    }
}

module.exports = ImageService;
