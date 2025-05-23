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
const { app } = require('electron'); // 引入app模块用于获取用户数据目录

// 获取用户数据目录
const getUserDataPath = () => {
    try {
        // 在主进程中，app对象是可用的
        if (app && typeof app.getPath === 'function') {
            return app.getPath('userData');
        }
    } catch (error) {
        log.warn('[ImageCache] 无法获取Electron userData路径:', error.message);
        // 发生错误，回退到备选方案
    }
    
    // 在渲染进程或测试中使用，提供一个合理的备选方案
    return path.join(os.homedir(), '.modelnest');
};

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
    cacheDir: path.join(getUserDataPath(), 'cache', 'images'),
    maxCacheSizeMB: 200,
    compressQuality: 50, // 0-100
    debug: false, // 是否输出调试日志
    logStats: true, // 是否记录统计信息
    dbPath: path.join(getUserDataPath(), 'cache', 'cache_metadata.db') // 使用用户数据目录存储数据库
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
        
        // 尝试执行迁移（只在第一次初始化时）
        // 注意这是异步的，但我们不等待它完成
        migrateFromOldCacheLocation().catch(err => {
            log.error('[ImageCache] 迁移过程中出错:', err);
        });
        
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
    
    // 记录缓存目录位置
    log.info(`[ImageCache] 图片缓存目录设置为: ${config.cacheDir}`);
    log.info(`[ImageCache] 缓存数据库位置: ${config.dbPath}`);
    
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
        log.info('[ImageCache] Starting cache clear operation...');
        
        // 使用事务包装所有操作
        database.transaction(() => {
            // 1. 获取所有缓存文件路径
            const allFilesStmt = database.prepare('SELECT id, file_path FROM image_cache_metadata');
            const allFiles = allFilesStmt.all();
            
            if (allFiles.length === 0) {
                log.info('[ImageCache] No cache files to clear.');
                return;
            }
            
            // 记录找到的文件总数
            log.info(`[ImageCache] Found ${allFiles.length} cache files to delete.`);
            
            // 2. 删除所有文件（尽量同步删除以确保事务一致性）
            let successCount = 0;
            let errorCount = 0;
            let notFoundCount = 0;
            
            for (const file of allFiles) {
                try {
                    // 检查文件是否存在
                    if (fs.existsSync(file.file_path)) {
                        fs.unlinkSync(file.file_path);
                        log.debug(`[ImageCache] Deleted file: ${file.file_path}`);
                        successCount++;
                    } else {
                        log.debug(`[ImageCache] File not found (already deleted or never existed): ${file.file_path}`);
                        notFoundCount++;
                    }
                } catch (error) {
                    // 记录详细错误信息
                    errorCount++;
                    log.warn(`[ImageCache] Failed to delete cache file (ID: ${file.id}): ${file.file_path}`, error.message, error.stack);
                }
            }
            
            // 3. 清空元数据表
            const deleteStmt = database.prepare('DELETE FROM image_cache_metadata');
            const deleteResult = deleteStmt.run();
            const deletedRows = deleteResult.changes;
            
            log.info(`[ImageCache] Deleted ${deletedRows} records from database.`);
            
            // 4. 重置序列（可选，但有助于保持ID小）
            try {
                database.prepare("DELETE FROM sqlite_sequence WHERE name = 'image_cache_metadata'").run();
                log.debug('[ImageCache] Reset sqlite_sequence for image_cache_metadata table.');
            } catch (seqError) {
                log.warn('[ImageCache] Failed to reset sqlite_sequence:', seqError.message);
                // 继续执行，这不是关键错误
            }
            
            log.info(`[ImageCache] Cache cleared successfully. Found ${allFiles.length} files, deleted ${successCount} files, ${notFoundCount} not found, ${errorCount} errors.`);
        })();
        
        // 重置统计
        stats.cacheHits = 0;
        stats.totalRequests = 0;
        stats.originalSize = 0;
        stats.compressedSize = 0;
        stats.lastCleanTime = new Date();
        
        // 额外检查：清除所有子目录中的孤立文件
        try {
            await cleanOrphanedFiles();
        } catch (orphanError) {
            log.warn('[ImageCache] Failed to clean orphaned files:', orphanError.message);
        }
    } catch (error) {
        log.error('[ImageCache] Failed to clear cache:', error.message, error.stack);
        throw error;
    }
}

/**
 * 清理可能存在的孤立文件（数据库中没有记录但文件系统中存在的文件）
 * @returns {Promise<void>}
 */
