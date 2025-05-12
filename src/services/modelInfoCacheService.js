const { app } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const log = require('electron-log');
const Database = require('better-sqlite3');
const BSON = require('bson');

const DEFAULT_DB_DIR_NAME = 'ModelNestCache';
const DEFAULT_DB_FILE_NAME = 'model_cache.sqlite';

/**
 * @readonly
 * @enum {string}
 * @description Defines the types of data that can be cached.
 * This enum guides the cache service in handling data, including TTL and storage location.
 */
const CacheDataType = {
  /**
   * Represents an array of ModelObjects returned by listModels.
   * Storage: L1 Cache.
   * currentMetadata: { contentHash: string } (Directory content digest)
   */
  MODEL_LIST: 'MODEL_LIST',

  /**
   * Represents a single complete ModelObject returned by readModelDetail.
   * Storage: L1 Cache.
   * currentMetadata: { fileSize: number, metadata_lastModified_ms: number, etag: string | null }
   *   (For its primary info source file, usually the associated .json or model main file)
   */
  MODEL_DETAIL: 'MODEL_DETAIL',

  /**
   * Represents raw JSON content (JavaScript object) parsed from a model's associated .json file.
   * Storage: L2 Cache (SQLite table model_json_info_cache).
   * currentMetadata: { fileSize: number, metadata_lastModified_ms: number, etag: string | null }
   *   (For the original .json file)
   */
  MODEL_JSON_INFO: 'MODEL_JSON_INFO',
};

// Internal TTL Strategies (in seconds)
const TTL_STRATEGIES = {
  [CacheDataType.MODEL_LIST]: {
    // Differentiated by source type, but for simplicity in this service,
    // we might use a single L1 TTL or pass it from DataSource if needed.
    // For now, using a generic L1 TTL for MODEL_LIST.
    // Specific TTLs per source type (local vs webdav) can be managed by DataSource
    // when calling setDataToCache, or this service can be enhanced.
    // As per doc: LocalDataSource: 5 mins (300s), WebdavDataSource: 15 mins (900s)
    // We'll use a placeholder here and expect DataSource to provide specific TTLs if needed,
    // or apply a general one. For this implementation, we'll define them here.
    L1_LOCAL: 300, // 5 minutes
    L1_WEBDAV: 900, // 15 minutes
  },
  [CacheDataType.MODEL_DETAIL]: {
    L1: 3600, // 1 hour
  },
  [CacheDataType.MODEL_JSON_INFO]: {
    L2: 604800, // 7 days
  },
};


class ModelInfoCacheService {
    constructor(configService) {
        this.configService = configService; // Retained for global enable/disable and DB path
        this.isInitialized = false;
        this.isEnabled = true; // Default, updated from config

        this.l1Cache = new Map();
        // L1 maxItems can still be configurable if desired, but TTLs are now internal.
        this.l1MaxItems = 200; // Default, can be loaded from config if needed

        this.db = null;
        this.dbPath = '';

        this.logger = log.scope('Service:ModelInfoCache');
        this.logger.info('Service instance created. Refactored for unified cache logic.');
    }

