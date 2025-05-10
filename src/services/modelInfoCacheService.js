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
                const l1TtlConfig = await this.configService.getSetting('cache.l1.ttlSeconds');
                this.l1TtlMs = (l1TtlConfig || DEFAULT_L1_TTL_SECONDS) * 1000;

                const l2TtlConfig = await this.configService.getSetting('cache.l2.ttlSeconds');
                this.l2TtlMs = (l2TtlConfig || DEFAULT_L2_TTL_SECONDS) * 1000;
                
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

            this.db.exec(`
                CREATE TABLE IF NOT EXISTS list_models_cache (
                    cache_key TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL,
                    directory_path TEXT NOT NULL,
                    show_subdirectory INTEGER NOT NULL,
                    supported_exts_hash TEXT NOT NULL,
                    directory_content_hash TEXT,
                    bson_data BLOB NOT NULL,
                    cached_timestamp_ms INTEGER NOT NULL,
                    ttl_seconds INTEGER NOT NULL,
                    last_accessed_timestamp_ms INTEGER NOT NULL
                );
            `);
            // directory_content_hash is NULLABLE
            // Added show_subdirectory and supported_exts_hash as per design doc 3.3.2
            this.logger.info('Table "list_models_cache" ensured.');

            // Create indexes as per design document
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mjic_source_id ON model_json_info_cache (source_id);`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mjic_last_accessed ON model_json_info_cache (last_accessed_timestamp_ms);`);
            // Indexes for list_models_cache
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_lmc_source_id_dir ON list_models_cache (source_id, directory_path);`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_lmc_last_accessed ON list_models_cache (last_accessed_timestamp_ms);`);
            this.logger.info('Indexes for cache tables ensured.');

        } catch (error) {
            this.logger.error(`Error creating SQLite tables or indexes: ${error.message}`, error);
            // This is a critical error, L2 might not work.
        }
    }
    
    // --- L1 Memory Cache Methods (mostly unchanged, ensure deep copies if necessary as per design doc) ---
    getFromMemory(key) {
        if (!this.isInitialized || !this.isEnabled) {
            this.logger.debug(`L1: getFromMemory called but service not initialized or disabled. Initialized: ${this.isInitialized}, Enabled: ${this.isEnabled}`);
            return undefined;
        }
        const cachedItem = this.l1Cache.get(key);
        if (cachedItem) {
            const { data, timestamp, ttl, sourceJsonStats } = cachedItem; // sourceJsonStats is part of L1 item
            const effectiveTtl = ttl || this.l1TtlMs;
            if (Date.now() < timestamp + effectiveTtl) {
                // Design doc mentions: "校验 L1 (TTL, sourceJsonStats vs FS)"
                // This check should ideally happen in the ModelService or a higher-level get method
                // that has access to the file system stats of the original JSON.
                // For now, this method only checks TTL.
                this.logger.debug(`L1 cache hit for key: ${key}`);
                this.l1Cache.delete(key);
                this.l1Cache.set(key, cachedItem); // LRU
                return JSON.parse(JSON.stringify(data)); // Return deep clone as per design doc
            } else {
                this.logger.info(`L1 cache expired for key: ${key}`);
                this.l1Cache.delete(key);
            }
        } else {
            this.logger.debug(`L1 cache miss for key: ${key}`);
        }
        return undefined;
    }

    setToMemory(key, value, ttl, sourceJsonStats = null) {
        if (!this.isInitialized || !this.isEnabled) {
            this.logger.debug(`L1: setToMemory called but service not initialized or disabled. Initialized: ${this.isInitialized}, Enabled: ${this.isEnabled}`);
            return;
        }
        if (this.l1Cache.size >= this.l1MaxItems && !this.l1Cache.has(key)) { // only remove if adding a new key
            const oldestKey = this.l1Cache.keys().next().value;
            if (oldestKey) {
                this.l1Cache.delete(oldestKey);
                this.logger.info(`L1 cache full, removed oldest item: ${oldestKey}`);
            }
        }
        const itemTtl = ttl || this.l1TtlMs;
        // Store a deep clone in memory to prevent external modifications
        const clonedValue = JSON.parse(JSON.stringify(value));
        this.l1Cache.set(key, { data: clonedValue, timestamp: Date.now(), ttl: itemTtl, sourceJsonStats });
        this.logger.info(`L1 cache set for key: ${key} with TTL: ${itemTtl}ms. sourceJsonStats: ${sourceJsonStats ? JSON.stringify(sourceJsonStats) : 'null'}`);
    }

    deleteFromMemory(key) {
        if (!this.isInitialized || !this.isEnabled) {
            this.logger.debug(`L1: deleteFromMemory called but service not initialized or disabled. Initialized: ${this.isInitialized}, Enabled: ${this.isEnabled}`);
            return;
        }
        const deleted = this.l1Cache.delete(key);
        if (deleted) {
            this.logger.info(`L1 cache deleted for key: ${key}`);
        } else {
            this.logger.debug(`L1 cache delete: key not found: ${key}`);
        }
    }

    clearMemoryCache() {
        // Allow clearing even if disabled, as it's a management operation
        if (!this.isInitialized) {
            this.logger.warn('L1: clearMemoryCache called before initialization.');
            // Optionally, one might still want to clear if it's partially set up
            // For now, strict check.
            return;
        }
        this.l1Cache.clear();
        this.logger.info('L1 memory cache cleared.');
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
            stmt.run(
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

    async getListModelsResultFromL2(cacheKey) {
        if (!this.db || !this.isEnabled) {
            this.logger.debug(`L2: getListModelsResultFromL2 - DB not available or service disabled. Key: ${cacheKey}`);
            return undefined;
        }
        this.logger.debug(`L2: getListModelsResultFromL2 called for key: ${cacheKey}`);
        try {
            const stmt = this.db.prepare(`
                SELECT bson_data, directory_content_hash, cached_timestamp_ms, ttl_seconds
                FROM list_models_cache
                WHERE cache_key = ?
            `);
            const row = stmt.get(cacheKey);

            if (!row) {
                this.logger.debug(`L2: list_models_cache miss for key: ${cacheKey}`);
                return undefined;
            }

            const { bson_data, directory_content_hash, cached_timestamp_ms, ttl_seconds } = row;
            const expiresAt = cached_timestamp_ms + (ttl_seconds * 1000);

            if (Date.now() >= expiresAt) {
                this.logger.info(`L2: list_models_cache expired for key: ${cacheKey}. Deleting.`);
                await this.deleteFromL2(cacheKey, 'list_models_cache');
                return undefined;
            }

            let modelObjArray;
            try {
                const deserializedObject = BSON.deserialize(bson_data);
                if (deserializedObject && typeof deserializedObject === 'object' && deserializedObject.hasOwnProperty('data') && Array.isArray(deserializedObject.data)) {
                    modelObjArray = deserializedObject.data;
                } else {
                    // Handle cases where data might be stored in an old format or is corrupted differently
                    this.logger.error(`L2: BSON deserialize error for key ${cacheKey} in list_models_cache: Unexpected data structure. Expected { data: [...] }. Deleting entry.`);
                    await this.deleteFromL2(cacheKey, 'list_models_cache');
                    return undefined;
                }
            } catch (bsonError) {
                this.logger.error(`L2: BSON deserialize error for key ${cacheKey} in list_models_cache: ${bsonError.message}. Deleting entry.`, bsonError);
                await this.deleteFromL2(cacheKey, 'list_models_cache');
                return undefined;
            }

            const updateStmt = this.db.prepare(`UPDATE list_models_cache SET last_accessed_timestamp_ms = ? WHERE cache_key = ?`);
            updateStmt.run(Date.now(), cacheKey);

            this.logger.info(`L2: list_models_cache hit for key: ${cacheKey}`);
            return {
                data: modelObjArray, // Renamed to 'data' for consistency with unified get
                directoryContentHash: directory_content_hash, // Keep original name from DB
                cachedTimestampMs: cached_timestamp_ms,
                ttlSeconds: ttl_seconds
            };

        } catch (error) {
            this.logger.error(`L2: Error getting listModelsResult for key ${cacheKey} from SQLite: ${error.message}`, error);
            return undefined;
        }
    }

    async setListModelsResultToL2(cacheKey, modelObjArray, directoryContentHash, ttlSeconds, keyParts) {
        if (!this.db || !this.isEnabled) {
            this.logger.debug(`L2: setListModelsResultToL2 - DB not available or service disabled. Key: ${cacheKey}`);
            return;
        }
        this.logger.debug(`L2: setListModelsResultToL2 called for key: ${cacheKey}`);

        if (!keyParts ||
            typeof keyParts.sourceId !== 'string' ||
            typeof keyParts.directoryPath !== 'string' ||
            typeof keyParts.showSubdirectory !== 'number' || // Expect 0 or 1
            typeof keyParts.supportedExtsHash !== 'string') {
             this.logger.error(`L2: Invalid or missing keyParts for key ${cacheKey} in list_models_cache. Required: sourceId, directoryPath, showSubdirectory, supportedExtsHash. Got: ${JSON.stringify(keyParts)}`);
             return;
        }
        
        let bsonData;
        try {
            // Wrap the array in an object before serializing
            const dataToSerialize = { data: modelObjArray };
            bsonData = BSON.serialize(dataToSerialize);
        } catch (bsonError) {
            this.logger.error(`L2: BSON serialize error for key ${cacheKey} in list_models_cache: ${bsonError.message}. Write aborted.`, bsonError);
            return;
        }

        const effectiveTtlSeconds = ttlSeconds || (this.l2TtlMs / 1000); // Default L2 TTL
        const cached_timestamp_ms = Date.now();
        const last_accessed_timestamp_ms = cached_timestamp_ms;

        try {
            const stmt = this.db.prepare(`
                INSERT OR REPLACE INTO list_models_cache
                (cache_key, source_id, directory_path, show_subdirectory, supported_exts_hash, directory_content_hash, bson_data, cached_timestamp_ms, ttl_seconds, last_accessed_timestamp_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const runInfo = this.db.prepare(`
                INSERT OR REPLACE INTO list_models_cache
                (cache_key, source_id, directory_path, show_subdirectory, supported_exts_hash, directory_content_hash, bson_data, cached_timestamp_ms, ttl_seconds, last_accessed_timestamp_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                cacheKey,
                keyParts.sourceId,
                keyParts.directoryPath,
                keyParts.showSubdirectory,
                keyParts.supportedExtsHash,
                directoryContentHash, // Can be null
                bsonData,
                cached_timestamp_ms,
                effectiveTtlSeconds,
                last_accessed_timestamp_ms
            );

            this.logger.info(`L2: list_models_cache attempted set for key: ${cacheKey} with TTL: ${effectiveTtlSeconds}s. Changes: ${runInfo.changes}, Last ROWID: ${runInfo.lastInsertRowid}`);

            if (runInfo.changes === 0) {
                this.logger.warn(`L2: stmt.run for key ${cacheKey} reported 0 changes. Data might not have been written as expected.`);
            }

            // Optional: Immediately try to read back the data to verify
            try {
                const verifyStmt = this.db.prepare('SELECT cache_key, LENGTH(bson_data) as len FROM list_models_cache WHERE cache_key = ?');
                const verifyRow = verifyStmt.get(cacheKey);
                if (verifyRow) {
                    this.logger.info(`L2: Verification read for key ${cacheKey} successful. BSON data length: ${verifyRow.len}`);
                } else {
                    this.logger.error(`L2: Verification read FAILED for key ${cacheKey}. Data not found after insert/replace.`);
                }
            } catch (verifyError) {
                this.logger.error(`L2: Error during verification read for key ${cacheKey}: ${verifyError.message}`, verifyError);
            }

        } catch (error) {
            this.logger.error(`L2: Error setting listModelsResult for key ${cacheKey} in SQLite: ${error.message}`, error);
            // Log the full error object for more details, including potential SQLite error codes
            this.logger.error('Full error object during setListModelsResultToL2:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
        }
    }
    
    async deleteFromL2(cacheKey, tableName) {
        if (!this.db || !this.isEnabled) {
            this.logger.debug(`L2: deleteFromL2 - DB not available or service disabled. Key: ${cacheKey}, Table: ${tableName}`);
            return;
        }
        this.logger.debug(`L2: deleteFromL2 called for key: ${cacheKey}, table: ${tableName}`);
        if (tableName !== 'model_json_info_cache' && tableName !== 'list_models_cache') {
            this.logger.error(`L2: deleteFromL2 - Invalid table name: ${tableName}`);
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
        if (tableName !== 'model_json_info_cache' && tableName !== 'list_models_cache') {
            this.logger.error(`L2: clearL2Table - Invalid table name: ${tableName}`);
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
        this.logger.info(`L2: Clearing all L2 cache tables.`);
        await this.clearL2Table('model_json_info_cache');
        await this.clearL2Table('list_models_cache');
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

        const tablesToClean = ['model_json_info_cache', 'list_models_cache'];

        for (const tableName of tablesToClean) {
            try {
                // TTL Cleanup: Delete entries where (cached_timestamp_ms + ttl_seconds * 1000) < now
                const stmt = this.db.prepare(`
                    DELETE FROM ${tableName}
                    WHERE (cached_timestamp_ms + ttl_seconds * 1000) < ?
                `);
                const result = stmt.run(now);
                if (result.changes > 0) {
                    this.logger.info(`L2 Cleanup: Deleted ${result.changes} expired entries from ${tableName}.`);
                    totalExpiredDeleted += result.changes;
                }
            } catch (error) {
                this.logger.error(`L2 Cleanup: Error cleaning expired entries from ${tableName}: ${error.message}`, error);
            }
        }
        
        // LRU Cleanup
        // Design doc: cache.l2.maxItems.modelInfo, cache.l2.maxItems.listModels
        const l2MaxItemsModelInfo = (await this.configService.getSetting('cache.l2.maxItems.modelInfo')) || 5000;
        const l2MaxItemsListModels = (await this.configService.getSetting('cache.l2.maxItems.listModels')) || 1000; // Example default

        const maxItemsConfig = {
            'model_json_info_cache': l2MaxItemsModelInfo,
            'list_models_cache': l2MaxItemsListModels
        };
        
        for (const tableName of tablesToClean) {
            const currentMaxItems = maxItemsConfig[tableName];
            if (!currentMaxItems) continue; // Skip if no maxItems configured for this table

            try {
                const countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`);
                const currentCount = countStmt.get().count;

                if (currentCount > currentMaxItems) {
                    const itemsToDelete = currentCount - currentMaxItems;
                    this.logger.info(`L2 Cleanup (${tableName}): Exceeds max items (${currentMaxItems}). Current: ${currentCount}. Deleting ${itemsToDelete} LRU items.`);
                    const deleteLruStmt = this.db.prepare(`
                        DELETE FROM ${tableName}
                        WHERE cache_key IN (
                            SELECT cache_key FROM ${tableName}
                            ORDER BY last_accessed_timestamp_ms ASC
                            LIMIT ?
                        )
                    `);
                    const lruResult = deleteLruStmt.run(itemsToDelete);
                    this.logger.info(`L2 Cleanup (${tableName}): Deleted ${lruResult.changes} LRU entries.`);
                }
            } catch (error) {
                this.logger.error(`L2 Cleanup: Error during LRU cleanup for ${tableName}: ${error.message}`, error);
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
        // L1 stores modelObj directly, so type distinction is less critical here, but key is important.
        let l1Data = this.getFromMemory(cacheKey);
        if (l1Data !== undefined) {
            // Here, ModelService would perform the sourceJsonStats check if l1Data is a modelObj
            // and has sourceJsonStats. This service returns what it has.
            this.logger.info(`Unified Get: L1 cache hit for key: ${cacheKey}`);
            return l1Data; // This is expected to be a modelObj if L1 stores them
        }
        this.logger.debug(`Unified Get: L1 cache miss for key: ${cacheKey}. Trying L2.`);

        // 2. Try L2 Cache (SQLite)
        let l2Data;
        let l2SourceJsonStats; // For modelJsonInfo
        let l2DirectoryContentHash; // For listModels

        if (type === 'modelJsonInfo') {
            const l2Result = await this.getModelJsonInfoFromL2(cacheKey);
            if (l2Result) {
                l2Data = l2Result.modelJsonInfo;
                l2SourceJsonStats = l2Result.sourceJsonStats;
            }
        } else if (type === 'listModels') {
            const l2Result = await this.getListModelsResultFromL2(cacheKey);
            if (l2Result) {
                l2Data = l2Result.modelObjArray;
                l2DirectoryContentHash = l2Result.directoryContentHash;
            }
        } else {
            this.logger.warn(`Unified Get: Unknown cache type "${type}" for key: ${cacheKey}`);
            return undefined;
        }

        if (l2Data !== undefined) {
            this.logger.info(`Unified Get: L2 cache hit for key: ${cacheKey}, type: ${type}. Updating L1.`);
            // If L2 provided data, ModelService would use it to construct a full modelObj (if type is modelJsonInfo)
            // and then set that modelObj into L1.
            // For now, this service will set the L2 data directly into L1, which might differ from L1's typical content (full modelObj).
            // This needs careful handling in ModelService.
            // Or, L1 should only store what L2 provides for that type, if we simplify L1's role.
            // Design doc: L1 stores modelObj. L2 stores modelJsonInfo.
            // So, if L2 (modelJsonInfo) hits, ModelService builds modelObj, then sets L1.
            // This method should probably just return l2Data and its associated metadata.
            // The L1 update with the full modelObj should happen in ModelService.
            
            // For now, returning L2 data directly. ModelService will handle L1 update.
            if (type === 'modelJsonInfo') {
                 return { data: l2Data, sourceJsonStats: l2SourceJsonStats };
            } else if (type === 'listModels') {
                 return { data: l2Data, directoryContentHash: l2DirectoryContentHash };
            }
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

        if (type === 'listModels') { // listModels results can be directly stored in L1
            this.setToMemory(cacheKey, value, effectiveTtlSeconds * 1000, extraArgs.directoryContentHash || null);
        }
        // For 'modelJsonInfo', L1 (modelObj) is typically set by ModelService after constructing the full object.
        // This service's 'set' focuses on L2 for 'modelJsonInfo'.

        // 2. Set to L2 Disk Cache (SQLite)
        if (type === 'modelJsonInfo') {
            const { sourceJsonStats } = extraArgs;
            if (!sourceJsonStats) {
                this.logger.warn(`Unified Set (L2 modelJsonInfo): sourceJsonStats missing for key ${cacheKey}. L2 write might be skipped or incomplete.`);
                // return; // Or proceed without it, depending on strictness
            }
            await this.setModelJsonInfoToL2(cacheKey, value, sourceJsonStats || {}, effectiveTtlSeconds);
        } else if (type === 'listModels') {
            const { directoryContentHash, keyParts } = extraArgs;
            if (!directoryContentHash || !keyParts) {
                this.logger.warn(`Unified Set (L2 listModels): directoryContentHash or keyParts missing for key ${cacheKey}. L2 write might be skipped.`);
               // return;
            }
            await this.setListModelsResultToL2(cacheKey, value, directoryContentHash || '', effectiveTtlSeconds, keyParts || {});
        } else {
            this.logger.warn(`Unified Set: Unknown cache type "${type}" for L2. Key: ${cacheKey}`);
        }
        this.logger.info(`Unified Set: Processed for key ${cacheKey}, type ${type}.`);
    }

    // --- Invalidation and Clear Methods ---
    
    invalidateL1(key) {
        this.deleteFromMemory(key);
    }

    async invalidateL2(key, type = 'modelJsonInfo') {
        const tableName = type === 'modelJsonInfo' ? 'model_json_info_cache' : 'list_models_cache';
        await this.deleteFromL2(key, tableName);
    }
    
    async clearEntry(key, type = 'modelJsonInfo') {
        this.logger.info(`Clearing cache entry for key: ${key}, type: ${type}`);
        this.deleteFromMemory(key); // L1 key is usually the same
        const tableName = type === 'modelJsonInfo' ? 'model_json_info_cache' : 'list_models_cache';
        await this.deleteFromL2(key, tableName);
    }

    async clearBySource(sourceId) {
        this.logger.info(`Attempting to clear all cache entries for sourceId: ${sourceId}`);
        let l1ClearedCount = 0;
        for (const key of this.l1Cache.keys()) {
            if (key.startsWith(`${sourceId}:`)) {
                this.l1Cache.delete(key);
                l1ClearedCount++;
            }
        }
        this.logger.info(`L1: Cleared ${l1ClearedCount} entries for sourceId: ${sourceId}`);

        if (!this.db) {
            this.logger.warn('L2: Database not available, cannot clear by source from L2.');
            return;
        }
        try {
            const stmt1 = this.db.prepare(`DELETE FROM model_json_info_cache WHERE source_id = ?`);
            const result1 = stmt1.run(sourceId);
            this.logger.info(`L2: Cleared ${result1.changes} entries from model_json_info_cache for sourceId: ${sourceId}`);

            const stmt2 = this.db.prepare(`DELETE FROM list_models_cache WHERE source_id = ?`);
            const result2 = stmt2.run(sourceId);
            this.logger.info(`L2: Cleared ${result2.changes} entries from list_models_cache for sourceId: ${sourceId}`);
        } catch (error) {
            this.logger.error(`L2: Error clearing entries by sourceId ${sourceId}: ${error.message}`, error);
        }
    }

    async clearAll() { // This should call the new L2 methods
        this.clearMemoryCache();
        await this.clearAllL2Cache();
        this.logger.info('All caches (L1 and L2) cleared.');
    }

    async invalidateListModelsCacheForDirectory(sourceId, directoryPath) {
        if (!this.db || !this.isEnabled) {
            this.logger.debug(`L2: invalidateListModelsCacheForDirectory - DB not available or service disabled. Source: ${sourceId}, Dir: ${directoryPath}`);
            return;
        }
        // Normalize directoryPath: ensure it's relative, no trailing slash (unless root '/'), starts with '/' if not root.
        // For root, it might be empty string or '/'. Let's assume DB stores root as '/' or an empty string consistently.
        // And other paths like 'models' or 'models/lora'.
        // The cache key generation for listModels should produce consistent directory_path values.
        // For this invalidation, we assume directoryPath is as stored or can be matched.
        // A common representation for root in DB could be an empty string or a single '/'.
        // Let's assume `directoryPath` passed here is like 'models/subdir' or '' for root.
        // And `list_models_cache.directory_path` stores it similarly.

        const normDirPath = directoryPath === '/' ? '' : (directoryPath.startsWith('/') ? directoryPath.substring(1) : directoryPath);
        // If root is stored as '/', then normDirPath for root should be '/'
        // If root is stored as '', then normDirPath for root should be ''

        this.logger.info(`L2: Invalidating list_models_cache for sourceId: ${sourceId}, directoryPath: ${directoryPath} (normalized: ${normDirPath})`);

        try {
            // Delete entries where the cached directory is exactly the one modified.
            // Delete entries where a cached parent directory (with show_subdirectory=1) might now be stale.
            // Example: if 'A/B/C' is modified, invalidate 'A/B/C', 'A/B' (if recursive), 'A' (if recursive).
            const stmt = this.db.prepare(`
                DELETE FROM list_models_cache
                WHERE source_id = ?
                  AND (
                    directory_path = ?
                    OR (
                         ? LIKE (CASE WHEN directory_path = '' THEN '%' ELSE directory_path || '/%' END)
                         AND show_subdirectory = 1
                       )
                  )
            `);
            // Note: The LIKE condition `? LIKE directory_path || '/%'` means "modifiedPath starts with cachedParentPath".
            // Example: modifiedPath = 'models/lora', cachedParentPath = 'models'. 'models/lora' LIKE 'models/%' -> true.
            // If cachedParentPath is root (''), then `directory_path || '/%'` becomes `/%`.
            // If `directory_path` is stored as `/` for root, then `directory_path || '%'`
            // The CASE WHEN handles root directory stored as empty string.
            
            const result = stmt.run(sourceId, normDirPath, normDirPath);
            this.logger.info(`L2: Invalidated ${result.changes} entries in list_models_cache for sourceId: ${sourceId}, directoryPath: ${directoryPath}`);
        } catch (error) {
            this.logger.error(`L2: Error invalidating list_models_cache for sourceId ${sourceId}, directoryPath ${directoryPath}: ${error.message}`, error);
        }
    }


    // --- Cache Stats Methods (Update for SQLite) ---
    getMemoryCacheStats() {
        if (!this.isInitialized) {
            this.logger.warn('getMemoryCacheStats called before initialization.');
            return { items: 0 };
        }
        return {
            items: this.l1Cache.size,
            maxItems: this.l1MaxItems,
            isEnabled: this.isEnabled,
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
            
            const tables = ['model_json_info_cache', 'list_models_cache'];
            for (const tableName of tables) {
                try {
                    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`);
                    const result = stmt.get();
                    tableStats[tableName] = { items: result.count };
                } catch (tableError) {
                    this.logger.error(`Error getting item count for table ${tableName}: ${tableError.message}`);
                    tableStats[tableName] = { items: 0, error: tableError.message };
                }
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
        
        const memoryStats = this.getMemoryCacheStats();
        const l2Stats = await this.getDiskCacheStats(); // This is now L2 stats

        return {
            l1: memoryStats, // Renamed for clarity
            l2: l2Stats,     // Renamed for clarity
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