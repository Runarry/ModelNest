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
const Database = require('better-sqlite3'); // 替换为 better-sqlite3

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
    logStats: true, // 是否记录统计信息
    dbPath: path.join(process.cwd(), 'cache', 'cache_metadata.db') // 添加数据库路径
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
let db = null; // 数据库连接

/**
 * 初始化数据库连接和表结构
 * @returns {Database} 数据库连接
 */
function initDatabase() {
    if (db) return db; // 如果已经初始化，直接返回

    try {
        // 确保目录存在
        const dbDir = path.dirname(config.dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        // 打开数据库连接
        db = new Database(config.dbPath, { verbose: config.debug ? log.debug : null });
        log.info(`[ImageCache] Database opened: ${config.dbPath}`);

        // 设置性能PRAGMAs
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        log.info('[ImageCache] Applied PRAGMA settings: journal_mode=WAL, synchronous=NORMAL');

        // 创建图片缓存元数据表
        db.exec(`
            CREATE TABLE IF NOT EXISTS image_cache_metadata (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cache_key TEXT NOT NULL UNIQUE,
                library_id TEXT NOT NULL,
                image_path TEXT NOT NULL,
                file_path TEXT NOT NULL,
                mime_type TEXT,
                format TEXT,
                size_bytes INTEGER NOT NULL,
                original_size_bytes INTEGER,
                created_at INTEGER NOT NULL,
                last_accessed INTEGER NOT NULL,
                access_count INTEGER DEFAULT 0
            );
            
            CREATE INDEX IF NOT EXISTS idx_image_cache_key ON image_cache_metadata(cache_key);
            CREATE INDEX IF NOT EXISTS idx_image_cache_last_accessed ON image_cache_metadata(last_accessed);
        `);

        log.info('[ImageCache] Database tables initialized');
        return db;
    } catch (error) {
        log.error('[ImageCache] Database initialization error:', error.message, error.stack);
        throw error;
    }
}

/**
 * 设置图片缓存与压缩参数
 * @param {Object} options
 */
function setConfig(options = {}) {
    config = { ...config, ...options };
    
    // 初始化数据库
    try {
        initDatabase();
    } catch (err) {
        log.error('[ImageCache] Failed to initialize database during setConfig:', err.message);
    }
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
    // 使用hash的前两位创建子目录结构
    const subDir = hash.substring(0, 2);
    const cacheDirWithSub = path.join(config.cacheDir, subDir);
    // 返回不带扩展名的基础路径，扩展名将在 setCache 和 getCache 中处理
    return {
        fullPath: path.join(cacheDirWithSub, hash),
        hash: hash,
        subDir: subDir,
        cacheKey: cacheKey
    };
}

// 移除 getCacheMetaFilePath 函数

/**
 * 确保缓存目录存在
 * @param {string} subDir 子目录名（可选）
 * @returns {Promise<void>}
 */
async function ensureCacheDirExists(subDir = null) {
    try {
        const dirToCheck = subDir ? path.join(config.cacheDir, subDir) : config.cacheDir;
        
        await fs.promises.access(dirToCheck);
    } catch (error) {
        if (error.code === 'ENOENT') {
            log.info(`[ImageCache] 缓存目录不存在，尝试创建: ${subDir ? path.join(config.cacheDir, subDir) : config.cacheDir}`);
            try {
                await fs.promises.mkdir(subDir ? path.join(config.cacheDir, subDir) : config.cacheDir, { recursive: true, mode: 0o755 });
                log.info(`[ImageCache] 缓存目录已创建: ${subDir ? path.join(config.cacheDir, subDir) : config.cacheDir}`);
            } catch (mkdirError) {
                log.error(`[ImageCache] 创建缓存目录失败: ${subDir ? path.join(config.cacheDir, subDir) : config.cacheDir}`, mkdirError.message, mkdirError.stack);
                throw mkdirError; // Re-throw if mkdir fails
            }
        } else {
            log.error(`[ImageCache] 访问缓存目录失败: ${subDir ? path.join(config.cacheDir, subDir) : config.cacheDir}`, error.message, error.stack);
            throw error;
        }
    }
}


/**
 * 从缓存中获取图片 Buffer，通过元数据库查询所需信息
 * @param {string} libraryId 库 ID
 * @param {string} imageName 图片名称
 * @returns {Promise<{data: Buffer, mimeType: string | null} | null>} 包含 Buffer 和 mimeType 的对象，或 null
 */
async function getCache(libraryId, imageName) {
    const startTime = Date.now();
    stats.totalRequests++;
    
    // 生成缓存键和哈希
    const cacheInfo = getCacheFilePath(libraryId, imageName);
    const logPrefix = `[ImageCache ${cacheInfo.cacheKey}]`;
    
    log.debug(`${logPrefix} >>> getCache START`);

    try {
        // 1. 首先尝试通过元数据数据库查找
        const database = initDatabase();
        
        // 查询元数据
        const stmt = database.prepare('SELECT file_path, mime_type, access_count FROM image_cache_metadata WHERE cache_key = ?');
        const metadata = stmt.get(cacheInfo.cacheKey);

        if (!metadata) {
            log.info(`${logPrefix} Cache MISS: No metadata found in database`);
            return null;
        }

        // 2. 检查缓存文件是否存在
        try {
            // 读取缓存文件
            const cacheBuffer = await fs.promises.readFile(metadata.file_path);
            
            // 3. 更新访问时间和计数
            const updateTime = Date.now();
            const updateStmt = database.prepare(
                'UPDATE image_cache_metadata SET last_accessed = ?, access_count = access_count + 1 WHERE cache_key = ?'
            );
            updateStmt.run(updateTime, cacheInfo.cacheKey);

            stats.cacheHits++;
            const duration = Date.now() - startTime;
            log.info(`${logPrefix} Cache HIT. Size: ${(cacheBuffer.length / 1024).toFixed(1)}KB, MimeType: ${metadata.mime_type}, AccessCount: ${metadata.access_count+1}. Duration: ${duration}ms`);
            
            return { 
                data: cacheBuffer, 
                mimeType: metadata.mime_type || 'application/octet-stream'
            };
        } catch (fileError) {
            // 文件不存在或无法读取
            if (fileError.code === 'ENOENT') {
                log.warn(`${logPrefix} Cache inconsistency: metadata exists but file ${metadata.file_path} not found. Removing invalid entry.`);
                
                // 删除无效的元数据条目
                const deleteStmt = database.prepare('DELETE FROM image_cache_metadata WHERE cache_key = ?');
                deleteStmt.run(cacheInfo.cacheKey);
            } else {
                log.error(`${logPrefix} Error reading cache file: ${metadata.file_path}`, fileError.message);
            }
            return null;
        }
    } catch (error) {
        // 处理数据库或其他错误
        log.error(`${logPrefix} Error during getCache:`, error.message, error.stack);
        return null;
    } finally {
        const duration = Date.now() - startTime;
        log.debug(`${logPrefix} <<< getCache END. Duration: ${duration}ms`);
    }
}

/**
 * 将图片 Buffer 处理后存入缓存，并在数据库中记录元数据
 * @param {string} libraryId 库 ID
 * @param {string} imageName 图片名称
 * @param {Buffer} sourceBuffer 原始图片 Buffer
 * @param {string} preferredFormat 期望的缓存格式 ('JPEG', 'PNG', 'WebP', 'Original')
 * @param {string | null} originalMimeType 原始图片的 MIME 类型 (必须提供以确定原始扩展名)
 * @returns {Promise<{data: Buffer, mimeType: string} | null>} 包含处理后的 Buffer 和 mimeType 的对象，或在失败时返回 null
 */
async function setCache(libraryId, imageName, sourceBuffer, preferredFormat = 'Original', originalMimeType = null) {
    const startTime = Date.now();
    
    // 生成缓存键和路径信息
    const cacheInfo = getCacheFilePath(libraryId, imageName);
    const logPrefix = `[ImageCache ${cacheInfo.cacheKey}]`;
    
    log.debug(`${logPrefix} >>> setCache START. Source buffer size: ${sourceBuffer ? sourceBuffer.length : 'null/undefined'}. Preferred format: ${preferredFormat}`);

    if (!sourceBuffer || sourceBuffer.length === 0) {
        log.warn(`${logPrefix} Called with empty or invalid sourceBuffer. Aborting.`);
        return null; // Return null on invalid input
    }
    
    stats.originalSize += sourceBuffer.length; // 记录原始大小

    let processedBuffer = sourceBuffer; // 默认使用原始 Buffer
    let formatUsed = 'Original'; // 默认格式
    let finalMimeType = originalMimeType || 'application/octet-stream'; // 最终MIME类型

    try {
        const database = initDatabase();
        
        // 确保缓存目录及子目录存在
        await ensureCacheDirExists(cacheInfo.subDir);

        // 检查源格式是否需要转换
        if (preferredFormat !== 'Original') {
            // 确定源格式
            const sourceFormat = originalMimeType ? originalMimeType.split('/')[1]?.toLowerCase() : null;
            
            // 检查是否真的需要处理（如果源格式和目标格式相同，可以跳过处理）
            const needsProcessing = !(
                (preferredFormat.toLowerCase() === 'jpeg' && sourceFormat === 'jpeg') ||
                (preferredFormat.toLowerCase() === 'jpg' && sourceFormat === 'jpeg') ||
                (preferredFormat.toLowerCase() === 'png' && sourceFormat === 'png') ||
                (preferredFormat.toLowerCase() === 'webp' && sourceFormat === 'webp')
            );
            
            if (needsProcessing) {
                log.debug(`${logPrefix} Source format (${sourceFormat}) differs from target (${preferredFormat}). Processing with Sharp.`);
                const sharpStartTime = Date.now();
                
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
                            finalMimeType = 'image/jpeg';
                            break;
                        case 'png':
                            processedBuffer = await sharpInstance
                                .png({ quality: config.compressQuality })
                                .toBuffer();
                            formatUsed = 'PNG';
                            finalMimeType = 'image/png';
                            break;
                        case 'webp':
                            processedBuffer = await sharpInstance
                                .webp({ quality: config.compressQuality })
                                .toBuffer();
                            formatUsed = 'WebP';
                            finalMimeType = 'image/webp';
                            break;
                        default:
                            log.warn(`${logPrefix} Unsupported preferredFormat: ${preferredFormat}. Falling back to Original.`);
                            processedBuffer = sourceBuffer;
                            formatUsed = 'Original (Fallback)';
                            finalMimeType = originalMimeType || 'application/octet-stream';
                            break;
                    }
                    
                    const sharpDuration = Date.now() - sharpStartTime;
                    log.info(`${logPrefix} Image processed with Sharp. Format: ${formatUsed}, Quality: ${config.compressQuality}. Duration: ${sharpDuration}ms`);
                } catch (sharpError) {
                    log.error(`${logPrefix} Sharp processing FAILED for format ${preferredFormat}.`, sharpError.message);
                    // 转换失败，使用原始 Buffer
                    processedBuffer = sourceBuffer;
                    formatUsed = 'Original (Fallback)';
                    finalMimeType = originalMimeType || 'application/octet-stream';
                }
            } else {
                log.info(`${logPrefix} Source format matches target format (${sourceFormat}). Skipping processing.`);
                formatUsed = 'Original (Format Match)';
            }
        } else {
            log.info(`${logPrefix} Preferred format is Original, skipping processing.`);
        }

        // 确定最终的文件扩展名和路径
        const finalExtension = mimeToExt[finalMimeType] || defaultExt;
        const finalFilePath = cacheInfo.fullPath + finalExtension;
        
        log.debug(`${logPrefix} Writing processed buffer to: ${finalFilePath}`);
        
        // 使用事务包装所有数据库操作
        database.transaction(() => {
            // 1. 首先查询是否已存在相同键的元数据
            const existingEntryStmt = database.prepare('SELECT id, file_path FROM image_cache_metadata WHERE cache_key = ?');
            const existingEntry = existingEntryStmt.get(cacheInfo.cacheKey);
            
            // 2. 如果存在旧记录，我们需要删除旧文件
            if (existingEntry) {
                try {
                    log.debug(`${logPrefix} Found existing metadata. Deleting old file: ${existingEntry.file_path}`);
                    fs.unlinkSync(existingEntry.file_path);
                } catch (unlinkError) {
                    if (unlinkError.code !== 'ENOENT') {
                        log.warn(`${logPrefix} Failed to delete old cache file: ${existingEntry.file_path}`, unlinkError.message);
                    }
                }
            }
            
            // 3. 同步写入新文件
            fs.writeFileSync(finalFilePath, processedBuffer);
            
            // 4. 更新或插入元数据
            const now = Date.now();
            if (existingEntry) {
                const updateStmt = database.prepare(`
                    UPDATE image_cache_metadata SET 
                    file_path = ?, mime_type = ?, format = ?, 
                    size_bytes = ?, original_size_bytes = ?,
                    last_accessed = ?, access_count = 0
                    WHERE cache_key = ?
                `);
                
                updateStmt.run(
                    finalFilePath,
                    finalMimeType,
                    formatUsed,
                    processedBuffer.length,
                    sourceBuffer.length,
                    now,
                    cacheInfo.cacheKey
                );
            } else {
                const insertStmt = database.prepare(`
                    INSERT INTO image_cache_metadata
                    (cache_key, library_id, image_path, file_path, mime_type, format, 
                     size_bytes, original_size_bytes, created_at, last_accessed, access_count)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                `);
                
                insertStmt.run(
                    cacheInfo.cacheKey,
                    libraryId,
                    imageName,
                    finalFilePath,
                    finalMimeType,
                    formatUsed,
                    processedBuffer.length,
                    sourceBuffer.length,
                    now,
                    now
                );
            }
        })();
        
        stats.compressedSize += processedBuffer.length;
        
        const totalDuration = Date.now() - startTime;
        log.info(`${logPrefix} Cache operation successful. Size: ${(sourceBuffer.length / 1024).toFixed(1)}KB → ${(processedBuffer.length / 1024).toFixed(1)}KB. Format: ${formatUsed}. Duration: ${totalDuration}ms`);
        
        // 异步执行缓存清理（不等待结果）
        checkAndCleanCache().catch(err => {
            log.error(`${logPrefix} Background cache cleanup failed:`, err.message);
        });
        
        return { data: processedBuffer, mimeType: finalMimeType };
    } catch (error) {
        const totalDuration = Date.now() - startTime;
        log.error(`${logPrefix} Failed to process or cache image. Duration: ${totalDuration}ms`, error.message, error.stack);
        
        // 如果处理失败，尝试清理可能已部分创建的文件
        try {
            const finalExtension = mimeToExt[finalMimeType] || defaultExt;
            const finalFilePath = cacheInfo.fullPath + finalExtension;
            
            try {
                fs.accessSync(finalFilePath);
                log.warn(`${logPrefix} Cleaning up incomplete cache file: ${finalFilePath}`);
                fs.unlinkSync(finalFilePath);
            } catch (accessError) {
                // 文件可能不存在，忽略
            }
        } catch (cleanupError) {
            log.warn(`${logPrefix} Error during cleanup:`, cleanupError.message);
        }
        
        return null;
    } finally {
        log.debug(`${logPrefix} <<< setCache END`);
    }
}


