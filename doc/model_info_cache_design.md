# ModelNest `model info` 缓存方案设计文档

## 1. 引言

本文档旨在为 ModelNest 项目设计一个高效的 `model info` 缓存系统。`model info` 指的是模型的详细元数据，特别是从外部源（如 Civitai API）获取并通过 `.json` 文件存储的信息，以及由 `ModelService` 最终整合的 `modelObj` 对象。核心需求是构建一个包含内存缓存和本地磁盘缓存的两级缓存系统，以减少对外部 API 的依赖、加快模型信息获取速度、优化 JSON 解析性能，并提升整体用户体验。

设计将基于项目现有架构（如 [`doc/架构说明.md`](doc/架构说明.md) 所述），并重点关注与 `ModelService` ([`src/services/modelService.js`](src/services/modelService.js)) 的集成。

## 2. 核心需求与缓存目标

*   **缓存 `ModelService` 返回的 `modelObj`**: 内存中缓存完整的 `modelObj`。
*   **缓存 JSON 解析结果**: 磁盘上主要缓存从 `.json` 文件解析得到的 `modelJsonInfo` (通常是来自 Civitai 的元数据)，以节省重复读取和解析的开销。
*   **两级缓存**:
    *   L1: 内存缓存，速度最快，容量有限。
    *   L2: 磁盘缓存，容量较大，持久化。
*   **按模型库隔离**: 缓存应能感知并区分不同的数据源 (`sourceId`)。
*   **高效的失效机制**: 基于文件元数据 (修改时间、大小) 和 TTL。
*   **IO 友好**: L2 磁盘缓存采用 SQLite + BSON 以优化 IO 和解析性能。

## 3. 缓存结构设计

### 3.1. 缓存键策略

缓存的统一键将基于数据源 ID 和模型关联的 `.json` 文件路径（如果存在）或主模型文件路径。

*   **主缓存键 (`cacheKey`)**: 字符串格式，`{sourceId}:{normalized_resource_path}`。
    *   `sourceId`: 数据源的唯一标识符。
    *   `normalized_resource_path`:
        *   如果模型有关联的 `.json` 文件，则为此 `.json` 文件的规范化相对路径。
        *   如果模型没有 `.json` 文件（例如，仅有模型主文件），则为此模型主文件（如 `.safetensors`）的规范化相对路径。这将用于标识一个潜在的 `modelObj`，即使其 `modelJsonInfo` 为空。

### 3.2. L1: 内存缓存

*   **存储内容**: 完整的 `modelObj` JavaScript 对象。
*   **数据结构**: 使用 `Map` 对象实现。
    *   键: `cacheKey` (如上定义)。
    *   值: `{ data: modelObj, timestamp: Date.now(), ttl: configuredTtlForL1, sourceJsonStats: { mtimeMs: ..., size: ... } | null }`
        *   `sourceJsonStats`: 如果 `modelObj.jsonPath` 存在，则记录其关联的 `.json` 文件的 `mtimeMs` 和 `size`，用于快速失效判断。如果不存在 `.json` 文件，则为 `null`。
*   **大小限制**: 可配置的最大条目数 (例如，默认 200 个)。
*   **替换策略**: LRU (最近最少使用)。通过在访问或更新时将被操作的条目重新插入到 `Map` 的方式模拟（`Map` 保持插入顺序）。超出限制时，移除迭代器最前面的条目。
*   **实现位置**: `ModelInfoCacheService` 内部。

### 3.3. L2: 磁盘缓存 (SQLite + BSON)

*   **存储内容**: `modelObj.modelJsonInfo` 部分，即从 `.json` 文件解析或从外部 API 获取的详细模型元数据。
*   **存储机制**: 单个 SQLite 数据库文件。
    *   **文件路径**: 用户应用数据目录下，例如 `app.getPath('userData')/ModelNest/cache/model_cache.sqlite`。
