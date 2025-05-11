# 缓存逻辑统一方案文档

**版本**: 1.1
**日期**: 2025-05-11

**目标**: 统一并优化应用内的模型信息缓存逻辑，提高可维护性、性能和一致性。将 L1 和 L2 缓存键的生成逻辑统一到 `modelInfoCacheService.js` 中，并优化 `DataSource` 与缓存服务的交互流程。

## 1. 核心概念与术语

*   **L1 缓存**: 内存缓存 (`Map` 实现)，用于快速访问最常用的、已处理的 JavaScript 对象。
*   **L2 缓存**: 基于 SQLite 的持久化磁盘缓存，用于存储可序列化的、相对原始的数据。
*   **`CacheDataType`**: 枚举/常量集，标识缓存数据类型，指导缓存服务处理（TTL、存储位置等）。
*   **`currentMetadata`**: 调用方获取缓存时提供的当前数据源状态元数据，用于缓存有效性比较。
*   **TTL (Time-To-Live)**: 缓存条目生存时间，由缓存服务内部根据 `CacheDataType` 确定，不可外部配置。
*   **`modelInfoCacheService.js`**: 统一管理 L1 和 L2 缓存的服务。
*   **`DataSource`**: 数据源实现，如 [`src/data/localDataSource.js`](src/data/localDataSource.js) 和 [`src/data/webdavDataSource.js`](src/data/webdavDataSource.js)。

## 2. `CacheDataType` 定义