/**
 * 清理全部图片缓存
 * @returns {Promise<void>}
 */
async function clearCache() {
    try {
        const database = initDatabase();
        
        // 使用事务包装所有操作
        database.transaction(() => {
            // 1. 获取所有缓存文件路径
            const allFilesStmt = database.prepare('SELECT file_path FROM image_cache_metadata');
            const allFiles = allFilesStmt.all();
            
            if (allFiles.length === 0) {
                log.info('[ImageCache] No cache files to clear.');
                return;
            }
            
            // 2. 删除所有文件（尽量同步删除以确保事务一致性）
            let successCount = 0;
            let errorCount = 0;
            
            for (const file of allFiles) {
                try {
                    fs.unlinkSync(file.file_path);
                    successCount++;
                } catch (error) {
                    // 忽略 ENOENT 错误（文件不存在）
                    if (error.code !== 'ENOENT') {
                        errorCount++;
                        log.warn(`[ImageCache] Failed to delete cache file: ${file.file_path}`, error.message);
                    }
                }
            }
            
            // 3. 清空元数据表
            const deleteStmt = database.prepare('DELETE FROM image_cache_metadata');
            deleteStmt.run();
            
            // 4. 重置序列（可选，但有助于保持ID小）
            database.prepare('DELETE FROM sqlite_sequence WHERE name = "image_cache_metadata"').run();
            
            log.info(`[ImageCache] Cache cleared successfully. Deleted ${successCount} files (${errorCount} errors).`);
        })();
        
        // 重置统计
        stats.cacheHits = 0;
        stats.totalRequests = 0;
        stats.originalSize = 0;
        stats.compressedSize = 0;
        stats.lastCleanTime = new Date();
    } catch (error) {
        log.error('[ImageCache] Failed to clear cache:', error.message, error.stack);
        throw error;
    }
}

