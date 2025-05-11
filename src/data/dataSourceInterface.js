// src/data/dataSourceInterface.js
const log = require('electron-log');

// Define custom error for read-only operations
class ReadOnlyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReadOnlyError';
  }
}

// 导入具体的数据源实现（移至 getDataSourceInstance 内部）
const { LocalDataSource } = require('./localDataSource');
const { WebDavDataSource } = require('./webdavDataSource');

// 缓存数据源实例，键为 sourceId，值为 DataSource 实例
const dataSourceInstances = {};

/**
 * 比较两个数据源配置对象的关键字段是否相同。
 * @param {object} config1 第一个配置对象。
 * @param {object} config2 第二个配置对象。
 * @returns {boolean} 如果关键字段相同则返回 true，否则返回 false。
 */
function compareDataSourceConfigs(config1, config2) {
    if (!config1 || !config2) return false; // 如果任一配置为空，则认为不同
    if (config1.type !== config2.type) return false; // 类型必须相同

    if (config1.type === 'local') {
        // 对于 local 类型，比较 path
        return config1.path === config2.path;
    } else if (config1.type === 'webdav') {
        // 对于 webdav 类型，比较 url, username, password, subDirectory
        // 将 undefined, null, '' 视为空路径进行比较
        const subDir1 = config1.subDirectory || '';
        const subDir2 = config2.subDirectory || '';

        return config1.url === config2.url &&
               config1.username === config2.username &&
               config1.password === config2.password &&
               subDir1 === subDir2; // 比较处理过的 subDirectory
    }
    // 对于未知类型，保守地认为不同
    log.warn(`[DataSourceInterface] compareDataSourceConfigs encountered unknown type: ${config1.type}`);
    return false;
}


/**
 * 获取或创建数据源实例。
 * @param {object} sourceConfig - 数据源配置。
 * @returns {import('./baseDataSource').DataSource} 数据源实例。
 * @throws {Error} 如果配置无效或类型不受支持。
 */
function getDataSourceInstance(sourceConfig) {
    if (!sourceConfig || !sourceConfig.id || !sourceConfig.type) {
        log.error('[DataSourceInterface] getDataSourceInstance called with invalid sourceConfig:', sourceConfig);
        throw new Error('Invalid source configuration provided (missing id or type).');
    }
    const sourceId = sourceConfig.id;
    const sourceType = sourceConfig.type;

    // 检查缓存
    if (dataSourceInstances[sourceId]) {
        // 检查配置是否已更改，如果更改则需要创建新实例或更新现有实例
        // 简单起见，如果配置对象不同，则重新创建（这假设配置对象是不可变的）
        // 注意：现在使用关键字段比较来判断配置是否实质性更改
        if (compareDataSourceConfigs(dataSourceInstances[sourceId].config, sourceConfig)) {
             log.debug(`[DataSourceInterface] Reusing existing DataSource instance for sourceId: ${sourceId} (key fields match)`);
             return dataSourceInstances[sourceId];
        } else {
             log.warn(`[DataSourceInterface] Source config changed (key fields mismatch) for sourceId: ${sourceId}. Creating new instance.`);
             // 记录具体的配置差异，帮助调试 (可选，但可能有用)
             // log.debug(`[DataSourceInterface] Old config: ${JSON.stringify(dataSourceInstances[sourceId].config)}`);
             // log.debug(`[DataSourceInterface] New config: ${JSON.stringify(sourceConfig)}`);
             // 可以选择性地清理旧实例的资源，如果需要的话
             // delete dataSourceInstances[sourceId]; // 如果需要强制重新创建
        }
    }

    // 创建新实例
    log.debug(`[DataSourceInterface] Creating new DataSource instance for sourceId: ${sourceId}, type: ${sourceType}`);
    let ds;
    if (sourceType === 'local') {
        ds = new LocalDataSource(sourceConfig);
    } else if (sourceType === 'webdav') {
        ds = new WebDavDataSource(sourceConfig);
        // WebDavDataSource 内部应处理初始化逻辑（如 ensureInitialized）
        // 但在这里调用 ensureInitialized 可能更安全，以防万一它不是在构造函数中完成的
        // await ds.ensureInitialized(); // 如果 WebDAV 需要异步初始化
    } else {
        throw new Error(`Unsupported data source type: '${sourceType}' for source ID ${sourceId}`);
    }

    // 缓存实例
    dataSourceInstances[sourceId] = ds;
    return ds;
}


