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
   * @param {import('./modelInfoCacheService')} modelInfoCacheService - An instance of ModelInfoCacheService.
   * @param {import('./configService')} configService - An instance of ConfigService.
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
    log.info('[Service] ModelService initialized with ModelInfoCacheService and ConfigService.');
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

      await dataSourceInterface.writeModelJson(sourceConfig, modelIdentifier, jsonDataString);
      log.info('[ModelService saveModel] Model JSON data written successfully', { sourceId: modelObj.sourceId, jsonPath: modelObj.jsonPath });

      const modelJsonInfoCacheKey = `modelJsonInfo:${modelObj.sourceId}:${modelObj.jsonPath}`;
      this.modelInfoCacheService.deleteFromL1(modelJsonInfoCacheKey); 
      log.info(`[ModelService saveModel] Invalidated L1 cache for key: ${modelJsonInfoCacheKey}`);
      await this.modelInfoCacheService.invalidateL2(modelJsonInfoCacheKey, 'modelJsonInfo'); 
      log.info(`[ModelService saveModel] Invalidated L2 modelJsonInfo cache for key: ${modelJsonInfoCacheKey}`);

      try {
        const dirPath = path.dirname(modelObj.jsonPath); 
        const normalizedDirPath = dirPath === '.' ? '' : dirPath.replace(/^\/+|\/+$/g, '');
        log.info(`[ModelService saveModel] Invalidating listModels L1 cache for directory: ${normalizedDirPath}, sourceId: ${modelObj.sourceId}`);
        await this.modelInfoCacheService.invalidateListModelsCacheForDirectory(modelObj.sourceId, normalizedDirPath);
      } catch (cacheError) {
        log.error(`[ModelService saveModel] Failed to invalidate listModels L1 cache for ${modelObj.jsonPath}: ${cacheError.message}`, cacheError);
      }

      const updatedFullModelObj = await this.getModelDetail(modelObj.sourceId, modelObj.jsonPath, modelObj.file);
      log.info('[ModelService saveModel] Successfully retrieved updated full model object after save.', { sourceId: modelObj.sourceId, jsonPath: modelObj.jsonPath });
      return updatedFullModelObj;

    } catch (error) {
      log.error('[ModelService] Failed to save model or retrieve updated details:', error.message, error.stack, { modelObj });
      throw error;
    }
  }

  async listModels(sourceId, directory, filters = {}, supportedExtensions = null, showSubdirectory = false) {
    const startTime = Date.now();
    log.info(`[ModelService] listModels called. sourceId: ${sourceId}, directory: ${directory}, filters: ${JSON.stringify(filters)}, showSubDir: ${showSubdirectory}`);

    const sourceConfig = await this.dataSourceService.getSourceConfig(sourceId);
    if (!sourceConfig) {
      log.warn(`[ModelService listModels] Source config not found for ID: ${sourceId}. Returning empty array.`);
      return [];
    }
    const extsToUse = supportedExtensions || await this.dataSourceService.getSupportedExtensions();

    let normalizedDirectoryPath = directory || '';
    if (normalizedDirectoryPath === '/' || normalizedDirectoryPath === './') {
        normalizedDirectoryPath = '';
    }
    normalizedDirectoryPath = normalizedDirectoryPath.replace(/^\/+|\/+$/g, '');

    const showSubdirectoryFlag = showSubdirectory ? 1 : 0;
    const supportedExtsHash = generateSupportedExtsHash(extsToUse);
    const listModelsCacheKey = `listModels:${sourceId}:${normalizedDirectoryPath}:${showSubdirectoryFlag}:${supportedExtsHash}`;
    log.debug(`[ModelService listModels] L1 Cache key generated: ${listModelsCacheKey}`);

    let currentDirectoryContentHash = null;

    const l1CacheEntry = await this.modelInfoCacheService.getFromL1(listModelsCacheKey, 'listModels');

    if (l1CacheEntry) {
      log.debug(`[ModelService listModels] L1 cache hit for key: ${listModelsCacheKey}. Validating...`);
      const { data: cachedModelArray, directoryContentHash: l1DirectoryContentHash } = l1CacheEntry; 

      let isL1Valid = true;
      if (sourceConfig.type === 'local') {
        try {
          currentDirectoryContentHash = await dataSourceInterface.getDirectoryContentMetadataDigest(sourceConfig, normalizedDirectoryPath, extsToUse, showSubdirectory);
          if (currentDirectoryContentHash !== l1DirectoryContentHash) {
            log.info(`[ModelService listModels] L1 cache for LocalDataSource stale (digest mismatch) for ${listModelsCacheKey}. Current: ${currentDirectoryContentHash}, Cached: ${l1DirectoryContentHash}`);
            isL1Valid = false;
          } else {
            log.info(`[ModelService listModels] L1 cache for LocalDataSource valid (digest match) for ${listModelsCacheKey}.`);
          }
        } catch (e) {
          log.warn(`[ModelService listModels] Error getting directory content digest for ${sourceId}:${normalizedDirectoryPath}. Assuming L1 stale. Error: ${e.message}`);
          isL1Valid = false;
          currentDirectoryContentHash = null;
        }
      }

      if (isL1Valid) {
        log.info(`[ModelService listModels] L1 cache valid for ${listModelsCacheKey}. Returning ${cachedModelArray.length} models from L1 cache.`);
        const filteredFromCache = this._applyFiltersToListModels(cachedModelArray, filters, sourceId, directory);
        const duration = Date.now() - startTime;
        log.info(`[ModelService listModels] Finished (from L1 cache). Duration: ${duration}ms. Source: ${sourceId}, Dir: ${directory}, Models: ${filteredFromCache.length}`);
        return filteredFromCache;
      }
    } else {
      log.info(`[ModelService listModels] L1 cache miss for key: ${listModelsCacheKey}`);
    }

    log.info(`[ModelService listModels] Fetching fresh model list from dataSourceInterface for source: ${sourceId}, dir: ${directory}`);
    let baseModelInfos = await dataSourceInterface.listModels(sourceConfig, directory, extsToUse, showSubdirectory);
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

    if (sourceConfig.type === 'local' && currentDirectoryContentHash === null) { 
        try {
            currentDirectoryContentHash = await dataSourceInterface.getDirectoryContentMetadataDigest(sourceConfig, normalizedDirectoryPath, extsToUse, showSubdirectory);
            log.debug(`[ModelService listModels] Calculated directory content hash for L1 caching (Local): ${currentDirectoryContentHash}`);
        } catch (e) {
            log.warn(`[ModelService listModels] Error recalculating directory content digest for L1 caching. Will cache without hash. Error: ${e.message}`);
            currentDirectoryContentHash = undefined;
        }
    }

    const ttlConfigPath = sourceConfig.type === 'local' ? 'cache.l1.ttlSeconds.listModelsLocal' : 'cache.l1.ttlSeconds.listModelsWebDAV';
    const defaultTtl = sourceConfig.type === 'local' ? 300 : 1800;
    const ttlListModelsL1Seconds = await this.configService.getSetting(ttlConfigPath, defaultTtl);
    
    const l1Options = {
        ttlMs: ttlListModelsL1Seconds * 1000,
        directoryContentHash: currentDirectoryContentHash
    };

    await this.modelInfoCacheService.setToL1(listModelsCacheKey, modelObjs, 'listModels', l1Options);
    log.info(`[ModelService listModels] Stored ${modelObjs.length} models to L1 cache for key: ${listModelsCacheKey}`);
    
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

      const subdirs = await dataSourceInterface.listSubdirectories(sourceConfig);
      log.info(`[ModelService listSubdirectories] Found ${subdirs.length} subdirectories for source ${sourceId}`);
      return subdirs;
    } catch (error) {
      log.error(`[ModelService] Error listing subdirectories for source ${sourceId}:`, error.message, error.stack);
      throw error;
    }
  }

  async getModelDetail(sourceId, jsonPath, modelFilePath = null) {
    log.info(`[ModelService] getModelDetail called. sourceId: ${sourceId}, jsonPath: ${jsonPath}, modelFilePath: ${modelFilePath}`);
    const modelJsonInfoCacheKey = `modelJsonInfo:${sourceId}:${jsonPath}`;
    const l1CacheKeyForFullModelObj = modelJsonInfoCacheKey;

    log.debug(`[ModelService getModelDetail] Cache key for L1 (full obj) and L2 (jsonInfo): ${modelJsonInfoCacheKey}`);

    try {
      const sourceConfig = await this.dataSourceService.getSourceConfig(sourceId);
      if (!sourceConfig) {
        log.warn(`[ModelService getModelDetail] Source config not found for ID: ${sourceId}. Cannot proceed.`);
        return {};
      }
      log.debug(`[ModelService getModelDetail] Retrieved source config for ID: ${sourceId}`);

      let currentSourceJsonStats = null;
      try {
        currentSourceJsonStats = await dataSourceInterface.getFileStats(sourceConfig, jsonPath);
        log.debug(`[ModelService getModelDetail] Current .json file stats for ${jsonPath}:`, currentSourceJsonStats);
      } catch (statError) {
        log.warn(`[ModelService getModelDetail] Could not get .json file stats for ${jsonPath}. Cache validation will be affected. Error: ${statError.message}`);
      }

      const l1FullModelObjEntry = await this.modelInfoCacheService.getFromL1(l1CacheKeyForFullModelObj, 'modelJsonInfo'); 
      
      if (l1FullModelObjEntry) {
        log.debug(`[ModelService getModelDetail] L1 cache hit for full model object: ${l1CacheKeyForFullModelObj}`);
        const { data: cachedFullModelObj, sourceJsonStats: l1SourceJsonStats } = l1FullModelObjEntry;
        
        if (currentSourceJsonStats && l1SourceJsonStats &&
            currentSourceJsonStats.mtimeMs === l1SourceJsonStats.mtimeMs &&
            currentSourceJsonStats.size === l1SourceJsonStats.size) {
          log.info(`[ModelService getModelDetail] L1 cache for full model object valid (stats match) for ${l1CacheKeyForFullModelObj}. Returning cached data.`);
          return cachedFullModelObj;
        } else {
          log.info(`[ModelService getModelDetail] L1 cache for full model object stale or stats mismatch for ${l1CacheKeyForFullModelObj}.`);
        }
      } else {
        log.info(`[ModelService getModelDetail] L1 cache miss for full model object: ${l1CacheKeyForFullModelObj}.`);
      }

      const cachedJsonInfoResult = await this.modelInfoCacheService.get(modelJsonInfoCacheKey, 'modelJsonInfo');
      let modelJsonData; 
      let sourceStatsForUsedJsonData = currentSourceJsonStats; 

      if (cachedJsonInfoResult) {
        const { data: jsonDataFromCache, sourceJsonStats: cachedSourceJsonStats, fromL2 } = cachedJsonInfoResult;
        log.debug(`[ModelService getModelDetail] modelInfoCacheService.get returned for ${modelJsonInfoCacheKey}. FromL2: ${fromL2}`);

        if (currentSourceJsonStats && cachedSourceJsonStats &&
            currentSourceJsonStats.mtimeMs === cachedSourceJsonStats.mtimeMs &&
            currentSourceJsonStats.size === cachedSourceJsonStats.size) {
          log.info(`[ModelService getModelDetail] Cached modelJsonInfo for ${modelJsonInfoCacheKey} is valid (stats match).`);
          modelJsonData = jsonDataFromCache;
          sourceStatsForUsedJsonData = cachedSourceJsonStats; 
        } else {
          log.info(`[ModelService getModelDetail] Cached modelJsonInfo for ${modelJsonInfoCacheKey} is stale or stats mismatch. Will fetch from source.`);
        }
      } else {
        log.info(`[ModelService getModelDetail] Cache miss for modelJsonInfo (L1 and L2) for ${modelJsonInfoCacheKey}. Will fetch from source.`);
      }

      let fullModelObj;
      if (!modelJsonData) { 
        log.info(`[ModelService getModelDetail] Fetching full model detail (including .json) from dataSourceInterface for ${jsonPath}`);
        fullModelObj = await dataSourceInterface.readModelDetail(sourceConfig, jsonPath, modelFilePath);
        
        if (fullModelObj && fullModelObj.modelJsonInfo) {
            modelJsonData = fullModelObj.modelJsonInfo; 
            try {
                currentSourceJsonStats = await dataSourceInterface.getFileStats(sourceConfig, jsonPath);
                sourceStatsForUsedJsonData = currentSourceJsonStats; 
                log.debug(`[ModelService getModelDetail] Updated .json file stats after read for ${jsonPath}:`, currentSourceJsonStats);
            } catch (statError) {
                log.warn(`[ModelService getModelDetail] Could not get .json file stats after read for ${jsonPath}. Cache might lack stats. Error: ${statError.message}`);
                currentSourceJsonStats = null; 
                sourceStatsForUsedJsonData = null;
            }

            if (modelJsonData && Object.keys(modelJsonData).length > 0 && currentSourceJsonStats) {
                const l2TtlModelJsonInfoSeconds = await this.configService.getSetting('cache.l2.ttlSeconds.modelJsonInfo', 3600 * 24 * 7);
                await this.modelInfoCacheService.set(modelJsonInfoCacheKey, modelJsonData, l2TtlModelJsonInfoSeconds, 'modelJsonInfo', { sourceJsonStats: currentSourceJsonStats, isJsonInfoOnly: true });
                log.info(`[ModelService getModelDetail] Stored/Updated modelJsonInfo in L2 for ${modelJsonInfoCacheKey}`);
            } else {
                log.warn(`[ModelService getModelDetail] modelJsonData is empty or currentSourceJsonStats missing after fetch for ${jsonPath}. Not storing .json content in L2.`);
            }
        } else {
            log.warn(`[ModelService getModelDetail] dataSourceInterface.readModelDetail did not return a valid modelObj or modelJsonInfo for ${jsonPath}.`);
            return {};
        }
      } else {
        log.info(`[ModelService getModelDetail] Using cached modelJsonData for ${jsonPath}. Reading base model structure.`);
        fullModelObj = await dataSourceInterface.readModelDetail(sourceConfig, jsonPath, modelFilePath); 
        if (fullModelObj) {
            fullModelObj.modelJsonInfo = modelJsonData; 
        } else {
            log.error(`[ModelService getModelDetail] Failed to read base model structure for ${jsonPath} when using cached .json data.`);
            return {};
        }
      }
      
      if (fullModelObj && Object.keys(fullModelObj).length > 0) {
        const l1TtlModelInfoSeconds = await this.configService.getSetting('cache.l1.ttlSeconds.modelInfo', 3600);
        if (sourceStatsForUsedJsonData) { 
            await this.modelInfoCacheService.setToL1(l1CacheKeyForFullModelObj, fullModelObj, 'modelJsonInfo', { sourceJsonStats: sourceStatsForUsedJsonData, ttlMs: l1TtlModelInfoSeconds * 1000 });
            log.info(`[ModelService getModelDetail] Stored/Updated full model object in L1 for ${l1CacheKeyForFullModelObj}`);
        } else {
            log.warn(`[ModelService getModelDetail] sourceStatsForUsedJsonData is missing for ${jsonPath}. Not storing full model object in L1 as stats are crucial for L1 validation.`);
        }
      } else {
        log.warn(`[ModelService getModelDetail] Constructed fullModelObj is empty for ${jsonPath}. Not caching in L1.`);
        return {};
      }
      
      log.info(`[ModelService getModelDetail] Successfully retrieved/constructed model detail for source ${sourceId}, path ${jsonPath}`);
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