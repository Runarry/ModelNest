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

// 默认配置
const defaultConfig = {
    cacheDir: path.join(process.cwd(), 'cache', 'images'),
    maxCacheSizeMB: 500,
    compressQuality: 80, // 0-100
    compressFormat: 'jpeg', // jpeg/webp
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
    log.debug(`[ImageCache] getCache: 尝试获取缓存 for ${libraryId}_${imageName} at ${cacheFilePath}`);

    try {
        await ensureCacheDirExists(); // 确保目录存在
        const cacheBuffer = await fs.promises.readFile(cacheFilePath);
        // 更新访问时间 (异步，不阻塞返回)
        fs.promises.utimes(cacheFilePath, new Date(), new Date()).catch(utimeError => {
            log.warn(`[ImageCache] 更新缓存文件访问时间失败: ${cacheFilePath}`, utimeError.message);
        });
        stats.cacheHits++;
        const duration = Date.now() - startTime;
        log.info(`[ImageCache] 缓存命中: ${libraryId}_${imageName} -> ${path.basename(cacheFilePath)}, 大小: ${(cacheBuffer.length / 1024).toFixed(1)}KB, 耗时: ${duration}ms`);
        return cacheBuffer;
    } catch (error) {
        if (error.code === 'ENOENT') {
            log.debug(`[ImageCache] 缓存未命中: ${libraryId}_${imageName} (${cacheFilePath})`);
        } else {
            log.warn(`[ImageCache] 读取缓存文件时出错: ${cacheFilePath}`, error.message, error.stack);
        }
        return null; // 文件不存在或读取错误，返回 null
    }
}

/**
 * 将图片 Buffer 处理后存入缓存
 * @param {string} libraryId 库 ID
 * @param {string} imageName 图片名称
 * @param {Buffer} sourceBuffer 原始图片 Buffer
 * @returns {Promise<void>}
 */
async function setCache(libraryId, imageName, sourceBuffer) {
    const startTime = Date.now();
    const cacheFilePath = getCacheFilePath(libraryId, imageName);
    log.info(`[ImageCache] setCache: 开始处理并缓存图片 for ${libraryId}_${imageName} to ${cacheFilePath}`);
    stats.originalSize += sourceBuffer.length; // 记录原始大小

    try {
        await ensureCacheDirExists(); // 确保目录存在

        // 使用 sharp 处理图片：调整大小、转换格式、压缩
        const sharpInstance = sharp(sourceBuffer)
            .rotate() // 自动旋转（基于 EXIF）
            .resize(1024, 1024, { // 调整大小，例如最大 1024x1024
                fit: 'inside', // 保持比例，完整放入
                withoutEnlargement: true // 不放大图片
            });

        let processedBuffer;
        if (config.compressFormat === 'webp') {
            processedBuffer = await sharpInstance
                .webp({ quality: config.compressQuality })
                .toBuffer();
        } else { // 默认 jpeg
            processedBuffer = await sharpInstance
                .jpeg({ quality: config.compressQuality, progressive: true }) // 使用 progressive jpeg
                .toBuffer();
        }

        // 写入处理后的 Buffer 到缓存文件
        await fs.promises.writeFile(cacheFilePath, processedBuffer);
        stats.compressedSize += processedBuffer.length; // 记录压缩后大小

        const duration = Date.now() - startTime;
        log.info(`[ImageCache] 图片处理并缓存成功: ${libraryId}_${imageName} -> ${path.basename(cacheFilePath)}, 大小: ${(sourceBuffer.length / 1024).toFixed(1)}KB -> ${(processedBuffer.length / 1024).toFixed(1)}KB, 耗时: ${duration}ms`);

        // 检查并清理缓存 (异步，不阻塞)
        checkAndCleanCache().catch(cleanError => {
            log.error(`[ImageCache] 后台缓存清理失败:`, cleanError.message, cleanError.stack);
        });

    } catch (error) {
        const duration = Date.now() - startTime;
        log.error(`[ImageCache] 处理或写入缓存失败 for ${libraryId}_${imageName} to ${cacheFilePath}, 耗时: ${duration}ms`, error.message, error.stack);
        // 尝试删除可能不完整的缓存文件
        try {
            await fs.promises.unlink(cacheFilePath);
        } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') {
                log.warn(`[ImageCache] 删除失败的缓存文件时出错: ${cacheFilePath}`, unlinkError.message);
            }
        }
        // 可以选择重新抛出错误，让调用者知道缓存失败
        // throw error;
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

    // 2. 按最久未用排序
    files.sort((a, b) => a.atime - b.atime);

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
        currentCacheSizeMB: getCurrentCacheSizeMB() // 添加获取当前缓存大小的函数（如果需要）
    })
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