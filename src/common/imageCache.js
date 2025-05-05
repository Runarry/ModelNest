/**
 * 图片压缩与缓存模块
 * 适用于本地图片与 WebDAV 图片的统一压缩、缓存、清理管理
 *
 * 主要功能：
 * 1. 首次加载图片时自动压缩并缓存，后续优先读取缓存
 * 2. 支持最大缓存空间限制，超限时按 LRU 策略清理
 * 3. 支持缓存清理（启动/退出/手动）
 * 4. 支持配置压缩参数、缓存目录等
 *
 * 依赖建议：sharp、jimp 等 Node.js 图像处理库
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const sharp = require('sharp');
const crypto = require('crypto'); // 添加加密模块用于生成hash
const log = require('electron-log'); // 导入 electron-log
// const configService = require('../services/configService'); // 移除对 configService 的直接依赖

 // 默认配置
 const defaultConfig = {
    cacheDir: path.join(process.cwd(), 'cache', 'images'),
    maxCacheSizeMB: 200,
    compressQuality: 50, // 0-100
    debug: false, // 是否输出调试日志
    logStats: true // 是否记录统计信息
};

// 统计信息
const stats = {
    totalRequests: 0,
    cacheHits: 0,
    originalSize: 0,
    compressedSize: 0,
    lastCleanTime: null
};

let config = { ...defaultConfig };

/**
 * 设置图片缓存与压缩参数
 * @param {Object} options
 */
function setConfig(options = {}) {
    config = { ...config, ...options };
}

// --- 新的缓存接口 ---

/**
 * 生成缓存文件的完整路径
 * @param {string} libraryId 库 ID
 * @param {string} imageName 图片名称 (通常是模型基础名 + 后缀，或特定标识符)
 * @returns {string} 缓存文件的绝对路径
 */
function getCacheFilePath(libraryId, imageName) {
    const cacheKey = `${libraryId}_${imageName}`;
    // 使用 SHA256 更安全，避免潜在的路径遍历或特殊字符问题
    const hash = crypto.createHash('sha256').update(cacheKey).digest('hex');
    // 可以考虑根据 hash 创建子目录分散文件，例如 hash 的前两位
    // const subDir = hash.substring(0, 2);
    // const cacheDirWithSub = path.join(config.cacheDir, subDir);
    // return path.join(cacheDirWithSub, hash); // 暂时不加后缀，直接存 Buffer
    return path.join(config.cacheDir, hash); // 直接存储 hash 命名的文件
}

/**
 * 确保缓存目录存在
 * @returns {Promise<void>}
 */
async function ensureCacheDirExists() {
    try {
        await fs.promises.access(config.cacheDir);
    } catch (error) {
        if (error.code === 'ENOENT') {
            log.info(`[ImageCache] 缓存目录不存在，尝试创建: ${config.cacheDir}`);
            try {
                await fs.promises.mkdir(config.cacheDir, { recursive: true, mode: 0o755 });
                log.info(`[ImageCache] 缓存目录已创建: ${config.cacheDir}`);
            } catch (mkdirError) {
                log.error(`[ImageCache] 创建缓存目录失败: ${config.cacheDir}`, mkdirError.message, mkdirError.stack);
                throw mkdirError; // Re-throw if mkdir fails
            }
        } else {
            log.error(`[ImageCache] 访问缓存目录失败: ${config.cacheDir}`, error.message, error.stack);
            throw error;
        }
    }
}


/**
 * 从缓存中获取图片 Buffer
 * @param {string} libraryId 库 ID
 * @param {string} imageName 图片名称
 * @returns {Promise<Buffer | null>} 缓存的 Buffer 或 null
 */
