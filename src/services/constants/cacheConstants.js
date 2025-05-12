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

module.exports = {
    DEFAULT_DB_DIR_NAME,
    DEFAULT_DB_FILE_NAME,
    CacheDataType,
    TTL_STRATEGIES
}