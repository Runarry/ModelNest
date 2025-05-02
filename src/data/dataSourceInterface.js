// src/data/dataSourceInterface.js
const fs = require('fs');
const path = require('path');
const log = require('electron-log');
// 导入具体的数据源实现
const { LocalDataSource } = require('./dataSource');
const { WebDavDataSource } = require('./webdavDataSource');

// 缓存数据源实例，键为 sourceId，值为 DataSource 实例
const dataSourceInstances = {};

/**
 * Writes the model JSON data based on the source configuration type.
 *
 * @param {object} sourceConfig - The configuration object for the specific data source (must include 'type', 'id', and necessary details like 'path' or 'url'/'username'/'password').
 * @param {object} model - The model object (must include 'jsonPath').
 * @param {string} dataToWrite - The JSON string data to write.
 * @returns {Promise<void>} A promise that resolves when the write operation is complete.
 * @throws {Error} If the data source type is unknown, config is invalid, or writing fails.
 */
async function writeModelJson(sourceConfig, model, dataToWrite) {
    const startTime = Date.now();
    if (!sourceConfig || !sourceConfig.type || !sourceConfig.id) {
        log.error('[DataSourceInterface] writeModelJson called with invalid sourceConfig:', sourceConfig);
        throw new Error('Invalid source configuration provided (missing type or id).');
    }
     if (!model || !model.jsonPath) {
        log.error('[DataSourceInterface] writeModelJson called with invalid model object:', model);
        throw new Error('Invalid model object provided for writing (missing jsonPath).');
    }
    if (typeof dataToWrite !== 'string') {
        log.error('[DataSourceInterface] writeModelJson called with non-string dataToWrite:', typeof dataToWrite);
        throw new Error('Invalid data provided for writing (must be a string).');
    }

    const sourceType = sourceConfig.type;
    const sourceId = sourceConfig.id;
    const jsonPath = model.jsonPath; // The path where the JSON should be saved

    log.info(`[DataSourceInterface] Attempting to write model JSON for sourceId: ${sourceId}, type: ${sourceType}, path: ${jsonPath}`);

    try {
        if (sourceType === 'local') {
            if (!jsonPath) { // Local type requires jsonPath from model
                 throw new Error(`Local source (ID: ${sourceId}) requires jsonPath in the model object.`);
            }
            log.debug(`[DataSourceInterface] Writing to local file system: ${jsonPath}`);
            // Ensure directory exists before writing
            const dirPath = path.dirname(jsonPath);
            try {
                await fs.promises.access(dirPath);
            } catch (accessError) {
                if (accessError.code === 'ENOENT') {
                    log.info(`[DataSourceInterface] Directory ${dirPath} does not exist, creating...`);
                    await fs.promises.mkdir(dirPath, { recursive: true });
                } else {
                    log.error(`[DataSourceInterface] Error accessing directory ${dirPath}:`, accessError);
                    throw accessError;
                }
            }
            // Write the file
            await fs.promises.writeFile(jsonPath, dataToWrite, 'utf-8');
            const duration = Date.now() - startTime;
            log.info(`[DataSourceInterface] Successfully wrote to local file: ${jsonPath},耗时: ${duration}ms`);

        } else if (sourceType === 'webdav') {
             if (!jsonPath) { // WebDAV also needs the target path
                 throw new Error(`WebDAV source (ID: ${sourceId}) requires jsonPath in the model object.`);
            }
            log.debug(`[DataSourceInterface] Writing to WebDAV source: ${jsonPath}`);
            // Create a temporary instance to perform the write operation
            // Note: This might not be the most efficient way if writes are frequent,
            // as it involves client initialization overhead.
            // --> 修改：复用或创建 WebDAV 实例
            let ds = dataSourceInstances[sourceId];
            if (!ds) {
                log.debug(`[DataSourceInterface writeModelJson] Creating new WebDavDataSource instance for sourceId: ${sourceId}`);
                ds = new WebDavDataSource(sourceConfig);
                dataSourceInstances[sourceId] = ds;
            } else {
                log.debug(`[DataSourceInterface writeModelJson] Reusing existing WebDavDataSource instance for sourceId: ${sourceId}`);
            }
            // The writeModelJson method within WebDavDataSource handles ensureInitialized
            await ds.writeModelJson(jsonPath, dataToWrite);
            const duration = Date.now() - startTime;
            log.info(`[DataSourceInterface] Successfully wrote to WebDAV: ${jsonPath}, 耗时: ${duration}ms`);

        } else {
            throw new Error(`Unsupported data source type: '${sourceType}' for source ID ${sourceId}`);
        }
    } catch (error) {
        const duration = Date.now() - startTime;
        log.error(`[DataSourceInterface] Failed to write model JSON for sourceId: ${sourceId}, type: ${sourceType}, path: ${jsonPath}, 耗时: ${duration}ms`, error.message, error.stack);
        throw error; // Re-throw
    }
}