```javascript
// 在 modelInfoCacheService.js 或共享常量中定义
const CacheDataType = {
  /**
   * 表示由 listModels 方法返回的模型对象数组 (Array<ModelObject>)。
   * 存储: L1 缓存。
   * currentMetadata: { contentHash: string } (目录内容摘要，由 DataSource 计算)
   */
  MODEL_LIST: 'MODEL_LIST',

  /**
   * 表示由 readModelDetail 方法返回的单个完整模型对象 (ModelObject)。
   * 存储: L1 缓存。
   * currentMetadata: { fileSize: number, lastModified: number, etag: string | null }
   *   (针对其主要信息来源文件，通常是关联的 .json 文件或模型主文件)
   */
  MODEL_DETAIL: 'MODEL_DETAIL',

  /**
   * 表示从模型关联的 .json 文件解析出来的原始 JSON 内容 (JavaScript 对象)。
   * 存储: L2 缓存 (SQLite 表 model_json_info_cache)。
   * currentMetadata: { fileSize: number, lastModified: number, etag: string | null }
   *   (针对原始 .json 文件)
   */
  MODEL_JSON_INFO: 'MODEL_JSON_INFO',
};

markdown



3. 内部 TTL (Time-To-Live) 策略 (由 ModelInfoCacheService 内部管理)
CacheDataType.MODEL_LIST:
L1 TTL:
本地数据源 (LocalDataSource): 5 分钟 (300 秒)
WebDAV 数据源 (WebdavDataSource): 15 分钟 (900 秒)
依据: listModels 结果易变，本地源变化快，WebDAV 相对慢。
CacheDataType.MODEL_DETAIL:
L1 TTL: 1 小时 (3600 秒)
依据: 单个模型对象构建成本较高，内容相对稳定。
CacheDataType.MODEL_JSON_INFO:
L2 TTL: 7 天 (604800 秒)
依据: .json 文件内容相对稳定，L2 作为持久缓存可长时保留。
4. currentMetadata 内容确定
由 DataSource 在调用 getDataFromCache 时提供，结构取决于 CacheDataType:

CacheDataType.MODEL_LIST:
currentMetadata: { contentHash: string }
contentHash: 代表目录内容（包括相关文件及其元数据）状态的哈希值。由 DataSource 负责计算。
CacheDataType.MODEL_DETAIL 或 CacheDataType.MODEL_JSON_INFO:
currentMetadata: { fileSize: number, lastModified: number, etag: string | null }
fileSize: 文件大小 (字节)。
lastModified: 文件最后修改时间戳 (毫秒)。
etag: 文件的 ETag (主要用于 WebDAV，本地文件可为 null)。
这些元数据指与缓存数据直接对应的源文件。
5. modelInfoCacheService.js 公共接口定义
// In src/services/modelInfoCacheService.js

class ModelInfoCacheService {
    // ... constructor, L1Cache (Map), db (SQLite instance), logger ...

    /**
     * 从缓存中获取数据。
     * @param {CacheDataType} dataType - 要获取的数据类型。
     * @param {string} sourceId - 数据源的唯一ID。
     * @param {string} pathIdentifier - 数据的路径或唯一标识符 (相对于数据源和类型)。
     * @param {object} currentMetadata - 当前源数据的元数据，用于有效性检查。结构取决于 dataType。
     * @returns {Promise<any | undefined>} 缓存的数据 (如 ModelObject, Array<ModelObject>, ModelJsonInfo)，
     *                                    如果未命中或无效则返回 undefined。
     */
    async getDataFromCache(dataType, sourceId, pathIdentifier, currentMetadata) {
        // 1. 生成内部缓存键 (私有方法 _generateCacheKey)
        // 2. L1 查找:
        //    - 若命中，校验TTL和 currentMetadata 与 L1 中存储的元数据。
        //    - 若有效，返回 L1 数据。
        //    - 若无效或过期，删除 L1 条目，继续。
        // 3. L2 查找 (仅当 dataType === CacheDataType.MODEL_JSON_INFO):
        //    - 若命中，校验TTL (基于L2存储的cached_timestamp_ms和ttl_seconds) 和 currentMetadata 与 L2 中存储的元数据。
        //    - 若有效，返回 L2 数据 (反序列化BSON)。
        //    - 若无效或过期，删除 L2 条目。
        // 4. 若均未命中或无效，返回 undefined。
    }

    /**
     * 将数据设置到缓存中。
     * @param {CacheDataType} dataType - 要设置的数据类型。
     * @param {string} sourceId - 数据源的唯一ID。
     * @param {string} pathIdentifier - 数据的路径或唯一标识符。
     * @param {any} data - 要缓存的数据本身。
     * @param {object} metadataForCache - 与 data 关联的源文件元数据，将随数据一同存储在缓存中。结构取决于 dataType。
     * @returns {Promise<void>}
     */
    async setDataToCache(dataType, sourceId, pathIdentifier, data, metadataForCache) {
        // 1. 生成内部缓存键。
        // 2. 根据 dataType 和内部 TTL 策略获取 TTL 值。
        // 3. L1 存储 (对于 MODEL_LIST, MODEL_DETAIL):
        //    - 存储 data 和 metadataForCache，以及当前时间戳和计算出的过期时间戳。
        // 4. L2 存储 (对于 MODEL_JSON_INFO):
        //    - 序列化 data 为 BSON。
        //    - 存储序列化后的 data 和 metadataForCache，以及当前时间戳和TTL值到 SQLite。
    }

    /**
     * 使指定缓存条目无效。
     * @param {CacheDataType} dataType - 要失效的数据类型。
     * @param {string} sourceId - 数据源的唯一ID。
     * @param {string} pathIdentifier - 数据的路径或唯一标识符。
     * @returns {Promise<void>}
     */
    async invalidateCacheEntry(dataType, sourceId, pathIdentifier) {
        // 1. 生成内部缓存键。
        // 2. 从 L1 删除。
        // 3. 如果 dataType === CacheDataType.MODEL_JSON_INFO，从 L2 删除。
    }

    /**
     * 清除指定数据源的所有缓存。
     * @param {string} sourceId - 数据源的唯一ID。
     * @returns {Promise<void>}
     */
    async clearCacheForSource(sourceId) {
        // 1. 清除 L1 中所有与 sourceId 相关的条目 (通过遍历或前缀匹配键)。
        // 2. 清除 L2 (model_json_info_cache) 中所有与 sourceId 相关的条目。
    }

    /**
     * 清除所有缓存 (L1 和 L2)。
     * @returns {Promise<void>}
     */
    async clearAllCache() {
        // 1. 清空 L1 缓存 (this.L1Cache.clear())。
        // 2. 清空 L2 (model_json_info_cache) 表中的所有记录。
    }

    // --- 私有方法 ---
    // _generateCacheKey(dataType, sourceId, pathIdentifier)
    // _getL1Entry(cacheKey)
    // _setL1Entry(cacheKey, data, metadata, ttlMs)
    // _deleteL1Entry(cacheKey)
    // _getL2ModelJsonInfo(cacheKey)
    // _setL2ModelJsonInfo(cacheKey, data, metadata, ttlSeconds)
    // _deleteL2ModelJsonInfo(cacheKey)
    // _isL1EntryValid(entry, currentMetadata)
    // _isL2EntryValid(entry, currentMetadata) // entry is from DB
}

javascript



6. 内部缓存键生成逻辑 (私有)
格式: CacheDataType_String:sourceId:pathIdentifier
pathIdentifier 对于 MODEL_LIST 应包含目录路径及影响列表的参数（如 showSubdirectory, supportedExts）的规范化表示或哈希。对于 MODEL_DETAIL 和 MODEL_JSON_INFO，是模型文件或关联 .json 文件的规范化相对路径。
7. DataSource 修改指导 (src/data/localDataSource.js, src/data/webdavDataSource.js)
7.1. listModels 流程
DataSource 计算 directoryPath 和相关参数（showSubdirectory, supportedExts）对应的 pathIdentifier。
DataSource 计算当前目录内容的 contentHash 作为 currentMetadata.contentHash。
调用 modelInfoCacheService.getDataFromCache(CacheDataType.MODEL_LIST, this.id, pathIdentifier, { contentHash })。
若返回有效数据 (Array)，直接使用。
若返回 undefined (缓存未命中/失效): a. DataSource 执行原始的目录列表和模型信息收集逻辑，得到 modelListResult (Array)。 b. DataSource 重新计算（或使用之前的）contentHash 作为 metadataForCache.contentHash。 c. 调用 modelInfoCacheService.setDataToCache(CacheDataType.MODEL_LIST, this.id, pathIdentifier, modelListResult, { contentHash })。 d. 返回 modelListResult。
7.2. readModelDetail (获取 ModelObject) 优化流程
DataSource 获取模型主文件 (modelFilePath) 和关联 .json 文件 (associatedJsonPath) 的当前元数据 (currentModelFileMetadata 和 currentJsonFileMetadata，包含 fileSize, lastModified, etag)。
步骤 A: 尝试从 L1 获取 MODEL_DETAIL
调用 modelInfoCacheService.getDataFromCache(CacheDataType.MODEL_DETAIL, this.id, modelFilePath, currentModelFileMetadata)。
若返回有效 ModelObject，直接使用。
步骤 B: 若 L1 未命中/失效，尝试从 L2 获取 MODEL_JSON_INFO
调用 modelInfoCacheService.getDataFromCache(CacheDataType.MODEL_JSON_INFO, this.id, associatedJsonPath, currentJsonFileMetadata)。
若返回有效 rawJsonInfoObject: i. DataSource 使用此 rawJsonInfoObject 和模型主文件信息构建完整的 ModelObject。 ii. DataSource 调用 modelInfoCacheService.setDataToCache(CacheDataType.MODEL_DETAIL, this.id, modelFilePath, newlyBuiltModelObject, currentModelFileMetadata) 将新构建的 ModelObject 写回 L1 缓存。 iii.返回构建的 ModelObject。
步骤 C: 若 L1 和 L2 均未命中/失效，则从原始数据源获取 a. DataSource 读取原始 .json 文件内容，解析为 parsedJsonInfoObject。获取其元数据 sourceJsonFileMetadata。 b. DataSource 调用 modelInfoCacheService.setDataToCache(CacheDataType.MODEL_JSON_INFO, this.id, associatedJsonPath, parsedJsonInfoObject, sourceJsonFileMetadata) 将其存入 L2。 c. DataSource 使用 parsedJsonInfoObject 和模型主文件信息（获取其元数据 sourceModelFileMetadata）构建完整的 ModelObject。 d. DataSource 调用 modelInfoCacheService.setDataToCache(CacheDataType.MODEL_DETAIL, this.id, modelFilePath, builtModelObject, sourceModelFileMetadata) 将其存入 L1。 e. 返回构建的 ModelObject。
7.3. writeModelJson 流程
DataSource 成功写入 .json 文件后。
获取被写入的 .json 文件路径 (jsonFilePath) 和对应的模型文件路径 (modelFilePath)。
调用 modelInfoCacheService.invalidateCacheEntry(CacheDataType.MODEL_JSON_INFO, this.id, jsonFilePath)。
调用 modelInfoCacheService.invalidateCacheEntry(CacheDataType.MODEL_DETAIL, this.id, modelFilePath)。
使包含此模型的目录的 MODEL_LIST 缓存失效（可能通过 invalidateCacheEntry 如果能确定键，或更广范围的清理如 clearCacheForSource，或依赖下次获取时 contentHash 不匹配）。
8. SQLite 表结构 (model_json_info_cache)
保持表名 model_json_info_cache，并仅用于 CacheDataType.MODEL_JSON_INFO。

CREATE TABLE IF NOT EXISTS model_json_info_cache (
    cache_key TEXT PRIMARY KEY, -- "MODEL_JSON_INFO:sourceId:path/to/file.json"
    source_id TEXT NOT NULL,
    normalized_json_path TEXT NOT NULL, -- 原始 .json 文件的规范化路径 (pathIdentifier for this type)
    bson_data BLOB NOT NULL,            -- BSON 序列化的原始 JSON 对象
    metadata_filesize INTEGER NOT NULL, -- 原始 .json 文件的 fileSize
    metadata_last_modified REAL NOT NULL, -- 原始 .json 文件的 lastModified (mtimeMs)
    metadata_etag TEXT,                 -- 原始 .json 文件的 etag (nullable)
    cached_timestamp_ms INTEGER NOT NULL, -- 缓存条目创建/更新的时间戳
    ttl_seconds INTEGER NOT NULL,         -- 此条目的TTL (由服务内部设定)
    last_accessed_timestamp_ms INTEGER NOT NULL -- (可选，用于更复杂的LRU L2清理)
);

-- 索引建议
CREATE INDEX IF NOT EXISTS idx_mjic_source_id ON model_json_info_cache (source_id);
CREATE INDEX IF NOT EXISTS idx_mjic_expires_at ON model_json_info_cache (cached_timestamp_ms, ttl_seconds);
CREATE INDEX IF NOT EXISTS idx_mjic_last_accessed ON model_json_info_cache (last_accessed_timestamp_ms);
---

sql



9. 后续步骤
修改 ModelInfoCacheService: 实现新接口和内部逻辑。
修改 DataSource 实现: 适配新缓存服务接口和流程。
测试: 全面测试。