    async initialize() {
        if (this.isInitialized) {
            this.logger.warn('Service already initialized.');
            return;
        }
        this.logger.info('Initializing ModelInfoCacheService (Refactored)...');

        if (this.configService) {
            try {
                let configEnabled = await this.configService.getSetting('cache.enabled');
                this.isEnabled = typeof configEnabled === 'boolean' ? configEnabled : true;

                if (!this.isEnabled) {
                    this.logger.info('ModelInfoCacheService is disabled via global cache.enabled configuration.');
                    this.isInitialized = true;
                    this.l1Cache.clear();
                    this.logger.info('Service initialized (globally disabled).');
                    return;
                }
                
                const l1MaxItemsValue = await this.configService.getSetting('cache.l1.maxItems');
                this.l1MaxItems = (l1MaxItemsValue !== undefined && l1MaxItemsValue !== null) ? l1MaxItemsValue : 200;


                const configuredDbPath = await this.configService.getSetting('cache.l2.dbPath');
                if (configuredDbPath && typeof configuredDbPath === 'string' && configuredDbPath.trim() !== '') {
                    this.dbPath = configuredDbPath;
                } else {
                    const userDataPath = app.getPath('userData');
                    this.dbPath = path.join(userDataPath, DEFAULT_DB_DIR_NAME, DEFAULT_DB_FILE_NAME);
                }
                this.logger.info(`Using L2 cache database path: ${this.dbPath}`);

            } catch (error) {
                this.logger.error(`Error loading configuration for ModelInfoCacheService: ${error.message}`, error);
                this.logger.warn('Falling back to default cache settings for DB path and L1 max items.');
                const userDataPath = app.getPath('userData');
                this.dbPath = path.join(userDataPath, DEFAULT_DB_DIR_NAME, DEFAULT_DB_FILE_NAME);
                this.isEnabled = true;
                this.l1MaxItems = 200;
            }
        } else {
            this.logger.warn('ConfigService not provided. Using default settings for DB path and L1 max items.');
            const userDataPath = app.getPath('userData');
            this.dbPath = path.join(userDataPath, DEFAULT_DB_DIR_NAME, DEFAULT_DB_FILE_NAME);
        }

        if (!this.isEnabled) {
            this.isInitialized = true;
            this.logger.info('ModelInfoCacheService initialization skipped as it is disabled.');
            return;
        }

        try {
            if (!this.dbPath) {
                 throw new Error('SQLite database path is not defined after configuration loading.');
            }
            await fs.ensureDir(path.dirname(this.dbPath));
            this.logger.info(`Ensured directory for SQLite DB: ${path.dirname(this.dbPath)}`);

            this.db = new Database(this.dbPath, { verbose: this.logger.debug.bind(this.logger) });
            this.logger.info(`SQLite database connected at: ${this.dbPath}`);
            this._createTables();
        } catch (error) {
            this.logger.error(`Failed to initialize SQLite database at '${this.dbPath}': ${error.message}`, error);
            this.db = null;
            this.logger.warn('L2 SQLite cache will be unavailable due to database initialization error.');
        }

        this.isInitialized = true;
        this.logger.info(`Service initialized. Status: ${this.isEnabled ? 'Enabled' : 'Disabled'}. L1 Max Items: ${this.l1MaxItems}. DB Path: '${this.dbPath || 'N/A'}'`);
        
        // Start periodic L2 cleanup
        this._scheduleL2Cleanup();
    }