/**
 * Lists models based on the source configuration type.
 *
 * @param {object} sourceConfig - The configuration object for the data source.
 * @param {string|null} directory - The specific subdirectory to list models from (relative to source root), or null for the root.
 * @param {string[]} supportedExts - An array of supported file extensions (e.g., ['.safetensors', '.ckpt']).
 * @returns {Promise<Array<object>>} A promise that resolves with an array of model objects.
 * @throws {Error} If the data source type is unknown or listing fails.
 */
async function listModels(sourceConfig, directory = null, supportedExts = []) { // 添加 supportedExts 参数
    const startTime = Date.now();
    if (!sourceConfig || !sourceConfig.type || !sourceConfig.id) {
        log.error('[DataSourceInterface] listModels called with invalid sourceConfig:', sourceConfig);
        throw new Error('Invalid source configuration provided (missing type or id).');
    }
    if (!Array.isArray(supportedExts)) {
        log.warn(`[DataSourceInterface] listModels called with non-array supportedExts: ${supportedExts}. Using empty array.`);
        supportedExts = [];
    }

    const sourceType = sourceConfig.type;
    const sourceId = sourceConfig.id;
    // 更详细的日志记录传入的 sourceConfig 和 supportedExts
    log.info(`[DataSourceInterface] Attempting to list models. sourceId: ${sourceId}, type: ${sourceType}, directory: ${directory}, supportedExts: ${supportedExts}`);
    log.debug(`[DataSourceInterface] Received sourceConfig: ${JSON.stringify(sourceConfig)}`); // 添加日志

    try {
        let models = [];
        if (sourceType === 'local') {
            // LocalDataSource doesn't need instantiation for static-like methods if designed that way,
            // but here we follow the pattern of instantiating it.
            const ds = new LocalDataSource(sourceConfig);
            // 传递 supportedExts 给具体实现
            models = await ds.listModels(directory, supportedExts);
        } else if (sourceType === 'webdav') {
            // --> 修改：复用或创建 WebDAV 实例
            let ds = dataSourceInstances[sourceId];
            if (!ds) {
                log.debug(`[DataSourceInterface listModels] Creating new WebDavDataSource instance for sourceId: ${sourceId}`);
                ds = new WebDavDataSource(sourceConfig);
                dataSourceInstances[sourceId] = ds;
            } else {
                log.debug(`[DataSourceInterface listModels] Reusing existing WebDavDataSource instance for sourceId: ${sourceId}`);
            }
            await ds.ensureInitialized(); // Ensure client is ready
            // 传递 supportedExts 给具体实现
            models = await ds.listModels(directory, supportedExts);
        } else {
            throw new Error(`Unsupported data source type: '${sourceType}' for source ID ${sourceId}`);
        }
        const duration = Date.now() - startTime;
        log.info(`[DataSourceInterface] Successfully listed models for sourceId: ${sourceId}, type: ${sourceType}, directory: ${directory}, supportedExts: ${supportedExts}. Found ${models.length} models. 耗时: ${duration}ms`);
        return models;
    } catch (error) {
        const duration = Date.now() - startTime;
        log.error(`[DataSourceInterface] Failed to list models for sourceId: ${sourceId}, type: ${sourceType}, directory: ${directory}, supportedExts: ${supportedExts}, 耗时: ${duration}ms`, error.message, error.stack); // 在错误日志中添加 supportedExts
        throw error; // Re-throw
    }
}

/**
 * Lists subdirectories based on the source configuration type.
 *
 * @param {object} sourceConfig - The configuration object for the data source.
 * @returns {Promise<Array<string>>} A promise that resolves with an array of subdirectory names.
 * @throws {Error} If the data source type is unknown or listing fails.
 */
