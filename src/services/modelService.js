const log = require('electron-log');
const path = require('path');
const crypto = require('crypto'); // For hashing supportedExts
const dataSourceInterface = require('../data/dataSourceInterface'); // Adjusted path
const { prepareModelDataForSaving } = require('../data/modelParser'); // Adjusted path

// Helper function to generate hash for supported extensions
function generateSupportedExtsHash(extensions) {
  if (!Array.isArray(extensions) || extensions.length === 0) {
    return crypto.createHash('sha256').update('').digest('hex');
  }
  const sortedExts = [...extensions].map(ext => ext.toLowerCase()).sort();
  const extsString = sortedExts.join('|');
  return crypto.createHash('sha256').update(extsString).digest('hex');
}

class ModelService {
  /**
   * @param {import('./dataSourceService')} dataSourceService - An instance of DataSourceService.
   * @param {import('./configService')} configService - An instance of ConfigService.
   * @param {import('./modelInfoCacheService')} modelInfoCacheService - An instance of ModelInfoCacheService.
   */
  constructor(dataSourceService, modelInfoCacheService, configService) {
    if (!dataSourceService) {
      throw new Error("ModelService requires a DataSourceService instance.");
    }
    if (!modelInfoCacheService) {
      throw new Error("ModelService requires a ModelInfoCacheService instance.");
    }
    if (!configService) {
      throw new Error("ModelService requires a ConfigService instance.");
    }
    this.dataSourceService = dataSourceService;
    this.modelInfoCacheService = modelInfoCacheService;
    this.configService = configService;
    this.filterOptionsCache = new Map(); // Cache for filter options by sourceId
    log.info('[Service] ModelService initialized with DataSourceService, ModelInfoCacheService, and ConfigService.');
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

      const sourceConfig = await this.dataSourceService.getSourceConfig(modelObj.sourceId);
      if (!sourceConfig) {
        throw new Error(`Configuration for source ID ${modelObj.sourceId} not found.`);
      }
      log.debug(`[ModelService saveModel] Retrieved source config for ID: ${modelObj.sourceId}`);

      if (modelObj.modelJsonInfo) {
        if (modelObj.modelJsonInfo.hasOwnProperty('basic') && modelObj.modelJsonInfo.hasOwnProperty('baseModel')) {
          delete modelObj.modelJsonInfo.basic;
          log.debug('[ModelService saveModel] Deleted modelObj.modelJsonInfo.basic as baseModel also exists.');
        } else if (modelObj.modelJsonInfo.hasOwnProperty('basic') && !modelObj.modelJsonInfo.hasOwnProperty('baseModel')) {
          modelObj.modelJsonInfo.baseModel = modelObj.modelJsonInfo.basic;
          delete modelObj.modelJsonInfo.basic;
          log.debug('[ModelService saveModel] Moved modelObj.modelJsonInfo.basic to baseModel and deleted basic.');
        }
      }

      const dataToSave = prepareModelDataForSaving(modelObj);
      log.debug(`[ModelService saveModel] Data prepared for saving. Keys: ${Object.keys(dataToSave)}`);
      const jsonDataString = JSON.stringify(dataToSave, null, 2);
      log.debug(`[ModelService saveModel] Data (string) prepared for writing to: ${modelObj.jsonPath}`);

      const modelIdentifier = {
        jsonPath: modelObj.jsonPath,
        sourceId: modelObj.sourceId
      };

      await dataSourceInterface.writeModelJson(sourceConfig, modelIdentifier, jsonDataString, this.modelInfoCacheService);
      log.info('[ModelService saveModel] Model JSON data written successfully', { sourceId: modelObj.sourceId, jsonPath: modelObj.jsonPath });

      // Cache invalidation logic removed as it's now handled by data sources.
      log.info(`[ModelService saveModel] Model JSON data written. Cache invalidation is now handled by data sources.`);

      const updatedFullModelObj = await this.getModelDetail(modelObj.sourceId, modelObj.jsonPath, modelObj.file);
      log.info('[ModelService saveModel] Successfully retrieved updated full model object after save.', { sourceId: modelObj.sourceId, jsonPath: modelObj.jsonPath });
      return updatedFullModelObj;

    } catch (error) {
      log.error('[ModelService] Failed to save model or retrieve updated details:', error.message, error.stack, { modelObj });
      throw error;
    }
  }

  async listModels(sourceId, directory, filters = {}, supportedExtensions = null, showSubdirectory = true) {
    const startTime = Date.now();
    log.info(`[ModelService] listModels called. sourceId: ${sourceId}, directory: ${directory}, filters: ${JSON.stringify(filters)}, showSubDir: ${showSubdirectory}`);

    const sourceConfig = await this.dataSourceService.getSourceConfig(sourceId);
    if (!sourceConfig) {
      log.warn(`[ModelService listModels] Source config not found for ID: ${sourceId}. Returning empty array.`);
      return [];
    }
    const extsToUse = supportedExtensions || await this.dataSourceService.getSupportedExtensions();

    // L1 cache logic removed. Fetching directly from data source.
    log.info(`[ModelService listModels] Fetching model list from dataSourceInterface for source: ${sourceId}, dir: ${directory}. Cache is now handled by data sources.`);
    let baseModelInfos = await dataSourceInterface.listModels(sourceConfig, directory, extsToUse, showSubdirectory, this.modelInfoCacheService);
    log.info(`[ModelService listModels] Fetched ${baseModelInfos.length} raw model entries for source ${sourceId} in directory ${directory}`);

    const modelObjs = [];
    for (const baseInfo of baseModelInfos) {
        try {
            const fullModelDetail = await this.getModelDetail(baseInfo.sourceId || sourceId, baseInfo.jsonPath, baseInfo.file);
            if (fullModelDetail && Object.keys(fullModelDetail).length > 0) {
                modelObjs.push(fullModelDetail);
            } else {
                log.warn(`[ModelService listModels] Skipping model as getModelDetail returned empty for ${baseInfo.jsonPath}`);
            }
        } catch (detailError) {
            log.error(`[ModelService listModels] Error fetching detail for ${baseInfo.jsonPath}: ${detailError.message}. Skipping this model.`);
        }
    }
    log.info(`[ModelService listModels] Constructed ${modelObjs.length} full model objects for source ${sourceId} in directory ${directory}`);
    
    // L1 cache setting logic removed.
    const filteredModelObjs = this._applyFiltersToListModels(modelObjs, filters, sourceId, directory);
    const duration = Date.now() - startTime;
    log.info(`[ModelService listModels] Finished (from source). Duration: ${duration}ms. Source: ${sourceId}, Dir: ${directory}, Models: ${filteredModelObjs.length}`);
    return filteredModelObjs;
  }

  _applyFiltersToListModels(modelObjs, filters, sourceId, directory) {
      log.debug(`[ModelService _applyFiltersToListModels] Before filtering. Count: ${modelObjs.length}`);
      if (filters && ( (Array.isArray(filters.baseModel) && filters.baseModel.length > 0) || (Array.isArray(filters.modelType) && filters.modelType.length > 0) )) {
        const baseModelFilter = (filters.baseModel && Array.isArray(filters.baseModel)) ? filters.baseModel.map(bm => bm.toLowerCase()) : [];
        const modelTypeFilter = (filters.modelType && Array.isArray(filters.modelType)) ? filters.modelType.map(mt => mt.toLowerCase()) : [];

        modelObjs = modelObjs.filter(modelObj => {
          let passesBaseModel = true;
          if (baseModelFilter.length > 0) {
            passesBaseModel = modelObj.baseModel && typeof modelObj.baseModel === 'string' && baseModelFilter.includes(modelObj.baseModel.toLowerCase());
          }

          let passesModelType = true;
          if (modelTypeFilter.length > 0) {
            passesModelType = modelObj.modelType && typeof modelObj.modelType === 'string' && modelTypeFilter.includes(modelObj.modelType.toLowerCase());
          }
          
          return passesBaseModel && passesModelType;
        });
        log.debug(`[ModelService _applyFiltersToListModels] Filtered model objects. Count: ${modelObjs.length}`);
      }

      log.info(`[ModelService _applyFiltersToListModels] Returning ${modelObjs.length} filtered model objects for source ${sourceId} in directory ${directory}`);

      function _isDefaultDirectory(dir) {
        return dir === '' || dir === '/' || dir === './' || dir === null || typeof dir === 'undefined';
      }

      function _areFiltersEmpty(fltrs) {
        if (!fltrs || Object.keys(fltrs).length === 0) {
          return true;
        }
        const { baseModel, modelType } = fltrs;
        const isBaseModelFilterEmpty = !baseModel || (Array.isArray(baseModel) && baseModel.length === 0);
        const isModelTypeFilterEmpty = !modelType || (Array.isArray(modelType) && modelType.length === 0);
        
        return isBaseModelFilterEmpty && isModelTypeFilterEmpty;
      }
      
      if (_isDefaultDirectory(directory) && _areFiltersEmpty(filters)) {
        const baseModels = new Set();
        const modelTypes = new Set();

        modelObjs.forEach(modelObj => {
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
  }
  
  async listSubdirectories(sourceId) {
    log.info(`[ModelService] listSubdirectories called. sourceId: ${sourceId}`);
    try {
      const sourceConfig = await this.dataSourceService.getSourceConfig(sourceId);
      if (!sourceConfig) {
        return [];
      }
      log.debug(`[ModelService listSubdirectories] Retrieved source config for ID: ${sourceId}`);

      const subdirs = await dataSourceInterface.listSubdirectories(sourceConfig, this.modelInfoCacheService);
      log.info(`[ModelService listSubdirectories] Found ${subdirs.length} subdirectories for source ${sourceId}`);
      return subdirs;
    } catch (error) {
      log.error(`[ModelService] Error listing subdirectories for source ${sourceId}:`, error.message, error.stack);
      throw error;
    }
  }

  async getModelDetail(sourceId, jsonPath, modelFilePath = null) {
    log.info(`[ModelService] getModelDetail called. sourceId: ${sourceId}, jsonPath: ${jsonPath}, modelFilePath: ${modelFilePath}`);
    // Cache logic removed. Fetching directly from data source.
    log.info(`[ModelService getModelDetail] Fetching full model detail from dataSourceInterface for ${jsonPath}. Cache is now handled by data sources.`);

    try {
      const sourceConfig = await this.dataSourceService.getSourceConfig(sourceId);
      if (!sourceConfig) {
        log.warn(`[ModelService getModelDetail] Source config not found for ID: ${sourceId}. Cannot proceed.`);
        return {};
      }
      log.debug(`[ModelService getModelDetail] Retrieved source config for ID: ${sourceId}`);

      const fullModelObj = await dataSourceInterface.readModelDetail(sourceConfig, jsonPath, modelFilePath, this.modelInfoCacheService);
      
      if (!fullModelObj || Object.keys(fullModelObj).length === 0) {
        log.warn(`[ModelService getModelDetail] dataSourceInterface.readModelDetail did not return a valid modelObj for ${jsonPath}.`);
        return {};
      }
      
      log.info(`[ModelService getModelDetail] Successfully retrieved model detail for source ${sourceId}, path ${jsonPath}`);
      return fullModelObj;

    } catch (error) {
      log.error(`[ModelService] Error getting model detail for source ${sourceId}, path ${jsonPath}:`, error.message, error.stack);
      throw error;
    }
  }

  async getAvailableFilterOptions(sourceId = null, directory = '', supportedExtensions = null) {
    log.info(`[ModelService] getAvailableFilterOptions called. sourceId: ${sourceId || 'all'}, directory: ${directory}`);
    if (!sourceId) {
      log.debug('[ModelService getAvailableFilterOptions] sourceId is null or undefined, returning empty options immediately.');
      return { baseModels: [], modelTypes: [] };
    }

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
        modelObjsToProcess = await this.listModels(sourceId, '', {}, extsToUse, true); 
        log.debug(`[ModelService getAvailableFilterOptions] Fetched ${modelObjsToProcess.length} modelObjs for source ${sourceId} to build filter options.`);
      } catch (error) {
        log.error(`[ModelService getAvailableFilterOptions] Error listing modelObjs for source ${sourceId}: ${error.message}`);
        return { baseModels: [], modelTypes: [] };
      }

      const baseModels = new Set();
      const modelTypes = new Set();

      modelObjsToProcess.forEach(modelObj => {
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