async function getCache(libraryId, imageName) {
    const startTime = Date.now();
    stats.totalRequests++;
    const cacheFilePath = getCacheFilePath(libraryId, imageName);
    log.debug(`[ImageCache] >>> getCache START for key: ${libraryId}_${imageName}. Calculated cacheFilePath: ${cacheFilePath}`);

    try {
        await ensureCacheDirExists(); // 确保目录存在
        log.debug(`[ImageCache] Attempting fs.promises.readFile for: ${cacheFilePath}`);
        const cacheBuffer = await fs.promises.readFile(cacheFilePath);
        log.info(`[ImageCache] fs.promises.readFile SUCCESS for: ${cacheFilePath}. Buffer size: ${cacheBuffer.length}`);
        // 更新访问时间 (异步，不阻塞返回)
        fs.promises.utimes(cacheFilePath, new Date(), new Date()).catch(utimeError => {
            log.warn(`[ImageCache] Failed to update access time for cache file: ${cacheFilePath}`, utimeError.message);
        });
        stats.cacheHits++;
        const duration = Date.now() - startTime;
        log.info(`[ImageCache] Cache HIT for: ${libraryId}_${imageName}. Path: ${path.basename(cacheFilePath)}, Size: ${(cacheBuffer.length / 1024).toFixed(1)}KB. Duration: ${duration}ms`);
        log.debug(`[ImageCache] <<< getCache END (Hit) for key: ${libraryId}_${imageName}`);
        return cacheBuffer;
    } catch (error) {
        if (error.code === 'ENOENT') {
            log.info(`[ImageCache] Cache MISS (ENOENT): File not found at ${cacheFilePath} for key ${libraryId}_${imageName}`);
        } else {
            log.error(`[ImageCache] Error reading cache file: ${cacheFilePath} for key ${libraryId}_${imageName}`, error.message, error.stack);
        }
        const duration = Date.now() - startTime;
        log.debug(`[ImageCache] <<< getCache END (Miss or Error) for key: ${libraryId}_${imageName}. Duration: ${duration}ms`);
        return null; // 文件不存在或读取错误，返回 null
    }
}

/**
 * 将图片 Buffer 处理后存入缓存
 * @param {string} libraryId 库 ID
 * @param {string} imageName 图片名称
 * @param {Buffer} sourceBuffer 原始图片 Buffer
 * @param {string} preferredFormat 期望的缓存格式 ('JPEG', 'PNG', 'WebP', 'Original')
 * @returns {Promise<void>}
 */
