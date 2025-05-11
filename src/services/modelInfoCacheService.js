const { app } = require('electron');
const path = require('path');
const fs = require('fs-extra'); // Still needed for app.getPath('userData') and potentially ensuring DB directory
const log = require('electron-log');
const Database = require('better-sqlite3');
const BSON = require('bson');
// const ConfigService = require('./configService'); // Will be handled during integration

const DEFAULT_L1_MAX_ITEMS = 200;
const DEFAULT_L1_TTL_SECONDS = 3600; // 1 hour
const DEFAULT_L2_TTL_SECONDS = 604800; // 7 days
// const DEFAULT_L2_MAX_ITEMS = 5000; // For SQLite, this is managed by cleanup logic
const DEFAULT_DB_DIR_NAME = 'ModelNestCache'; // Directory for the SQLite DB
const DEFAULT_DB_FILE_NAME = 'model_cache.sqlite';

class ModelInfoCacheService {
    constructor(configService) {
        this.configService = configService;
        this.isInitialized = false;
        this.isEnabled = true; // Default, updated from config

        this.l1Cache = new Map();
        this.l1MaxItems = DEFAULT_L1_MAX_ITEMS;
        this.l1TtlMs = DEFAULT_L1_TTL_SECONDS * 1000;

        this.l2TtlMs = DEFAULT_L2_TTL_SECONDS * 1000; // Default for L2 entries
        this.db = null; // SQLite database instance
        this.dbPath = ''; // Path to the SQLite DB file

        this.logger = log.scope('ModelInfoCacheService');
        this.logger.info('Service instance created. SQLite and BSON will be used for L2 cache.');
    }