async function listSubdirectories(sourceConfig) {
    const startTime = Date.now();
     if (!sourceConfig || !sourceConfig.type || !sourceConfig.id) {
        log.error('[DataSourceInterface] listSubdirectories called with invalid sourceConfig:', sourceConfig);
        throw new Error('Invalid source configuration provided (missing type or id).');
    }

    const sourceType = sourceConfig.type;
    const sourceId = sourceConfig.id;
    log.info(`[DataSourceInterface] Attempting to list subdirectories for sourceId: ${sourceId}, type: ${sourceType}`);

    try {
        let subdirs = [];
        if (sourceType === 'local') {
            const ds = new LocalDataSource(sourceConfig);
            subdirs = await ds.listSubdirectories();
        } else if (sourceType === 'webdav') {
            // --> 修改：复用或创建 WebDAV 实例
            let ds = dataSourceInstances[sourceId];
            if (!ds) {
                log.debug(`[DataSourceInterface listSubdirectories] Creating new WebDavDataSource instance for sourceId: ${sourceId}`);
                ds = new WebDavDataSource(sourceConfig);
                dataSourceInstances[sourceId] = ds;
            } else {
                log.debug(`[DataSourceInterface listSubdirectories] Reusing existing WebDavDataSource instance for sourceId: ${sourceId}`);
            }
             await ds.ensureInitialized(); // Ensure client is ready
            subdirs = await ds.listSubdirectories();
        } else {
            throw new Error(`Unsupported data source type: '${sourceType}' for source ID ${sourceId}`);
        }
        const duration = Date.now() - startTime;
        log.info(`[DataSourceInterface] Successfully listed subdirectories for sourceId: ${sourceId}, type: ${sourceType}. Found ${subdirs.length} directories. 耗时: ${duration}ms`);
        return subdirs;
    } catch (error) {
        const duration = Date.now() - startTime;
        log.error(`[DataSourceInterface] Failed to list subdirectories for sourceId: ${sourceId}, type: ${sourceType}, 耗时: ${duration}ms`, error.message, error.stack);
        throw error; // Re-throw
    }
}

/**
 * Reads model detail based on the source configuration type.
 *
 * @param {object} sourceConfig - The configuration object for the data source.
 * @param {string} jsonPath - The path to the model's JSON file.
 * @returns {Promise<object>} A promise that resolves with the model detail object.
 * @throws {Error} If the data source type is unknown or reading fails.
 */
async function readModelDetail(sourceConfig, jsonPath) {
    const startTime = Date.now();
    if (!sourceConfig || !sourceConfig.type || !sourceConfig.id) {
        log.error('[DataSourceInterface] readModelDetail called with invalid sourceConfig:', sourceConfig);
        throw new Error('Invalid source configuration provided (missing type or id).');
    }
     if (!jsonPath) {
        log.error('[DataSourceInterface] readModelDetail called with invalid jsonPath:', jsonPath);
        throw new Error('Invalid jsonPath provided for reading model detail.');
    }

    const sourceType = sourceConfig.type;
    const sourceId = sourceConfig.id;
    log.info(`[DataSourceInterface] Attempting to read model detail for sourceId: ${sourceId}, type: ${sourceType}, path: ${jsonPath}`);

    try {
        let detail = {};
        if (sourceType === 'local') {
            const ds = new LocalDataSource(sourceConfig);
            detail = await ds.readModelDetail(jsonPath);
        } else if (sourceType === 'webdav') {
            // --> 修改：复用或创建 WebDAV 实例
            let ds = dataSourceInstances[sourceId];
            if (!ds) {
                log.debug(`[DataSourceInterface readModelDetail] Creating new WebDavDataSource instance for sourceId: ${sourceId}`);
                ds = new WebDavDataSource(sourceConfig);
                dataSourceInstances[sourceId] = ds;
            } else {
                log.debug(`[DataSourceInterface readModelDetail] Reusing existing WebDavDataSource instance for sourceId: ${sourceId}`);
            }
             await ds.ensureInitialized(); // Ensure client is ready
            detail = await ds.readModelDetail(jsonPath);
        } else {
            throw new Error(`Unsupported data source type: '${sourceType}' for source ID ${sourceId}`);
        }
        const duration = Date.now() - startTime;
        log.info(`[DataSourceInterface] Successfully read model detail for sourceId: ${sourceId}, type: ${sourceType}, path: ${jsonPath}. 耗时: ${duration}ms`);
        return detail;
    } catch (error) {
        const duration = Date.now() - startTime;
        log.error(`[DataSourceInterface] Failed to read model detail for sourceId: ${sourceId}, type: ${sourceType}, path: ${jsonPath}, 耗时: ${duration}ms`, error.message, error.stack);
        // Don't throw error here, return empty object as per original logic in IPC handler
        // throw error;
         return {}; // Return empty object on failure to match previous behavior
    }
}