    _createTables() {
        if (!this.db) {
            this.logger.error('Cannot create tables, database not initialized.');
            return;
        }
        try {
            // Updated table structure as per doc/model_info_cache_refactoring_plan_v1.3.md Section 8
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS model_json_info_cache (
                    cache_key TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL,
                    normalized_json_path TEXT NOT NULL,
                    bson_data BLOB NOT NULL,
                    metadata_filesize INTEGER NOT NULL,
                    metadata_lastModified_ms REAL NOT NULL,
                    metadata_etag TEXT,
                    cached_timestamp_ms INTEGER NOT NULL,
                    ttl_seconds INTEGER NOT NULL,
                    last_accessed_timestamp_ms INTEGER NOT NULL 
                );
            `);
            this.logger.info('Table "model_json_info_cache" ensured with new schema.');

            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mjic_source_id ON model_json_info_cache (source_id);`);
            // Index for TTL expiration check: (cached_timestamp_ms + ttl_seconds * 1000)
            // SQLite doesn't directly support indexing expressions like that in CREATE INDEX for older versions.
            // We can index the components.
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mjic_expires_at ON model_json_info_cache (cached_timestamp_ms, ttl_seconds);`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mjic_last_accessed ON model_json_info_cache (last_accessed_timestamp_ms);`);
            this.logger.info('Indexes for model_json_info_cache table ensured.');

        } catch (error) {
            this.logger.error(`Error creating SQLite tables or indexes: ${error.message}`, error);
        }
    }

    /**
     * Generates a unique cache key.
     * @param {CacheDataType} dataType - The type of data.
     * @param {string} sourceId - The ID of the data source.
     * @param {string} pathIdentifier - The path or unique identifier for the data.
     * @returns {string} The generated cache key.
     * @private
     */
    _generateCacheKey(dataType, sourceId, pathIdentifier) {
        if (!dataType || !sourceId || typeof pathIdentifier === 'undefined') {
            this.logger.error('Cannot generate cache key: dataType, sourceId, or pathIdentifier is missing.', { dataType, sourceId, pathIdentifier });
            throw new Error('Invalid arguments for _generateCacheKey');
        }
        // Normalize pathIdentifier for consistency if it's a path
        // For MODEL_LIST, pathIdentifier might be complex (dir?param=val). Assume it's pre-normalized by caller.
        const normalizedPathIdentifier = pathIdentifier.replace(/\\/g, '/');
        return `${dataType}:${sourceId}:${normalizedPathIdentifier}`;
    }

    /**
     * Gets the TTL in seconds for a given data type and source characteristics.
     * @param {CacheDataType} dataType
     * @param {string} [sourceType] - Optional, e.g., 'local', 'webdav'. Used for MODEL_LIST.
     * @returns {number} TTL in seconds.
     * @private
     */
    _getTtlSeconds(dataType, sourceType) {
        switch (dataType) {
            case CacheDataType.MODEL_LIST:
                if (sourceType === 'local') return TTL_STRATEGIES[CacheDataType.MODEL_LIST].L1_LOCAL;
                if (sourceType === 'webdav') return TTL_STRATEGIES[CacheDataType.MODEL_LIST].L1_WEBDAV;
                return TTL_STRATEGIES[CacheDataType.MODEL_LIST].L1_LOCAL; // Default for MODEL_LIST
            case CacheDataType.MODEL_DETAIL:
                return TTL_STRATEGIES[CacheDataType.MODEL_DETAIL].L1;
            case CacheDataType.MODEL_JSON_INFO:
                return TTL_STRATEGIES[CacheDataType.MODEL_JSON_INFO].L2;
            default:
                this.logger.warn(`Unknown CacheDataType for TTL: ${dataType}. Using default 3600s.`);
                return 3600;
        }
    }

    /**
     * Checks if an L1 cache entry is valid based on TTL and metadata.
     * @param {object} l1Entry - The L1 cache entry.
     * @param {object} currentMetadata - Current metadata of the source data.
     * @returns {boolean} True if valid, false otherwise.
     * @private
     */
    _isL1EntryValid(l1Entry, currentMetadata) {
        if (!l1Entry) return false;

        const { timestamp, ttlMs, metadata: cachedMetadata, dataType, originalKey } = l1Entry;

        // Check TTL
        if (Date.now() >= timestamp + ttlMs) {
            this.logger.debug(`L1 entry TTL expired. Key: ${originalKey}`);
            return false;
        }

        // Check metadata consistency
        if (!this._isMetadataValid(cachedMetadata, currentMetadata, dataType, originalKey, 'L1')) {
            return false;
        }
        return true;
    }

    /**
     * Validates metadata consistency for a cache entry.
     * @param {object} cachedMetadata - The metadata stored in the cache.
     * @param {object} currentMetadata - The current metadata of the data source.
     * @param {CacheDataType} dataType - The type of data being validated.
     * @param {string} entryKeyForLog - The cache key or identifier for logging purposes.
     * @param {string} cacheLevelForLog - The cache level ('L1' or 'L2') for logging.
     * @returns {boolean} True if metadata is valid, false otherwise.
     * @private
     */
    _isMetadataValid(cachedMetadata, currentMetadata, dataType, entryKeyForLog, cacheLevelForLog) {
        if (dataType === CacheDataType.MODEL_LIST) {
            if (!cachedMetadata || !currentMetadata || cachedMetadata.contentHash !== currentMetadata.contentHash) {
                this.logger.debug(`${cacheLevelForLog} ${dataType} contentHash mismatch. Key: ${entryKeyForLog}`, { cached: cachedMetadata, current: currentMetadata });
                return false;
            }
        } else if (dataType === CacheDataType.MODEL_DETAIL || dataType === CacheDataType.MODEL_JSON_INFO) {
            if (!cachedMetadata || !currentMetadata) {
                this.logger.debug(`${cacheLevelForLog} ${dataType} metadata missing. Key: ${entryKeyForLog}`);
                return false;
            }
            if (cachedMetadata.fileSize !== currentMetadata.fileSize ||
                cachedMetadata.metadata_lastModified_ms !== currentMetadata.metadata_lastModified_ms ||
                (currentMetadata.etag !== undefined && cachedMetadata.etag !== currentMetadata.etag)) { // Only compare etag if current one is provided
                this.logger.debug(`${cacheLevelForLog} ${dataType} metadata mismatch. Key: ${entryKeyForLog}`, { cached: cachedMetadata, current: currentMetadata });
                return false;
            }
        }
        return true;
    }

    /**
     * Checks if an L2 cache entry (from DB) is valid based on TTL and metadata.
     * @param {object} dbEntry - The L2 cache entry from database.
     * @param {object} currentMetadata - Current metadata of the source data.
     * @returns {boolean} True if valid, false otherwise.
     * @private
     */
    _isL2EntryValid(dbEntry, currentMetadata) {
        if (!dbEntry) return false;

        const { cache_key, cached_timestamp_ms, ttl_seconds, metadata_filesize, metadata_lastModified_ms, metadata_etag } = dbEntry;

        // Check TTL
        if (Date.now() >= cached_timestamp_ms + (ttl_seconds * 1000)) {
            this.logger.debug(`L2 entry TTL expired. Key: ${cache_key}`);
            return false;
        }
        
        // Check metadata (specific to MODEL_JSON_INFO)
        if (!currentMetadata) { // currentMetadata is essential for validation
            this.logger.debug(`L2 currentMetadata missing for validation. Key: ${cache_key}`);
            return false;
        }

        const cachedL2Metadata = {
            fileSize: metadata_filesize,
            metadata_lastModified_ms: metadata_lastModified_ms,
            etag: metadata_etag
        };

        if (!this._isMetadataValid(cachedL2Metadata, currentMetadata, CacheDataType.MODEL_JSON_INFO, cache_key, 'L2')) {
            return false;
        }
        return true;
    }


    /**
     * Retrieves data from the cache.
     * @param {CacheDataType} dataType - The type of data to retrieve.
     * @param {string} sourceId - The ID of the data source.
     * @param {string} pathIdentifier - The path or unique identifier for the data.
     * @param {object} currentMetadata - Current metadata of the source data for validation.
     * @returns {Promise<any|undefined>} Cached data or undefined if not found/invalid.
     */
    async getDataFromCache(dataType, sourceId, pathIdentifier, currentMetadata) {
        if (!this.isInitialized || !this.isEnabled) {
            this.logger.debug(`getDataFromCache: Service not initialized or disabled. DataType: ${dataType}`);
            return undefined;
        }

        const cacheKey = this._generateCacheKey(dataType, sourceId, pathIdentifier);
        this.logger.debug(`getDataFromCache: Attempting for key: ${cacheKey}, dataType: ${dataType}`);

        // 1. L1 Lookup
        const l1Entry = this.l1Cache.get(cacheKey);
        if (l1Entry) {
            l1Entry.originalKey = cacheKey; // For logging in _isL1EntryValid
            l1Entry.dataType = dataType; // For _isL1EntryValid to know context
            if (this._isL1EntryValid(l1Entry, currentMetadata)) {
                this.logger.info(`L1 cache hit and valid for key: ${cacheKey}`);
                // LRU behavior: move to end
                this.l1Cache.delete(cacheKey);
                this.l1Cache.set(cacheKey, l1Entry);
                return structuredClone(l1Entry.data); // Return deep clone
            } else {
                this.logger.info(`L1 cache entry invalid or expired for key: ${cacheKey}. Deleting.`);
                this.l1Cache.delete(cacheKey);
            }
        } else {
            this.logger.debug(`L1 cache miss for key: ${cacheKey}`);
        }

        // 2. L2 Lookup (only for CacheDataType.MODEL_JSON_INFO)
        if (dataType === CacheDataType.MODEL_JSON_INFO) {
            if (!this.db) {
                this.logger.warn(`L2 lookup skipped for key ${cacheKey}: DB not available.`);
                return undefined;
            }
            try {
                const stmt = this.db.prepare(`
                    SELECT * FROM model_json_info_cache WHERE cache_key = ?
                `);
                const dbRow = stmt.get(cacheKey);

                if (dbRow) {
                    if (this._isL2EntryValid(dbRow, currentMetadata)) {
                        this.logger.info(`L2 cache hit and valid for key: ${cacheKey}`);
                        try {
                            const data = BSON.deserialize(dbRow.bson_data);
                            // Update last_accessed_timestamp_ms
                            const updateStmt = this.db.prepare(`UPDATE model_json_info_cache SET last_accessed_timestamp_ms = ? WHERE cache_key = ?`);
                            updateStmt.run(Date.now(), cacheKey);
                            
                            // Optionally, promote to L1 (though design doc doesn't explicitly require this step here,
                            // it's a common pattern. For now, just return from L2).
                            // If promoting, use setDataToCache with L1 target.
                            return data; // BSON.deserialize already returns a new object
                        } catch (bsonError) {
                            this.logger.error(`L2 BSON deserialize error for key ${cacheKey}: ${bsonError.message}. Deleting entry.`, bsonError);
                            await this._deleteL2Entry(cacheKey);
                            return undefined;
                        }
                    } else {
                        this.logger.info(`L2 cache entry invalid or expired for key: ${cacheKey}. Deleting.`);
                        await this._deleteL2Entry(cacheKey);
                    }
                } else {
                    this.logger.debug(`L2 cache miss for key: ${cacheKey}`);
                }
            } catch (error) {
                this.logger.error(`L2: Error getting data for key ${cacheKey} from SQLite: ${error.message}`, error);
            }
        }
        this.logger.debug(`Cache miss for key: ${cacheKey} after L1 and L2 checks.`);
        return undefined;
    }

    /**
     * Sets data to the cache.
     * @param {CacheDataType} dataType - The type of data to set.
     * @param {string} sourceId - The ID of the data source.
     * @param {string} pathIdentifier - The path or unique identifier for the data.
     * @param {any} data - The data to cache.
     * @param {object} metadataForCache - Metadata associated with the data's source.
     * @param {string} [sourceTypeForTTL] - Optional: 'local' or 'webdav', for MODEL_LIST TTL.
     * @returns {Promise<void>}
     */
    async setDataToCache(dataType, sourceId, pathIdentifier, data, metadataForCache, sourceTypeForTTL) {
        if (!this.isInitialized || !this.isEnabled) {
            this.logger.debug(`setDataToCache: Service not initialized or disabled. DataType: ${dataType}`);
            return;
        }
        if (data === undefined || data === null) {
            this.logger.warn(`setDataToCache: Data is undefined/null for ${dataType} ${sourceId}:${pathIdentifier}. Skipping cache set.`);
            return;
        }

        const cacheKey = this._generateCacheKey(dataType, sourceId, pathIdentifier);
        this.logger.debug(`setDataToCache: Attempting for key: ${cacheKey}, dataType: ${dataType}`);

        const ttlSeconds = this._getTtlSeconds(dataType, sourceTypeForTTL);

        // L1 Storage (for MODEL_LIST, MODEL_DETAIL)
        if (dataType === CacheDataType.MODEL_LIST || dataType === CacheDataType.MODEL_DETAIL) {
            if (this.l1Cache.size >= this.l1MaxItems && !this.l1Cache.has(cacheKey)) {
                const oldestKey = this.l1Cache.keys().next().value;
                if (oldestKey) {
                    this.l1Cache.delete(oldestKey);
                    this.logger.info(`L1 cache full, removed oldest item: ${oldestKey}`);
                }
            }
            const clonedData = structuredClone(data);
            this.l1Cache.set(cacheKey, {
                data: clonedData,
                metadata: metadataForCache, // This is the source file's metadata
                timestamp: Date.now(),
                ttlMs: ttlSeconds * 1000,
                dataType: dataType // Store dataType for validation context
            });
            this.logger.info(`L1 cache set for key: ${cacheKey} with TTL: ${ttlSeconds}s`);
        }

        // L2 Storage (for MODEL_JSON_INFO)
        if (dataType === CacheDataType.MODEL_JSON_INFO) {
            if (!this.db) {
                this.logger.warn(`L2 set skipped for key ${cacheKey}: DB not available.`);
                return;
            }
            if (!metadataForCache || typeof metadataForCache.fileSize !== 'number' || typeof metadataForCache.metadata_lastModified_ms !== 'number') {
                this.logger.error(`L2 set skipped for key ${cacheKey}: Invalid or missing metadataForCache (fileSize, metadata_lastModified_ms).`, metadataForCache);
                return;
            }

            let bsonData;
            try {
                bsonData = BSON.serialize(data);
            } catch (bsonError) {
                this.logger.error(`L2 BSON serialize error for key ${cacheKey}: ${bsonError.message}. Write aborted.`, bsonError);
                return;
            }

            const cached_timestamp_ms = Date.now();
            const last_accessed_timestamp_ms = cached_timestamp_ms;

            try {
                const stmt = this.db.prepare(`
                    INSERT OR REPLACE INTO model_json_info_cache
                    (cache_key, source_id, normalized_json_path, bson_data, 
                     metadata_filesize, metadata_lastModified_ms, metadata_etag, 
                     cached_timestamp_ms, ttl_seconds, last_accessed_timestamp_ms)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                const runInfo = stmt.run(
                    cacheKey,
                    sourceId,
                    pathIdentifier.replace(/\\/g, '/'), // Ensure pathIdentifier is stored normalized
                    bsonData,
                    metadataForCache.fileSize,
                    metadataForCache.metadata_lastModified_ms,
                    metadataForCache.etag === undefined ? null : metadataForCache.etag, // Handle potentially undefined etag
                    cached_timestamp_ms,
                    ttlSeconds,
                    last_accessed_timestamp_ms
                );
                this.logger.info(`L2 cache set for key: ${cacheKey}. Changes: ${runInfo.changes}. TTL: ${ttlSeconds}s`);
                 if (runInfo.changes === 0) {
                    this.logger.warn(`L2: stmt.run for key ${cacheKey} reported 0 changes. Data might not have been written as expected.`);
                }
            } catch (error) {
                this.logger.error(`L2: Error setting data for key ${cacheKey} in SQLite: ${error.message}`, error);
            }
        }
    }

    /**
     * Invalidates a specific cache entry.
     * @param {CacheDataType} dataType - The type of data to invalidate.
     * @param {string} sourceId - The ID of the data source.
     * @param {string} pathIdentifier - The path or unique identifier for the data.
     * @returns {Promise<void>}
     */
    async invalidateCacheEntry(dataType, sourceId, pathIdentifier) {
        if (!this.isInitialized || !this.isEnabled) {
            this.logger.debug(`invalidateCacheEntry: Service not initialized or disabled. DataType: ${dataType}`);
            return;
        }
        const cacheKey = this._generateCacheKey(dataType, sourceId, pathIdentifier);
        this.logger.info(`Invalidating cache entry for key: ${cacheKey}, dataType: ${dataType}`);

        // Delete from L1
        if (this.l1Cache.has(cacheKey)) {
            this.l1Cache.delete(cacheKey);
            this.logger.info(`L1 entry deleted for key: ${cacheKey}`);
        }

        // Delete from L2 if applicable
        if (dataType === CacheDataType.MODEL_JSON_INFO) {
            await this._deleteL2Entry(cacheKey);
        }
    }
    
    /**
     * Helper to delete a single L2 entry.
     * @param {string} cacheKey
     * @returns {Promise<void>}
     * @private
     */
    async _deleteL2Entry(cacheKey) {
        if (!this.db) {
            this.logger.warn(`L2 delete skipped for key ${cacheKey}: DB not available.`);
            return;
        }
        try {
            const stmt = this.db.prepare(`DELETE FROM model_json_info_cache WHERE cache_key = ?`);
            const result = stmt.run(cacheKey);
            if (result.changes > 0) {
                this.logger.info(`L2 entry deleted for key: ${cacheKey}`);
            } else {
                this.logger.debug(`L2 entry not found for deletion: ${cacheKey}`);
            }
        } catch (error) {
            this.logger.error(`L2: Error deleting entry for key ${cacheKey}: ${error.message}`, error);
        }
    }


    /**
     * Clears all cache entries for a specific data source.
     * @param {string} sourceId - The ID of the data source.
     * @returns {Promise<void>}
     */
    async clearCacheForSource(sourceId) {
        if (!this.isInitialized || !this.isEnabled) {
            this.logger.debug(`clearCacheForSource: Service not initialized or disabled. SourceID: ${sourceId}`);
            return;
        }
        this.logger.info(`Clearing all cache entries for sourceId: ${sourceId}`);

        // Clear L1 entries for this sourceId
        let l1ClearedCount = 0;
        const l1Prefix = `:${sourceId}:`; // Common part of the key after dataType
        for (const key of this.l1Cache.keys()) {
            if (key.includes(l1Prefix)) { // More general check than startsWith if dataType is variable
                 const keyParts = key.split(':');
                 if (keyParts.length > 1 && keyParts[1] === sourceId) {
                    this.l1Cache.delete(key);
                    l1ClearedCount++;
                 }
            }
        }
        this.logger.info(`L1: Cleared ${l1ClearedCount} entries for sourceId: ${sourceId}`);

        // Clear L2 entries for this sourceId
        if (!this.db) {
            this.logger.warn(`L2 clear for source ${sourceId} skipped: DB not available.`);
            return;
        }
        try {
            const stmt = this.db.prepare(`DELETE FROM model_json_info_cache WHERE source_id = ?`);
            const result = stmt.run(sourceId);
            this.logger.info(`L2: Cleared ${result.changes} entries from model_json_info_cache for sourceId: ${sourceId}`);
        } catch (error) {
            this.logger.error(`L2: Error clearing entries by sourceId ${sourceId}: ${error.message}`, error);
        }
    }

    /**
     * Clears all caches (L1 and L2).
     * @returns {Promise<void>}
     */
    async clearAllCache() {
        if (!this.isInitialized) { // No need to check isEnabled, clear should work even if temp disabled
            this.logger.warn('clearAllCache called before initialization.');
            // return; // Or proceed to clear what can be cleared
        }
        this.logger.info('Clearing all caches (L1 and L2).');

        // Clear L1
        this.l1Cache.clear();
        this.logger.info('L1 cache cleared.');

        // Clear L2
        if (!this.db) {
            this.logger.warn('L2 clear all skipped: DB not available.');
            return;
        }
        try {
            const stmt = this.db.prepare(`DELETE FROM model_json_info_cache`);
            const result = stmt.run();
            this.logger.info(`L2: Cleared table model_json_info_cache. ${result.changes} rows deleted.`);
            // Optionally VACUUM, but be cautious.
            // this.db.exec('VACUUM');
            // this.logger.info('L2: Database VACUUM completed after clearing all.');
        } catch (error) {
            this.logger.error(`L2: Error clearing all entries from model_json_info_cache: ${error.message}`, error);
        }
    }
    
    _scheduleL2Cleanup() {
        // Run cleanup periodically (e.g., every hour)
        // For simplicity, a basic interval. More robust scheduling might use a library or main process events.
        const cleanupIntervalMs = 3600 * 1000; // 1 hour
        setInterval(async () => {
            if (this.isEnabled && this.db) {
                this.logger.info('Periodic L2 cleanup task started...');
                await this._runL2Cleanup();
            }
        }, cleanupIntervalMs);
        this.logger.info(`Scheduled periodic L2 cleanup every ${cleanupIntervalMs / 1000 / 60} minutes.`);
        
        // Initial cleanup shortly after startup
        setTimeout(async () => {
            if (this.isEnabled && this.db) {
                 this.logger.info('Initial L2 cleanup task started...');
                 await this._runL2Cleanup();
            }
        }, 5 * 60 * 1000); // 5 minutes after init
    }

    async _runL2Cleanup() {
        if (!this.db || !this.isEnabled) {
            this.logger.debug(`L2 Cleanup: Skipped, DB not available or service disabled.`);
            return;
        }
        this.logger.info(`L2 Cleanup: Running task...`);
        const now = Date.now();
        let totalExpiredDeleted = 0;

        try {
            // TTL Cleanup for model_json_info_cache
            const stmt = this.db.prepare(`
                DELETE FROM model_json_info_cache
                WHERE (cached_timestamp_ms + ttl_seconds * 1000) < ?
            `);
            const result = stmt.run(now);
            if (result.changes > 0) {
                this.logger.info(`L2 Cleanup: Deleted ${result.changes} expired entries from model_json_info_cache.`);
                totalExpiredDeleted += result.changes;
            }
        } catch (error) {
            this.logger.error(`L2 Cleanup: Error cleaning expired entries from model_json_info_cache: ${error.message}`, error);
        }
        
        // LRU Cleanup for model_json_info_cache (if maxItems configured)
        let l2MaxItemsModelInfo = 5000; // Default
        if (this.configService) {
            const l2ModelInfoMaxItemsValue = await this.configService.getSetting('cache.l2.maxItems.modelInfo'); // Assuming this config key exists
            l2MaxItemsModelInfo = (l2ModelInfoMaxItemsValue !== undefined && l2ModelInfoMaxItemsValue !== null) ? l2ModelInfoMaxItemsValue : 5000;
        }
        
        if (l2MaxItemsModelInfo > 0) {
            try {
                const countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM model_json_info_cache`);
                const currentCount = countStmt.get().count;

                if (currentCount > l2MaxItemsModelInfo) {
                    const itemsToDelete = currentCount - l2MaxItemsModelInfo;
                    this.logger.info(`L2 Cleanup (model_json_info_cache): Exceeds max items (${l2MaxItemsModelInfo}). Current: ${currentCount}. Deleting ${itemsToDelete} LRU items.`);
                    const deleteLruStmt = this.db.prepare(`
                        DELETE FROM model_json_info_cache
                        WHERE cache_key IN (
                            SELECT cache_key FROM model_json_info_cache
                            ORDER BY last_accessed_timestamp_ms ASC
                            LIMIT ?
                        )
                    `);
                    const lruResult = deleteLruStmt.run(itemsToDelete);
                    this.logger.info(`L2 Cleanup (model_json_info_cache): Deleted ${lruResult.changes} LRU entries.`);
                }
            } catch (error) {
                this.logger.error(`L2 Cleanup: Error during LRU cleanup for model_json_info_cache: ${error.message}`, error);
            }
        }

        if (totalExpiredDeleted > 0) {
            this.logger.info(`L2 Cleanup: Finished. Total expired entries deleted: ${totalExpiredDeleted}. LRU cleanup also performed if applicable.`);
        } else {
            this.logger.info(`L2 Cleanup: Finished. No expired entries found. LRU cleanup performed if applicable.`);
        }
    }


    // --- Cache Stats Methods ---
    getL1CacheStats() {
        if (!this.isInitialized) {
            this.logger.warn('getL1CacheStats called before initialization.');
            return { items: 0, maxItems: this.l1MaxItems, isEnabled: this.isEnabled };
        }
        return {
            items: this.l1Cache.size,
            maxItems: this.l1MaxItems,
            isEnabled: this.isEnabled,
        };
    }

    async getL2CacheStats() {
        if (!this.isInitialized || !this.dbPath || !this.isEnabled || !this.db) {
            this.logger.warn(`L2 Stats: Called but service/DB not ready. Initialized: ${this.isInitialized}, DBPath: ${this.dbPath}, Enabled: ${this.isEnabled}, DB Ready: !!${this.db}`);
            return { tables: {}, totalDbFileSize: 0, path: this.dbPath || 'N/A', isEnabled: this.isEnabled && !!this.db };
        }

        let totalSize = 0;
        const tableStats = {};
        try {
            const stat = await fs.stat(this.dbPath); // Use async stat
            totalSize = stat.size;
            
            const tableName = 'model_json_info_cache';
            try {
                const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`);
                const result = stmt.get();
                tableStats[tableName] = { items: result.count };
            } catch (tableError) {
                this.logger.error(`Error getting item count for table ${tableName}: ${tableError.message}`, tableError);
                tableStats[tableName] = { items: 0, error: tableError.message };
            }
            this.logger.info(`L2 DB stats: Total size ${totalSize} bytes. Table counts: ${JSON.stringify(tableStats)}`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                this.logger.warn(`L2 DB file not found at ${this.dbPath} for stats.`);
            } else {
                this.logger.error(`Error getting L2 DB file stats from ${this.dbPath}: ${error.message}`, error);
            }
        }
        return {
            tables: tableStats,
            totalDbFileSize: totalSize,
            path: this.dbPath,
            isEnabled: this.isEnabled && !!this.db,
        };
    }

    async getCacheStats() {
        const l1Stats = this.getL1CacheStats();
        const l2Stats = await this.getL2CacheStats();

        return {
            l1: l1Stats,
            l2: l2Stats,
            serviceEnabled: this.isEnabled,
            initialized: this.isInitialized,
        };
    }
    
    close() {
        if (this.db) {
            try {
                this.db.close();
                this.logger.info('SQLite database connection closed.');
            } catch (err) {
                this.logger.error('Error closing the SQLite database', err.message);
            }
            this.db = null;
        }
        // Clear any scheduled cleanup timers
        // (Node.js automatically handles setInterval cleanup on process exit, but explicit clear is good practice if service can be re-initialized)
        if (this._cleanupIntervalId) {
            clearInterval(this._cleanupIntervalId);
            this._cleanupIntervalId = null;
        }
         if (this._initialCleanupTimeoutId) {
            clearTimeout(this._initialCleanupTimeoutId);
            this._initialCleanupTimeoutId = null;
        }
    }
}

// Export CacheDataType along with the service
module.exports = { ModelInfoCacheService, CacheDataType };