async function setCache(libraryId, imageName, sourceBuffer, preferredFormat = 'Original') { // 添加 preferredFormat 参数，并提供默认值
    const startTime = Date.now();
    const cacheFilePath = getCacheFilePath(libraryId, imageName);
    log.info(`[ImageCache] >>> setCache START for key: ${libraryId}_${imageName}. Target path: ${cacheFilePath}. Source buffer size: ${sourceBuffer ? sourceBuffer.length : 'null/undefined'}. Preferred format: ${preferredFormat}`);
    if (!sourceBuffer || sourceBuffer.length === 0) {
        log.warn(`[ImageCache] setCache called with empty or invalid sourceBuffer for key: ${libraryId}_${imageName}. Aborting.`);
        return; // Or throw error? For now, just return.
    }
    stats.originalSize += sourceBuffer.length; // 记录原始大小

    let writeStartTime, writeEndTime;
    let processedBuffer = sourceBuffer; // 默认使用原始 Buffer
    let formatUsed = 'Original'; // 默认格式
    // const preferredFormat = configService.get('imageCache.preferredFormat', 'Original'); // 使用传入的参数，移除对 configService 的调用

    try {
        await ensureCacheDirExists(); // 确保目录存在

        if (preferredFormat !== 'Original') {
            // 只有在需要转换格式时才使用 sharp
            let sharpStartTime, sharpEndTime;
            log.debug(`[ImageCache] Starting sharp processing for ${libraryId}_${imageName} to format: ${preferredFormat}`);
            sharpStartTime = Date.now();
            try {
                const sharpInstance = sharp(sourceBuffer)
                    .rotate() // 自动旋转（基于 EXIF）
                    .resize(1024, 1024, { // 调整大小
                        fit: 'inside',
                        withoutEnlargement: true
                    });

                switch (preferredFormat.toLowerCase()) {
                    case 'jpeg':
                    case 'jpg':
                        processedBuffer = await sharpInstance
                            .jpeg({ quality: config.compressQuality, progressive: true })
                            .toBuffer();
                        formatUsed = 'JPEG';
                        break;
                    case 'png':
                        processedBuffer = await sharpInstance
                            .png({ quality: config.compressQuality }) // sharp 的 png quality 范围不同，可能需要调整
                            .toBuffer();
                        formatUsed = 'PNG';
                        break;
                    case 'webp':
                        processedBuffer = await sharpInstance
                            .webp({ quality: config.compressQuality })
                            .toBuffer();
                        formatUsed = 'WebP';
                        break;
                    default:
                        log.warn(`[ImageCache] Unsupported preferredFormat: ${preferredFormat}. Falling back to Original.`);
                        processedBuffer = sourceBuffer; // 格式不支持，回退到原始格式
                        formatUsed = 'Original';
                        break;
                }
                sharpEndTime = Date.now();
                if (formatUsed !== 'Original') {
                    log.info(`[ImageCache] Sharp processing SUCCESS for ${libraryId}_${imageName}. Format: ${formatUsed}, Quality: ${config.compressQuality}. Duration: ${sharpEndTime - sharpStartTime}ms. Processed size: ${processedBuffer.length}`);
                } else {
                     log.info(`[ImageCache] Using Original format for ${libraryId}_${imageName}.`);
                }

            } catch (sharpError) {
                sharpEndTime = Date.now();
                log.error(`[ImageCache] Sharp processing FAILED for ${libraryId}_${imageName} to format ${preferredFormat}. Duration: ${sharpEndTime - sharpStartTime}ms. Falling back to Original.`, sharpError.message, sharpError.stack);
                // 转换失败，使用原始 Buffer
                processedBuffer = sourceBuffer;
                formatUsed = 'Original (Fallback)';
                // 不再抛出错误，而是尝试保存原始文件
                // throw sharpError;
            }
        } else {
             log.info(`[ImageCache] Preferred format is Original, skipping sharp processing for ${libraryId}_${imageName}.`);
        }


        // 写入 Buffer (可能是原始的，也可能是处理过的) 到缓存文件
        log.debug(`[ImageCache] Attempting fs.promises.writeFile to: ${cacheFilePath} (Format: ${formatUsed})`);
        writeStartTime = Date.now();
        await fs.promises.writeFile(cacheFilePath, processedBuffer);
        writeEndTime = Date.now();
        log.info(`[ImageCache] fs.promises.writeFile SUCCESS for: ${cacheFilePath}. Duration: ${writeEndTime - writeStartTime}ms`);
        stats.compressedSize += processedBuffer.length; // 记录压缩后大小

        const totalDuration = Date.now() - startTime;
        log.info(`[ImageCache] Image processed and cached successfully: ${libraryId}_${imageName} -> ${path.basename(cacheFilePath)}. Size: ${(sourceBuffer.length / 1024).toFixed(1)}KB -> ${(processedBuffer.length / 1024).toFixed(1)}KB. Total Duration: ${totalDuration}ms`);
        log.debug(`[ImageCache] <<< setCache END (Success) for key: ${libraryId}_${imageName}`);

        // 检查并清理缓存 (异步，不阻塞)
        checkAndCleanCache().catch(cleanError => {
            log.error(`[ImageCache] Background cache cleanup failed:`, cleanError.message, cleanError.stack);
        });

    } catch (error) {
        const totalDuration = Date.now() - startTime;
        log.error(`[ImageCache] FAILED to process or write cache for key ${libraryId}_${imageName} to ${cacheFilePath}. Total Duration: ${totalDuration}ms`, error.message, error.stack);
        // 尝试删除可能不完整的缓存文件
        try {
            log.warn(`[ImageCache] Attempting to delete potentially incomplete cache file: ${cacheFilePath}`);
            await fs.promises.unlink(cacheFilePath);
            log.warn(`[ImageCache] Successfully deleted potentially incomplete cache file: ${cacheFilePath}`);
        } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') { // Don't warn if file doesn't exist
                log.warn(`[ImageCache] Failed to delete potentially incomplete cache file: ${cacheFilePath}`, unlinkError.message);
            }
        }
        log.debug(`[ImageCache] <<< setCache END (Failure) for key: ${libraryId}_${imageName}`);
        // 重新抛出错误，让 imageService 知道缓存失败
        throw error;
    }
}


/**
 * 清理全部图片缓存
 * @returns {Promise<void>}
 */
async function clearCache() {
    if (fs.existsSync(config.cacheDir)) {
        const files = await fs.promises.readdir(config.cacheDir);
        await Promise.all(files.map(file =>
            fs.promises.unlink(path.join(config.cacheDir, file))
        ));
    }
    stats.cacheHits = 0;
    stats.totalRequests = 0;
    stats.originalSize = 0;
    stats.compressedSize = 0;
}

/**
 * 检查并清理超出最大空间的缓存（LRU）
 * @returns {Promise<void>}
 */