    async initialize() {
        if (this.isInitialized) {
            this.logger.warn('Service already initialized.');
            return;
        }
        this.logger.info('Initializing ModelInfoCacheService with SQLite+BSON backend...');

        // Load configurations
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
                
                let l1Enabled = await this.configService.getSetting('cache.l1.enabled');
                if (typeof l1Enabled === 'boolean' && !l1Enabled) {
                    this.logger.info('L1 cache is disabled via configuration.');
                    this.l1Cache.clear(); // Clear L1 if it's specifically disabled
                }


                this.l1MaxItems = await this.configService.getSetting('cache.l1.maxItems') || DEFAULT_L1_MAX_ITEMS;
                const l1DefaultTtlConfig = await this.configService.getSetting('cache.l1.ttlSeconds.default');
                this.l1TtlMs = (l1DefaultTtlConfig || DEFAULT_L1_TTL_SECONDS) * 1000;
                log.info(`Default L1 TTL set to: ${this.l1TtlMs}ms (from config: ${l1DefaultTtlConfig}s)`);

                const l2ModelJsonInfoTtlConfig = await this.configService.getSetting('cache.l2.ttlSeconds.modelJsonInfo');
                this.l2TtlMs = (l2ModelJsonInfoTtlConfig || DEFAULT_L2_TTL_SECONDS) * 1000;
                log.info(`Default L2 TTL for modelJsonInfo set to: ${this.l2TtlMs}ms (from config: ${l2ModelJsonInfoTtlConfig}s)`);
                
                // Determine DB Path
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
                this.logger.warn('Falling back to default cache settings due to configuration error.');
                const userDataPath = app.getPath('userData');
                this.dbPath = path.join(userDataPath, DEFAULT_DB_DIR_NAME, DEFAULT_DB_FILE_NAME);
                this.isEnabled = true; // Default to enabled on error
                this.l1MaxItems = DEFAULT_L1_MAX_ITEMS;
                this.l1TtlMs = DEFAULT_L1_TTL_SECONDS * 1000;
                this.l2TtlMs = DEFAULT_L2_TTL_SECONDS * 1000;
            }
        } else {
            this.logger.warn('ConfigService not provided. Using default cache settings.');
            const userDataPath = app.getPath('userData');
            this.dbPath = path.join(userDataPath, DEFAULT_DB_DIR_NAME, DEFAULT_DB_FILE_NAME);
        }

        if (!this.isEnabled) { // Re-check after potential fallback
            this.isInitialized = true;
            this.logger.info('ModelInfoCacheService initialization skipped as it is disabled.');
            return;
        }

        // Initialize SQLite Database
        try {
            if (!this.dbPath) {
                 throw new Error('SQLite database path is not defined after configuration loading.');
            }
            await fs.ensureDir(path.dirname(this.dbPath)); // Ensure the directory for the DB file exists
            this.logger.info(`Ensured directory for SQLite DB: ${path.dirname(this.dbPath)}`);

            this.db = new Database(this.dbPath, { verbose: this.logger.debug.bind(this.logger) }); // Pass logger for verbose output
            this.logger.info(`SQLite database connected at: ${this.dbPath}`);

            // Create tables if they don't exist
            this._createTables();

        } catch (error) {
            this.logger.error(`Failed to initialize SQLite database at '${this.dbPath}': ${error.message}`, error);
            this.db = null; // Ensure db is null if connection failed
            this.logger.warn('L2 SQLite cache will be unavailable due to database initialization error.');
        }

        this.isInitialized = true;
        this.logger.info(`Service initialized. Status: ${this.isEnabled ? 'Enabled' : 'Disabled'}. L1 Max Items: ${this.l1MaxItems}. L1 TTL: ${this.l1TtlMs}ms. L2 TTL: ${this.l2TtlMs}ms. DB Path: '${this.dbPath || 'N/A'}'`);
    }

    _createTables() {
        if (!this.db) {
            this.logger.error('Cannot create tables, database not initialized.');
            return;
        }
        try {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS model_json_info_cache (
                    cache_key TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL,
                    normalized_json_path TEXT NOT NULL,
                    bson_data BLOB NOT NULL,
                    source_json_mtime_ms REAL NOT NULL,
                    source_json_size INTEGER NOT NULL,
                    cached_timestamp_ms INTEGER NOT NULL,
                    ttl_seconds INTEGER NOT NULL,
                    last_accessed_timestamp_ms INTEGER NOT NULL
                );
            `);
            this.logger.info('Table "model_json_info_cache" ensured.');

            // Create indexes as per design document
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mjic_source_id ON model_json_info_cache (source_id);`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mjic_last_accessed ON model_json_info_cache (last_accessed_timestamp_ms);`);
            this.logger.info('Indexes for model_json_info_cache table ensured.');

        } catch (error) {
            this.logger.error(`Error creating SQLite tables or indexes: ${error.message}`, error);
            // This is a critical error, L2 might not work.
        }
    }
    
    // --- L1 Memory Cache Methods ---
    getFromL1(key, type = 'modelJsonInfo') { // Added type for context, though L1 structure is generic
        if (!this.isInitialized || !this.isEnabled) {
            this.logger.debug(`L1: getFromL1 called but service not initialized or disabled. Key: ${key}, Type: ${type}`);
            return undefined;
        }
        const cachedItem = this.l1Cache.get(key);
        if (cachedItem) {
            const { data, timestamp, ttlMs, sourceJsonStats, directoryContentHash } = cachedItem;
            const effectiveTtlMs = ttlMs || this.l1TtlMs; // Use item-specific TTL if present, else default L1 TTL

            if (Date.now() < timestamp + effectiveTtlMs) {
                this.logger.debug(`L1 cache hit for key: ${key} (type: ${type})`);
                this.l1Cache.delete(key); // For LRU behavior
                this.l1Cache.set(key, cachedItem); // Move to end
                
                // Return all relevant metadata for the caller (ModelService) to validate
                return {
                    data: JSON.parse(JSON.stringify(data)), // Deep clone
                    timestamp,
                    ttlMs: effectiveTtlMs,
                    sourceJsonStats, // Will be undefined if not set (e.g., for listModels)
                    directoryContentHash // Will be undefined if not set (e.g., for modelJsonInfo)
                };
            } else {
                this.logger.info(`L1 cache expired for key: ${key} (type: ${type})`);
                this.l1Cache.delete(key);
            }
        } else {
            this.logger.debug(`L1 cache miss for key: ${key} (type: ${type})`);
        }
        return undefined;
    }

    setToL1(key, value, type = 'modelJsonInfo', options = {}) {
        if (!this.isInitialized || !this.isEnabled) {
            this.logger.debug(`L1: setToL1 called but service not initialized or disabled. Key: ${key}, Type: ${type}`);
            return;
        }

        if (this.l1Cache.size >= this.l1MaxItems && !this.l1Cache.has(key)) {
            const oldestKey = this.l1Cache.keys().next().value;
            if (oldestKey) {
                this.l1Cache.delete(oldestKey);
                this.logger.info(`L1 cache full, removed oldest item: ${oldestKey}`);
            }
        }

        const itemTtlMs = options.ttlMs || this.l1TtlMs; // Use provided TTL or default L1 TTL
        const clonedValue = JSON.parse(JSON.stringify(value));
        
        const cacheEntry = {
            data: clonedValue,
            timestamp: Date.now(),
            ttlMs: itemTtlMs,
        };

        if (type === 'modelJsonInfo' && options.sourceJsonStats) {
            cacheEntry.sourceJsonStats = options.sourceJsonStats;
        } else if (type === 'listModels' && options.directoryContentHash) {
            cacheEntry.directoryContentHash = options.directoryContentHash;
        }
        
        this.l1Cache.set(key, cacheEntry);
        this.logger.info(`L1 cache set for key: ${key} (type: ${type}) with TTL: ${itemTtlMs}ms. Options: ${JSON.stringify(options)}`);
    }

    deleteFromL1(key) {
        if (!this.isInitialized || !this.isEnabled) {
            this.logger.debug(`L1: deleteFromL1 called but service not initialized or disabled. Key: ${key}`);
            return;
        }
        const deleted = this.l1Cache.delete(key);
        if (deleted) {
            this.logger.info(`L1 cache deleted for key: ${key}`);
        } else {
            this.logger.debug(`L1 cache delete: key not found: ${key}`);
        }
    }

    clearL1Cache() {
        if (!this.isInitialized) {
            this.logger.warn('L1: clearL1Cache called before initialization.');
            return;
        }
        this.l1Cache.clear();
        this.logger.info('L1 memory cache cleared.');
    }

    clearL1ByPrefix(prefix) {
        if (!this.isInitialized || !this.isEnabled) {
            this.logger.debug(`L1: clearL1ByPrefix called but service not initialized or disabled. Prefix: ${prefix}`);
            return 0;
        }
        let clearedCount = 0;
        for (const key of this.l1Cache.keys()) {
            if (key.startsWith(prefix)) {
                this.l1Cache.delete(key);
                clearedCount++;
            }
        }
        if (clearedCount > 0) {
            this.logger.info(`L1: Cleared ${clearedCount} entries with prefix: ${prefix}`);
        }
        return clearedCount;
    }

    clearL1ByType(type) {
        // This requires keys to be structured to identify type, e.g., "listModels:..." or "modelJsonInfo:..."
        // Or, L1 items themselves store their type, then iterate values.
        // For now, assuming a prefix like "listModels:" or "modelJsonInfo:"
        if (!this.isInitialized || !this.isEnabled) {
            this.logger.debug(`L1: clearL1ByType called but service not initialized or disabled. Type: ${type}`);
            return 0;
        }
        this.logger.info(`L1: Clearing cache entries of type: ${type}`);
        let clearedCount = 0;
        // Example: if type is 'listModels', prefix is 'listModels:'
        // This is a convention that ModelService must follow when generating keys for setToL1.
        const prefixToClear = `${type}:`;
        
        for (const key of this.l1Cache.keys()) {
            if (key.startsWith(prefixToClear)) {
                this.l1Cache.delete(key);
                clearedCount++;
            }
        }
        if (clearedCount > 0) {
            this.logger.info(`L1: Cleared ${clearedCount} entries of type '${type}' (using prefix '${prefixToClear}').`);
        } else {
            this.logger.info(`L1: No entries found for type '${type}' with prefix '${prefixToClear}'.`);
        }
        return clearedCount;
    }


    // --- L2 SQLite Cache Methods (NEW) ---

    async getModelJsonInfoFromL2(cacheKey) {
        if (!this.db || !this.isEnabled) {
            this.logger.debug(`L2: getModelJsonInfoFromL2 - DB not available or service disabled. Key: ${cacheKey}`);
            return undefined;
        }
        this.logger.debug(`L2: getModelJsonInfoFromL2 called for key: ${cacheKey}`);
        try {
            const stmt = this.db.prepare(`
                SELECT bson_data, source_json_mtime_ms, source_json_size, cached_timestamp_ms, ttl_seconds
                FROM model_json_info_cache
                WHERE cache_key = ?
            `);
            const row = stmt.get(cacheKey);

            if (!row) {
                this.logger.debug(`L2: model_json_info_cache miss for key: ${cacheKey}`);
                return undefined;
            }

            const { bson_data, source_json_mtime_ms, source_json_size, cached_timestamp_ms, ttl_seconds } = row;
            const expiresAt = cached_timestamp_ms + (ttl_seconds * 1000);

            if (Date.now() >= expiresAt) {
                this.logger.info(`L2: model_json_info_cache expired for key: ${cacheKey}. Deleting.`);
                await this.deleteFromL2(cacheKey, 'model_json_info_cache');
                return undefined;
            }

            let modelJsonInfo;
            try {
                modelJsonInfo = BSON.deserialize(bson_data);
            } catch (bsonError) {
                this.logger.error(`L2: BSON deserialize error for key ${cacheKey} in model_json_info_cache: ${bsonError.message}. Deleting entry.`, bsonError);
                await this.deleteFromL2(cacheKey, 'model_json_info_cache');
                return undefined;
            }
            
            // Update last_accessed_timestamp_ms
            const updateStmt = this.db.prepare(`UPDATE model_json_info_cache SET last_accessed_timestamp_ms = ? WHERE cache_key = ?`);
            updateStmt.run(Date.now(), cacheKey);

            this.logger.info(`L2: model_json_info_cache hit for key: ${cacheKey}`);
            return {
                modelJsonInfo,
                sourceJsonStats: { mtimeMs: source_json_mtime_ms, size: source_json_size }
            };

        } catch (error) {
            this.logger.error(`L2: Error getting modelJsonInfo for key ${cacheKey} from SQLite: ${error.message}`, error);
            return undefined;
        }
    }

    async setModelJsonInfoToL2(cacheKey, modelJsonInfo, sourceJsonStats, ttlSeconds) {
        if (!this.db || !this.isEnabled) {
            this.logger.debug(`L2: setModelJsonInfoToL2 - DB not available or service disabled. Key: ${cacheKey}`);
            return;
        }
        this.logger.debug(`L2: setModelJsonInfoToL2 called for key: ${cacheKey}`);

        if (!sourceJsonStats || typeof sourceJsonStats.mtimeMs !== 'number' || typeof sourceJsonStats.size !== 'number') {
            this.logger.error(`L2: Invalid or missing sourceJsonStats for key ${cacheKey}. Cannot write to model_json_info_cache.`);
            return;
        }
        
        // Extract sourceId and normalized_json_path from cacheKey (e.g., "{sourceId}:{normalized_json_path}")
        const keyParts = cacheKey.split(':');
        if (keyParts.length < 2) {
            this.logger.error(`L2: Invalid cacheKey format for model_json_info_cache: ${cacheKey}. Expected {sourceId}:{normalized_json_path}.`);
            return;
        }
        const source_id = keyParts.shift();
        const normalized_json_path = keyParts.join(':');


        let bsonData;
        try {
            bsonData = BSON.serialize(modelJsonInfo);
        } catch (bsonError) {
            this.logger.error(`L2: BSON serialize error for key ${cacheKey} in model_json_info_cache: ${bsonError.message}. Write aborted.`, bsonError);
            return;
        }

        const effectiveTtlSeconds = ttlSeconds || (this.l2TtlMs / 1000);
        const cached_timestamp_ms = Date.now();
        const last_accessed_timestamp_ms = cached_timestamp_ms;

        try {
            const stmt = this.db.prepare(`
                INSERT OR REPLACE INTO model_json_info_cache
                (cache_key, source_id, normalized_json_path, bson_data, source_json_mtime_ms, source_json_size, cached_timestamp_ms, ttl_seconds, last_accessed_timestamp_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            // stmt.run(
            //     cacheKey,
            //     source_id,
            //     normalized_json_path,
            //     bsonData,
            //     sourceJsonStats.mtimeMs,
            //     sourceJsonStats.size,
            //     cached_timestamp_ms,
            //     effectiveTtlSeconds,
            //     last_accessed_timestamp_ms
            // );

            // Capture the info object from the run command
            const runInfo = stmt.run(
                cacheKey,
                source_id,
                normalized_json_path,
                bsonData,
                sourceJsonStats.mtimeMs,
                sourceJsonStats.size,
                cached_timestamp_ms,
                effectiveTtlSeconds,
                last_accessed_timestamp_ms
            );

            this.logger.info(`L2: model_json_info_cache - DB write attempt for key: ${cacheKey}. Changes: ${runInfo.changes}, Last ROWID: ${runInfo.lastInsertRowid}. TTL: ${effectiveTtlSeconds}s`);

            if (runInfo.changes === 0) {
                this.logger.warn(`L2: stmt.run for key ${cacheKey} (model_json_info_cache) reported 0 changes. Data might not have been written as expected.`);
            }

            // Verification read
            try {
                const verifyStmt = this.db.prepare('SELECT cache_key, LENGTH(bson_data) as len FROM model_json_info_cache WHERE cache_key = ?');
                const verifyRow = verifyStmt.get(cacheKey);
                if (verifyRow) {
                    this.logger.info(`L2: Verification read for key ${cacheKey} (model_json_info_cache) successful. BSON data length: ${verifyRow.len}`);
                } else {
                    this.logger.error(`L2: Verification read FAILED for key ${cacheKey} (model_json_info_cache). Data not found after insert/replace.`);
                }
            } catch (verifyError) {
                this.logger.error(`L2: Error during verification read for key ${cacheKey} (model_json_info_cache): ${verifyError.message}`, verifyError);
            }

        } catch (error) {
            this.logger.error(`L2: Error setting modelJsonInfo for key ${cacheKey} in SQLite (model_json_info_cache): ${error.message}`, error);
            if (error.code) { // SQLite errors often have a code
                 this.logger.error(`L2: SQLite error code: ${error.code}`);
            }
            this.logger.error('L2: Full error object during setModelJsonInfoToL2:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
        }
    }

    async deleteFromL2(cacheKey, tableName) {
        if (!this.db || !this.isEnabled) {
            this.logger.debug(`L2: deleteFromL2 - DB not available or service disabled. Key: ${cacheKey}, Table: ${tableName}`);
            return;
        }
        this.logger.debug(`L2: deleteFromL2 called for key: ${cacheKey}, table: ${tableName}`);
        if (tableName !== 'model_json_info_cache') {
            this.logger.error(`L2: deleteFromL2 - Invalid table name: ${tableName}. Only 'model_json_info_cache' is allowed.`);
            return;
        }
        try {
            const stmt = this.db.prepare(`DELETE FROM ${tableName} WHERE cache_key = ?`);
            const result = stmt.run(cacheKey);
            if (result.changes > 0) {
                this.logger.info(`L2: Deleted key ${cacheKey} from table ${tableName}.`);
            } else {
                this.logger.debug(`L2: Key ${cacheKey} not found in table ${tableName} for deletion.`);
            }
        } catch (error) {
            this.logger.error(`L2: Error deleting key ${cacheKey} from table ${tableName}: ${error.message}`, error);
        }
    }

    async clearL2Table(tableName) {
        if (!this.db || !this.isEnabled) {
            this.logger.debug(`L2: clearL2Table - DB not available or service disabled. Table: ${tableName}`);
            return;
        }
        this.logger.debug(`L2: clearL2Table called for table: ${tableName}`);
        if (tableName !== 'model_json_info_cache') {
            this.logger.error(`L2: clearL2Table - Invalid table name: ${tableName}. Only 'model_json_info_cache' is allowed.`);
            return;
        }
        try {
            const stmt = this.db.prepare(`DELETE FROM ${tableName}`);
            const result = stmt.run();
            this.logger.info(`L2: Cleared table ${tableName}. ${result.changes} rows deleted.`);
        } catch (error) {
            this.logger.error(`L2: Error clearing table ${tableName}: ${error.message}`, error);
        }
    }

    async clearAllL2Cache() {
        this.logger.info(`L2: Clearing 'model_json_info_cache' table.`);
        await this.clearL2Table('model_json_info_cache');
        // Optionally, VACUUM to shrink DB file, but be cautious as it's blocking.
        // try {
        //     this.db.exec('VACUUM');
        //     this.logger.info('L2: Database VACUUM completed.');
        // } catch (vacError) {
        //     this.logger.error(`L2: Error during VACUUM: ${vacError.message}`, vacError);
        // }
    }

    async runL2Cleanup() {
        if (!this.db || !this.isEnabled) {
            this.logger.debug(`L2: runL2Cleanup - DB not available or service disabled.`);
            return;
        }
        this.logger.info(`L2: Running cleanup task...`);
        const now = Date.now();
        let totalExpiredDeleted = 0;

        const tableNameToClean = 'model_json_info_cache'; // Only clean this table

        try {
            // TTL Cleanup
            const stmt = this.db.prepare(`
                DELETE FROM ${tableNameToClean}
                WHERE (cached_timestamp_ms + ttl_seconds * 1000) < ?
            `);
            const result = stmt.run(now);
            if (result.changes > 0) {
                this.logger.info(`L2 Cleanup: Deleted ${result.changes} expired entries from ${tableNameToClean}.`);
                totalExpiredDeleted += result.changes;
            }
        } catch (error) {
            this.logger.error(`L2 Cleanup: Error cleaning expired entries from ${tableNameToClean}: ${error.message}`, error);
        }
        
        // LRU Cleanup for model_json_info_cache
        const l2MaxItemsModelInfo = (await this.configService.getSetting('cache.l2.maxItems.modelInfo')) || 5000;
        
        if (l2MaxItemsModelInfo > 0) { // Only apply LRU if maxItems is positive
            try {
                const countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM ${tableNameToClean}`);
                const currentCount = countStmt.get().count;

                if (currentCount > l2MaxItemsModelInfo) {
                    const itemsToDelete = currentCount - l2MaxItemsModelInfo;
                    this.logger.info(`L2 Cleanup (${tableNameToClean}): Exceeds max items (${l2MaxItemsModelInfo}). Current: ${currentCount}. Deleting ${itemsToDelete} LRU items.`);
                    const deleteLruStmt = this.db.prepare(`
                        DELETE FROM ${tableNameToClean}
                        WHERE cache_key IN (
                            SELECT cache_key FROM ${tableNameToClean}
                            ORDER BY last_accessed_timestamp_ms ASC
                            LIMIT ?
                        )
                    `);
                    const lruResult = deleteLruStmt.run(itemsToDelete);
                    this.logger.info(`L2 Cleanup (${tableNameToClean}): Deleted ${lruResult.changes} LRU entries.`);
                }
            } catch (error) {
                this.logger.error(`L2 Cleanup: Error during LRU cleanup for ${tableNameToClean}: ${error.message}`, error);
            }
        }


        if (totalExpiredDeleted > 0) {
            this.logger.info(`L2 Cleanup: Finished. Total expired entries deleted: ${totalExpiredDeleted}. LRU cleanup also performed if applicable.`);
        } else {
            this.logger.info(`L2 Cleanup: Finished. No expired entries found. LRU cleanup performed if applicable.`);
        }
    }


    // --- Unified Cache Methods (To be updated) ---

    async get(cacheKey, type = 'modelJsonInfo') {
        if (!this.isInitialized || !this.isEnabled) {
            this.logger.debug(`Unified Get: Called but service not initialized or disabled. Type: ${type}, Key: ${cacheKey}`);
            return undefined;
        }
        this.logger.debug(`Unified Get: Attempting for key: ${cacheKey}, type: ${type}`);

        // 1. Try L1 Cache
        // L1 stores structured items. The 'type' helps interpret L1 content and decide L2 strategy.
        const l1Hit = this.getFromL1(cacheKey, type); // getFromL1 now returns the full L1 item structure
        if (l1Hit !== undefined) {
            // ModelService will use l1Hit.data, l1Hit.sourceJsonStats, l1Hit.directoryContentHash for further validation
            this.logger.info(`Unified Get: L1 cache hit for key: ${cacheKey} (type: ${type})`);
            return l1Hit; // Returns { data, timestamp, ttlMs, sourceJsonStats?, directoryContentHash? }
        }
        this.logger.debug(`Unified Get: L1 cache miss for key: ${cacheKey} (type: ${type}). Trying L2.`);

        // 2. Try L2 Cache (SQLite) - Only for 'modelJsonInfo'
        if (type === 'modelJsonInfo') {
            const l2Result = await this.getModelJsonInfoFromL2(cacheKey); // This method is specific to model_json_info_cache
            if (l2Result && l2Result.modelJsonInfo !== undefined) {
                this.logger.info(`Unified Get: L2 cache hit for key: ${cacheKey} (type: modelJsonInfo).`);
                // ModelService is responsible for constructing the full object if needed and updating L1.
                // This service returns the raw L2 data and its metadata.
                return {
                    data: l2Result.modelJsonInfo,
                    sourceJsonStats: l2Result.sourceJsonStats,
                    fromL2: true // Indicate it's from L2, so ModelService knows to populate L1
                };
            }
        } else if (type === 'listModels') {
            // listModels results are L1 only. L1 was already checked and missed.
            this.logger.debug(`Unified Get: L1 miss for 'listModels' type, key: ${cacheKey}. No L2 for this type.`);
        } else {
            this.logger.warn(`Unified Get: Unknown cache type "${type}" for key: ${cacheKey}`);
            return undefined;
        }

        this.logger.info(`Unified Get: L1 and L2 cache miss for key: ${cacheKey}, type: ${type}`);
        return undefined;
    }

    async set(cacheKey, value, ttlSeconds, type = 'modelJsonInfo', extraArgs = {}) {
        if (!this.isInitialized || !this.isEnabled) {
            this.logger.debug(`Unified Set: Called but service not initialized or disabled. Type: ${type}, Key: ${cacheKey}`);
            return;
        }
        this.logger.info(`Unified Set: Attempting for key: ${cacheKey}, type: ${type}`);

        const effectiveTtlSeconds = ttlSeconds || (type === 'modelJsonInfo' ? (this.l2TtlMs / 1000) : (this.l1TtlMs / 1000)); // Use L2 default for modelJsonInfo, L1 for others or specific TTL

        // 1. Set to L1 Memory Cache
        // L1 stores modelObj. If 'value' is modelJsonInfo, ModelService should have built modelObj first.
        // This 'set' is likely called by ModelService with a full modelObj for L1.
        // If type is 'modelJsonInfo', the 'value' here is assumed to be the modelJsonInfo part for L2,
        // and ModelService would separately call setToMemory with the full modelObj.
        // Let's assume 'value' for L1 is always the full modelObj if type implies it.
        // For simplicity here, if type is modelJsonInfo, we assume 'value' is modelJsonInfo for L2,
        // and L1 set is handled by ModelService with the full object.
        // If type is listModels, 'value' is modelObjArray, which can go to L1 as is.

        // The primary role of this unified 'set' method is to persist 'modelJsonInfo' to L2.
        // ModelService is responsible for calling `setToL1` directly for L1 cache entries
        // (both for fully constructed model objects derived from modelJsonInfo, and for listModels results).

        if (type === 'modelJsonInfo') {
            const { sourceJsonStats, isJsonInfoOnly } = extraArgs; // isJsonInfoOnly indicates 'value' is just JSON info
            if (!sourceJsonStats) {
                this.logger.warn(`Unified Set (L2 modelJsonInfo): sourceJsonStats missing for key ${cacheKey}. L2 write might be skipped or incomplete.`);
            }
            if (value === undefined || value === null) {
                 this.logger.warn(`Unified Set (L2 modelJsonInfo): value is undefined/null for key ${cacheKey}. L2 write skipped.`);
                 return;
            }
            // 'value' here is expected to be the modelJsonInfo data itself.
            await this.setModelJsonInfoToL2(cacheKey, value, sourceJsonStats || {}, effectiveTtlSeconds);
        } else if (type === 'listModels') {
            // L1 set for listModels should be done by ModelService calling setToL1 directly with the array and options.
            // No L2 operation for listModels.
            this.logger.debug(`Unified Set: type 'listModels' is L1 only. L2 write skipped for key: ${cacheKey}. ModelService should use setToL1 directly.`);
        } else {
            this.logger.warn(`Unified Set: Unknown cache type "${type}" for L2. Key: ${cacheKey}`);
        }
        this.logger.info(`Unified Set: L2 processing (if applicable) complete for key ${cacheKey}, type ${type}.`);
    }

    // --- Invalidation and Clear Methods ---
    
    // deleteFromL1 is already defined above. Renamed from invalidateL1.

    async invalidateL2(key, type = 'modelJsonInfo') {
        if (type === 'modelJsonInfo') {
            // deleteFromL2 now only accepts 'model_json_info_cache' as tableName
            await this.deleteFromL2(key, 'model_json_info_cache');
        } else {
            this.logger.warn(`invalidateL2: type '${type}' does not have L2 storage. Key: ${key}`);
        }
    }
    
    async clearEntry(key, type = 'modelJsonInfo') {
        this.logger.info(`Clearing cache entry for key: ${key}, type: ${type}`);
        this.deleteFromL1(key); // Clears from L1 regardless of type
        if (type === 'modelJsonInfo') {
            await this.invalidateL2(key, 'modelJsonInfo'); // invalidateL2 only handles modelJsonInfo
        }
        // No L2 operation for 'listModels' type as it's L1 only
    }

    async clearBySource(sourceId) {
        this.logger.info(`Attempting to clear all cache entries for sourceId: ${sourceId}`);
        
        // Clear L1 by sourceId using type-specific prefixes
        // ModelService should ensure keys are prefixed like "modelJsonInfo:{sourceId}:..." and "listModels:{sourceId}:..."
        let l1ClearedCount = 0;
        l1ClearedCount += this.clearL1ByPrefix(`modelJsonInfo:${sourceId}:`);
        l1ClearedCount += this.clearL1ByPrefix(`listModels:${sourceId}:`);
        // Or, if ModelService uses a generic sourceId prefix for all its L1 entries:
        // l1ClearedCount += this.clearL1ByPrefix(`${sourceId}:`);
        // The current clearL1ByPrefix implementation is simple.
        // A more robust clearBySource for L1 might iterate all keys and parse them if they have a standard structure.
        this.logger.info(`L1: Cleared ${l1ClearedCount} entries potentially related to sourceId: ${sourceId} based on common prefixes.`);

        // Clear L2 (model_json_info_cache only) by sourceId
        if (!this.db) {
            this.logger.warn('L2: Database not available, cannot clear by source from L2.');
            return;
        }
        try {
            const stmt1 = this.db.prepare(`DELETE FROM model_json_info_cache WHERE source_id = ?`);
            const result1 = stmt1.run(sourceId);
            this.logger.info(`L2: Cleared ${result1.changes} entries from model_json_info_cache for sourceId: ${sourceId}`);
        } catch (error) {
            this.logger.error(`L2: Error clearing model_json_info_cache entries by sourceId ${sourceId}: ${error.message}`, error);
        }
    }

    async clearAll() {
        this.clearL1Cache();
        await this.clearAllL2Cache();
        this.logger.info('All caches (L1 and L2) cleared.');
    }

    async invalidateListModelsCacheForDirectory(sourceId, directoryPath) {
        // This method now only operates on L1 cache for 'listModels' type.
        // It uses clearL1ByPrefix. The prefix must match how listModels keys are generated by ModelService.
        // Example key structure assumed by ModelService: "listModels:{sourceId}:{normalizedDirectoryPath}:..."
        this.logger.info(`L1: Invalidating listModels cache for sourceId: ${sourceId}, directoryPath: '${directoryPath}'`);

        // ModelService should be responsible for normalizing directoryPath before generating cache keys
        // and when calling this invalidation method.
        // For example, ensuring consistent trailing slashes or lack thereof.
        const prefix = `listModels:${sourceId}:${directoryPath}`;
        
        const clearedCount = this.clearL1ByPrefix(prefix);
        
        if (clearedCount > 0) {
            this.logger.info(`L1: Cleared ${clearedCount} listModels cache entries with prefix '${prefix}'.`);
        } else {
            this.logger.info(`L1: No listModels cache entries found with prefix '${prefix}'. Consider key generation consistency.`);
        }
        // Note: This simple prefix invalidation might be too broad or too narrow if directoryPath is part of a more complex key structure
        // or if parent/child directory invalidation logic is needed beyond simple prefix.
        // For V2, this targets exact directory path matches based on prefix.
        // Recursive invalidation (e.g., invalidating '/models' when '/models/subdir' changes) would require
        // iterating all listModels keys and parsing the path, or ModelService explicitly calling invalidate for parent paths.
    }


    // --- Cache Stats Methods (Update for SQLite) ---
    getL1CacheStats() { // Renamed from getMemoryCacheStats
        if (!this.isInitialized) {
            this.logger.warn('getL1CacheStats called before initialization.');
            return { items: 0, maxItems: this.l1MaxItems, isEnabled: this.isEnabled };
        }
        return {
            items: this.l1Cache.size,
            maxItems: this.l1MaxItems,
            isEnabled: this.isEnabled, // Global cache enabled status
        };
    }

    async getDiskCacheStats() { // To be renamed/refactored to getL2CacheStats
        if (!this.isInitialized || !this.dbPath || !this.isEnabled || !this.db) {
            this.logger.warn(`L2 Stats: Called but service/DB not ready. Initialized: ${this.isInitialized}, DBPath: ${this.dbPath}, Enabled: ${this.isEnabled}, DB Ready: !!${this.db}`);
            return { tables: {}, totalSize: 0, path: this.dbPath || 'N/A', isEnabled: this.isEnabled && !!this.db };
        }

        let totalSize = 0;
        const tableStats = {};
        try {
            const stat = fs.statSync(this.dbPath);
            totalSize = stat.size;
            
            const tableName = 'model_json_info_cache';
            try {
                const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`);
                const result = stmt.get();
                tableStats[tableName] = { items: result.count };
            } catch (tableError) {
                this.logger.error(`Error getting item count for table ${tableName}: ${tableError.message}`);
                tableStats[tableName] = { items: 0, error: tableError.message };
            }
            this.logger.info(`L2 DB stats: Total size ${totalSize} bytes. Table counts: ${JSON.stringify(tableStats)}`);
        } catch (error) {
            this.logger.error(`Error getting L2 DB file stats from ${this.dbPath}: ${error.message}`);
        }
        return {
            tables: tableStats,
            totalDbFileSize: totalSize, // in bytes
            path: this.dbPath,
            isEnabled: this.isEnabled && !!this.db,
        };
    }

    async getCacheStats() {
        if (!this.isInitialized) {
            this.logger.warn('getCacheStats called before initialization.');
            // Attempt to initialize if not already, though it should be.
            // await this.initialize(); // Avoid re-initializing if called early by mistake
        }
        
        const l1Stats = this.getL1CacheStats();
        const l2Stats = await this.getDiskCacheStats();

        return {
            l1: l1Stats,
            l2: l2Stats,
            serviceEnabled: this.isEnabled,
            initialized: this.isInitialized,
        };
    }
    
    // Call this when the application is shutting down
    close() {
        if (this.db) {
            this.db.close((err) => {
                if (err) {
                    this.logger.error('Error closing the SQLite database', err.message);
                } else {
                    this.logger.info('SQLite database connection closed.');
                }
            });
            this.db = null;
        }
    }
}

module.exports = ModelInfoCacheService;