/**
 * Gets image data based on the source configuration type.
 *
 * @param {object} sourceConfig - The configuration object for the data source.
 * @param {string} imagePath - The path to the image file.
 * @returns {Promise<object|null>} A promise that resolves with an object containing { path, data, mimeType } or null if not found/error.
 * @throws {Error} If the data source type is unknown (but returns null for fetch errors).
 */
async function getImageData(sourceConfig, imagePath) {
    const startTime = Date.now();
    if (!sourceConfig || !sourceConfig.type || !sourceConfig.id) {
        log.error('[DataSourceInterface] getImageData called with invalid sourceConfig:', sourceConfig);
        throw new Error('Invalid source configuration provided (missing type or id).');
    }
     if (!imagePath) {
        log.error('[DataSourceInterface] getImageData called with invalid imagePath:', imagePath);
        throw new Error('Invalid imagePath provided for getting image data.');
    }

    const sourceType = sourceConfig.type;
    const sourceId = sourceConfig.id;
    log.info(`[DataSourceInterface] Attempting to get image data for sourceId: ${sourceId}, type: ${sourceType}, path: ${imagePath}`);

    try {
        let imageData = null;
        if (sourceType === 'local') {
            // For local files, we just need to check existence and read later if needed.
            // The actual reading happens in the imageCache logic.
            // We return the path so the cache logic knows where to find it.
            // We need to simulate the structure returned by WebDAV's getImageData for consistency.
            try {
                // 读取本地文件内容到 Buffer
                const fileData = await fs.promises.readFile(imagePath);
                imageData = {
                    path: imagePath, // 保留原始路径信息（虽然 imageService 可能不再直接使用）
                    data: fileData, // 返回 Buffer 数据
                    mimeType: `image/${path.extname(imagePath).slice(1).toLowerCase()}` // 基于扩展名的 MIME 类型
                };
                log.debug(`[DataSourceInterface] Local image file read successfully: ${imagePath}, size: ${(fileData.length / 1024).toFixed(1)}KB`);
            } catch (readError) {
                if (readError.code === 'ENOENT') {
                    log.warn(`[DataSourceInterface] Local image file not found during read: ${imagePath}`);
                } else {
                    log.error(`[DataSourceInterface] Error reading local image file ${imagePath}:`, readError);
                }
                imageData = null; // 指示失败
            }
        } else if (sourceType === 'webdav') {
            // --> 修改：复用或创建 WebDAV 实例
            let ds = dataSourceInstances[sourceId];
            if (!ds) {
                log.debug(`[DataSourceInterface getImageData] Creating new WebDavDataSource instance for sourceId: ${sourceId}`);
                ds = new WebDavDataSource(sourceConfig);
                dataSourceInstances[sourceId] = ds;
            } else {
                log.debug(`[DataSourceInterface getImageData] Reusing existing WebDavDataSource instance for sourceId: ${sourceId}`);
            }
             await ds.ensureInitialized(); // Ensure client is ready
            // WebDAV needs to actually download the data
            imageData = await ds.getImageData(imagePath); // This returns { path, data, mimeType } or null
        } else {
            throw new Error(`Unsupported data source type: '${sourceType}' for source ID ${sourceId}`);
        }
        const duration = Date.now() - startTime;
        if (imageData) {
             log.info(`[DataSourceInterface] Successfully prepared/retrieved image data for sourceId: ${sourceId}, type: ${sourceType}, path: ${imagePath}. 耗时: ${duration}ms`);
        } else {
             log.warn(`[DataSourceInterface] Failed to get image data for sourceId: ${sourceId}, type: ${sourceType}, path: ${imagePath}. 耗时: ${duration}ms`);
        }
        return imageData;
    } catch (error) {
         const duration = Date.now() - startTime;
        // Log errors, but return null to match original behavior (e.g., image not found)
        log.error(`[DataSourceInterface] Failed to get image data for sourceId: ${sourceId}, type: ${sourceType}, path: ${imagePath}, 耗时: ${duration}ms`, error.message, error.stack);
        // throw error; // Don't throw, return null
        return null;
    }
}


module.exports = {
    writeModelJson,
    listModels,
    listSubdirectories,
    readModelDetail,
    getImageData
};