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
    constructor(dataSourceService) {
        if (!dataSourceService) {
            throw new Error("ImageService requires a DataSourceService instance.");
        }
        this.dataSourceService = dataSourceService;
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
            log.debug(`[ImageService] Attempting imageCache.getCache for key: ${libraryId}/${imageName}`);
            const cachedBuffer = await imageCache.getCache(libraryId, imageName);
            log.debug(`[ImageService] imageCache.getCache returned for key: ${libraryId}/${imageName}. Result: ${cachedBuffer ? `Buffer(${cachedBuffer.length} bytes)` : 'null'}`);

            if (cachedBuffer) {
                // 缓存命中
                const mimeType = imageCache.config.compressFormat === 'webp' ? 'image/webp' : 'image/jpeg';
                log.info(`[ImageService] Cache HIT for ${libraryId}/${imageName}. Returning cached buffer.`);
                const duration = Date.now() - startTime;
                log.info(`[ImageService] <<< getImage END (Cache Hit) for ${libraryId}/${imageName}. Duration: ${duration}ms`);
                return { data: cachedBuffer, mimeType: mimeType };
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
                const duration = Date.now() - startTime;
                log.warn(`[ImageService] <<< getImage END (No Source Data) for ${libraryId}/${imageName}. Duration: ${duration}ms`);
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


            // 3. 将原始 Buffer 存入缓存（imageCache.setCache 会进行处理）
            log.debug(`[ImageService] Attempting imageCache.setCache for key: ${libraryId}/${imageName}, source buffer size: ${sourceBuffer.length} bytes`);
            try {
                await imageCache.setCache(libraryId, imageName, sourceBuffer);
                log.info(`[ImageService] imageCache.setCache call completed successfully for ${libraryId}/${imageName}`);
            } catch (setCacheError) {
                log.error(`[ImageService] imageCache.setCache failed for ${libraryId}/${imageName}:`, setCacheError.message, setCacheError.stack);
                // 即使 setCache 失败，也可能需要决定是否返回原始数据或 null
                // 这里选择继续尝试读取（万一 setCache 内部部分成功或有其他问题），但记录错误
            }


            // 4. 再次从缓存获取处理后的图片 Buffer
            log.debug(`[ImageService] Attempting imageCache.getCache AGAIN for key: ${libraryId}/${imageName} (after setCache)`);
            const finalBuffer = await imageCache.getCache(libraryId, imageName);
            log.debug(`[ImageService] imageCache.getCache (after setCache) returned for key: ${libraryId}/${imageName}. Result: ${finalBuffer ? `Buffer(${finalBuffer.length} bytes)` : 'null'}`);

            if (finalBuffer) {
                const finalMimeType = imageCache.config.compressFormat === 'webp' ? 'image/webp' : 'image/jpeg';
                log.info(`[ImageService] Successfully retrieved processed buffer from cache after setCache for ${libraryId}/${imageName}.`);
                const duration = Date.now() - startTime;
                log.info(`[ImageService] <<< getImage END (Cache Miss, Processed) for ${libraryId}/${imageName}. Duration: ${duration}ms`);
                return { data: finalBuffer, mimeType: finalMimeType };
            } else {
                // 如果 setCache 之后 getCache 仍然失败
                log.error(`[ImageService] CRITICAL: Failed to retrieve image from cache immediately after setCache call for ${libraryId}/${imageName}. This might indicate a write/read issue or setCache failure.`);
                // 考虑降级：返回原始 buffer？这取决于业务需求
                // log.warn(`[ImageService] Falling back to returning original source buffer for ${libraryId}/${imageName}`);
                // return { data: sourceBuffer, mimeType: originalMimeType || 'application/octet-stream' };
                const duration = Date.now() - startTime;
                log.error(`[ImageService] <<< getImage END (Failed Post-SetCache Read) for ${libraryId}/${imageName}. Duration: ${duration}ms`);
                return null; // 或者直接返回 null 表示失败
            }

        } catch (error) {
            // 捕获所有可能的错误
            log.error(`[ImageService] UNHANDLED Error during getImage for ${libraryId}/${imageName}:`, error.message, error.stack);
            const duration = Date.now() - startTime;
            log.error(`[ImageService] <<< getImage END (Unhandled Error) for ${libraryId}/${imageName}. Duration: ${duration}ms`);
            return null;
        }
    }
/**
     * Updates the configuration for the underlying image cache.
     * @param {object} newCacheConfig - The new configuration object for the image cache.
     * Expected format: { enabled: boolean, maxSizeMb: number, compress: boolean, compressFormat: string, compressQuality: number }
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
/**
     * Cleans up the image cache. Intended to be called on application exit.
     */
    async cleanupCache() {
        log.info('[ImageService] cleanupCache called. Clearing image cache...');
        try {
            // Assuming imageCache.clearCache() is synchronous or handles its own async ops.
            // If it returns a Promise, use await here.
            imageCache.clearCache();
            log.info('[ImageService] Image cache cleared successfully.');
        } catch (error) {
            log.error('[ImageService] Failed to clear image cache:', error);
            // Depending on requirements, might re-throw the error.
            // throw error;
        }
    }
}

module.exports = ImageService;
