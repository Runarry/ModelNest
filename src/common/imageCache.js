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

// MIME 类型与扩展名映射
const mimeToExt = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    // 可以根据需要添加更多类型
};

const extToMime = Object.fromEntries(Object.entries(mimeToExt).map(([mime, ext]) => [ext, mime]));

const defaultExt = '.bin'; // 未知或不支持的类型的默认扩展名

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
    // return path.join(cacheDirWithSub, hash);
    // 返回不带扩展名的基础路径，扩展名将在 setCache 和 getCache 中处理
    return path.join(config.cacheDir, hash);
}

// 移除 getCacheMetaFilePath 函数

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
 * 从缓存中获取图片 Buffer，通过文件扩展名推断 MIME 类型
 * @param {string} libraryId 库 ID
 * @param {string} imageName 图片名称
 * @returns {Promise<{data: Buffer, mimeType: string | null} | null>} 包含 Buffer 和 mimeType 的对象，或 null
 */
async function getCache(libraryId, imageName) {
    const startTime = Date.now();
    stats.totalRequests++;
    const baseCachePath = getCacheFilePath(libraryId, imageName); // 获取不带扩展名的基础路径
    const baseName = path.basename(baseCachePath);
    log.debug(`[ImageCache] >>> getCache START for key: ${libraryId}_${imageName}. Base path: ${baseCachePath}`);

    try {
        await ensureCacheDirExists(); // 确保目录存在

        // 读取缓存目录查找匹配的文件
        const files = await fs.promises.readdir(config.cacheDir);
        const matchingFiles = files.filter(f => f.startsWith(baseName));

        if (matchingFiles.length === 0) {
            log.info(`[ImageCache] Cache MISS: No file found starting with ${baseName} for key ${libraryId}_${imageName}`);
            const duration = Date.now() - startTime;
            log.debug(`[ImageCache] <<< getCache END (Miss) for key: ${libraryId}_${imageName}. Duration: ${duration}ms`);
            return null;
        }

        // 通常应该只有一个匹配项，但以防万一，取第一个
        const foundFileName = matchingFiles[0];
        const foundFilePath = path.join(config.cacheDir, foundFileName);
        log.debug(`[ImageCache] Found matching cache file: ${foundFilePath}`);

        // 读取找到的缓存文件
        const cacheBuffer = await fs.promises.readFile(foundFilePath);
        log.info(`[ImageCache] fs.promises.readFile SUCCESS for: ${foundFilePath}. Buffer size: ${cacheBuffer.length}`);

        // 从扩展名推断 MIME 类型
        const extension = path.extname(foundFileName).toLowerCase();
        const mimeType = extToMime[extension] || null; // 如果扩展名不在映射中，则为 null
        log.info(`[ImageCache] Inferred MimeType from extension '${extension}': ${mimeType}`);

        // 更新访问时间 (异步，不阻塞返回) - 只更新找到的数据文件
        const updateTime = new Date();
        fs.promises.utimes(foundFilePath, updateTime, updateTime).catch(utimeError => {
            log.warn(`[ImageCache] Failed to update access time for cache file: ${foundFilePath}`, utimeError.message);
        });

        stats.cacheHits++;
        const duration = Date.now() - startTime;
        log.info(`[ImageCache] Cache HIT for: ${libraryId}_${imageName}. Path: ${foundFileName}, Size: ${(cacheBuffer.length / 1024).toFixed(1)}KB, MimeType: ${mimeType}. Duration: ${duration}ms`);
        log.debug(`[ImageCache] <<< getCache END (Hit) for key: ${libraryId}_${imageName}`);
        return { data: cacheBuffer, mimeType: mimeType }; // 返回包含 Buffer 和推断出的 mimeType 的对象

    } catch (error) {
        // 处理读取目录或文件时的错误
        log.error(`[ImageCache] Error during getCache for key ${libraryId}_${imageName} (base path: ${baseCachePath})`, error.message, error.stack);
        const duration = Date.now() - startTime;
        log.debug(`[ImageCache] <<< getCache END (Error) for key: ${libraryId}_${imageName}. Duration: ${duration}ms`);
        return null; // 发生错误，返回 null
    }
}