*   **数据格式**: `modelJsonInfo` JavaScript 对象将通过 **BSON** 序列化为二进制数据 (`Buffer`) 后存储。
*   **SQLite 表结构 (表名: `model_json_info_cache`)**:

    | 列名                      | 类型    | 约束          | 描述                                                                 |
    | :------------------------ | :------ | :------------ | :------------------------------------------------------------------- |
    | `cache_key`               | TEXT    | PRIMARY KEY   | `{sourceId}:{normalized_json_path}` (源 JSON 文件的唯一键)           |
    | `source_id`               | TEXT    | NOT NULL      | 数据源 ID                                                            |
    | `normalized_json_path`    | TEXT    | NOT NULL      | 源 JSON 文件在其数据源中的规范化相对路径                               |
    | `bson_data`               | BLOB    | NOT NULL      | BSON 序列化后的 `modelJsonInfo` 数据                                 |
    | `source_json_mtime_ms`    | REAL    | NOT NULL      | 缓存时，源 JSON 文件的 `mtimeMs` (毫秒时间戳)                        |
    | `source_json_size`        | INTEGER | NOT NULL      | 缓存时，源 JSON 文件的大小 (bytes)                                   |
    | `cached_timestamp_ms`     | INTEGER | NOT NULL      | 此条目被缓存的 Unix毫秒时间戳                                          |
    | `ttl_seconds`             | INTEGER | NOT NULL      | 此条目的有效生存时间 (秒)                                            |
    | `last_accessed_timestamp_ms`| INTEGER | NOT NULL      | 最近访问此条目的 Unix毫秒时间戳 (用于 LRU 清理)                      |

*   **索引**:
    *   `cache_key` (自动因主键创建)。
    *   `source_id` (用于按库管理和清理)。
    *   `last_accessed_timestamp_ms` (用于 LRU 清理)。
    *   `(cached_timestamp_ms + ttl_seconds * 1000)` (表达式索引，用于高效 TTL 清理，如果 SQLite 版本支持)。或者分别索引 `cached_timestamp_ms`。
*   **依赖**: 需要引入 `sqlite3` 和 `bson` npm 包。
*   **实现位置**: `ModelInfoCacheService` 内部。

## 4. 缓存读写逻辑

### 4.1. 数据流图 (读取 `model info`)

```mermaid
graph LR
    subgraph UserAction["用户操作/系统调用"]
        Action["请求模型详情 (getModelDetail)"]
    end

    subgraph MainProcess["主进程"]
        MS["ModelService"]
        MICS["ModelInfoCacheService"]
        DSInt["DataSourceInterface"]
        Crawler["CivitaiCrawlerUtil (按需)"]
        FS["文件系统"]
        CAPI["Civitai API (外部)"]

        subgraph L1Cache["L1: 内存缓存 (modelObj)"]
            L1Map["Map<cacheKey, CachedModelObj>"]
        end
        subgraph L2Cache["L2: 磁盘缓存 (modelJsonInfo via BSON)"]
            L2DB["SQLite (model_json_info_cache 表)"]
        end
    end

    Action -- sourceId, jsonPath, modelFilePath --> MS

    MS -- 1. 构造 cacheKey --> MS
    MS -- 2. getFromL1(cacheKey) --> MICS
    MICS -- 查 L1Map --> L1Map
    L1Map -- A1. 命中 --> MICS
    MICS -- A2. 校验 L1 (TTL, sourceJsonStats vs FS) --> FS
    FS -- JSON元数据 --> MICS
    MICS -- A3. L1有效 --> MS
    MS -- A4. 返回克隆的 modelObj --> Action

    L1Map -- B1. L1未命中/失效 --> MICS
    MICS -- 3. getFromL2(cacheKeyForJson) --> L2DB
    L2DB -- B2. SQLite查询 (BLOB) --> MICS
    MICS -- B3. L2命中 --> MICS
    MICS -- B4. BSON反序列化 --> MICS
    MICS -- B5. 校验 L2 (TTL, sourceJsonStats vs FS) --> FS
    FS -- JSON元数据 --> MICS
    MICS -- B6. L2有效 (得到 modelJsonInfo) --> MS
    MS -- B7. 需构建完整 modelObj (可能部分已有) --> MS
    MS -- B8. 使用L2的modelJsonInfo填充/构建modelObj --> MS
    MS -- B9. 更新L1(新modelObj) --> MICS
    MICS -- 写L1Map --> L1Map
    MS -- B10. 返回 modelObj --> Action

    MICS -- C1. L2未命中/失效 --> MS
    MS -- 4. 从数据源加载完整 modelObj --> DSInt
    DSInt -- readModelDetail (读文件, 解析JSON等) --> FS
    FS -- 文件内容/JSON内容 --> DSInt
    DSInt -- 返回初步 modelObj (可能无 modelJsonInfo) --> MS
    
    alt 如果需要从Civitai获取modelJsonInfo
      MS -- 5. 触发爬虫逻辑 --> Crawler
      Crawler -- (内部计算模型文件哈希) --> Crawler
      Crawler -- 请求Civitai API --> CAPI
      CAPI -- 返回civitaiData --> Crawler
      Crawler -- 返回civitaiData (作为 modelJsonInfo) --> MS
      MS -- 6. 将civitaiData写入对应的.json文件 --> FS
    end

    MS -- 7. 得到最终 modelObj 和 sourceJsonStats --> MS
    MS -- 8. 更新L2(BSON(modelJsonInfo), sourceJsonStats) --> MICS
    MICS -- BSON序列化 --> MICS
    MICS -- 写L2DB (SQLite INSERT/REPLACE) --> L2DB
    MS -- 9. 更新L1(最终modelObj, sourceJsonStats) --> MICS
    MICS -- 写L1Map --> L1Map
    MS -- 10. 返回 modelObj --> Action
```

