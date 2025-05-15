// src/services/configService.js
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const log = require('electron-log');
const { deepClone } = require('../common/utils'); // 假设 utils.js 中有 deepClone

const DEFAULT_CONFIG = {
  modelSources: [],
  supportedExtensions: ['.safetensors', '.ckpt', '.pt', '.pth', '.bin'],
  blockedTags: [], // Add blockedTags field with default empty array
  imageCache: {
    maxCacheSizeMB: 200,
    compressQuality: 80,
  },
  locale: null,
  cache: { // V2: New cache configuration structure
    enabled: true,
    l1: {
      enabled: true,
      maxItems: 200, // Default max items for L1 cache (e.g., for listModels results, full model objects)
      ttlSeconds: { // Default TTLs for L1 items if not specified by type
        default: 3600,       // 1 hour general default for L1 items not otherwise specified
        modelInfo: 3600,     // TTL for full model objects (derived from modelJsonInfo) in L1
        listModelsLocal: 300,  // 5 minutes for listModels results from local sources
        listModelsWebDAV: 1800 // 30 minutes for listModels results from WebDAV sources
      }
    },
    l2: { // L2 is now only for model_json_info_cache
      // enabled: true, // L2 is implicitly enabled if cache.enabled is true and DB can be initialized.
      ttlSeconds: {
         modelJsonInfo: 604800 // 7 days TTL for model_json_info_cache items in L2
      },
      dbPath: "", // User configurable, if empty, defaults to app.getPath('userData')/cache/model_cache.sqlite
      maxItems: { // Max items for L2 tables (relevant for cleanup)
          modelJsonInfo: 5000 // Max items for the model_json_info_cache table
      }
    }
  }
};

class ConfigService {
  constructor() {
    this.config = null;
    this.configPath = path.join(app.getPath('userData'), 'config.json');
    log.info(`[ConfigService] Config path set to: ${this.configPath}`);
  }

  /**
   * Initializes the ConfigService by loading the configuration.
   * @returns {Promise<void>}
   */
  async initialize() {
    log.info('[ConfigService] Initializing...');
    try {
      await this._loadConfigFromFile();
      log.info('[ConfigService] Initialization successful.');
    } catch (error) {
      log.error('[ConfigService] Initialization failed:', error.message, error.stack);
      // Even if loading fails, we set a default config to allow the app to run
      this.config = deepClone(DEFAULT_CONFIG);
      log.warn('[ConfigService] Using default configuration due to initialization error.');
    }
  }

  /**
   * Loads configuration from the config file.
   * Migrated core logic from main.js loadConfig.
   * @private
   * @returns {Promise<void>}
   */
  async _loadConfigFromFile() {
    try {
      // Check if file exists using fs.promises.access (throws if not found)
      await fs.promises.access(this.configPath);
      log.info(`[ConfigService] Config file found at ${this.configPath}. Reading...`);
      // Read file using fs.promises.readFile
      const configData = await fs.promises.readFile(this.configPath, 'utf-8');
      let loadedConfig = JSON.parse(configData);
      log.info('[ConfigService] Config file parsed successfully.');

      if(loadedConfig.supportedExtensions && loadedConfig.supportedExtensions.length === 0){
        loadedConfig.supportedExtensions = DEFAULT_CONFIG.supportedExtensions;
      }

      

      // Ensure default keys exist if missing from file
      loadedConfig = { ...deepClone(DEFAULT_CONFIG), ...loadedConfig };

      log.debug(`[ConfigService _loadConfigFromFile] supportedExtensions after merge. Value: ${JSON.stringify(loadedConfig.supportedExtensions)}, Type: ${typeof loadedConfig.supportedExtensions}`);

      // Ensure each modelSource has a readOnly property (defaulting to false)
      if (Array.isArray(loadedConfig.modelSources)) {
        loadedConfig.modelSources.forEach(source => {
          source.readOnly = source.readOnly ?? false; // Default to false if undefined or null
        });
      }

      // Convert relative local paths to absolute paths
      // Migrated from main.js loadConfig
      if (Array.isArray(loadedConfig.modelSources)) {
        loadedConfig.modelSources.forEach(source => {
          if (source.type === 'local' && source.path && !path.isAbsolute(source.path)) {
            // Use app.getAppPath() or process.cwd() depending on desired base for relative paths
            // Using process.cwd() for consistency with original main.js logic
            const absolutePath = path.join(process.cwd(), source.path);
            log.info(`[ConfigService] Converting relative path "${source.path}" to absolute path "${absolutePath}"`);
            source.path = absolutePath;
          }
        });
      }

      // --- 添加：确保 imageCache 配置和默认大小 ---
      if (!loadedConfig.imageCache) {
        loadedConfig.imageCache = {}; // 确保 imageCache 对象存在
        log.warn('[ConfigService] Loaded config missing imageCache object. Initializing empty.');
      }
      // 检查 maxCacheSizeMB 是否有效，如果无效或缺失，则使用默认值 200
      if (loadedConfig.imageCache.maxCacheSizeMB === undefined ||
          loadedConfig.imageCache.maxCacheSizeMB === null ||
          typeof loadedConfig.imageCache.maxCacheSizeMB !== 'number' || // 确保是数字
          loadedConfig.imageCache.maxCacheSizeMB <= 0) {
          const originalValue = loadedConfig.imageCache.maxCacheSizeMB;
          log.warn(`[ConfigService] Invalid or missing imageCache.maxCacheSizeMB found (value: ${originalValue}). Applying default value: 200 MB.`);
          loadedConfig.imageCache.maxCacheSizeMB = 200; // 应用默认值
      }
      // 可以选择性地为其他 imageCache 属性添加默认值检查
      if (loadedConfig.imageCache.compressQuality === undefined || loadedConfig.imageCache.compressQuality === null) {
          loadedConfig.imageCache.compressQuality = DEFAULT_CONFIG.imageCache.compressQuality;
      }
      // --- 结束：确保 imageCache 配置和默认大小 ---


      this.config = loadedConfig;
      log.info('[ConfigService] Configuration loaded and processed.');

    } catch (error) {
      if (error.code === 'ENOENT') {
        log.warn(`[ConfigService] config.json not found at ${this.configPath}. Using default configuration.`);
        this.config = deepClone(DEFAULT_CONFIG);
      } else {
        log.error('[ConfigService] Failed to load or parse config.json:', error.message, error.stack);
        // Throw the error to be caught by the initialize method
        throw new Error(`Failed to load or parse config.json: ${error.message}`);
      }
    }
  }

