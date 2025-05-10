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

      // 1. Get source configuration using DataSourceService
      const sourceConfig = await this.dataSourceService.getSourceConfig(modelObj.sourceId);
      if (!sourceConfig) {
        throw new Error(`Configuration for source ID ${modelObj.sourceId} not found.`);
      }
      log.debug(`[ModelService saveModel] Retrieved source config for ID: ${modelObj.sourceId}`);

      //兼容性处理，为了兼容以前老配置
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

      // 2. Prepare data for saving using modelParser
      // modelParser.prepareModelDataForSaving now expects modelObj and returns a deep copy of modelObj.modelJsonInfo
      const dataToSave = prepareModelDataForSaving(modelObj);
      log.debug(`[ModelService saveModel] Data prepared for saving. Keys: ${Object.keys(dataToSave)}`);

      // 3. Serialize data
      const jsonDataString = JSON.stringify(dataToSave, null, 2); // Pretty-print JSON
      log.debug(`[ModelService saveModel] Data (string) prepared for writing to: ${modelObj.jsonPath}`);

      // 4. Define modelIdentifier for dataSourceInterface.writeModelJson
      const modelIdentifier = {
        jsonPath: modelObj.jsonPath,
        sourceId: modelObj.sourceId
        // Add any other fields required by dataSourceInterface.writeModelJson for identification
      };

      // 5. Write data using dataSourceInterface
      await dataSourceInterface.writeModelJson(sourceConfig, modelIdentifier, jsonDataString);
      log.info('[ModelService saveModel] Model JSON data written successfully', { sourceId: modelObj.sourceId, jsonPath: modelObj.jsonPath });

      // Invalidate listModels cache for the directory of the saved model
      try {
        const dirPath = path.dirname(modelObj.jsonPath); // Get directory from jsonPath
        // Normalize dirPath if necessary, e.g., remove leading/trailing slashes if ModelInfoCacheService expects a specific format
        const normalizedDirPath = dirPath === '.' ? '' : dirPath.replace(/^\/+|\/+$/g, ''); // Example normalization
        
        log.info(`[ModelService saveModel] Invalidating listModels cache for directory: ${normalizedDirPath}, sourceId: ${modelObj.sourceId}`);
        await this.modelInfoCacheService.invalidateListModelsCacheForDirectory(modelObj.sourceId, normalizedDirPath);
      } catch (cacheError) {
        log.error(`[ModelService saveModel] Failed to invalidate listModels cache for ${modelObj.jsonPath}: ${cacheError.message}`, cacheError);
        // Continue even if cache invalidation fails, as main save operation succeeded.
      }

      // 新增：获取并返回完全更新的 modelObj
      const updatedFullModelObj = await this.getModelDetail(modelObj.sourceId, modelObj.jsonPath, modelObj.file);
      log.info('[ModelService saveModel] Successfully retrieved updated full model object after save.', { sourceId: modelObj.sourceId, jsonPath: modelObj.jsonPath });
      return updatedFullModelObj; // 返回完整的、新解析的 modelObj

    } catch (error) {
      log.error('[ModelService] Failed to save model or retrieve updated details:', error.message, error.stack, { modelObj });
      throw error; // Re-throw the error to be handled by the caller (e.g., IPC layer)
    }
  }

  /**
   * Lists models within a specific directory of a data source.
   * @param {string} sourceId - The ID of the data source.
   * @param {string} directory - The directory path relative to the source root.
   * @returns {Promise<Array<object>>} - Resolves with an array of model objects (new modelObj structure) or rejects on error.
   */
  async listModels(sourceId, directory, filters = {}, supportedExtensions = null, showSubdirectory = false) {
    const startTime = Date.now();
    log.info(`[ModelService] listModels called. sourceId: ${sourceId}, directory: ${directory}, filters: ${JSON.stringify(filters)}, showSubDir: ${showSubdirectory}`);

    const sourceConfig = await this.dataSourceService.getSourceConfig(sourceId);
    if (!sourceConfig) {
      log.warn(`[ModelService listModels] Source config not found for ID: ${sourceId}. Returning empty array.`);
      return [];
    }
    const extsToUse = supportedExtensions || await this.dataSourceService.getSupportedExtensions();

    // Normalize directory path for cache key (e.g., '' for root, 'models/lora' for subdirs)
    // Assuming directory is relative to source root. Remove leading/trailing slashes.
    // Root could be null, '', or '/'. Standardize to empty string for root for cache key.
    let normalizedDirectoryPath = directory || '';
    if (normalizedDirectoryPath === '/' || normalizedDirectoryPath === './') {
        normalizedDirectoryPath = '';
    }
    normalizedDirectoryPath = normalizedDirectoryPath.replace(/^\/+|\/+$/g, '');


    const showSubdirectoryFlag = showSubdirectory ? 1 : 0;
    const supportedExtsHash = generateSupportedExtsHash(extsToUse);
    const cacheKey = `list_models:${sourceId}:${normalizedDirectoryPath}:${showSubdirectoryFlag}:${supportedExtsHash}`;
    log.debug(`[ModelService listModels] Cache key generated: ${cacheKey}`);

    // 1. Try to get from L2 cache
    const cachedResult = await this.modelInfoCacheService.getListModelsResultFromL2(cacheKey);
    let currentDirectoryContentHash = null; // For LocalDataSource
    // const dataSource = this.dataSourceService.getDataSourceInstance(sourceConfig); // ERROR: getDataSourceInstance is not a function on DataSourceService
    // TODO: The removal of 'dataSource' instance here affects cache validation based on getDirectoryContentMetadataDigest.
    // This logic needs to be revisited. Either dataSourceInterface.listModels should return this hash,
    // or dataSourceInterface should export getDataSourceInstance, or cache validation strategy needs change.
    // For now, content hash validation is effectively disabled. Cache will rely on TTL.

    if (cachedResult) {
      log.debug(`[ModelService listModels] Cache hit for key: ${cacheKey}. Validating...`);
      const { data: cachedModelObjArray, directoryContentHash: cachedDirContentHash, cachedTimestampMs, ttlSeconds } = cachedResult;
      
      const effectiveTtl = (ttlSeconds || (this.configService.getSetting('cache.l2.ttlSeconds.listModelsLocal', 600))) * 1000; // Default 10 mins
      if (Date.now() < cachedTimestampMs + effectiveTtl) {
        let isValid = true;
        // TODO: Re-enable or redesign content hash validation.
        // The following blocks are commented out because 'dataSource' instance is no longer directly available here.
        /*
        if (sourceConfig.type === 'local') {
          // if (dataSource && typeof dataSource.getDirectoryContentMetadataDigest === 'function') {
          //   currentDirectoryContentHash = await dataSource.getDirectoryContentMetadataDigest(normalizedDirectoryPath, extsToUse, showSubdirectory);
          //   if (currentDirectoryContentHash !== cachedDirContentHash) {
          //     log.info(`[ModelService listModels] LocalDataSource cache stale (digest mismatch) for ${cacheKey}. Current: ${currentDirectoryContentHash}, Cached: ${cachedDirContentHash}`);
          //     isValid = false;
          //   } else {
          //     log.info(`[ModelService listModels] LocalDataSource cache valid (digest match) for ${cacheKey}.`);
          //   }
          // } else {
          //    log.warn(`[ModelService listModels] LocalDataSource for ${sourceId} does not have getDirectoryContentMetadataDigest. Cannot validate digest. Assuming stale.`);
          //    isValid = false; // Cannot validate, assume stale
          // }
          log.warn(`[ModelService listModels] LocalDataSource content hash validation temporarily disabled for ${cacheKey}. Relying on TTL.`);
          if (!cachedDirContentHash) { // If there was no hash to begin with, it's harder to say, assume valid by TTL.
            log.debug(`[ModelService listModels] No cachedDirContentHash for local source ${cacheKey}, assuming valid by TTL.`);
          } else {
            // If we had a hash, but can't verify now, assume stale to be safe, unless TTL is very short.
            // For now, let TTL decide. If TTL is good, assume valid.
          }

        } else if (sourceConfig.type === 'webdav') {
          // if (cachedDirContentHash && dataSource && typeof dataSource.getDirectoryContentMetadataDigest === 'function') {
          //    const currentWebDavHash = await dataSource.getDirectoryContentMetadataDigest(normalizedDirectoryPath);
          //    if (currentWebDavHash !== cachedDirContentHash) {
          //       log.info(`[ModelService listModels] WebDavDataSource cache stale (digest mismatch) for ${cacheKey}. Current: ${currentWebDavHash}, Cached: ${cachedDirContentHash}`);
          //       isValid = false;
          //    } else {
          //       log.info(`[ModelService listModels] WebDavDataSource cache valid (digest match) for ${cacheKey}.`);
          //    }
          // } else {
          //   log.info(`[ModelService listModels] WebDavDataSource cache for ${cacheKey} relies on TTL only (no digest or validation method).`);
          // }
          log.warn(`[ModelService listModels] WebDavDataSource content hash validation temporarily disabled for ${cacheKey}. Relying on TTL.`);
        }
        */
        // Fallback: if hash validation is disabled, rely purely on TTL.
        // The original 'isValid' is declared on line 168.
        // We rely on that declaration. Removing the re-declaration from here.

        if (!isValid) { // This 'isValid' refers to the one declared on line 168.
            log.info(`[ModelService listModels] Cache for ${cacheKey} marked invalid by (disabled) content check or TTL expired (this log might be redundant).`)
        }


        if (isValid) { // If TTL is good, and (disabled) content check didn't invalidate.
          log.info(`[ModelService listModels] Cache valid (or assumed valid by TTL) for ${cacheKey}. Returning ${cachedModelObjArray.length} models from cache.`);
          // Apply filters to cached data
          const filteredFromCache = this._applyFiltersToListModels(cachedModelObjArray, filters, sourceId, directory);
          const duration = Date.now() - startTime;
          log.info(`[ModelService listModels] Finished (from cache). Duration: ${duration}ms. Source: ${sourceId}, Dir: ${directory}, Models: ${filteredFromCache.length}`);
          return filteredFromCache;
        }
      } else {
        log.info(`[ModelService listModels] Cache TTL expired for key: ${cacheKey}`);
      }
    }

    // 2. Cache miss or stale: Fetch from data source
    log.info(`[ModelService listModels] Fetching fresh model list from dataSourceInterface for source: ${sourceId}, dir: ${directory}`);
    let modelObjs = await dataSourceInterface.listModels(sourceConfig, directory, extsToUse, showSubdirectory); // This line is already correct
    log.info(`[ModelService listModels] Fetched ${modelObjs.length} raw model objects for source ${sourceId} in directory ${directory}`);

    // 3. Update L2 Cache
    // TODO: Re-evaluate how to get currentDirectoryContentHash for caching without direct dataSource instance.
    // For now, we will cache without the content hash if it's not available from a previous (disabled) validation step.
    /*
    if (sourceConfig.type === 'local' && dataSource && typeof dataSource.getDirectoryContentMetadataDigest === 'function') {
      // If currentDirectoryContentHash wasn't calculated during validation, calculate it now.
      if (currentDirectoryContentHash === null) { // currentDirectoryContentHash would be null due to disabled validation
          // currentDirectoryContentHash = await dataSource.getDirectoryContentMetadataDigest(normalizedDirectoryPath, extsToUse, showSubdirectory);
          // log.debug(`[ModelService listModels] Calculated new directory content hash for LocalDataSource: ${currentDirectoryContentHash}`);
          log.warn(`[ModelService listModels] Cannot calculate new directory content hash for LocalDataSource ${sourceId} due to disabled validation logic. Caching without hash.`);
          currentDirectoryContentHash = undefined; // Explicitly set to undefined for caching
      }
    } else if (sourceConfig.type === 'webdav' && dataSource && typeof dataSource.getDirectoryContentMetadataDigest === 'function') {
        // Similar for WebDAV, if needed.
        log.warn(`[ModelService listModels] Cannot calculate new directory content hash for WebDAV ${sourceId} due to disabled validation logic. Caching without hash.`);
        currentDirectoryContentHash = undefined; // Explicitly set to undefined for caching
    */
    // TODO: The following lines accessed 'dataSource' which is no longer available here.
    // They also contained a stray closing brace that caused syntax errors.
    // currentDirectoryContentHash = await dataSource.getDirectoryContentMetadataDigest(normalizedDirectoryPath);
    // log.debug(`[ModelService listModels] Fetched directory content hash for WebDavDataSource: ${currentDirectoryContentHash}`);
    // } // REMOVED STRAY BRACE
    
    const keyParts = {
        sourceId: sourceId,
        directoryPath: normalizedDirectoryPath,
        showSubdirectory: showSubdirectoryFlag,
        supportedExtsHash: supportedExtsHash
    };
    const ttlListModels = sourceConfig.type === 'local'
        ? await this.configService.getSetting('cache.l2.ttlSeconds.listModelsLocal', 600) // 10 mins
        : await this.configService.getSetting('cache.l2.ttlSeconds.listModelsWebDAV', 3600); // 1 hour

    await this.modelInfoCacheService.setListModelsResultToL2(cacheKey, modelObjs, currentDirectoryContentHash, ttlListModels, keyParts);
    log.info(`[ModelService listModels] Stored ${modelObjs.length} models to L2 cache for key: ${cacheKey}`);
    
    // 4. Apply filters to freshly fetched data
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
        log.debug(`[ModelService _applyFiltersToListModels] Filtered model objects. Count: ${modelObjs.length}`);
      }

      log.info(`[ModelService _applyFiltersToListModels] Returning ${modelObjs.length} filtered model objects for source ${sourceId} in directory ${directory}`);

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
    // Catch block was part of the original try-catch for the whole listModels method.
    // The new structure has the main try-catch at the beginning of the refactored listModels.
    // This method _applyFiltersToListModels is now synchronous and doesn't need its own try-catch if called correctly.
  }
  
  // Original catch for listModels
  // } catch (error) {
  //   log.error(`[ModelService] Error listing models for source ${sourceId} in directory ${directory}:`, error.message, error.stack);
  //   throw error; // Re-throw the error
  // }


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
  async getModelDetail(sourceId, jsonPath, modelFilePath = null) {
    log.info(`[ModelService] getModelDetail called. sourceId: ${sourceId}, jsonPath: ${jsonPath}, modelFilePath: ${modelFilePath}`);
    const cacheKey = `model-json:${sourceId}:${jsonPath}`;
    log.debug(`[ModelService getModelDetail] Cache key: ${cacheKey}`);

    try {
      // 1. Get source configuration using DataSourceService
      const sourceConfig = await this.dataSourceService.getSourceConfig(sourceId);
      if (!sourceConfig) {
        log.warn(`[ModelService getModelDetail] Source config not found for ID: ${sourceId}. Cannot proceed.`);
        return {}; // Return empty object if source config is missing
      }
      log.debug(`[ModelService getModelDetail] Retrieved source config for ID: ${sourceId}`);

      // Attempt to get file stats for comparison
      let currentFileStats = null;
      try {
        // Assuming dataSourceInterface has getFileStats method
        // jsonPath is the path to the .json file itself.
        currentFileStats = await dataSourceInterface.getFileStats(sourceConfig, jsonPath);
        log.debug(`[ModelService getModelDetail] Current file stats for ${jsonPath}:`, currentFileStats);
      } catch (statError) {
        log.warn(`[ModelService getModelDetail] Could not get file stats for ${jsonPath}. Cache validation might be skipped or fail. Error: ${statError.message}`);
        // Proceed without stats, cache will be treated as stale if it relies on stats
      }

      // 2. Try to get from cache
      const cachedData = await this.modelInfoCacheService.get(cacheKey);
      if (cachedData) {
        log.debug(`[ModelService getModelDetail] Cache hit for key: ${cacheKey}`);
        const { data: cachedModelObj, fileStats: cachedFileStats } = cachedData;

        // Validate cache using file stats if available
        if (currentFileStats && cachedFileStats) {
          if (currentFileStats.mtimeMs === cachedFileStats.mtimeMs && currentFileStats.size === cachedFileStats.size) {
            log.info(`[ModelService getModelDetail] Cache valid (stats match) for ${cacheKey}. Returning cached data.`);
            return cachedModelObj;
          } else {
            log.info(`[ModelService getModelDetail] Cache stale (stats mismatch) for ${cacheKey}. Fetching fresh data.`);
            log.debug('[ModelService getModelDetail] Stats mismatch details:', { currentFileStats, cachedFileStats });
          }
        } else if (currentFileStats && !cachedFileStats) {
            log.info(`[ModelService getModelDetail] Cached data for ${cacheKey} exists but has no fileStats. Current file has stats. Treating cache as stale.`);
        } else if (!currentFileStats && cachedFileStats) {
            log.info(`[ModelService getModelDetail] Cached data for ${cacheKey} has fileStats, but current file stats could not be retrieved. Assuming cache might be stale or using it cautiously if no other option.`);
            // Depending on policy, could return cached data or treat as stale.
            // For now, let's assume if we can't get current stats, we can't reliably validate.
            log.info(`[ModelService getModelDetail] Treating cache as stale due to missing current file stats for ${cacheKey}.`);
        } else {
          // No stats available on either side, or only on one side where comparison isn't straightforward.
          // If TTL is managed by the cache service internally based on 'createdAt', it might still be valid.
          // For file-based cache without stats, it's harder to validate beyond simple TTL.
          // The design doc mentions `sourceJsonStats` for comparison. If `currentFileStats` is null, we can't compare.
          // If `cachedFileStats` is null, but `currentFileStats` is available, it implies the cache entry is old or incomplete.
          log.info(`[ModelService getModelDetail] Cache hit for ${cacheKey}, but file stats comparison is not possible or inconclusive. Proceeding to check TTL or consider stale.`);
          // If the cache service handles TTL expiration internally on 'get', this might be okay.
          // However, the explicit instruction is to compare file stats. If that's not possible, we should consider it a cache miss or stale.
          // For now, if `currentFileStats` is missing, we can't reliably validate against `cachedFileStats`.
          // If `cachedFileStats` is missing, the cache item is not in the expected format for stat-based validation.
          // Let's be conservative: if `currentFileStats` is null, we can't validate, so treat as stale.
          if (!currentFileStats) {
            log.info(`[ModelService getModelDetail] Cannot validate cache for ${cacheKey} due to missing current file stats. Fetching fresh data.`);
          } else {
            // This case means cachedData exists, currentFileStats exists, but cachedFileStats is missing.
            log.info(`[ModelService getModelDetail] Cache for ${cacheKey} is missing fileStats. Fetching fresh data.`);
          }
        }
      } else {
        log.info(`[ModelService getModelDetail] Cache miss for key: ${cacheKey}`);
      }

      // 3. If cache miss or stale, read from source
      log.info(`[ModelService getModelDetail] Fetching model detail from dataSourceInterface for ${jsonPath}`);
      const modelObj = await dataSourceInterface.readModelDetail(sourceConfig, jsonPath, modelFilePath);
      log.debug('[ModelService getModelDetail] modelObj from dataSourceInterface:', JSON.stringify(modelObj, null, 2));

      // After fetching, update currentFileStats again, in case it changed between the first check and read,
      // or if the initial attempt failed. This ensures the stats stored with the cache are as fresh as possible.
      if (!currentFileStats) { // Or if we want to be absolutely sure, always re-fetch stats after reading the file.
        try {
          currentFileStats = await dataSourceInterface.getFileStats(sourceConfig, jsonPath);
          log.debug(`[ModelService getModelDetail] Re-fetched file stats for ${jsonPath} before caching:`, currentFileStats);
        } catch (statError) {
          log.warn(`[ModelService getModelDetail] Could not re-fetch file stats for ${jsonPath} before caching. Data will be cached without stats. Error: ${statError.message}`);
          currentFileStats = null; // Ensure it's null if fetching failed
        }
      }
      
      // 4. Store in cache
      if (modelObj && Object.keys(modelObj).length > 0) { // Ensure modelObj is not empty
        const ttlSeconds = await this.configService.getSetting('cache.modelJson.ttlSeconds', 3600 * 24 * 7); // Default 7 days
        log.debug(`[ModelService getModelDetail] Caching model data for key: ${cacheKey} with TTL: ${ttlSeconds}s`);
        await this.modelInfoCacheService.set(cacheKey, modelObj, ttlSeconds, 'modelJsonInfo', { sourceJsonStats: currentFileStats });
        log.info(`[ModelService getModelDetail] Successfully cached model detail for ${cacheKey}`);
      } else {
        log.warn(`[ModelService getModelDetail] Fetched modelObj is empty for ${jsonPath}. Not caching.`);
      }
      
      log.info(`[ModelService getModelDetail] Successfully retrieved model detail (modelObj) for source ${sourceId}, path ${jsonPath}`);
      return modelObj;

    } catch (error) {
      log.error(`[ModelService] Error getting model detail for source ${sourceId}, path ${jsonPath}:`, error.message, error.stack);
      // Do not cache errors
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