/**
 * 将图片 Buffer 处理后存入缓存，文件名包含基于 MIME 类型的扩展名
 * @param {string} libraryId 库 ID
 * @param {string} imageName 图片名称
 * @param {Buffer} sourceBuffer 原始图片 Buffer
 * @param {string} preferredFormat 期望的缓存格式 ('JPEG', 'PNG', 'WebP', 'Original')
 * @param {string | null} originalMimeType 原始图片的 MIME 类型 (必须提供以确定原始扩展名)
 * @returns {Promise<{data: Buffer, mimeType: string} | null>} 包含处理后的 Buffer 和 mimeType 的对象，或在失败时返回 null
 */
async function setCache(libraryId, imageName, sourceBuffer, preferredFormat = 'Original', originalMimeType = null) {
    const startTime = Date.now();
    const baseCachePath = getCacheFilePath(libraryId, imageName); // 获取不带扩展名的基础路径
    log.info(`[ImageCache] >>> setCache START for key: ${libraryId}_${imageName}. Base path: ${baseCachePath}. Source buffer size: ${sourceBuffer ? sourceBuffer.length : 'null/undefined'}. Preferred format: ${preferredFormat}. Original MimeType: ${originalMimeType}`);

    if (!sourceBuffer || sourceBuffer.length === 0) {
        log.warn(`[ImageCache] setCache called with empty or invalid sourceBuffer for key: ${libraryId}_${imageName}. Aborting.`);
        return null; // Return null on invalid input
    }
    stats.originalSize += sourceBuffer.length; // 记录原始大小

    let writeStartTime, writeEndTime;
    let processedBuffer = sourceBuffer; // 默认使用原始 Buffer
    let formatUsed = 'Original'; // 默认格式
    let finalMimeType = originalMimeType; // 最终写入元数据的 MIME 类型

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
                        finalMimeType = 'image/jpeg'; // 更新 MIME 类型
                        break;
                    case 'png':
                        processedBuffer = await sharpInstance
                            .png({ quality: config.compressQuality }) // sharp 的 png quality 范围不同，可能需要调整
                            .toBuffer();
                        formatUsed = 'PNG';
                        finalMimeType = 'image/png'; // 更新 MIME 类型
                        break;
                    case 'webp':
                        processedBuffer = await sharpInstance
                            .webp({ quality: config.compressQuality })
                            .toBuffer();
                        formatUsed = 'WebP';
                        finalMimeType = 'image/webp'; // 更新 MIME 类型
                        break;
                    default:
                        log.warn(`[ImageCache] Unsupported preferredFormat: ${preferredFormat}. Falling back to Original.`);
                        processedBuffer = sourceBuffer; // 格式不支持，回退到原始格式
                        formatUsed = 'Original';
                        finalMimeType = originalMimeType; // 保持原始 MIME 类型
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
                finalMimeType = originalMimeType; // 保持原始 MIME 类型
                // 不再抛出错误，而是尝试保存原始文件
                // throw sharpError;
            }
        } else {
             log.info(`[ImageCache] Preferred format is Original, skipping sharp processing for ${libraryId}_${imageName}.`);
             finalMimeType = originalMimeType; // 确认使用原始 MIME 类型
             // If preferred format is Original, we don't cache, just return the original buffer
             const totalDuration = Date.now() - startTime;
             log.info(`[ImageCache] Returning original buffer as preferred format is Original for ${libraryId}_${imageName}. Total Duration: ${totalDuration}ms`);
             log.debug(`[ImageCache] <<< setCache END (Original) for key: ${libraryId}_${imageName}`);
             return { data: processedBuffer, mimeType: finalMimeType || 'application/octet-stream' };
        }


        // 确定最终的文件扩展名
        const finalExtension = mimeToExt[finalMimeType] || defaultExt;
        const finalCachePath = baseCachePath + finalExtension; // 拼接完整路径

        // 在写入前，删除可能存在的同名但不同扩展名的旧缓存文件
        try {
            const files = await fs.promises.readdir(config.cacheDir);
            const baseName = path.basename(baseCachePath);
            const oldFiles = files.filter(f => f.startsWith(baseName) && path.join(config.cacheDir, f) !== finalCachePath);
            for (const oldFile of oldFiles) {
                const oldFilePath = path.join(config.cacheDir, oldFile);
                log.warn(`[ImageCache] Deleting old cache file with different extension: ${oldFilePath}`);
                await fs.promises.unlink(oldFilePath);
            }
        } catch (readdirError) {
             log.warn(`[ImageCache] Error reading cache directory while checking for old files:`, readdirError.message);
             // 继续尝试写入
        }

        // 写入 Buffer 到带扩展名的缓存文件
        log.debug(`[ImageCache] Attempting fs.promises.writeFile to: ${finalCachePath} (Format: ${formatUsed}, Mime: ${finalMimeType})`);
        writeStartTime = Date.now();
        await fs.promises.writeFile(finalCachePath, processedBuffer);
        writeEndTime = Date.now();
        log.info(`[ImageCache] fs.promises.writeFile SUCCESS for: ${finalCachePath}. Duration: ${writeEndTime - writeStartTime}ms`);
        stats.compressedSize += processedBuffer.length; // 记录压缩后大小

        // 移除写入元数据文件的逻辑

        const totalDuration = Date.now() - startTime;
        log.info(`[ImageCache] Image processed and cached successfully: ${libraryId}_${imageName} -> ${path.basename(finalCachePath)}. Size: ${(sourceBuffer.length / 1024).toFixed(1)}KB -> ${(processedBuffer.length / 1024).toFixed(1)}KB. MimeType: ${finalMimeType}. Total Duration: ${totalDuration}ms`);
        log.debug(`[ImageCache] <<< setCache END (Success) for key: ${libraryId}_${imageName}`);

        // 检查并清理缓存 (异步，不阻塞) - 清理逻辑也需要调整
        checkAndCleanCache().catch(cleanError => {
            log.error(`[ImageCache] Background cache cleanup failed:`, cleanError.message, cleanError.stack);
        });

        // Return the processed buffer and mime type
        return { data: processedBuffer, mimeType: finalMimeType || 'application/octet-stream' };

    } catch (error) {
        const totalDuration = Date.now() - startTime;
        log.error(`[ImageCache] FAILED to process or write cache for key ${libraryId}_${imageName} to ${baseCachePath}. Total Duration: ${totalDuration}ms`, error.message, error.stack); // Use baseCachePath here as finalCachePath might not be defined
        // Attempt to delete potentially incomplete cache file (now with extension)
        // Since old files are attempted to be deleted before writing, this mainly handles interruptions during writing
        // finalCachePath might be undefined if the error occurs before determining the extension, but this is rare
        // Determine finalCachePath again in case it wasn't set
        const finalExtension = mimeToExt[finalMimeType] || defaultExt;
        const finalCachePath = baseCachePath + finalExtension;

        if (finalCachePath) {
            try {
                log.warn(`[ImageCache] Attempting to delete potentially incomplete cache file: ${finalCachePath}`);
                await fs.promises.unlink(finalCachePath);
                log.warn(`[ImageCache] Successfully deleted potentially incomplete cache file: ${finalCachePath}`);
            } catch (unlinkError) {
                if (unlinkError.code !== 'ENOENT') { // Don't warn if file doesn't exist
                    log.warn(`[ImageCache] Failed to delete potentially incomplete cache file: ${finalCachePath}`, unlinkError.message);
                }
            }
        } else {
             log.warn(`[ImageCache] Cannot determine finalCachePath to delete on failure for key ${libraryId}_${imageName}.`);
        }
        // Remove attempt to delete meta file
        log.debug(`[ImageCache] <<< setCache END (Failure) for key: ${libraryId}_${imageName}`);
        // Do not re-throw the error, return null instead as per the new return type
        return null;
    }
}