  /**
   * Saves the provided configuration object to the config file.
   * Migrated core logic from main.js ipcMain.handle('save-config').
   * @param {object} newConfig - The configuration object to save.
   * @returns {Promise<void>}
   */
  async saveConfig(newConfig) {
    log.info('[ConfigService] Attempting to save configuration...');
    if (!newConfig) {
        log.error('[ConfigService] saveConfig called with null or undefined config.');
        throw new Error('Cannot save null or undefined configuration.');
    }
    try {
      // 1. Validate/Clean newConfig (optional, add as needed)
      //    Example: Ensure modelSources is an array
      if (!Array.isArray(newConfig.modelSources)) {
          log.warn('[ConfigService] newConfig.modelSources is not an array. Setting to empty array.');
          newConfig.modelSources = [];
      }
       // Ensure default keys exist
       const configToSave = { ...deepClone(DEFAULT_CONFIG), ...newConfig };


      // 2. Convert absolute local paths back to relative (optional, depends on requirements)
      //    For simplicity and consistency with loading, we'll save absolute paths for now.
      //    If relative paths are desired, conversion logic would go here.

      // 3. Stringify and write to file
      const configString = JSON.stringify(configToSave, null, 2); // Pretty print
      await fs.promises.writeFile(this.configPath, configString, 'utf-8');
      log.info(`[ConfigService] Configuration saved successfully to: ${this.configPath}`);

      // 4. Update in-memory config *after* successful save
      //    Make sure to handle path conversions consistently if applied before saving
      this.config = deepClone(configToSave); // Use deepClone to avoid mutation issues
       // Re-apply absolute path conversion after updating internal state,
       // ensuring consistency with getConfig() results.
       if (Array.isArray(this.config.modelSources)) {
        this.config.modelSources.forEach(source => {
          if (source.type === 'local' && source.path && !path.isAbsolute(source.path)) {
            const absolutePath = path.join(process.cwd(), source.path);
            log.info(`[ConfigService] Converting relative path "${source.path}" back to absolute path "${absolutePath}" after save.`);
            source.path = absolutePath;
          }
        });
      }

      log.info('[ConfigService] In-memory configuration updated.');

      // Note: Sending 'config-updated' event and updating imageCache.setConfig
      // are handled outside this service, typically in the IPC handler after calling saveConfig.

    } catch (error) {
      log.error('[ConfigService] Failed to save configuration:', error.message, error.stack);
      // Rethrow the error to be handled by the caller (e.g., IPC handler)
      throw new Error(`Failed to save config.json: ${error.message}`);
    }
  }

  /**
   * Returns a deep copy of the current configuration object.
   * @returns {Promise<object>} A promise that resolves with the configuration object.
   */
  async getConfig() {
    // Return a deep copy to prevent external mutations
    if (!this.config) {
        log.warn('[ConfigService] getConfig called before initialization completed. Returning default config.');
        // Attempt to load if not initialized, though initialize should be called first
        await this.initialize(); // Ensure initialization attempt
        return deepClone(this.config || DEFAULT_CONFIG); // Return default if still null
    }
    return deepClone(this.config);
  }

  /**
   * Gets a specific setting value from the configuration.
   * @param {string} key - The configuration key (e.g., 'modelSources', 'imageCache.maxSize'). Supports dot notation for nested properties.
   * @returns {Promise<any>} A promise that resolves with the value of the setting, or undefined if not found.
   */
  async getSetting(key) {
    if (!this.config) {
        log.warn('[ConfigService] getSetting called before initialization completed.');
         await this.initialize(); // Ensure initialization attempt
         if (!this.config) return undefined; // Return undefined if still not loaded
    }

    if (!key) {
        return undefined;
    }

    // Basic dot notation support
    const keys = key.split('.');
    let value = this.config;

    for (const k of keys) {
        if (value && typeof value === 'object' && k in value) {
            value = value[k];
        } else {
            return undefined; // Key path not found
        }
    }

    // Return a deep copy if the value is an object or array
    return deepClone(value);
  }

  /**
   * Gets the list of blocked tags from the configuration.
   * @returns {Promise<string[]>} A promise that resolves with an array of blocked tags, or an empty array if not found.
   */
  async getBlockedTags() {
    // Use getSetting to retrieve the 'renderer.blockedTags' value
    const blockedTags = await this.getSetting('blockedTags');
    // Ensure the result is an array, defaulting to an empty array if not
    return Array.isArray(blockedTags) ? blockedTags : [];
  }

  getSupportedExtensions() {
    return this.config.supportedExtensions;
  }
}

// Export a single instance (Singleton pattern)
module.exports = ConfigService;