### 4.2. 读取流程 (`ModelService.getModelDetail(sourceId, jsonPath, modelFilePath)`)

1.  **构造缓存键 (`cacheKey`)**:
    *   如果 `jsonPath` 提供且有效，`cacheKey = {sourceId}:{normalized_json_path}`.
    *   如果 `jsonPath` 无效或未提供，但 `modelFilePath` 有效，`cacheKey = {sourceId}:{normalized_model_file_path}`. (此 `modelObj` 的 `modelJsonInfo` 可能为空)。
2.  **查询 L1 内存缓存 (`ModelInfoCacheService.getL1(cacheKey)`)**:
    *   **命中**:
        *   获取缓存的 `{ data: modelObj, timestamp, ttl, sourceJsonStats }`。
        *   检查 TTL 是否过期。
        *   如果 `modelObj.jsonPath` 存在且 `sourceJsonStats` 存在：
            *   从文件系统获取该 `jsonPath` 对应的实际文件 `mtimeMs` 和 `size`。
            *   与 `sourceJsonStats` 比较。若文件已更改，则 L1 此条目视为无效。
        *   **L1 有效 (未过期且依赖文件未变)**: 返回 `modelObj` 的深拷贝。更新此条目在 L1 LRU 中的位置。**流程结束。**
        *   **L1 无效**: 从 L1 中移除此条目。继续。
    *   **未命中**: 继续。
3.  **准备从数据源或 L2 加载 `modelJsonInfo`**:
    *   确定目标 `.json` 文件路径 (`actualJsonPath`)，这通常是传入的 `jsonPath`。
    *   构造 L2 缓存键: `l2CacheKey = {sourceId}:{actualJsonPath}` (仅当 `actualJsonPath` 有效时)。
4.  **查询 L2 磁盘缓存 (`ModelInfoCacheService.getL2(l2CacheKey)`)**: (仅当 `actualJsonPath` 有效且 L1 未提供有效的 `modelJsonInfo`)
    *   **命中**:
        *   从 SQLite 读取 `{ bson_data, source_json_mtime_ms, source_json_size, cached_timestamp_ms, ttl_seconds }`。
        *   检查 TTL (`cached_timestamp_ms`, `ttl_seconds`) 是否过期。
        *   从文件系统获取 `actualJsonPath` 对应的实际文件 `mtimeMs` 和 `size`。
        *   与记录的 `source_json_mtime_ms`, `source_json_size` 比较。若文件已更改，则 L2 此条目视为无效。
        *   **L2 有效**:
            *   使用 `BSON.deserialize(bson_data)` 得到 `modelJsonInfo` 对象。
            *   更新此条目在 L2 LRU 中的位置 (`last_accessed_timestamp_ms`)。
            *   **标记 `modelJsonInfoFromL2 = true`**。继续构建完整 `modelObj`。
        *   **L2 无效**: 从 L2 中删除此条目。`modelJsonInfo` 仍需从源获取。
    *   **未命中**: `modelJsonInfo` 需从源获取。