/**
 * 检查并清理超出最大空间的缓存（通过数据库实现LRU策略）
 * @returns {Promise<void>}
 */
async function checkAndCleanCache() {
    try {
        const database = initDatabase();
        const maxSizeBytes = config.maxCacheSizeMB * 1024 * 1024;
        const targetSizeBytes = maxSizeBytes * 0.9; // 清理到90%容量
        
        // 获取当前总缓存大小
        const sizeStmt = database.prepare('SELECT SUM(size_bytes) as total_size FROM image_cache_metadata');
        const sizeResult = sizeStmt.get();
        
        if (!sizeResult || !sizeResult.total_size) {
            log.debug('[ImageCache] Cache appears to be empty or size computation failed.');
            return;
        }
        
        const totalSizeBytes = sizeResult.total_size;
        const totalSizeMB = totalSizeBytes / (1024 * 1024);
        
        log.info(`[ImageCache] Current cache size: ${totalSizeMB.toFixed(2)}MB, Max allowed: ${config.maxCacheSizeMB}MB`);
        
        // 如果缓存大小在限制内，不需要清理
        if (totalSizeBytes <= maxSizeBytes) {
            log.debug('[ImageCache] Cache size within limits, no cleanup needed.');
            return;
        }
        
        // 计算需要清理的字节数
        const bytesToRemove = totalSizeBytes - targetSizeBytes;
        log.info(`[ImageCache] Cache exceeds limit. Need to remove ~${(bytesToRemove / 1024 / 1024).toFixed(2)}MB`);
        
        // 使用事务包装删除操作
        database.transaction(() => {
            // 根据最后访问时间选择要删除的条目（LRU策略）
            const filesToDeleteStmt = database.prepare(`
                SELECT id, file_path, size_bytes FROM image_cache_metadata 
                ORDER BY last_accessed ASC
                LIMIT 100
            `);
            const filesToDelete = filesToDeleteStmt.all();
            
            if (filesToDelete.length === 0) {
                log.warn('[ImageCache] No files found to delete for cleanup!');
                return;
            }
            
            let removedBytes = 0;
            let removedCount = 0;
            const deletedIds = [];
            
            // 删除文件并收集已删除的ID
            for (const item of filesToDelete) {
                if (removedBytes >= bytesToRemove) break; // 已清理足够空间
                
                try {
                    fs.unlinkSync(item.file_path);
                    removedBytes += item.size_bytes;
                    removedCount++;
                    deletedIds.push(item.id);
                    log.debug(`[ImageCache] Deleted cache file: ${item.file_path} (${(item.size_bytes / 1024).toFixed(1)}KB)`);
                } catch (error) {
                    if (error.code !== 'ENOENT') { // 忽略文件不存在的错误
                        log.warn(`[ImageCache] Failed to delete file: ${item.file_path}`, error.message);
                    } else {
                        // 即使文件不存在也添加ID，以便清理元数据
                        deletedIds.push(item.id);
                    }
                }
            }
            
            // 批量删除元数据
            if (deletedIds.length > 0) {
                const placeholders = deletedIds.map(() => '?').join(',');
                const deleteStmt = database.prepare(`DELETE FROM image_cache_metadata WHERE id IN (${placeholders})`);
                deleteStmt.run(...deletedIds);
            }
            
            const remainingSizeBytes = totalSizeBytes - removedBytes;
            const remainingSizeMB = remainingSizeBytes / (1024 * 1024);
            
            stats.lastCleanTime = new Date();
            log.info(`[ImageCache] Cleanup complete. Removed ${removedCount} files, freed ${(removedBytes / 1024 / 1024).toFixed(2)}MB. Current size: ${remainingSizeMB.toFixed(2)}MB`);
        })();
        
    } catch (error) {
        log.error('[ImageCache] Failed to perform cache cleanup:', error.message, error.stack);
    }
}