/**
 * Writes the model JSON data using the appropriate data source instance.
 *
 * @param {object} sourceConfig - The configuration object for the data source.
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

    const sourceId = sourceConfig.id;
    // 从 model 对象中获取 jsonPath，这是 writeModelJson 接口需要的
    const filePath = model.jsonPath;

    log.info(`[DataSourceInterface] Attempting to write model JSON for sourceId: ${sourceId}, path: ${filePath}`);

    // --- Read-only check START ---
    if (sourceConfig.readOnly === true) { // Explicitly check for true
        const errorMsg = `Data source '${sourceConfig.name || sourceId}' is read-only. Write operation denied for path: ${filePath}`;
        log.warn(`[DataSourceInterface] ${errorMsg}`);
        throw new ReadOnlyError(errorMsg);
    }
    // --- Read-only check END ---

    try {
        // 获取数据源实例
        const ds = getDataSourceInstance(sourceConfig);
        // 调用标准接口方法
        await ds.writeModelJson(filePath, dataToWrite);
        const duration = Date.now() - startTime;
        log.info(`[DataSourceInterface] Successfully wrote model JSON for sourceId: ${sourceId}, path: ${filePath}, 耗时: ${duration}ms`);
    } catch (error) {
        const duration = Date.now() - startTime;
        log.error(`[DataSourceInterface] Failed to write model JSON for sourceId: ${sourceId}, path: ${filePath}, 耗时: ${duration}ms`, error.message, error.stack);
        throw error; // Re-throw
    }
}


/**
 * Lists models using the appropriate data source instance.
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

    const sourceId = sourceConfig.id;
    log.info(`[DataSourceInterface] Attempting to list models. sourceId: ${sourceId}, directory: ${directory}, supportedExts: ${supportedExts}`);
    log.debug(`[DataSourceInterface] Received sourceConfig: ${JSON.stringify(sourceConfig)}`);

    try {
        // 获取数据源实例
        const ds = getDataSourceInstance(sourceConfig);
        // 调用标准接口方法
        const models = await ds.listModels(directory, sourceConfig, supportedExts);
        const duration = Date.now() - startTime;
        log.info(`[DataSourceInterface] Successfully listed models for sourceId: ${sourceId}, directory: ${directory}. Found ${models.length} models. 耗时: ${duration}ms`);
        return models;
    } catch (error) {
        const duration = Date.now() - startTime;
        log.error(`[DataSourceInterface] Failed to list models for sourceId: ${sourceId}, directory: ${directory}, 耗时: ${duration}ms`, error.message, error.stack);
        throw error; // Re-throw
    }
}

/**
 * Lists subdirectories using the appropriate data source instance.
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

    const sourceId = sourceConfig.id;
    log.info(`[DataSourceInterface] Attempting to list subdirectories for sourceId: ${sourceId}`);

    try {
        // 获取数据源实例
        const ds = getDataSourceInstance(sourceConfig);
        // 调用标准接口方法
        const subdirs = await ds.listSubdirectories();
        const duration = Date.now() - startTime;
        log.info(`[DataSourceInterface] Successfully listed subdirectories for sourceId: ${sourceId}. Found ${subdirs.length} directories. 耗时: ${duration}ms`);
        return subdirs;
    } catch (error) {
        const duration = Date.now() - startTime;
        log.error(`[DataSourceInterface] Failed to list subdirectories for sourceId: ${sourceId}, 耗时: ${duration}ms`, error.message, error.stack);
        throw error; // Re-throw
    }
}

/**
 * Reads model detail using the appropriate data source instance.
 *
 * @param {object} sourceConfig - The configuration object for the data source.
 * @param {string} jsonPath - The path to the model's JSON file.
 * @returns {Promise<object>} A promise that resolves with the model detail object.
 * @throws {Error} If the data source type is unknown or reading fails.
 */
async function readModelDetail(sourceConfig, jsonPath, modelFilePath) {
    log.debug(`[DataSourceInterface readModelDetail] Entry. sourceId: ${sourceConfig?.id}, jsonPath: ${jsonPath}`);
    const startTime = Date.now();
    if (!sourceConfig || !sourceConfig.type || !sourceConfig.id) {
        log.error('[DataSourceInterface] readModelDetail called with invalid sourceConfig:', sourceConfig);
        throw new Error('Invalid source configuration provided (missing type or id).');
    }


    const sourceId = sourceConfig.id;
    log.info(`[DataSourceInterface] Attempting to read model detail for sourceId: ${sourceId}, path: ${jsonPath}`);

    try {
        // 获取数据源实例
        const ds = getDataSourceInstance(sourceConfig);
        // 调用标准接口方法
        const detail = await ds.readModelDetail(jsonPath||"", modelFilePath, sourceConfig.id);
        log.debug('[DataSourceInterface readModelDetail] modelObj from concrete data source:', JSON.stringify(detail, null, 2));
        const duration = Date.now() - startTime;
        log.info(`[DataSourceInterface] Successfully read model detail for sourceId: ${sourceId}, path: ${jsonPath}. 耗时: ${duration}ms`);
        return detail;
    } catch (error) {
        const duration = Date.now() - startTime;
        log.error(`[DataSourceInterface] Failed to read model detail for sourceId: ${sourceId}, path: ${jsonPath}, 耗时: ${duration}ms`, error.message, error.stack);
        // 保持原有逻辑，失败时返回空对象
        return {};
    }
}