5.  **从数据源加载/构建 `modelObj`**:
    *   调用 `dataSourceInterface.readModelDetail(sourceConfig, jsonPath, modelFilePath)` 获取基础的 `modelObj` (不含或含旧的 `modelJsonInfo`)。
    *   **如果 L2 已提供了有效的 `modelJsonInfo` (来自步骤 4)**: 将此 `modelJsonInfoFromL2` 赋值给 `modelObj.modelJsonInfo`。
    *   **否则 (L1, L2 均未提供有效 `modelJsonInfo`，或 `jsonPath` 本身就不存在)**:
        *   如果 `jsonPath` 存在但其内容无效或需要更新 (例如，用户触发刷新，或无缓存时首次加载)：
            *   调用爬虫逻辑 (如 `getCivitaiModelInfoWithTagsAndVersions(modelFilePath)`) 获取最新的 `civitaiInfo`。
            *   如果成功获取 `civitaiInfo`:
                *   将其作为 `modelObj.modelJsonInfo`。
                *   将 `civitaiInfo` 写入（或覆盖）到 `jsonPath` 对应的 `.json` 文件中。
                *   获取新写入/更新的 `.json` 文件的 `mtimeMs` 和 `size` (`newJsonStats`)。
                *   **更新 L2 缓存**: `ModelInfoCacheService.setL2(l2CacheKey, civitaiInfo, newJsonStats)`。
        *   如果 `jsonPath` 不存在，且应用逻辑决定不创建/不爬取，则 `modelObj.modelJsonInfo` 可能为空。
6.  **更新 L1 内存缓存**:
    *   获取最终构建的 `modelObj`。
    *   如果 `modelObj.jsonPath` 存在，获取其最新的文件元数据 `currentJsonStats`。
    *   `ModelInfoCacheService.setL1(cacheKey, modelObj, currentJsonStats)`。
7.  返回 `modelObj` 的深拷贝。

### 4.3. 写入/更新流程

*   **场景1: `ModelService.saveModel()` 保存 `modelObj` (通常是用户编辑后)**
    1.  `ModelService` 内部逻辑将 `modelObj.modelJsonInfo` 写入到对应的 `.json` 文件。
    2.  获取该 `.json` 文件最新的 `mtimeMs` 和 `size` (`newJsonStats`)。
    3.  `ModelInfoCacheService.setL2(l2CacheKey, modelObj.modelJsonInfo, newJsonStats)`。
    4.  `ModelService` 通常会重新调用 `getModelDetail` 或以其他方式获取更新后的 `modelObj`。这个过程会自动更新 L1。或者，`saveModel` 成功后，可以直接用保存后的 `modelObj` 和 `newJsonStats` 更新 L1：`ModelInfoCacheService.setL1(cacheKey, updatedModelObj, newJsonStats)`。
*   **场景2: 爬虫服务更新了 `.json` 文件**
    1.  爬虫服务获取了 `civitaiInfo` 并将其写入了目标 `.json` 文件。
    2.  爬虫服务获取该 `.json` 文件最新的 `mtimeMs` 和 `size` (`newJsonStats`)。
    3.  爬虫服务调用 `ModelInfoCacheService.setL2(l2CacheKey, civitaiInfo, newJsonStats)`。
    4.  爬虫服务可以调用 `ModelInfoCacheService.invalidateL1(cacheKey)` 来使 L1 中可能存在的旧 `modelObj` 失效，下次访问时会重新构建。

### 4.4. L1 缓存键在 JSON 文件不存在时的处理

*   当 `getModelDetail` 被调用时，如果 `jsonPath` 参数为空或无效，但 `modelFilePath` 有效，此时 `cacheKey` 会基于 `modelFilePath`。
*   L1 缓存中存储的 `modelObj` 的 `sourceJsonStats` 字段将为 `null`。
*   在L1有效性检查时，由于 `sourceJsonStats` 为 `null`，不会进行基于JSON文件元数据的比较，仅检查TTL。
*   L2 缓存的查找将不会发生，因为没有有效的 `jsonPath` 来构造 `l2CacheKey`。
*   这种 `modelObj` 主要包含基于模型文件本身的信息，其 `modelJsonInfo` 部分通常为空或默认。

## 5. 缓存失效机制

### 5.1. TTL (Time To Live)
*   L1 和 L2 缓存条目都包含创建时间戳和可配置的 TTL 值。
*   **L1 TTL**: 例如，默认 1 小时。通过 `ConfigService` 配置。
*   **L2 TTL**: 例如，默认 7 天。通过 `ConfigService` 配置。
*   在读取缓存时检查是否过期。过期则视为未命中，并可触发删除。

