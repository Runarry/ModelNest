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
     * 获取模型图片，处理缓存和压缩。
     * Migrated core logic from src/ipc/modelLibraryIPC.js handle('getModelImage', ...)
     * @param {string} sourceId 数据源 ID
     * @param {string} imagePath 图片在数据源中的相对路径
     * @returns {Promise<{path: string, data: Buffer, mimeType: string} | null>} 包含缓存路径、Buffer 数据和 mimeType 的对象，或在失败时返回 null
     */
    async getImage(sourceId, imagePath) {
        log.debug(`[ImageService] getImage called for sourceId: ${sourceId}, imagePath: ${imagePath}`);
        let sourceConfig = null; // Define here for potential use in final catch block
        let tempFilePath = null; // Path for temporary WebDAV file, define for cleanup

        try {
            // 1. 获取 SourceConfig (通过注入的 DataSourceService)
            sourceConfig = await this.dataSourceService.getSourceConfig(sourceId);
            if (!sourceConfig) {
                log.error(`[ImageService] 未找到数据源配置: ${sourceId}`);
                return null;
            }
            log.debug(`[ImageService] Found source config for ${sourceId}: type=${sourceConfig.type}`);

            // 2. 生成缓存 Key 和路径 (逻辑来自 modelLibraryIPC)
            // Use posix path for WebDAV consistency, absolute for local (matching IPC logic)
            const hashKey = sourceConfig.type === 'local'
                ? path.resolve(imagePath) // Keep local paths absolute
                : imagePath.replace(/\\/g, '/').toLowerCase(); // Normalize WebDAV paths

            log.debug(`[ImageService] Generated hash key for ${sourceConfig.type} source: ${hashKey}`);

            // TODO: Consider making cache path configurable via ConfigService? For now, keep it hardcoded.
            const cacheDir = path.join(process.cwd(), 'cache', 'images');
            const cacheFilename = crypto.createHash('md5').update(hashKey).digest('hex') +
                                  (imageCache.config.compressFormat === 'webp' ? '.webp' : '.jpg');
            const cachePath = path.join(cacheDir, cacheFilename);
            const mimeType = imageCache.config.compressFormat === 'webp' ? 'image/webp' : 'image/jpeg';

            log.debug(`[ImageService] Calculated cache path: ${cachePath}`);

            // 3. 检查缓存 (逻辑来自 modelLibraryIPC)
            log.debug('[ImageService] Checking cache at:', cachePath);
            try {
                if (fs.existsSync(cachePath)) {
                    log.debug('[ImageService] Cache hit, reading...');
                    const data = await fs.promises.readFile(cachePath);
                    log.debug('[ImageService] Successfully read cache file');
                    return { path: cachePath, data, mimeType };
                } else {
                    log.debug('[ImageService] Cache miss');
                }
            } catch (e) {
                log.error('[ImageService] Cache check/read error:', e.message);
                // Proceed to fetch if cache read fails
            }

            // 4. 调用 dataSourceInterface 获取数据 (逻辑来自 modelLibraryIPC)
            log.debug(`[ImageService] Calling dataSourceInterface.getImageData for source ${sourceId}, path: ${imagePath}`);
            const imageDataResult = await dataSourceInterface.getImageData(sourceConfig, imagePath);

            if (!imageDataResult) {
                log.warn(`[ImageService] dataSourceInterface.getImageData returned null for ${imagePath}`);
                return null; // Image not found or error in interface
            }
            log.debug(`[ImageService] dataSourceInterface.getImageData returned result for ${imagePath}`);

            // 5. 处理源文件路径和 WebDAV 临时文件 (逻辑来自 modelLibraryIPC)
            let sourceImagePathForCache; // Path to the file to be compressed

            if (sourceConfig.type === 'local') {
                 // Interface should return an existing path for local sources
                if (!imageDataResult.path || !fs.existsSync(imageDataResult.path)) {
                     log.error(`[ImageService] Local image path missing or invalid from interface result for: ${imagePath} (path: ${imageDataResult.path})`);
                     return null;
                }
                sourceImagePathForCache = imageDataResult.path;
                log.debug(`[ImageService] Using local image path for caching: ${sourceImagePathForCache}`);
            } else if (sourceConfig.type === 'webdav') {
                if (!imageDataResult.data) {
                     log.error(`[ImageService] WebDAV image data missing from interface result for: ${imagePath}`);
                     return null;
                }
                // Save WebDAV data to a temporary file for imageCache
                const tempDir = path.join(process.cwd(), 'cache', 'temp_images'); // TODO: Configurable?
                if (!fs.existsSync(tempDir)) {
                    try {
                        await fs.promises.mkdir(tempDir, { recursive: true });
                        log.debug(`[ImageService] Created temp directory: ${tempDir}`);
                    } catch (mkdirError) {
                        log.error(`[ImageService] Failed to create temp directory ${tempDir}:`, mkdirError);
                        return null;
                    }
                }
                // Use a hash of the imagePath for the temp filename base
                const tempFilenameBase = crypto.createHash('md5').update(imagePath).digest('hex');
                // Try to preserve original extension, default to .png
                const tempFilenameExt = path.extname(imagePath || '.png') || '.png';
                const tempFilename = tempFilenameBase + tempFilenameExt;
                tempFilePath = path.join(tempDir, tempFilename); // Assign to outer scope variable

                log.debug(`[ImageService] Writing WebDAV image data to temporary file: ${tempFilePath}`);
                try {
                    await fs.promises.writeFile(tempFilePath, imageDataResult.data);
                    sourceImagePathForCache = tempFilePath;
                } catch (writeError) {
                     log.error(`[ImageService] Failed to write WebDAV temp file ${tempFilePath}:`, writeError);
                     return null; // Cannot proceed without temp file
                }
            } else {
                 log.error(`[ImageService] Unsupported source type after interface call: ${sourceConfig.type}`);
                 return null;
            }

            // 6. 调用 imageCache 压缩和缓存 (逻辑来自 modelLibraryIPC)
            log.debug(`[ImageService] Calling imageCache.getCompressedImage with source path: ${sourceImagePathForCache}, hashKey: ${hashKey}`);
            let compressedPath;
            try {
                // imageCache uses hashKey internally to determine the output path (which should match cachePath)
                compressedPath = await imageCache.getCompressedImage(sourceImagePathForCache, hashKey);
                log.debug(`[ImageService] Compressed image path returned: ${compressedPath}`);

                // Verify the compressed path matches the expected cache path (as per original logic)
                if (path.resolve(compressedPath) !== path.resolve(cachePath)) {
                     log.warn(`[ImageService] Compressed path (${compressedPath}) differs from expected cache path (${cachePath}). Reading from returned path.`);
                     // Trust the path returned by imageCache
                }

                // 7. 读取最终缓存文件 (逻辑来自 modelLibraryIPC)
                log.debug(`[ImageService] Reading final cached/compressed file from: ${compressedPath}`);
                const finalData = await fs.promises.readFile(compressedPath);
                log.debug(`[ImageService] Successfully read final cached file: ${compressedPath}`);

                // 8. 清理临时文件 (放在成功读取之后)
                if (tempFilePath && fs.existsSync(tempFilePath)) {
                    // Only delete if it's different from the final compressed path
                    if (path.resolve(tempFilePath) !== path.resolve(compressedPath)) {
                        log.debug(`[ImageService] Cleaning up temporary WebDAV file: ${tempFilePath}`);
                        await fs.promises.unlink(tempFilePath).catch(e => log.error(`[ImageService] Temp file cleanup failed: ${tempFilePath}`, e.message));
                    } else {
                        log.debug(`[ImageService] Temporary file is the same as cache file, not deleting: ${tempFilePath}`);
                    }
                }

                // 9. 构造返回结果
                return { path: compressedPath, data: finalData, mimeType };

            } catch (e) {
                log.error(`[ImageService] Image compression/caching failed for ${sourceImagePathForCache}:`, e.message, e.stack);
                 // Clean up temp file if compression failed
                 if (tempFilePath && fs.existsSync(tempFilePath)) {
                    log.debug(`[ImageService] Cleaning up temporary WebDAV file after compression error: ${tempFilePath}`);
                    await fs.promises.unlink(tempFilePath).catch(unlinkErr => log.error(`[ImageService] Temp file cleanup failed after compression error: ${tempFilePath}`, unlinkErr.message));
                 }
                return null; // Return null on compression/caching failure
            }

        } catch (error) {
            log.error(`[ImageService] Unexpected error during getImage for ${sourceId}/${imagePath}:`, error);
            // Ensure temp file cleanup on any unexpected error after its potential creation
            if (tempFilePath && fs.existsSync(tempFilePath)) {
                 log.debug(`[ImageService] Cleaning up temporary WebDAV file after unexpected error: ${tempFilePath}`);
                 await fs.promises.unlink(tempFilePath).catch(unlinkErr => log.error(`[ImageService] Temp file cleanup failed after unexpected error: ${tempFilePath}`, unlinkErr.message));
            }
            return null;
        }
    }
}

module.exports = ImageService;