/**
 * Gets image data using the appropriate data source instance.
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

    const sourceId = sourceConfig.id;
    log.info(`[DataSourceInterface] Attempting to get image data for sourceId: ${sourceId}, path: ${imagePath}`);

    try {
        // 获取数据源实例
        const ds = getDataSourceInstance(sourceConfig);
        // 调用标准接口方法
        const imageData = await ds.getImageData(imagePath);
        const duration = Date.now() - startTime;
        if (imageData) {
             log.info(`[DataSourceInterface] Successfully retrieved image data for sourceId: ${sourceId}, path: ${imagePath}. 耗时: ${duration}ms`);
        } else {
             log.warn(`[DataSourceInterface] Failed to get image data for sourceId: ${sourceId}, path: ${imagePath}. 耗时: ${duration}ms`);
        }
        return imageData;
    } catch (error) {
         const duration = Date.now() - startTime;
        // 保持原有逻辑，失败时返回 null
        log.error(`[DataSourceInterface] Failed to get image data for sourceId: ${sourceId}, path: ${imagePath}, 耗时: ${duration}ms`, error.message, error.stack);
        return null;
    }
}

/**
 * Gets file statistics (like mtimeMs and size) using the appropriate data source instance.
 *
 * @param {object} sourceConfig - The configuration object for the data source.
 * @param {string} filePath - The path to the file.
 * @returns {Promise<{mtimeMs: number, size: number}|null>} A promise that resolves with file stats or null if not found/error.
 * @throws {Error} If the data source type is unknown or fetching stats fails.
 */
async function getFileStats(sourceConfig, filePath) {
    const startTime = Date.now();
    if (!sourceConfig || !sourceConfig.type || !sourceConfig.id) {
        log.error('[DataSourceInterface] getFileStats called with invalid sourceConfig:', sourceConfig);
        throw new Error('Invalid source configuration provided (missing type or id).');
    }
    if (!filePath) {
        log.error('[DataSourceInterface] getFileStats called with invalid filePath:', filePath);
        throw new Error('Invalid filePath provided for getting file stats.');
    }

    const sourceId = sourceConfig.id;
    log.info(`[DataSourceInterface] Attempting to get file stats for sourceId: ${sourceId}, path: ${filePath}`);

    try {
        // 获取数据源实例
        const ds = getDataSourceInstance(sourceConfig);
        // 调用标准接口方法
        const stats = await ds.getFileStats(filePath);
        const duration = Date.now() - startTime;
        if (stats) {
             log.info(`[DataSourceInterface] Successfully retrieved file stats for sourceId: ${sourceId}, path: ${filePath}. 耗时: ${duration}ms`);
        } else {
             log.warn(`[DataSourceInterface] Failed to get file stats (returned null) for sourceId: ${sourceId}, path: ${filePath}. 耗时: ${duration}ms`);
        }
        return stats;
    } catch (error) {
         const duration = Date.now() - startTime;
        log.error(`[DataSourceInterface] Failed to get file stats for sourceId: ${sourceId}, path: ${filePath}, 耗时: ${duration}ms`, error.message, error.stack);
        // 根据具体数据源的实现，它可能会抛出错误或返回 null。
        // 此处重新抛出错误，让调用者处理。
        throw error;
    }
}

/**
 * 获取目录内容摘要（用于缓存失效判断）。
 * @param {object} sourceConfig - 数据源配置。
 * @param {string} directory - 目录路径（相对）。
 * @param {string[]} [supportedExts] - 支持的扩展名，仅 local 需要。
 * @param {boolean} [showSubdirectory] - 是否递归，仅 local 需要。
 * @returns {Promise<string|null>} 目录内容摘要（hash/etag/lastmod），失败时返回 null。
 */
async function getDirectoryContentMetadataDigest(sourceConfig, directory, supportedExts = [], showSubdirectory = false) {
    if (!sourceConfig || !sourceConfig.type || !sourceConfig.id) {
        log.error('[DataSourceInterface] getDirectoryContentMetadataDigest called with invalid sourceConfig:', sourceConfig);
        throw new Error('Invalid source configuration provided (missing type or id).');
    }
    const ds = getDataSourceInstance(sourceConfig);
    if (sourceConfig.type === 'local') {
        // local: 需要 supportedExts 和 showSubdirectory
        return await ds.getDirectoryContentMetadataDigest(directory, supportedExts, showSubdirectory);
    } else if (sourceConfig.type === 'webdav') {
        // webdav: 只需要目录
        return await ds.getDirectoryContentMetadataDigest(directory);
    } else {
        log.error(`[DataSourceInterface] getDirectoryContentMetadataDigest: Unsupported data source type: ${sourceConfig.type}`);
        throw new Error(`Unsupported data source type: ${sourceConfig.type}`);
    }
}

module.exports = {
    writeModelJson,
    listModels,
    listSubdirectories,
    readModelDetail,
    getImageData,
    getFileStats, // Export the new function
    getDirectoryContentMetadataDigest,
    // 可以选择性地导出 getDataSourceInstance 如果其他模块需要直接访问实例
    // getDataSourceInstance
};