### 5.2. 基于文件元数据的失效 (主要机制)
*   **L1 (`modelObj`)**: 当从 L1 读取 `modelObj` 时，如果其 `jsonPath` 和 `sourceJsonStats` 存在，则会获取实际 `.json` 文件的当前 `mtimeMs` 和 `size`。与 `sourceJsonStats` 不一致则 L1 条目失效。
*   **L2 (`modelJsonInfo`)**: 当从 L2 读取 `modelJsonInfo` 时，会获取其源 `.json` 文件的当前 `mtimeMs` 和 `size`。与 L2 缓存中记录的 `source_json_mtime_ms` 和 `source_json_size` 不一致则 L2 条目失效。

### 5.3. 数据写入/更新操作触发的缓存更新与失效

当模型的核心数据（尤其是存储在 `.json` 文件中的 `modelJsonInfo`）被修改时，相关的缓存条目必须被更新或视作无效，以保证数据一致性。

*   **通过 `ModelService.saveModel()`**:
    *   当用户通过应用程序编辑并保存模型信息时，`ModelService.saveModel()` 方法会被调用。
    *   此方法负责将更新后的 `modelJsonInfo` 写回对应的 `.json` 文件。
    *   **关键操作**: 在 `.json` 文件成功写入后，`ModelService`（或其调用的保存逻辑）**必须**调用 `ModelInfoCacheService` 的 `setL2()` 方法，使用新的 `modelJsonInfo` 和更新后的 `.json` 文件元数据（`mtimeMs`, `size`）来刷新 L2 缓存中的对应条目。
    *   同时，L1 缓存中对应的 `modelObj` 也需要更新。这可以通过 `ModelInfoCacheService.setL1()` 实现，传入新构建或获取的、包含最新数据的 `modelObj` 以及更新后的 `.json` 文件元数据。如果 `saveModel` 后会重新获取 `modelObj` (例如通过调用 `getModelDetail`)，则 L1 的更新会自然发生。

*   **通过外部更新 (如爬虫服务)**:
    *   当爬虫服务或其他后台进程获取了新的 `modelJsonInfo` 并更新了对应的 `.json` 文件时。
    *   该服务在成功更新 `.json` 文件后，同样需要调用 `ModelInfoCacheService.setL2()` 来刷新 L2 缓存，并调用 `ModelInfoCacheService.invalidateL1()` 或 `setL1()` (如果能构建新的 `modelObj`) 来处理 L1 缓存。

这些 `setL1()` 和 `setL2()` 操作会用新数据覆盖旧的缓存条目（如果键已存在），或者创建新条目，从而确保缓存反映了最新的数据状态。旧数据实际上是被新数据替换，或者在下次访问时因元数据不匹配而被视为无效。

### 5.4. 用户手动触发
*   提供 IPC 接口允许用户：
    *   清除特定模型（通过 `cacheKey`）的 L1 和 L2 缓存。
    *   清除某个数据源 (`sourceId`) 的所有 L1 和 L2 缓存。
    *   清除所有缓存。
*   `ModelInfoCacheService` 提供相应方法：`clear(cacheKey)`, `clearBySource(sourceId)`, `clearAll()`。

### 5.5. BSON 序列化/反序列化错误处理
*   **序列化 (写入 L2)**:
    *   如果 `BSON.serialize(modelJsonInfo)` 失败，记录错误，本次不写入 L2 缓存。
*   **反序列化 (读取 L2)**:
    *   如果 `BSON.deserialize(bson_data)` 失败（例如，数据损坏），记录错误，将此 L2 条目视为无效（可从数据库删除），并尝试从源数据加载。

## 6. 高级考虑点

### 6.1. 并发控制
*   **缓存击穿 (单个热点 Key 失效时，多次请求同时加载源数据)**:
    *   当 `ModelInfoCacheService` 发现某个 `cacheKey` 需要从源加载数据（例如，调用 `ModelService` 内部的加载逻辑或爬虫）时，可以使用一个内存中的 Promise 锁。
    *   `Map<cacheKey, Promise<ModelObjOrJsonInfo>>`。第一个请求创建 Promise 并开始加载，后续相同 `cacheKey` 的请求等待此 Promise。加载完成后，结果存入缓存，Promise 从 Map 中移除。
*   **缓存雪崩 (大量 Key 同时失效)**:
    *   为 TTL 设置一个小的随机浮动范围（例如，基础 TTL ± 10%），避免大量缓存在同一精确时刻集中过期。

