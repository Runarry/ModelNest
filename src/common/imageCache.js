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

/**
 * 获取压缩后图片（如有缓存则直接返回缓存路径，否则压缩原图并缓存）
 * @param {string} srcPath 原始图片路径（本地或 WebDAV 下载到本地的临时路径）
 * @returns {Promise<string>} 压缩后图片的本地缓存路径
 */

async function getCompressedImage(srcPath, hashKey) {
    const startTime = Date.now();
    log.info(`[ImageCache] 开始处理图片: ${srcPath}, hashKey: ${hashKey || '无'}`);
    if (hashKey && config.debug) log.debug(`[ImageCache] 使用外部hashKey: ${hashKey}`);
    stats.totalRequests++;

    // 1. 确保缓存目录存在
    try {
        await fs.promises.access(config.cacheDir);
        log.debug(`[ImageCache] 缓存目录存在: ${config.cacheDir}`);
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
            // Handle other access errors (e.g., permissions)
            log.error(`[ImageCache] 访问缓存目录失败: ${config.cacheDir}`, error.message, error.stack);
            throw error;
        }
    }
    // 2. 生成唯一缓存文件名
    const hash = hashKey
        ? crypto.createHash('md5').update(hashKey).digest('hex')
        : crypto.createHash('md5').update(srcPath + JSON.stringify(config)).digest('hex');
    const ext = config.compressFormat === 'webp' ? '.webp' : '.jpg';
    const cachePath = path.join(config.cacheDir, hash + ext);

    // 3. 检查缓存是否存在并更新访问时间
    log.debug(`[ImageCache] 检查缓存文件: ${cachePath}`);
    try {
        await fs.promises.access(cachePath); // Check if file exists and is accessible
        log.debug(`[ImageCache] 缓存文件存在，更新访问时间: ${cachePath}`);
        // Update access time asynchronously
        await fs.promises.utimes(cachePath, new Date(), new Date());
        stats.cacheHits++;
        const duration = Date.now() - startTime;
        log.info(`[ImageCache] 缓存命中: ${path.basename(srcPath)} -> ${path.basename(cachePath)}, 耗时: ${duration}ms`);
        return cachePath; // Return cached path
    } catch (error) {
        if (error.code === 'ENOENT') {
            log.debug(`[ImageCache] 缓存未命中: ${cachePath}`);
        } else {
            // Log errors other than 'file not found'
            log.warn(`[ImageCache] 缓存检查或更新时间时出错: ${cachePath}`, error.message, error.stack);
            // Decide if we should proceed or re-throw. For now, proceed to compression.
        }
        // If file doesn't exist (ENOENT) or other error occurred, proceed to compression.
    }

    // 4. 压缩图片并写入缓存

    log.info(`[ImageCache] 开始压缩图片: ${srcPath} -> ${cachePath}`);
    try {
        // Get source file stats asynchronously
        const srcStats = await fs.promises.stat(srcPath);
        stats.originalSize += srcStats.size;
        log.debug(`[ImageCache] 源文件大小: ${(srcStats.size / 1024).toFixed(1)} KB`);

        const sharpInstance = sharp(srcPath)
            .rotate()
            .resize(1024, 1024, {
                fit: 'inside',
                withoutEnlargement: true
            });

        if (config.compressFormat === 'webp') {
            await sharpInstance
                .webp({ quality: config.compressQuality })
                .toFile(cachePath);
        } else {
            await sharpInstance
                .jpeg({ quality: config.compressQuality })
                .toFile(cachePath);
        }
// 使用更可靠的文件存在检查
const MAX_RETRY = 3;
let retryCount = 0;
        // Asynchronously check if file exists after writing
        let writeSuccess = false;
        while (retryCount++ < MAX_RETRY) {
            try {
                await fs.promises.access(cachePath); // Check existence
                writeSuccess = true;
                log.debug(`[ImageCache] 缓存文件写入成功确认: ${cachePath}`);
                break;
            } catch (accessError) {
                if (accessError.code !== 'ENOENT') {
                    log.warn(`[ImageCache] 检查缓存文件时出错 (重试 ${retryCount}): ${cachePath}`, accessError.message);
                } else {
                    log.warn(`[ImageCache] 缓存文件写入后未找到 (重试 ${retryCount}): ${cachePath}`);
                }
                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        if (!writeSuccess) {
            log.error(`[ImageCache] 缓存文件写入失败或无法访问: ${cachePath}`);
            // Attempt to remove potentially corrupted file
            try { await fs.promises.unlink(cachePath); } catch (unlinkErr) { /* Ignore */ }
            throw new Error(`CACHE_WRITE_FAILED: ${cachePath}`);
        }

        // Get destination file stats asynchronously
        const destStats = await fs.promises.stat(cachePath);
        stats.compressedSize += destStats.size;
        const duration = Date.now() - startTime;
        log.info(`[ImageCache] 图片压缩完成: ${path.basename(srcPath)} -> ${path.basename(cachePath)}, 大小: ${(srcStats.size / 1024).toFixed(1)}KB -> ${(destStats.size / 1024).toFixed(1)}KB, 耗时: ${duration}ms`);


        // 5. 检查缓存空间
        await checkAndCleanCache();

        return cachePath;
    } catch (e) {
        const duration = Date.now() - startTime;
        log.error(`[ImageCache] 图片压缩失败: ${srcPath}, 耗时: ${duration}ms`, e.message, e.stack);
        return srcPath; // 降级为原图
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
    getCompressedImage,
    clearCache,
    checkAndCleanCache,
    config,
};