module.exports = {
    setConfig,
    initDatabase,
    getCache,
    setCache,
    clearCache,
    checkAndCleanCache,
    config,
    getStats: () => ({ // 确保 getStats 导出
        ...stats,
        cacheHitRate: stats.totalRequests > 0 ? (stats.cacheHits / stats.totalRequests * 100).toFixed(1) + '%' : '0%',
        spaceSaved: stats.originalSize > 0 && stats.compressedSize > 0 ? ((1 - stats.compressedSize / stats.originalSize) * 100).toFixed(1) + '%' : '0%'
    }),
    getCurrentCacheSizeBytes
};

/**
 * 获取当前缓存目录的总大小（字节）
 * @returns {Promise<number>} 缓存总大小（字节），如果出错则返回 0
 */
async function getCurrentCacheSizeBytes() {
    try {
        const database = initDatabase();
        
        // 直接从数据库查询总大小
        const stmt = database.prepare('SELECT SUM(size_bytes) as total_size FROM image_cache_metadata');
        const result = stmt.get();
        
        // 如果没有记录或结果为空，返回0
        if (!result || result.total_size === null) {
            return 0;
        }
        
        return result.total_size;
    } catch (error) {
        log.error('[ImageCache] Error getting cache size from database:', error.message, error.stack);
        return 0;
    }
}