async function checkAndCleanCache() {
    try {
        await fs.promises.access(config.cacheDir); // Check if cache dir exists
    } catch (error) {
        if (error.code === 'ENOENT') {
            return; // Directory doesn't exist, nothing to clean
        }
        console.error(`[ImageCache] 无法访问缓存目录进行清理: ${error.message}`);
        return; // Cannot proceed
    }

    // 1. 统计缓存目录大小 (Asynchronously)
    let files = [];
    try {
        const fileNames = await fs.promises.readdir(config.cacheDir);
        for (const fileName of fileNames) {
            const filePath = path.join(config.cacheDir, fileName);
            try {
                const fileStats = await fs.promises.stat(filePath);
                files.push({
                    path: filePath,
                    size: fileStats.size,
                    atime: fileStats.atimeMs, // Access time
                    mtime: fileStats.mtimeMs // Modification time
                });
            } catch (statError) {
                // Handle error if stat fails (e.g., file deleted concurrently)
                if (statError.code !== 'ENOENT') {
                    console.warn(`[ImageCache] 无法获取文件状态 ${filePath}:`, statError);
                }
                // Skip this file
            }
        }
    } catch (readdirError) {
        console.error(`[ImageCache] 读取缓存目录失败: ${readdirError.message}`);
        return; // Cannot proceed
    }


    const totalSizeMB = files.reduce((sum, file) => sum + file.size, 0) / (1024 * 1024);
    if (totalSizeMB <= config.maxCacheSizeMB) return;

    // 2. 按修改时间排序 (最旧的在前)
    files.sort((a, b) => a.mtime - b.mtime); // 使用 mtime 替代 atime

    // 3. 清理最旧的文件直到满足大小限制
    let removedSize = 0;
    const targetSizeMB = config.maxCacheSizeMB * 0.9; // 清理到90%容量
    for (const file of files) {
        if (totalSizeMB - removedSize <= targetSizeMB) break;
        try {
            await fs.promises.unlink(file.path); // Use async unlink
            removedSize += file.size / (1024 * 1024);
        } catch (unlinkError) {
             if (unlinkError.code !== 'ENOENT') { // Don't log error if file already gone
                console.error(`删除缓存文件失败: ${file.path}`, unlinkError);
             }
        }
    }

    stats.lastCleanTime = new Date();
    const logMsg = `[ImageCache] 缓存清理完成: 原大小 ${totalSizeMB.toFixed(2)}MB, 清理了 ${removedSize.toFixed(2)}MB`;
    if (config.debug) console.log(logMsg);

    // 添加统计方法
    module.exports.getStats = () => ({
        ...stats,
        cacheHitRate: stats.totalRequests > 0 ? (stats.cacheHits / stats.totalRequests * 100).toFixed(1) + '%' : '0%',
        spaceSaved: stats.originalSize > 0 ? (1 - stats.compressedSize/stats.originalSize) * 100 : 0
    });
}

module.exports = {
    setConfig,
    getCache, // 新增
    setCache, // 新增
    clearCache,
    checkAndCleanCache,
    config,
    getStats: () => ({ // 确保 getStats 导出
        ...stats,
        cacheHitRate: stats.totalRequests > 0 ? (stats.cacheHits / stats.totalRequests * 100).toFixed(1) + '%' : '0%',
        spaceSaved: stats.originalSize > 0 && stats.compressedSize > 0 ? ((1 - stats.compressedSize / stats.originalSize) * 100).toFixed(1) + '%' : '0%',
        // currentCacheSizeMB: getCurrentCacheSizeMB() // 不再在这里调用，避免潜在的性能问题
    }),
    getCurrentCacheSizeMB // 直接导出函数
};

// 辅助函数：获取当前缓存目录大小 (可选)
// 注意：这个函数可能比较耗时，谨慎使用
async function getCurrentCacheSizeMB() {
    try {
        await fs.promises.access(config.cacheDir);
        const fileNames = await fs.promises.readdir(config.cacheDir);
        let totalSize = 0;
        for (const fileName of fileNames) {
            const filePath = path.join(config.cacheDir, fileName);
            try {
                const fileStats = await fs.promises.stat(filePath);
                totalSize += fileStats.size;
            } catch (statError) {
                 if (statError.code !== 'ENOENT') {
                    log.warn(`[ImageCache] 获取文件状态失败 (getCurrentCacheSizeMB): ${filePath}`, statError.message);
                 }
            }
        }
        return (totalSize / (1024 * 1024)).toFixed(2);
    } catch (error) {
        if (error.code === 'ENOENT') return '0.00';
        log.error(`[ImageCache] 获取当前缓存大小时出错:`, error.message);
        return 'Error';
    }
}