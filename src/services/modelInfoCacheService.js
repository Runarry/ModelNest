const { app } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const log = require('electron-log');
const Database = require('better-sqlite3');
const BSON = require('bson');
const { 
    DEFAULT_DB_DIR_NAME,
    DEFAULT_DB_FILE_NAME,
    CacheDataType,
    TTL_STRATEGIES 
} = require("./constants/cacheConstants")



class ModelInfoCacheService {
    constructor(configService) {
        this.configService = configService; // Retained for global enable/disable and DB path
        this.isInitialized = false;
        this.isEnabled = true; // Default, updated from config

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
                    this.logger.info('Service initialized (globally disabled).');
                    return;
                }


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
                this.logger.warn('Falling back to default cache settings for DB path.');
                const userDataPath = app.getPath('userData');
                this.dbPath = path.join(userDataPath, DEFAULT_DB_DIR_NAME, DEFAULT_DB_FILE_NAME);
                this.isEnabled = true;
            }
        } else {
            this.logger.warn('ConfigService not provided. Using default settings for DB path.');
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

            // 检查并尝试从旧位置迁移数据库
            await this._migrateFromOldDbLocation();

            this.db = new Database(this.dbPath, { verbose: this.logger.debug.bind(this.logger) });
            this.logger.info(`SQLite database connected at: ${this.dbPath}`);

            // Apply performance PRAGMAs
            try {
                this.db.pragma('journal_mode = WAL');
                this.db.pragma('synchronous = NORMAL');
                this.logger.info('Applied PRAGMA settings: journal_mode=WAL, synchronous=NORMAL.');
            } catch (pragmaError) {
                this.logger.error(`Failed to apply PRAGMA settings: ${pragmaError.message}`, pragmaError);
                // Continue initialization even if PRAGMAs fail, but log the error.
            }

            this._createTables();
        } catch (error) {
            this.logger.error(`Failed to initialize SQLite database at '${this.dbPath}': ${error.message}`, error);
            this.db = null;
            this.logger.warn('L2 SQLite cache will be unavailable due to database initialization error.');
        }

        this.isInitialized = true;
        this.logger.info(`Service initialized. Status: ${this.isEnabled ? 'Enabled' : 'Disabled'}. DB Path: '${this.dbPath || 'N/A'}'`);

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
     * Gets the TTL in seconds for a given data type.
     * @param {CacheDataType} dataType
     * @returns {number} TTL in seconds.
     * @private
     */
    _getTtlSeconds(dataType) {
        if (dataType === CacheDataType.MODEL_JSON_INFO) {
            return TTL_STRATEGIES[CacheDataType.MODEL_JSON_INFO].L2;
        }
        this.logger.warn(`Unknown CacheDataType for TTL: ${dataType}. Using default 3600s.`);
        return 3600;
    }

    /**
     * Validates metadata consistency for a cache entry.
     * @param {object} cachedMetadata - The metadata stored in the cache.
     * @param {object} currentMetadata - The current metadata of the data source.
     * @param {CacheDataType} dataType - The type of data being validated.
     * @param {string} entryKeyForLog - The cache key or identifier for logging purposes.
     * @param {string} cacheLevelForLog - The cache level ('L2') for logging.
     * @returns {boolean} True if metadata is valid, false otherwise.
     * @private
     */
    _isMetadataValid(cachedMetadata, currentMetadata, dataType, entryKeyForLog, cacheLevelForLog) {
        if (dataType === CacheDataType.MODEL_JSON_INFO) {
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
     * 从缓存中获取数据。
     * @param {CacheDataType} dataType - 要获取的数据类型。
     * @param {string} sourceId - 数据源的ID。
     * @param {string} pathIdentifier - 数据的路径或唯一标识符。
     * @param {object} currentMetadata - 当前数据源的元数据，用于校验。
     * @returns {any|undefined} 返回缓存的数据，如果未找到或无效则返回undefined。
     */
    getDataFromCache(dataType, sourceId, pathIdentifier, currentMetadata) {
        if (!this.isInitialized || !this.isEnabled) {
            this.logger.debug(`getDataFromCache: Service not initialized or disabled. DataType: ${dataType}`);
            return undefined;
        }

        // Only support MODEL_JSON_INFO type for L2 cache
        if (dataType !== CacheDataType.MODEL_JSON_INFO) {
            return undefined;
        }

        const cacheKey = this._generateCacheKey(dataType, sourceId, pathIdentifier);
        this.logger.debug(`getDataFromCache: Attempting for key: ${cacheKey}, dataType: ${dataType}`);

        // L2 Lookup
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
                    // Try to deserialize BSON data safely using the helper function
                    const data = this._deserializeBson(dbRow.bson_data, cacheKey);

                    if (data !== null) {
                        // Update last_accessed_timestamp_ms
                        const updateStmt = this.db.prepare(`UPDATE model_json_info_cache SET last_accessed_timestamp_ms = ? WHERE cache_key = ?`);
                        updateStmt.run(Date.now(), cacheKey);
                        return data; // Deserialized data is valid
                    } else {
                        // Deserialization failed (error already logged in helper)
                        this.logger.warn(`L2 BSON deserialize failed for key ${cacheKey}. Deleting invalid entry.`);
                        this._deleteL2Entry(cacheKey); // Delete the corrupted/invalid entry
                        return undefined;
                    }
                } else {
                    this.logger.info(`L2 cache entry invalid or expired for key: ${cacheKey}. Deleting.`);
                    this._deleteL2Entry(cacheKey);
                }
            } else {
                this.logger.debug(`L2 cache miss for key: ${cacheKey}`);
            }
        } catch (error) {
            this.logger.error(`L2: Error getting data for key ${cacheKey} from SQLite: ${error.message}`, error);
        }
        
        this.logger.debug(`Cache miss for key: ${cacheKey}`);
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
     * @returns {void}
     */
    setDataToCache(dataType, sourceId, pathIdentifier, data, metadataForCache, sourceTypeForTTL) {
        if (!this.isInitialized || !this.isEnabled) {
            this.logger.debug(`setDataToCache: Service not initialized or disabled. DataType: ${dataType}`);
            return;
        }
        if (data === undefined || data === null) {
            this.logger.warn(`setDataToCache: Data is undefined/null for ${dataType} ${sourceId}:${pathIdentifier}. Skipping cache set.`);
            return;
        }

        // Only support MODEL_JSON_INFO type for L2 cache
        if (dataType !== CacheDataType.MODEL_JSON_INFO) {
            return;
        }

        const cacheKey = this._generateCacheKey(dataType, sourceId, pathIdentifier);
        this.logger.debug(`setDataToCache: Attempting for key: ${cacheKey}, dataType: ${dataType}`);

        const ttlSeconds = this._getTtlSeconds(dataType);

        // L2 Storage
        if (!this.db) {
            this.logger.warn(`L2 set skipped for key ${cacheKey}: DB not available.`);
            return;
        }
        if (!metadataForCache || typeof metadataForCache.fileSize !== 'number' || typeof metadataForCache.metadata_lastModified_ms !== 'number') {
            this.logger.error(`L2 set skipped for key ${cacheKey}: Invalid or missing metadataForCache (fileSize, metadata_lastModified_ms).`, metadataForCache);
            return;
        }

        // Try to serialize BSON data safely using the helper function
        const bsonData = this._serializeBson(data, cacheKey);

        if (bsonData === null) {
            // Serialization failed (error already logged in helper)
            this.logger.error(`L2 BSON serialize failed for key ${cacheKey}. Write aborted.`);
            return; // Do not proceed with database write
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

    /**
     * Invalidates a specific cache entry.
     * @param {CacheDataType} dataType - The type of data to invalidate.
     * @param {string} sourceId - The ID of the data source.
     * @param {string} pathIdentifier - The path or unique identifier for the data.
     * @returns {void}
     */
    invalidateCacheEntry(dataType, sourceId, pathIdentifier) {
        if (!this.isInitialized || !this.isEnabled) {
            this.logger.debug(`invalidateCacheEntry: Service not initialized or disabled. DataType: ${dataType}`);
            return;
        }

        // Only support MODEL_JSON_INFO type for L2 cache
        if (dataType !== CacheDataType.MODEL_JSON_INFO) {
            return;
        }

        const cacheKey = this._generateCacheKey(dataType, sourceId, pathIdentifier);
        this.logger.info(`Invalidating cache entry for key: ${cacheKey}, dataType: ${dataType}`);

        // Delete from L2
        this._deleteL2Entry(cacheKey);
    }

    /**
     * Helper to delete a single L2 entry.
     * @param {string} cacheKey
     * @returns {void}
     * @private
     */
    _deleteL2Entry(cacheKey) {
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
     * @returns {void}
     */
    clearCacheForSource(sourceId) {
        if (!this.isInitialized || !this.isEnabled) {
            this.logger.debug(`clearCacheForSource: Service not initialized or disabled. SourceID: ${sourceId}`);
            return;
        }
        this.logger.info(`Clearing all cache entries for sourceId: ${sourceId}`);

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
     * @returns {void}
     */
    clearAllCache() {
        if (!this.isInitialized) { // No need to check isEnabled, clear should work even if temp disabled
            this.logger.warn('clearAllCache called before initialization.');
            return;
        }
        this.logger.info('Clearing L2 cache.');

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
/**
     * Safely serializes data to BSON format.
     * @param {any} data - The data to serialize.
     * @param {string} cacheKey - The cache key for logging purposes.
     * @returns {Buffer|null} Serialized BSON buffer or null on error.
     * @private
     */
    _serializeBson(data, cacheKey) {
        try {
            return BSON.serialize(data);
        } catch (bsonError) {
            this.logger.error(`BSON serialize error for key ${cacheKey}: ${bsonError.message}.`, bsonError);
            return null;
        }
    }

    /**
     * Safely deserializes data from BSON format.
     * @param {Buffer} bsonData - The BSON buffer to deserialize.
     * @param {string} cacheKey - The cache key for logging purposes.
     * @returns {any|null} Deserialized data or null on error.
     * @private
     */
    _deserializeBson(bsonData, cacheKey) {
        try {
            return BSON.deserialize(bsonData);
        } catch (bsonError) {
            this.logger.error(`BSON deserialize error for key ${cacheKey}: ${bsonError.message}.`, bsonError);
            return null;
        }
    }

    _scheduleL2Cleanup() {
        // Run cleanup periodically (e.g., every hour)
        // For simplicity, a basic interval. More robust scheduling might use a library or main process events.
        const cleanupIntervalMs = 3600 * 1000; // 1 hour
        this._cleanupIntervalId = setInterval(async () => {
            if (this.isEnabled && this.db) {
                this.logger.info('Periodic L2 cleanup task started...');
                await this._runL2Cleanup();
            }
        }, cleanupIntervalMs);
        this.logger.info(`Scheduled periodic L2 cleanup every ${cleanupIntervalMs / 1000 / 60} minutes.`);

        // Initial cleanup shortly after startup
        this._initialCleanupTimeoutId = setTimeout(async () => {
            if (this.isEnabled && this.db) {
                this.logger.info('Initial L2 cleanup task started...');
                await this._runL2Cleanup();
            }
        }, 5 * 60 * 1000); // 5 minutes after init
    }

    async _runL2Cleanup() { // Keep async because configService.getSetting is async
        if (!this.db || !this.isEnabled) {
            this.logger.debug(`L2 Cleanup: Skipped, DB not available or service disabled.`);
            return;
        }
        this.logger.info(`L2 Cleanup: Running task...`);
        const now = Date.now();
        let totalExpiredDeleted = 0;
        let totalLruDeleted = 0;

        // --- Read config BEFORE transaction ---
        let l2MaxItemsModelInfo = 5000; // Default
        if (this.configService) {
            try {
                const l2ModelInfoMaxItemsValue = await this.configService.getSetting('cache.l2.maxItems.modelInfo'); // Assuming this config key exists
                l2MaxItemsModelInfo = (l2ModelInfoMaxItemsValue !== undefined && l2ModelInfoMaxItemsValue !== null) ? l2ModelInfoMaxItemsValue : 5000;
                this.logger.debug(`L2 Cleanup: Using maxItems for modelInfo: ${l2MaxItemsModelInfo}`);
            } catch (configError) {
                this.logger.error(`L2 Cleanup: Failed to read 'cache.l2.maxItems.modelInfo' from config: ${configError.message}. Falling back to default ${l2MaxItemsModelInfo}.`, configError);
            }
        } else {
            this.logger.warn(`L2 Cleanup: ConfigService not available, using default maxItems for modelInfo: ${l2MaxItemsModelInfo}`);
        }

        // --- Define the synchronous transaction function ---
        const cleanupTransaction = this.db.transaction(() => {
            // --- Transaction Start ---
            // Note: Variables defined outside (now, l2MaxItemsModelInfo) are accessible here.
            // We need to track changes *inside* the transaction scope for accurate counts *after* potential rollbacks.
            let expiredDeletedInTx = 0;
            let lruDeletedInTx = 0;

            // 1. TTL Cleanup
            try {
                const stmt = this.db.prepare(`
                    DELETE FROM model_json_info_cache
                    WHERE (cached_timestamp_ms + ttl_seconds * 1000) < ?
                `);
                const result = stmt.run(now);
                if (result.changes > 0) {
                    this.logger.info(`L2 Cleanup (TTL): Deleted ${result.changes} expired entries.`);
                    expiredDeletedInTx = result.changes; // Track changes within TX
                }
            } catch (error) {
                this.logger.error(`L2 Cleanup (TTL): Error cleaning expired entries: ${error.message}`, error);
                // Log error but continue within transaction for LRU cleanup
            }

            // 2. LRU Cleanup (only if needed and enabled)
            if (l2MaxItemsModelInfo > 0) {
                try {
                    const countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM model_json_info_cache`);
                    const currentCount = countStmt.get().count;
                    const itemsOverLimit = currentCount - l2MaxItemsModelInfo;

                    if (itemsOverLimit > 0) {
                        this.logger.info(`L2 Cleanup (LRU): Exceeds max items (${l2MaxItemsModelInfo}). Current: ${currentCount}. Deleting ${itemsOverLimit} LRU items.`);
                        const deleteLruStmt = this.db.prepare(`
                            DELETE FROM model_json_info_cache
                            WHERE cache_key IN (
                                SELECT cache_key FROM model_json_info_cache
                                ORDER BY last_accessed_timestamp_ms ASC
                                LIMIT ?
                            )
                        `);
                        const lruResult = deleteLruStmt.run(itemsOverLimit);
                        if (lruResult.changes > 0) {
                            this.logger.info(`L2 Cleanup (LRU): Deleted ${lruResult.changes} LRU entries.`);
                            lruDeletedInTx = lruResult.changes; // Track changes within TX
                        }
                    } else {
                         this.logger.debug(`L2 Cleanup (LRU): Item count (${currentCount}) within limit (${l2MaxItemsModelInfo}). No LRU deletion needed.`);
                    }
                } catch (error) {
                    this.logger.error(`L2 Cleanup (LRU): Error during LRU cleanup: ${error.message}`, error);
                    // Log error, transaction might rollback depending on the severity and other operations.
                }
            } else {
                 this.logger.debug(`L2 Cleanup (LRU): LRU cleanup skipped as maxItems is not positive (${l2MaxItemsModelInfo}).`);
            }
            // --- Transaction End ---
            // Return the counts from the transaction function so they can be accessed after execution
            return { expiredDeleted: expiredDeletedInTx, lruDeleted: lruDeletedInTx };
        }); // End of transaction definition

        // --- Execute the transaction ---
        try {
            const resultCounts = cleanupTransaction(); // Execute the transaction and get returned counts
            totalExpiredDeleted = resultCounts.expiredDeleted;
            totalLruDeleted = resultCounts.lruDeleted;
            this.logger.info(`L2 Cleanup Transaction finished successfully. Expired deleted: ${totalExpiredDeleted}. LRU deleted: ${totalLruDeleted}.`);
        } catch (transactionError) {
            this.logger.error(`L2 Cleanup Transaction failed: ${transactionError.message}`, transactionError);
            // Counts remain 0 as the transaction likely rolled back.
            totalExpiredDeleted = 0;
            totalLruDeleted = 0;
        }
    }


    // --- Cache Stats Methods ---
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
        const l2Stats = await this.getL2CacheStats();

        return {
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

    /**
     * 检查并迁移旧位置的数据库文件到新位置
     * @returns {Promise<void>}
     * @private
     */
    async _migrateFromOldDbLocation() {
        // 构建旧目录和文件路径
        const userDataPath = app.getPath('userData');
        const oldDirName = 'ModelNestCache';
        const oldDbPath = path.join(userDataPath, oldDirName, DEFAULT_DB_FILE_NAME);
        
        // 判断新旧路径是否相同
        if (this.dbPath === oldDbPath) {
            this.logger.debug('Old and new database paths are identical, no migration needed.');
            return;
        }
        
        // 检查新文件是否已存在
        try {
            await fs.access(this.dbPath);
            this.logger.debug(`Database file already exists at the new location: ${this.dbPath}`);
            // 新位置已有文件，无需迁移
            return;
        } catch (err) {
            // 新位置没有文件，继续迁移
        }
        
        // 检查旧文件是否存在
        try {
            await fs.access(oldDbPath);
            this.logger.info(`Found database file at old location: ${oldDbPath}`);
        } catch (err) {
            // 旧文件不存在，没有什么可迁移的
            this.logger.debug('No database file found at old location. Fresh start.');
            return;
        }
        
        // 迁移文件
        try {
            this.logger.info(`Migrating database from ${oldDbPath} to ${this.dbPath}`);
            
            // 确保目标目录存在
            await fs.ensureDir(path.dirname(this.dbPath));
            
            // 复制数据库文件（包括可能存在的WAL和SHM文件）
            await fs.copy(oldDbPath, this.dbPath);
            
            // 复制WAL和SHM文件（如果存在）
            const walFile = `${oldDbPath}-wal`;
            const shmFile = `${oldDbPath}-shm`;
            
            try {
                await fs.access(walFile);
                await fs.copy(walFile, `${this.dbPath}-wal`);
                this.logger.debug(`Copied WAL file to new location`);
            } catch (walErr) {
                // WAL文件不存在，不需要复制
            }
            
            try {
                await fs.access(shmFile);
                await fs.copy(shmFile, `${this.dbPath}-shm`);
                this.logger.debug(`Copied SHM file to new location`);
            } catch (shmErr) {
                // SHM文件不存在，不需要复制
            }
            
            this.logger.info(`Database migration completed successfully`);
        } catch (copyError) {
            this.logger.error(`Failed to migrate database: ${copyError.message}`, copyError);
            // 迁移失败，但不阻止服务继续初始化
        }
    }

    /**
     * 手动执行从旧路径的迁移（用于通过IPC调用）
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async manualMigrateFromOldLocation() {
        this.logger.info('Manual migration from old database location requested');
        
        try {
            await this._migrateFromOldDbLocation();
            
            // 迁移完成后尝试重新连接数据库（如果当前未连接）
            if (!this.db && this.isEnabled) {
                try {
                    this.db = new Database(this.dbPath, { verbose: this.logger.debug.bind(this.logger) });
                    this.db.pragma('journal_mode = WAL');
                    this.db.pragma('synchronous = NORMAL');
                    this._createTables();
                    this.logger.info('Successfully reconnected to database after migration');
                } catch (dbError) {
                    this.logger.error(`Failed to reconnect to database after migration: ${dbError.message}`);
                    return { 
                        success: false, 
                        message: `Migration completed but failed to reconnect: ${dbError.message}` 
                    };
                }
            }
            
            return { 
                success: true, 
                message: 'Migration from old database location completed successfully' 
            };
        } catch (error) {
            this.logger.error(`Manual migration failed: ${error.message}`, error);
            return { 
                success: false, 
                message: `Migration failed: ${error.message}` 
            };
        }
    }
}

module.exports = { ModelInfoCacheService };