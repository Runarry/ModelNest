// src/data/dataSourceInterface.js
const fs = require('fs');
const path = require('path');
const log = require('electron-log');
// 导入 WebDavDataSource 以便在需要时创建实例
const { WebDavDataSource } = require('./webdavDataSource');

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
            const tempWebDavSource = new WebDavDataSource(sourceConfig);
            // The writeModelJson method within WebDavDataSource handles ensureInitialized
            await tempWebDavSource.writeModelJson(jsonPath, dataToWrite);
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

module.exports = {
    writeModelJson
};