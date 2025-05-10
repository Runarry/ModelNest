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
    this.filterOptionsCache = new Map(); // Cache for filter options by sourceId
    log.info('[Service] ModelService initialized.');
  }

  /**
   * Saves model data.
   * @param {object} modelObj - The model object, now in the new structure { ...modelBaseInfo, modelJsonInfo: { ... } }.
   * @returns {Promise<{success: boolean}>} - Resolves with success status or rejects on error.
   */
  async saveModel(modelObj) {
    log.info('[ModelService] saveModel called', { jsonPath: modelObj?.jsonPath, sourceId: modelObj?.sourceId });
    try {
      if (!modelObj || !modelObj.jsonPath) {
        throw new Error('Model JSON path (modelObj.jsonPath) is required for saving.');
      }
      if (!modelObj.sourceId) {
        throw new Error('Source ID (modelObj.sourceId) is required for saving.');
      }
      if (!modelObj.modelJsonInfo) {
        throw new Error('modelJsonInfo is required for saving.');
      }

      // 1. Get source configuration using DataSourceService
      const sourceConfig = await this.dataSourceService.getSourceConfig(modelObj.sourceId);
      if (!sourceConfig) {
        throw new Error(`Configuration for source ID ${modelObj.sourceId} not found.`);
      }
      log.debug(`[ModelService saveModel] Retrieved source config for ID: ${modelObj.sourceId}`);

      // 2. Prepare data for saving using modelParser
      // modelParser.prepareModelDataForSaving now expects modelObj and returns a deep copy of modelObj.modelJsonInfo
      const dataToSave = prepareModelDataForSaving(modelObj);
      log.debug(`[ModelService saveModel] Data prepared for saving. Keys: ${Object.keys(dataToSave)}`);

      // 3. Serialize data
      // const dataToWrite = JSON.stringify(dataToSave, null, 2); // Pretty-print JSON // Removed as per review
      log.debug(`[ModelService saveModel] Data (object) prepared for writing to: ${modelObj.jsonPath}`);

      // 4. Define modelIdentifier for dataSourceInterface.writeModelJson
      const modelIdentifier = {
        jsonPath: modelObj.jsonPath,
        sourceId: modelObj.sourceId
        // Add any other fields required by dataSourceInterface.writeModelJson for identification
      };

      // 5. Write data using dataSourceInterface
      await dataSourceInterface.writeModelJson(sourceConfig, modelIdentifier, dataToSave);
      log.info('[ModelService saveModel] Model saved successfully', { sourceId: modelObj.sourceId, jsonPath: modelObj.jsonPath });
      return { success: true };
    } catch (error) {
      log.error('[ModelService] Failed to save model:', error.message, error.stack, { modelObj });
      throw error; // Re-throw the error to be handled by the caller (e.g., IPC layer)
    }
  }

  /**
   * Lists models within a specific directory of a data source.
   * @param {string} sourceId - The ID of the data source.
   * @param {string} directory - The directory path relative to the source root.
   * @returns {Promise<Array<object>>} - Resolves with an array of model objects (new modelObj structure) or rejects on error.
   */
  async listModels(sourceId, directory, filters = {}, supportedExtensions = null, showSubdirectory = false) { // Added supportedExtensions and showSubdirectory for consistency, though not directly used by current logic based on instructions
    log.info(`[ModelService] listModels called. sourceId: ${sourceId}, directory: ${directory}, filters: ${JSON.stringify(filters)}, showSubdirectory: ${showSubdirectory}`);
    log.debug('[ModelService listModels] Entry point. Parameters:', { sourceId, directory, filters, supportedExtensions, showSubdirectory });
    try {
      // 1. Get source configuration and supported extensions using DataSourceService
      const sourceConfig = await this.dataSourceService.getSourceConfig(sourceId);
      if (!sourceConfig) {
        return [];
      }
      // Use provided supportedExtensions if available, otherwise fetch from service.
      // The instruction implies dataSourceInterface.listModels will handle supportedExtensions.
      const extsToUse = supportedExtensions || await this.dataSourceService.getSupportedExtensions();
      log.debug(`[ModelService listModels] Retrieved source config. Using supported extensions: ${extsToUse}`);

      // 2. List models using dataSourceInterface
      // dataSourceInterface.listModels now returns an array of modelObj
      let modelObjs = await dataSourceInterface.listModels(sourceConfig, directory, extsToUse, showSubdirectory);
      log.debug(`[ModelService listModels] Raw modelObjs from dataSourceInterface (length: ${modelObjs.length}):`, JSON.stringify(modelObjs.slice(0, 5), null, 2)); // Log first 5 for brevity
      log.info(`[ModelService listModels] Found ${modelObjs.length} raw model objects for source ${sourceId} in directory ${directory}`);


      // 3. Apply filters if any (filters now apply to modelObj properties)
      log.debug(`[ModelService listModels] Before filtering. Count: ${modelObjs.length}`);
      if (filters && ( (Array.isArray(filters.baseModel) && filters.baseModel.length > 0) || (Array.isArray(filters.modelType) && filters.modelType.length > 0) )) {
        const baseModelFilter = (filters.baseModel && Array.isArray(filters.baseModel)) ? filters.baseModel.map(bm => bm.toLowerCase()) : [];
        const modelTypeFilter = (filters.modelType && Array.isArray(filters.modelType)) ? filters.modelType.map(mt => mt.toLowerCase()) : [];

        modelObjs = modelObjs.filter(modelObj => {
          let passesBaseModel = true;
          if (baseModelFilter.length > 0) {
            // Access baseModel from the top-level of modelObj
            passesBaseModel = modelObj.baseModel && typeof modelObj.baseModel === 'string' && baseModelFilter.includes(modelObj.baseModel.toLowerCase());
          }

          let passesModelType = true;
          if (modelTypeFilter.length > 0) {
            // Access modelType from the top-level of modelObj
            passesModelType = modelObj.modelType && typeof modelObj.modelType === 'string' && modelTypeFilter.includes(modelObj.modelType.toLowerCase());
          }
          
          return passesBaseModel && passesModelType;
        });
        log.debug(`[ModelService listModels] Filtered model objects. Count: ${modelObjs.length}`);
      }

      log.info(`[ModelService listModels] Returning ${modelObjs.length} filtered model objects for source ${sourceId} in directory ${directory}`);

      // Helper function to check if the directory is default or root
      function _isDefaultDirectory(dir) {
        return dir === '' || dir === '/' || dir === './' || dir === null || typeof dir === 'undefined';
      }

      // Helper function to check if filters are empty or not set
      function _areFiltersEmpty(fltrs) {
        if (!fltrs || Object.keys(fltrs).length === 0) {
          return true;
        }
        const { baseModel, modelType } = fltrs;
        const isBaseModelFilterEmpty = !baseModel || (Array.isArray(baseModel) && baseModel.length === 0);
        const isModelTypeFilterEmpty = !modelType || (Array.isArray(modelType) && modelType.length === 0);
        
        // Consider filters empty if all specified filter arrays are effectively empty
        return isBaseModelFilterEmpty && isModelTypeFilterEmpty;
      }
      
      // Update cache when listing root directory with no filters
      // The cache update logic should now use modelObj properties
      if (_isDefaultDirectory(directory) && _areFiltersEmpty(filters)) {
        const baseModels = new Set();
        const modelTypes = new Set();

        modelObjs.forEach(modelObj => {
          // Access baseModel and modelType from the top-level of modelObj
          if (modelObj.baseModel && typeof modelObj.baseModel === 'string' && modelObj.baseModel.trim() !== '') {
            baseModels.add(modelObj.baseModel.trim());
          }
          if (modelObj.modelType && typeof modelObj.modelType === 'string' && modelObj.modelType.trim() !== '') {
            modelTypes.add(modelObj.modelType.trim().toUpperCase());
          }
        });

        this.filterOptionsCache.set(sourceId, {
          baseModels: Array.from(baseModels).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })),
          modelTypes: Array.from(modelTypes).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        });
        log.debug(`[ModelService listModels] Updated filter options cache for source ${sourceId}`);
      }

      return modelObjs;
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
   * @param {string} [modelFilePath] - Optional: The path to the main model file (e.g. .safetensors). Used by dataSourceInterface if needed.
   * @returns {Promise<object>} - Resolves with the model detail object (new modelObj structure) or rejects on error.
   */
  async getModelDetail(sourceId, jsonPath, modelFilePath = null) { // Added modelFilePath as per typical usage, though instructions focus on jsonPath
    log.info(`[ModelService] getModelDetail called. sourceId: ${sourceId}, jsonPath: ${jsonPath}, modelFilePath: ${modelFilePath}`);
    try {
      // 1. Get source configuration using DataSourceService
      const sourceConfig = await this.dataSourceService.getSourceConfig(sourceId);
       if (!sourceConfig) {
        return {}; // Return empty object if source config is missing
      }
      log.debug(`[ModelService getModelDetail] Retrieved source config for ID: ${sourceId}`);

      // 2. Read model detail using dataSourceInterface
      // dataSourceInterface.readModelDetail now returns a modelObj
      // It might need modelFilePath for constructing the full modelObj if jsonPath alone isn't enough for all base info.
      const modelObj = await dataSourceInterface.readModelDetail(sourceConfig, jsonPath, modelFilePath);
      log.info(`[ModelService getModelDetail] Successfully retrieved model detail (modelObj) for source ${sourceId}, path ${jsonPath}`);
      return modelObj;
    } catch (error) {
      log.error(`[ModelService] Error getting model detail for source ${sourceId}, path ${jsonPath}:`, error.message, error.stack);
      throw error;
    }
  }

  /**
   * Gets available filter options (baseModels, modelTypes).
   * If a sourceId is provided, options are fetched only for that source.
   * Otherwise, options are aggregated from all sources.
   * @param {string} [sourceId=null] - Optional ID of the data source.
   * @param {string} [directory=''] - Optional directory to scan.
   * @param {string[]} [supportedExtensions=null] - Optional list of supported extensions.
   * @returns {Promise<{baseModels: Array<string>, modelTypes: Array<string>}>}
   */
  async getAvailableFilterOptions(sourceId = null, directory = '', supportedExtensions = null) { // Added directory and supportedExtensions as per typical usage
    log.info(`[ModelService] getAvailableFilterOptions called. sourceId: ${sourceId || 'all'}, directory: ${directory}`);
    if (!sourceId) {
      log.debug('[ModelService getAvailableFilterOptions] sourceId is null or undefined, returning empty options immediately.');
      return { baseModels: [], modelTypes: [] };
    }

    // Cache key could be more specific if directory/extensions matter for filter options,
    // but current logic updates cache based on root listing.
    // For simplicity, using sourceId as cache key as before.
    if (this.filterOptionsCache.has(sourceId)) {
      log.debug(`[ModelService getAvailableFilterOptions] Using cached filter options for source ${sourceId}`);
      return this.filterOptionsCache.get(sourceId);
    }

    try {
      let modelObjsToProcess = [];

      const sourceConfig = await this.dataSourceService.getSourceConfig(sourceId);
      if (!sourceConfig) {
        log.warn(`[ModelService getAvailableFilterOptions] No configuration found for sourceId: ${sourceId}. Returning empty options.`);
        return { baseModels: [], modelTypes: [] };
      }

      const extsToUse = supportedExtensions || await this.dataSourceService.getSupportedExtensions();

      try {
        // Fetch all modelObjs from the specified directory (or root if empty) of the source, no pre-filtering.
        // listModels now returns modelObjs.
        // Pass empty filter {} and showSubdirectory=true to get all models for accurate filter options.
        // The cache update in listModels is for root directory and no filters.
        // This function might need to call listModels with specific parameters to ensure it gets all data for options.
        // For now, assuming listModels called with empty directory and no filters is sufficient for populating cache,
        // or that this function's primary role is to read the cache populated by a general listModels call.
        // Based on instruction 4, this function calls `this.listModels`.
        // We should list models from the root to get comprehensive filter options.
        modelObjsToProcess = await this.listModels(sourceId, '', {}, extsToUse, true); // List all models in root, including subdirectories
        log.debug(`[ModelService getAvailableFilterOptions] Fetched ${modelObjsToProcess.length} modelObjs for source ${sourceId} to build filter options.`);
      } catch (error) {
        log.error(`[ModelService getAvailableFilterOptions] Error listing modelObjs for source ${sourceId}: ${error.message}`);
        return { baseModels: [], modelTypes: [] };
      }

      const baseModels = new Set();
      const modelTypes = new Set();

      modelObjsToProcess.forEach(modelObj => {
        // Extract from modelObj's top-level properties (modelBaseInfo part)
        if (modelObj.baseModel && typeof modelObj.baseModel === 'string' && modelObj.baseModel.trim() !== '') {
          baseModels.add(modelObj.baseModel.trim());
        }
        if (modelObj.modelType && typeof modelObj.modelType === 'string' && modelObj.modelType.trim() !== '') {
          modelTypes.add(modelObj.modelType.trim().toUpperCase());
        }
      });
      
      const sortedBaseModels = Array.from(baseModels).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      const sortedModelTypes = Array.from(modelTypes).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      const options = {
        baseModels: sortedBaseModels,
        modelTypes: sortedModelTypes,
      };
      
      // Update cache with newly generated options for this sourceId
      // This ensures that if listModels (which also updates cache) hasn't run for root yet,
      // we still populate the cache here.
      this.filterOptionsCache.set(sourceId, options);
      log.info(`[ModelService getAvailableFilterOptions] Options generated and cached for source ${sourceId} - BaseModels: ${sortedBaseModels.length}, ModelTypes: ${sortedModelTypes.length}`);
      return options;
    } catch (error) {
      log.error('[ModelService] Error in getAvailableFilterOptions:', error.message, error.stack);
      return { baseModels: [], modelTypes: [] };
    }
  }
}

module.exports = ModelService;