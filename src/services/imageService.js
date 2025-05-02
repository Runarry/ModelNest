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
        log.info(`[ImageService] getImage called for libraryId: ${libraryId}, imageName: ${imageName}`);

        try {
            // 1. 尝试从缓存获取
            const cachedBuffer = await imageCache.getCache(libraryId, imageName);
            if (cachedBuffer) {
                // 缓存命中，确定 mimeType 并返回
                // 注意：缓存本身不存储 mimeType，需要根据配置或推断
                const mimeType = imageCache.config.compressFormat === 'webp' ? 'image/webp' : 'image/jpeg';
                log.debug(`[ImageService] Cache hit for ${libraryId}/${imageName}. Returning cached buffer.`);
                const duration = Date.now() - startTime;
                 log.info(`[ImageService] getImage completed (cache hit) for ${libraryId}/${imageName}, 耗时: ${duration}ms`);
                return { data: cachedBuffer, mimeType: mimeType };
            }

            log.debug(`[ImageService] Cache miss for ${libraryId}/${imageName}. Fetching from data source.`);

            // 2. 缓存未命中，从数据源获取原始图片 Buffer
            const sourceConfig = await this.dataSourceService.getSourceConfig(libraryId);
            if (!sourceConfig) {
                log.error(`[ImageService] 未找到数据源配置: ${libraryId}`);
                return null;
            }

            log.debug(`[ImageService] Calling dataSourceInterface.getImageData for source ${libraryId}, path: ${imagePath}`);
            // 确保 dataSourceInterface.getImageData 返回的是 { data: Buffer | null, mimeType?: string }
            // 特别是对于 local 类型，它可能需要读取文件内容到 Buffer
            const imageDataResult = await dataSourceInterface.getImageData(sourceConfig, imagePath);

            if (!imageDataResult || !imageDataResult.data) {
                log.warn(`[ImageService] dataSourceInterface.getImageData returned null or no data for ${libraryId}/${imagePath}`);
                return null; // 图片未找到或读取错误
            }

            // 确认 imageDataResult.data 是 Buffer
            if (!Buffer.isBuffer(imageDataResult.data)) {
                 log.error(`[ImageService] dataSourceInterface.getImageData did not return a Buffer for ${libraryId}/${imagePath}`);
                 return null;
            }

            const sourceBuffer = imageDataResult.data;
            const originalMimeType = imageDataResult.mimeType; // 保留原始 mimeType 信息（虽然可能不准确）
            log.debug(`[ImageService] Successfully fetched source image buffer for ${libraryId}/${imageName}, size: ${(sourceBuffer.length / 1024).toFixed(1)}KB, original mime: ${originalMimeType}`);


            // 3. 将原始 Buffer 存入缓存（imageCache.setCache 会进行处理）
            // 注意：setCache 是异步的，但不一定需要 await 它完成才能继续，
            // 因为我们接下来会再次调用 getCache 来获取 *处理后* 的结果。
            // 但为了确保缓存写入操作已启动或完成（并处理可能的写入错误），使用 await 更稳妥。
            log.debug(`[ImageService] Calling imageCache.setCache for ${libraryId}/${imageName}`);
            // imageCache.setCache 现在内部处理 sharp 压缩和写入
            await imageCache.setCache(libraryId, imageName, sourceBuffer);
            log.debug(`[ImageService] imageCache.setCache call completed for ${libraryId}/${imageName}`);


            // 4. 再次从缓存获取处理后的图片 Buffer
            // 这确保我们返回的是经过 sharp 处理（压缩、格式转换）的最终版本
            log.debug(`[ImageService] Calling imageCache.getCache again to retrieve processed buffer for ${libraryId}/${imageName}`);
            const finalBuffer = await imageCache.getCache(libraryId, imageName);

            if (finalBuffer) {
                // 确定最终的 mimeType，基于缓存配置
                const finalMimeType = imageCache.config.compressFormat === 'webp' ? 'image/webp' : 'image/jpeg';
                log.info(`[ImageService] Successfully processed and retrieved final buffer for ${libraryId}/${imageName}`);
                 const duration = Date.now() - startTime;
                 log.info(`[ImageService] getImage completed (cache miss, processed) for ${libraryId}/${imageName}, 耗时: ${duration}ms`);
                return { data: finalBuffer, mimeType: finalMimeType };
            } else {
                // 如果 setCache 成功后 getCache 仍然失败，说明缓存写入或读取存在严重问题
                log.error(`[ImageService] CRITICAL: Failed to retrieve image from cache immediately after setCache for ${libraryId}/${imageName}.`);
                // 降级：可以考虑返回原始 buffer，但这可能不是期望的行为
                // return { data: sourceBuffer, mimeType: originalMimeType || 'application/octet-stream' };
                return null; // 或者直接返回 null 表示失败
            }

        } catch (error) {
            // 捕获所有可能的错误，包括 getSourceConfig, getImageData, setCache, getCache 等
            log.error(`[ImageService] Error during getImage for ${libraryId}/${imageName}:`, error.message, error.stack);
            const duration = Date.now() - startTime;
            log.error(`[ImageService] getImage failed for ${libraryId}/${imageName}, 耗时: ${duration}ms`);
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