/**
 * 清理全部图片缓存
 * @returns {Promise<void>}
 */
async function clearCache() {
    if (fs.existsSync(config.cacheDir)) {
        log.info(`[ImageCache] Clearing all cache files in ${config.cacheDir}`);
        const files = await fs.promises.readdir(config.cacheDir);
        const unlinkPromises = files.map(file => {
            const filePath = path.join(config.cacheDir, file);
            log.debug(`[ImageCache] Deleting cache file: ${filePath}`);
            return fs.promises.unlink(filePath).catch(err => {
                 // Log error but continue deleting others
                 log.error(`[ImageCache] Failed to delete file during clearCache: ${filePath}`, err.message);
            });
        });
        await Promise.all(unlinkPromises);
        log.info(`[ImageCache] Cache clear complete. Deleted ${files.length} items.`);
    } else {
        log.info(`[ImageCache] Cache directory ${config.cacheDir} does not exist, nothing to clear.`);
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
                    // 移除 isMeta 标记
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


    // 计算所有文件的总大小
    const totalCacheSizeMB = files.reduce((sum, file) => sum + file.size, 0) / (1024 * 1024);
    log.info(`[ImageCache] Checking cache size. Current total size: ${totalCacheSizeMB.toFixed(2)}MB. Max allowed: ${config.maxCacheSizeMB}MB.`);

    if (totalCacheSizeMB <= config.maxCacheSizeMB) {
        log.debug(`[ImageCache] Cache size within limit. No cleanup needed.`);
        return;
    }

    // 2. 按修改时间排序 (最旧的在前)
    files.sort((a, b) => a.mtime - b.mtime);

    // 3. 清理最旧的文件直到满足大小限制
    let currentSizeMB = totalCacheSizeMB;
    let removedSizeMB = 0;
    let removedFilesCount = 0;
    const targetSizeMB = config.maxCacheSizeMB * 0.9; // 清理到90%容量
    log.info(`[ImageCache] Cache size exceeds limit. Starting cleanup. Target size: ${targetSizeMB.toFixed(2)}MB.`);

    for (const file of files) {
        if (currentSizeMB <= targetSizeMB) break; // 达到目标大小，停止清理

        // 直接删除文件，不再区分数据和元数据
        const filePath = file.path;

        try {
            log.debug(`[ImageCache] Cleaning up cache file: ${filePath} (Size: ${(file.size / 1024).toFixed(1)}KB, Modified: ${new Date(file.mtime).toISOString()})`);
            await fs.promises.unlink(filePath); // 删除文件
            removedSizeMB += file.size / (1024 * 1024);
            currentSizeMB -= file.size / (1024 * 1024);
            removedFilesCount++;
            // 移除删除对应 meta 文件的逻辑
        } catch (unlinkError) {
             if (unlinkError.code !== 'ENOENT') { // Don't log error if file already gone
                log.error(`[ImageCache] Failed to delete cache file during cleanup: ${filePath}`, unlinkError.message);
             }
             // 如果删除失败，我们可能无法准确减少 currentSizeMB，但这应该很少见
        }
    }

    stats.lastCleanTime = new Date();
    const logMsg = `[ImageCache] Cache cleanup finished. Original total size: ${totalCacheSizeMB.toFixed(2)}MB. Removed ${removedFilesCount} files, freeing approx ${removedSizeMB.toFixed(2)}MB. Current total size: ${currentSizeMB.toFixed(2)}MB.`;
    log.info(logMsg); // Use info level for cleanup summary

    // 统计方法保持不变
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
    getCurrentCacheSizeBytes // 导出新函数名
};

// 辅助函数：获取当前缓存目录大小 (可选)
// 注意：这个函数可能比较耗时，谨慎使用
/**
 * 获取当前缓存目录的总大小（字节）
 * @returns {Promise<number>} 缓存总大小（字节），如果目录不存在或出错则返回 0
 */
async function getCurrentCacheSizeBytes() {
    let totalSize = 0;
    try {
        // 尝试访问，如果不存在会抛出 ENOENT
        await fs.promises.access(config.cacheDir);
        const fileNames = await fs.promises.readdir(config.cacheDir, { withFileTypes: true }); // 使用 withFileTypes 提高效率

        for (const dirent of fileNames) {
            // 只计算文件大小，忽略子目录（虽然此缓存设计中不应有子目录）
            if (dirent.isFile()) {
                const filePath = path.join(config.cacheDir, dirent.name);
                try {
                    const fileStats = await fs.promises.stat(filePath);
                    totalSize += fileStats.size;
                } catch (statError) {
                    // 如果文件在读取目录和获取状态之间被删除，则忽略
                    if (statError.code !== 'ENOENT') {
                        log.warn(`[ImageCache] 获取文件状态失败 (getCurrentCacheSizeBytes): ${filePath}`, statError.message);
                    }
                }
            }
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            log.info(`[ImageCache] 缓存目录不存在，大小计为 0: ${config.cacheDir}`);
            // 目录不存在，大小为 0，不是错误
        } else {
            log.error(`[ImageCache] 获取当前缓存大小时出错: ${config.cacheDir}`, error.message);
            // 其他错误，返回 0 并记录日志
        }
        return 0; // 返回数字 0 而不是字符串 'Error' 或 '0.00'
    }
    return totalSize; // 返回总字节数
}