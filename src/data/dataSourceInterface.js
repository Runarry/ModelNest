// src/data/dataSourceInterface.js
const log = require('electron-log');
// 导入具体的数据源实现（移至 getDataSourceInstance 内部）
const { LocalDataSource } = require('./localDataSource');
const { WebDavDataSource } = require('./webdavDataSource');

// 缓存数据源实例，键为 sourceId，值为 DataSource 实例
const dataSourceInstances = {};

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
        // 注意：这种比较可能不够健壮，取决于 sourceConfig 如何传递和修改
        if (dataSourceInstances[sourceId].config === sourceConfig) {
             log.debug(`[DataSourceInterface] Reusing existing DataSource instance for sourceId: ${sourceId}`);
             return dataSourceInstances[sourceId];
        } else {
             log.warn(`[DataSourceInterface] Source config changed for sourceId: ${sourceId}. Creating new instance.`);
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
        const models = await ds.listModels(directory, supportedExts);
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

    const sourceId = sourceConfig.id;
    log.info(`[DataSourceInterface] Attempting to read model detail for sourceId: ${sourceId}, path: ${jsonPath}`);

    try {
        // 获取数据源实例
        const ds = getDataSourceInstance(sourceConfig);
        // 调用标准接口方法
        const detail = await ds.readModelDetail(jsonPath);
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


module.exports = {
    writeModelJson,
    listModels,
    listSubdirectories,
    readModelDetail,
    getImageData,
    // 可以选择性地导出 getDataSourceInstance 如果其他模块需要直接访问实例
    // getDataSourceInstance
};