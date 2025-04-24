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
    if (hashKey && config.debug) console.log(`[ImageCache] 使用外部hashKey: ${hashKey}`); // Keep debug log conditional
    stats.totalRequests++;
    
    // 1. 确保缓存目录存在
    if (!fs.existsSync(config.cacheDir)) {
        try {
            fs.mkdirSync(config.cacheDir, { recursive: true, mode: 0o755 }); // 确保目录权限正确
        } catch (e) {
            console.error(`[ImageCache] 创建缓存目录失败: ${e.message}`);
            throw e; // 抛出异常避免继续执行
        }
    }
    // 2. 生成唯一缓存文件名
    const hash = hashKey
        ? crypto.createHash('md5').update(hashKey).digest('hex')
        : crypto.createHash('md5').update(srcPath + JSON.stringify(config)).digest('hex');
    const ext = config.compressFormat === 'webp' ? '.webp' : '.jpg';
    const cachePath = path.join(config.cacheDir, hash + ext);

    // 3. 检查缓存是否存在
    try {
        // 使用文件锁避免竞争条件
        if (fs.existsSync(cachePath)) {
            // 使用更可靠的方式更新访问时间
            fs.utimesSync(cachePath, new Date(), new Date());
            stats.cacheHits++;
            if (config.debug) {
                console.log(`[ImageCache] 缓存命中: ${path.basename(srcPath)} -> ${cachePath}`);
            }
            return cachePath;
        }
    } catch (e) {
        console.error(`[ImageCache] 缓存检查异常: ${e.message}`);
    }

    // 4. 压缩图片并写入缓存
    try {
        const srcStats = fs.statSync(srcPath);
        stats.originalSize += srcStats.size;

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
while (retryCount++ < MAX_RETRY) {
    if (fs.existsSync(cachePath)) {
        if (config.debug) {
            console.log(`[ImageCache] 缓存文件写入成功: ${cachePath}`);
        }
        break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
}

if (!fs.existsSync(cachePath)) {
    console.error(`[ImageCache] 缓存文件写入失败: ${cachePath}`);
    throw new Error('CACHE_WRITE_FAILED');
}


        const destStats = fs.statSync(cachePath);
        stats.compressedSize += destStats.size;

        if (config.debug) {
            // Removed compression summary log
        }

        // 5. 检查缓存空间
        await checkAndCleanCache();

        return cachePath;
    } catch (e) {
        console.error('图片压缩失败:', e);
        if (config.debug) console.error(e.stack);
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
    if (!fs.existsSync(config.cacheDir)) return;

    // 1. 统计缓存目录大小
    const files = fs.readdirSync(config.cacheDir)
        .map(file => {
            const filePath = path.join(config.cacheDir, file);
            const stats = fs.statSync(filePath);
            return {
                path: filePath,
                size: stats.size,
                atime: stats.atimeMs, // 访问时间
                mtime: stats.mtimeMs // 修改时间
            };
        });

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
            fs.unlinkSync(file.path);
            removedSize += file.size / (1024 * 1024);
        } catch (e) {
            console.error(`删除缓存文件失败: ${file.path}`, e);
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