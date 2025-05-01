const log = require('electron-log');
const fs = require('fs');
const path = require('path');
const dataSourceInterface = require('../data/dataSourceInterface'); // Adjusted path
const { prepareModelDataForSaving } = require('../data/modelParser'); // Adjusted path

class ModelService {
  /**
   * @param {import('./dataSourceService')} dataSourceService - An instance of DataSourceService.
   */
  constructor(dataSourceService) {
    if (!dataSourceService) {
      throw new Error("ModelService requires a DataSourceService instance.");
    }
    this.dataSourceService = dataSourceService;
    log.info('[Service] ModelService initialized.');
  }

  /**
   * Saves model data.
   * @param {object} modelData - The model data object, must include sourceId and jsonPath.
   * @returns {Promise<{success: boolean}>} - Resolves with success status or rejects on error.
   */
  async saveModel(modelData) {
    log.info('[ModelService] saveModel called', { jsonPath: modelData?.jsonPath, sourceId: modelData?.sourceId });
    try {
      if (!modelData || !modelData.jsonPath) {
        throw new Error('Model JSON path (modelData.jsonPath) is required for saving.');
      }
      if (!modelData.sourceId) {
        throw new Error('Source ID (modelData.sourceId) is required for saving.');
      }

      // 1. Read existing data (if any) - Directly using fs here as per original logic
      let existingData = {};
      try {
        // Assuming jsonPath is an absolute path accessible by the main process fs
        const rawData = await fs.promises.readFile(modelData.jsonPath, 'utf-8');
        existingData = JSON.parse(rawData);
        log.debug(`[ModelService saveModel] Successfully read existing model data: ${modelData.jsonPath}`);
      } catch (readError) {
        if (readError.code !== 'ENOENT') {
          log.warn(`[ModelService saveModel] Failed to read existing model JSON (${modelData.jsonPath}): ${readError.message}. Will create new file or overwrite.`);
        } else {
          log.info(`[ModelService saveModel] Existing model JSON not found (${modelData.jsonPath}). Will create new file.`);
        }
        existingData = {}; // Ensure starting from an empty object
      }

      // 2. Prepare final data using modelParser
      const finalDataToSave = prepareModelDataForSaving(existingData, modelData);
      log.debug(`[ModelService saveModel] Data prepared for saving. Keys: ${Object.keys(finalDataToSave)}`);

      // 3. Serialize data
      const dataToWrite = JSON.stringify(finalDataToSave, null, 2); // Pretty-print JSON
      log.debug(`[ModelService saveModel] Serialized data prepared for writing to: ${modelData.jsonPath}`);

      // 4. Get source configuration using DataSourceService
      const sourceConfig = await this.dataSourceService.getSourceConfig(modelData.sourceId);
      if (!sourceConfig) {
        // DataSourceService already logs error if config not found
        throw new Error(`Configuration for source ID ${modelData.sourceId} not found.`);
      }
      log.debug(`[ModelService saveModel] Retrieved source config for ID: ${modelData.sourceId}`);

      // 5. Write data using dataSourceInterface
      await dataSourceInterface.writeModelJson(sourceConfig, modelData, dataToWrite);
      log.info('[ModelService saveModel] Model saved successfully', { sourceId: modelData.sourceId, jsonPath: modelData.jsonPath });
      return { success: true };
    } catch (error) {
      log.error('[ModelService] Failed to save model:', error.message, error.stack, { modelData });
      throw error; // Re-throw the error to be handled by the caller (e.g., IPC layer)
    }
  }

  /**
   * Lists models within a specific directory of a data source.
   * @param {string} sourceId - The ID of the data source.
   * @param {string} directory - The directory path relative to the source root.
   * @returns {Promise<Array<object>>} - Resolves with an array of model info objects or rejects on error.
   */
  async listModels(sourceId, directory) {
    log.info(`[ModelService] listModels called. sourceId: ${sourceId}, directory: ${directory}`);
    try {
      // 1. Get source configuration and supported extensions using DataSourceService
      const sourceConfig = await this.dataSourceService.getSourceConfig(sourceId);
      if (!sourceConfig) {
        // DataSourceService already logs error if config not found
        return []; // Return empty array if source config is missing
      }
      const supportedExts = await this.dataSourceService.getSupportedExtensions();
      log.debug(`[ModelService listModels] Retrieved source config and supported extensions: ${supportedExts}`);

      // 2. List models using dataSourceInterface
      const models = await dataSourceInterface.listModels(sourceConfig, directory, supportedExts);
      log.info(`[ModelService listModels] Found ${models.length} models for source ${sourceId} in directory ${directory}`);
      return models;
    } catch (error) {
      log.error(`[ModelService] Error listing models for source ${sourceId} in directory ${directory}:`, error.message, error.stack);
      throw error; // Re-throw the error
    }
  }

  /**
   * Lists subdirectories within a data source.
   * @param {string} sourceId - The ID of the data source.
   * @returns {Promise<Array<string>>} - Resolves with an array of subdirectory names or rejects on error.
   */
  async listSubdirectories(sourceId) {
    log.info(`[ModelService] listSubdirectories called. sourceId: ${sourceId}`);
    try {
      // 1. Get source configuration using DataSourceService
      const sourceConfig = await this.dataSourceService.getSourceConfig(sourceId);
      if (!sourceConfig) {
        // DataSourceService already logs error if config not found
        return []; // Return empty array if source config is missing
      }
      log.debug(`[ModelService listSubdirectories] Retrieved source config for ID: ${sourceId}`);

      // 2. List subdirectories using dataSourceInterface
      const subdirs = await dataSourceInterface.listSubdirectories(sourceConfig);
      log.info(`[ModelService listSubdirectories] Found ${subdirs.length} subdirectories for source ${sourceId}`);
      return subdirs;
    } catch (error) {
      log.error(`[ModelService] Error listing subdirectories for source ${sourceId}:`, error.message, error.stack);
      throw error; // Re-throw the error
    }
  }

  /**
   * Gets the detailed information for a specific model.
   * @param {string} sourceId - The ID of the data source.
   * @param {string} jsonPath - The path to the model's JSON file relative to the source root.
   * @returns {Promise<object>} - Resolves with the model detail object or rejects on error.
   */
  async getModelDetail(sourceId, jsonPath) {
    log.info(`[ModelService] getModelDetail called. sourceId: ${sourceId}, jsonPath: ${jsonPath}`);
    try {
      // 1. Get source configuration using DataSourceService
      const sourceConfig = await this.dataSourceService.getSourceConfig(sourceId);
       if (!sourceConfig) {
        // DataSourceService already logs error if config not found
        // The original IPC handler returned {}, let's mimic that for consistency,
        // although throwing might be cleaner. Interface also handles this.
        return {};
      }
      log.debug(`[ModelService getModelDetail] Retrieved source config for ID: ${sourceId}`);

      // 2. Read model detail using dataSourceInterface
      // The interface function handles internal try/catch and logging, returning {} on error.
      const detail = await dataSourceInterface.readModelDetail(sourceConfig, jsonPath);
      log.info(`[ModelService getModelDetail] Successfully retrieved model detail for source ${sourceId}, path ${jsonPath}`);
      return detail;
    } catch (error) {
      // This catch block might be redundant if the interface handles all errors,
      // but keep it for safety to catch unexpected issues (like sourceConfig failing).
      log.error(`[ModelService] Error getting model detail for source ${sourceId}, path ${jsonPath}:`, error.message, error.stack);
      // Re-throw to allow caller (IPC) to handle it, consistent with original IPC logic.
      throw error;
    }
  }
}

module.exports = ModelService;