async function cleanOrphanedFiles() {
    try {
        log.info('[ImageCache] Checking for orphaned cache files...');
        
        // 确保缓存根目录存在
        if (!fs.existsSync(config.cacheDir)) {
            log.info('[ImageCache] Cache directory does not exist, no orphaned files to clean.');
            return;
        }
        
        // 读取缓存目录下的所有子目录（2字符哈希目录）
        const entries = fs.readdirSync(config.cacheDir, { withFileTypes: true });
        const subDirs = entries.filter(entry => entry.isDirectory() && entry.name.length === 2);
        
        if (subDirs.length === 0) {
            log.info('[ImageCache] No subdirectories found in cache directory.');
            return;
        }
        
        log.info(`[ImageCache] Found ${subDirs.length} cache subdirectories to check.`);
        
        let totalDeleted = 0;
        let totalErrored = 0;
        
        // 遍历每个子目录并删除所有文件
        for (const subDir of subDirs) {
            const fullSubDirPath = path.join(config.cacheDir, subDir.name);
            try {
                const files = fs.readdirSync(fullSubDirPath, { withFileTypes: true });
                const fileEntries = files.filter(f => f.isFile());
                
                log.debug(`[ImageCache] Subdirectory ${subDir.name} contains ${fileEntries.length} files.`);
                
                for (const file of fileEntries) {
                    const fullPath = path.join(fullSubDirPath, file.name);
                    try {
                        fs.unlinkSync(fullPath);
                        log.debug(`[ImageCache] Deleted orphaned file: ${fullPath}`);
                        totalDeleted++;
                    } catch (error) {
                        log.warn(`[ImageCache] Failed to delete orphaned file: ${fullPath}`, error.message);
                        totalErrored++;
                    }
                }
                
                // 尝试删除空子目录（如果已经没有文件了）
                try {
                    // 再次检查目录是否为空
                    const remainingFiles = fs.readdirSync(fullSubDirPath);
                    if (remainingFiles.length === 0) {
                        fs.rmdirSync(fullSubDirPath);
                        log.debug(`[ImageCache] Removed empty subdirectory: ${fullSubDirPath}`);
                    }
                } catch (rmDirError) {
                    log.warn(`[ImageCache] Failed to remove subdirectory: ${fullSubDirPath}`, rmDirError.message);
                }
            } catch (error) {
                log.error(`[ImageCache] Error processing subdirectory: ${fullSubDirPath}`, error.message);
            }
        }
        
        log.info(`[ImageCache] Orphaned file cleanup complete. Deleted ${totalDeleted} files with ${totalErrored} errors.`);
    } catch (error) {
        log.error('[ImageCache] Failed to clean orphaned files:', error.message, error.stack);
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

/**
 * 从旧的缓存位置迁移数据到新的用户数据目录
 * @returns {Promise<void>}
 */
async function migrateFromOldCacheLocation() {
    const oldCacheDir = path.join(process.cwd(), 'cache', 'images');
    const oldDbPath = path.join(process.cwd(), 'cache', 'cache_metadata.db');
    
    // 检查旧目录是否存在
    try {
        await fs.promises.access(oldCacheDir);
        log.info(`[ImageCache] 检测到旧缓存目录: ${oldCacheDir}`);
    } catch (error) {
        // 旧目录不存在，无需迁移
        log.info('[ImageCache] 未找到旧缓存目录，无需迁移。');
        return;
    }
    
    // 检查旧数据库是否存在
    let hasOldDb = false;
    try {
        await fs.promises.access(oldDbPath);
        hasOldDb = true;
        log.info(`[ImageCache] 检测到旧数据库: ${oldDbPath}`);
    } catch (error) {
        log.info('[ImageCache] 未找到旧数据库，将只迁移文件。');
    }
    
    // 创建新缓存目录（如果不存在）
    try {
        await fs.promises.access(config.cacheDir);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.promises.mkdir(config.cacheDir, { recursive: true });
            log.info(`[ImageCache] 已创建新缓存目录: ${config.cacheDir}`);
        }
    }
    
    // 如果旧数据库存在，尝试迁移数据
    if (hasOldDb) {
        try {
            log.info('[ImageCache] 开始从旧数据库迁移数据...');
            
            // 打开旧数据库
            const oldDb = new Database(oldDbPath);
            
            // 查询所有旧记录
            const oldRecords = oldDb.prepare('SELECT * FROM image_cache_metadata').all();
            log.info(`[ImageCache] 找到 ${oldRecords.length} 条旧记录`);
            
            if (oldRecords.length > 0) {
                // 初始化新数据库
                const newDb = initDatabase();
                
                // 开始事务
                newDb.transaction(() => {
                    // 准备插入语句
                    const insertStmt = newDb.prepare(`
                        INSERT OR REPLACE INTO image_cache_metadata
                        (cache_key, library_id, image_path, file_path, mime_type, format, 
                         size_bytes, original_size_bytes, created_at, last_accessed, access_count)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `);
                    
                    let successCount = 0;
                    let errorCount = 0;
                    
                    // 为每条记录迁移文件和元数据
                    for (const record of oldRecords) {
                        try {
                            const oldFilePath = record.file_path;
                            
                            // 检查文件是否存在
                            if (!fs.existsSync(oldFilePath)) {
                                log.warn(`[ImageCache] 旧文件不存在，跳过: ${oldFilePath}`);
                                errorCount++;
                                continue;
                            }
                            
                            // 确定新文件路径
                            // 从旧路径中提取文件名部分
                            const fileName = path.basename(oldFilePath);
                            const subDirName = path.basename(path.dirname(oldFilePath));
                            
                            // 创建目标子目录（如果需要）
                            const newSubDirPath = path.join(config.cacheDir, subDirName);
                            if (!fs.existsSync(newSubDirPath)) {
                                fs.mkdirSync(newSubDirPath, { recursive: true });
                            }
                            
                            // 新文件路径
                            const newFilePath = path.join(newSubDirPath, fileName);
                            
                            // 复制文件
                            fs.copyFileSync(oldFilePath, newFilePath);
                            
                            // 更新数据库记录
                            insertStmt.run(
                                record.cache_key,
                                record.library_id,
                                record.image_path,
                                newFilePath, // 使用新路径
                                record.mime_type,
                                record.format,
                                record.size_bytes,
                                record.original_size_bytes,
                                record.created_at,
                                record.last_accessed,
                                record.access_count
                            );
                            
                            successCount++;
                        } catch (error) {
                            log.error(`[ImageCache] 迁移记录失败: ${error.message}`, error.stack);
                            errorCount++;
                        }
                    }
                    
                    log.info(`[ImageCache] 迁移完成: 成功 ${successCount}, 失败 ${errorCount}`);
                })();
                
                // 关闭旧数据库
                oldDb.close();
            }
        } catch (error) {
            log.error('[ImageCache] 数据库迁移失败:', error.message, error.stack);
        }
    } else {
        // 只复制文件
        log.info('[ImageCache] 开始复制缓存文件...');
        await copyFilesRecursively(oldCacheDir, config.cacheDir);
    }
    
    log.info('[ImageCache] 迁移操作完成');
}

/**
 * 递归复制目录中的文件
 * @param {string} sourceDir - 源目录
 * @param {string} targetDir - 目标目录
 * @returns {Promise<{success: number, errors: number}>} - 成功和失败的计数
 */
async function copyFilesRecursively(sourceDir, targetDir) {
    let successCount = 0;
    let errorCount = 0;
    
    try {
        // 读取源目录内容
        const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });
        
        // 确保目标目录存在
        try {
            await fs.promises.access(targetDir);
        } catch (error) {
            if (error.code === 'ENOENT') {
                await fs.promises.mkdir(targetDir, { recursive: true });
            }
        }
        
        // 处理每个条目
        for (const entry of entries) {
            const sourcePath = path.join(sourceDir, entry.name);
            const targetPath = path.join(targetDir, entry.name);
            
            if (entry.isDirectory()) {
                // 递归处理子目录
                const result = await copyFilesRecursively(sourcePath, targetPath);
                successCount += result.success;
                errorCount += result.errors;
            } else if (entry.isFile()) {
                // 复制文件
                try {
                    await fs.promises.copyFile(sourcePath, targetPath);
                    successCount++;
                } catch (error) {
                    log.error(`[ImageCache] 复制文件失败: ${sourcePath} -> ${targetPath}`, error.message);
                    errorCount++;
                }
            }
        }
    } catch (error) {
        log.error(`[ImageCache] 读取目录失败: ${sourceDir}`, error.message);
        errorCount++;
    }
    
    return { success: successCount, errors: errorCount };
}

module.exports = {
    setConfig,
    initDatabase,
    getCache,
    setCache,
    clearCache,
    checkAndCleanCache,
    cleanOrphanedFiles,
    migrateFromOldCacheLocation,
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