### 6.2. 缓存穿透 (查询不存在的数据)
*   当从外部源（如 Civitai API）查询一个模型信息，结果为“未找到”时：
    *   可以在 L2 缓存中存储一个特殊的标记（例如，`bson_data` 为特定空值或一个特殊结构的 BSON 对象，并有一个额外的状态字段），表示此 `jsonPath` 已查询过且外部无数据。
    *   为此类“未找到”条目设置一个较短的 TTL（例如，1小时 - 24小时）。
    *   L1 缓存对应的 `modelObj` 的 `modelJsonInfo` 部分可以为 `null` 或特定标记。

### 6.3. 缓存预热
*   **可选策略1 (应用启动时)**:
    *   异步加载用户最近访问过的 N 个模型的 `model info` 到 L1 和 L2 缓存。需要记录访问历史/频率。
*   **可选策略2 (新模型库扫描后)**:
    *   当用户扫描并添加一个新的本地模型目录后，可以分析哪些模型文件尚无对应的 `.json` 文件。
    *   可以提示用户或根据配置自动触发一次后台任务，为这些新模型批量从 Civitai 获取信息、创建 `.json` 文件并填充缓存。

### 6.4. 缓存清理 (L1 和 L2)
*   **L1 (内存 `modelObj`)**:
    *   主要通过 LRU 和数量限制进行被动清理。
    *   TTL 过期也会导致条目在访问时被移除。
*   **L2 (SQLite `modelJsonInfo`)**:
    *   **TTL 清理**: 定期任务（例如，应用启动时或每日一次）执行 SQL 删除过期条目：
        `DELETE FROM model_json_info_cache WHERE (cached_timestamp_ms + ttl_seconds * 1000) < ?` (当前时间)。
    *   **LRU 清理 (基于条目数或估算大小)**:
        *   可配置 L2 缓存的最大条目数（例如，默认 5000 条）。
        *   当条目数超限时（可在写入后检查），删除 `last_accessed_timestamp_ms` 最早的 N 条记录。
        *   `DELETE FROM model_json_info_cache WHERE cache_key IN (SELECT cache_key FROM model_json_info_cache ORDER BY last_accessed_timestamp_ms ASC LIMIT ?)`
    *   **数据库文件大小控制**: SQLite 的 `VACUUM` 命令可以重建数据库文件并回收未使用空间，但它是一个阻塞操作，应在空闲时执行。主要通过限制条目数和定期清理过期条目来间接控制文件大小。

### 6.5. 可配置性 (`ConfigService`)
以下参数应可通过 `ConfigService` 配置，并提供合理的默认值：
*   `cache.enabled` (boolean, master switch for L1 & L2)
*   `cache.l1.enabled` (boolean)
*   `cache.l1.maxItems` (number, e.g., 200)
*   `cache.l1.ttlSeconds` (number, e.g., 3600 for 1 hour)
*   `cache.l2.enabled` (boolean)
*   `cache.l2.ttlSeconds` (number, e.g., 604800 for 7 days)
*   `cache.l2.maxItems` (number, e.g., 5000, for LRU cleanup trigger)
*   `cache.l2.cleanupIntervalHours` (number, e.g., 24, for periodic TTL cleanup task)
*   `cache.l2.dbPath` (string, advanced, defaults to `userData/ModelNest/cache/model_cache.sqlite`)

### 6.6. 错误处理
*   **SQLite 操作错误**: (DB连接、查询、写入失败) 记录详细错误日志。可以考虑短暂禁用 L2 缓存，或本次操作跳过 L2。
*   **BSON 序列化/反序列化错误**: 记录错误。序列化失败则不写入 L2。反序列化失败则视该 L2 条目无效，并可删除。
*   **文件系统操作错误** (获取 `mtime/size`): 记录错误，可能导致缓存有效性判断不准确，此时可选择将缓存条目视为无效。
*   **优雅降级**: 在缓存系统出现严重错误时，应能降级到无缓存模式，保证核心功能可用，但性能下降。

### 6.7. 日志记录 (`electron-log`)
记录关键缓存操作和事件，便于调试和监控：
*   L1/L2 命中/未命中 (含 `cacheKey`)。
*   L1/L2 条目写入/更新/删除/失效 (原因：TTL, 文件变更, 手动)。
*   BSON 序列化/反序列化成功/失败。
*   SQLite 操作成功/失败。
*   缓存清理任务执行情况。
*   所有配置加载。
*   错误日志应包含上下文信息。

