const log = require('electron-log');
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

      // 1. Get source configuration using DataSourceService (Moved up)
      const sourceConfig = await this.dataSourceService.getSourceConfig(modelData.sourceId);
      if (!sourceConfig) {
        // DataSourceService already logs error if config not found
        throw new Error(`Configuration for source ID ${modelData.sourceId} not found.`);
      }
      log.debug(`[ModelService saveModel] Retrieved source config for ID: ${modelData.sourceId}`);

      // 2. Read existing data using dataSourceInterface
      let existingData = {};
      try {
        // Use readModelDetail which handles different source types and returns {} on error/not found
        existingData = await dataSourceInterface.readModelDetail(sourceConfig, modelData.jsonPath);
        if (Object.keys(existingData).length > 0) {
             log.debug(`[ModelService saveModel] Successfully read existing model data via interface: ${modelData.jsonPath}`);
        } else {
             log.info(`[ModelService saveModel] Existing model JSON not found or empty via interface (${modelData.jsonPath}). Will create new file or overwrite.`);
        }
      } catch (readError) {
          // Although readModelDetail handles errors internally and returns {},
          // catch potential errors from the interface call itself (e.g., invalid config passed).
          log.warn(`[ModelService saveModel] Error calling readModelDetail for ${modelData.jsonPath}: ${readError.message}. Assuming no existing data.`);
          existingData = {}; // Ensure starting from an empty object on interface error
      }


      // 3. Prepare final data using modelParser
      const finalDataToSave = prepareModelDataForSaving(existingData, modelData);
      log.debug(`[ModelService saveModel] Data prepared for saving. Keys: ${Object.keys(finalDataToSave)}`);

      // 4. Serialize data
      const dataToWrite = JSON.stringify(finalDataToSave, null, 2); // Pretty-print JSON
      log.debug(`[ModelService saveModel] Serialized data prepared for writing to: ${modelData.jsonPath}`);

      // 5. Write data using dataSourceInterface (Source config already retrieved)
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