## 7. 与现有架构的集成

### 7.1. `ModelInfoCacheService`
*   创建一个新的服务 `src/services/modelInfoCacheService.js`。
*   **职责**:
    *   封装 L1 (内存 Map) 和 L2 (SQLite + BSON) 的所有缓存逻辑。
    *   初始化 SQLite 连接，创建表结构（如果不存在）。
    *   提供 `getL1`, `setL1`, `invalidateL1`, `getL2`, `setL2`, `invalidateL2`, `clear`, `clearBySource`, `clearAll` 等方法。
    *   处理 LRU 和 TTL 逻辑。
    *   执行定期的 L2 清理任务。
    *   从 `ConfigService` 读取缓存配置。
*   在主进程中实例化和运行。

### 7.2. `ModelService` 集成
*   `ModelService` 在其构造函数中接收 `ModelInfoCacheService` 实例 (依赖注入)。
*   在其 `getModelDetail` 方法中，按照 "4.2. 读取流程" 中描述的逻辑与 `ModelInfoCacheService` 交互。
*   在其 `saveModel` 方法成功写入 `.json` 文件后，调用 `ModelInfoCacheService` 的相应方法更新 L2 和 L1 缓存。

### 7.3. `ModelCrawlerService` (或其他更新 `.json` 文件的服务) 集成
*   当爬虫服务成功获取 `modelJsonInfo` 并将其写入（或更新）对应的 `.json` 文件后：
    1.  获取该 `.json` 文件的 `sourceId` 和 `normalized_json_path` (构成 `l2CacheKey`)。
    2.  获取该 `.json` 文件最新的 `mtimeMs` 和 `size` (`newJsonStats`)。
    3.  调用 `modelInfoCacheService.setL2(l2CacheKey, newModelJsonInfo, newJsonStats)`。
    4.  调用 `modelInfoCacheService.invalidateL1(correspondingL1CacheKey)` 以确保下次访问时 L1 会加载最新的数据。

### 7.4. 主进程实现
*   `ModelInfoCacheService` 及其所有依赖 (SQLite, BSON, 文件系统操作) 均在 Electron 主进程中运行，以利用 Node.js 的全部能力并避免阻塞渲染进程。

### 7.5. IPC 接口 (通过 `src/ipc/appIPC.js` 或新建 `cacheIPC.js`)
为渲染进程提供以下缓存管理功能：
*   `clearModelCache({ sourceId, resourcePath })`: 清除特定模型的缓存。
*   `clearSourceCache({ sourceId })`: 清除整个数据源的缓存。
*   `clearAllModelCache()`: 清除所有 `model info` 缓存。
*   `getCacheStatus()`: 获取缓存统计信息 (L1/L2 条目数，L2 数据库大小等)。
这些 IPC 调用由 `ModelInfoCacheService` 的相应方法处理。

## 8. 所选方案理由分析

*   **两级缓存**: 结合了内存的速度和磁盘的持久性与大容量。
*   **L1 缓存 `modelObj`**: `modelObj` 是 `ModelService` 的直接工作对象，在内存中缓存完整对象可以避免重复构建，提升频繁访问的性能。
*   **L2 缓存 `modelJsonInfo` (BSON + SQLite)**:
    *   **目标明确**: 针对性缓存耗时的 JSON 解析结果和外部 API 数据。
    *   **SQLite**: 解决了独立 JSON 文件方案的 IO 低效和管理不便问题，提供了事务性、较好的读写性能和集中的数据管理。
    *   **BSON**: 相较于纯文本 JSON，BSON 提供了更快的序列化/反序列化速度和可能更小的数据体积，直接满足用户对“节省解析时间”和“JS友好数据结构”的诉求（尽管仍需反序列化，但过程更快）。
*   **基于 `.json` 文件元数据失效**: 直接关联到被缓存数据的源头（`.json` 文件），失效判断准确可靠。
*   **缓存键设计**: `{sourceId}:{normalized_path}` 确保了全局唯一性和按库管理的能力。
*   **模块化**: `ModelInfoCacheService` 将缓存逻辑内聚，易于维护和测试。

此方案在满足核心需求的同时，兼顾了性能、可管理性、可配置性和与现有系统的集成。