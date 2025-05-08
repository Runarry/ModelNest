---

## ModelNest 并发与缓存优化详细方案

**版本**: 1.1
**日期**: 2025-05-08

### 1. 引言

本文档旨在为 ModelNest 项目中的数据源遍历和图片缓存模块提供详细的性能优化方案。当前版本在处理大目录或大量文件时，存在因串行操作导致的效率低下和主流程阻塞问题。本方案将通过引入并发控制机制和优化批量操作，显著提升系统性能和响应速度。

### 2. 核心优化工具：`asyncPool.js`

我们将在 `src/common/asyncPool.js` (如果目录不存在则创建) 中实现一个通用的异步并发池工具。

**文件**: `src/common/asyncPool.js`

```javascript
// src/common/asyncPool.js
const log = require('electron-log');

/**
 * 异步并发池，用于控制并发执行异步任务。
 * @param {number} poolLimit 并发上限。
 * @param {Array<any>} array 要处理的数组。
 * @param {Function} iteratorFn 迭代函数，接收数组中的一个元素，返回一个 Promise。
 * @param {string} taskName 可选的任务名称，用于日志记录。
 * @returns {Promise<Array<{status: 'fulfilled' | 'rejected', value?: any, reason?: any}>>} 返回 Promise.allSettled 的结果数组。
 */
async function asyncPool(poolLimit, array, iteratorFn, taskName = 'Unnamed Task') {
  const ret = []; // 存储所有 Promise 的结果
  const executing = []; // 存储正在执行的 Promise

  log.debug(`[AsyncPool][${taskName}] Starting with limit ${poolLimit} for ${array.length} items.`);

  for (const item of array) {
    // 为每个任务创建一个 Promise
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p); // 将 Promise 本身推入结果数组，后续用 allSettled 处理

    // 如果并发数达到上限，则等待一个任务完成
    if (poolLimit <= array.length && poolLimit > 0) { // 仅当并发限制有意义时才进行等待管理 (poolLimit > 0)
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e); // 将包装后的 Promise 推入执行队列
      if (executing.length >= poolLimit) {
        log.debug(`[AsyncPool][${taskName}] Reached pool limit (${poolLimit}). Waiting for a task to finish.`);
        await Promise.race(executing); // 等待执行队列中任意一个 Promise 完成
        log.debug(`[AsyncPool][${taskName}] A task finished. Continuing to add tasks.`);
      }
    }
  }
  log.debug(`[AsyncPool][${taskName}] All tasks added to pool. Waiting for all to settle.`);
  return Promise.allSettled(ret); // 等待所有任务完成并返回结果
}

module.exports = { asyncPool };
```

**关键特性**:
-   **并发控制**: 严格限制同时执行的异步任务数量。
-   **Promise.allSettled**: 返回所有任务的结果，无论成功或失败，便于上层统一处理。
-   **日志记录**: 包含任务名和并发状态的日志，方便调试。
-   **错误处理**: `asyncPool` 本身不直接处理 `iteratorFn` 抛出的错误，而是由 `Promise.allSettled` 捕获，调用方需要检查每个结果的 `status`。

### 3. 数据源遍历优化

#### 3.1. WebDAV 数据源 (`src/data/webdavDataSource.js`)

**优化目标**: 改进 `_recursiveListAllFiles` 方法，对子目录的递归调用和 `client.getDirectoryContents` 进行并发控制。

**具体修改点**:

1.  **引入 `asyncPool` 和默认并发数**:
    ```javascript
    // src/data/webdavDataSource.js
    const { asyncPool } = require('../common/asyncPool');
    const DEFAULT_WEBDAV_DIR_CONCURRENCY = 8; // WebDAV 目录遍历默认并发数
    const DEFAULT_WEBDAV_JSON_READ_CONCURRENCY = 8; // WebDAV JSON 读取默认并发数
    ```

2.  **修改 `_recursiveListAllFiles`**:
    -   在获取目录内容后，对子目录的递归调用使用 `asyncPool`。

    ```javascript
    // src/data/webdavDataSource.js
    // ...
    // 在类的构造函数或相关初始化方法中，确保 configService 被注入或可访问
    // constructor(config, configService) {
    //   super(config);
    //   this.configService = configService; // 示例注入
    // }

    async _recursiveListAllFiles(resolvedCurrentPath) {
        const sourceId = this.config.id;
        log.debug(`[WebDavDataSource][${sourceId}] 递归进入目录: ${resolvedCurrentPath}`);
        let filesFound = [];
        let items = [];
        // 从配置获取并发数，若未配置则使用默认值
        const webdavDirConcurrency = (this.configService && typeof this.configService.getSetting === 'function' ? this.configService.getSetting('performance.webdavConcurrency') : null) ?? DEFAULT_WEBDAV_DIR_CONCURRENCY;

        try {
            items = await this.client.getDirectoryContents(resolvedCurrentPath, { deep: false, details: true });
            // ... (原有的健壮性检查代码) ...
        } catch (error) {
            // ... (原有的错误处理代码) ...
            return [];
        }

        const subDirectoryTasks = [];
        for (const item of items) {
            if (item.basename === '.' || item.basename === '..') continue;
            if (item.type === 'file') {
                filesFound.push(item);
            } else if (item.type === 'directory') {
                subDirectoryTasks.push({ path: item.filename, taskName: `RecursiveList-${item.basename}` });
            } // ...
        }

        if (subDirectoryTasks.length > 0) {
            log.info(`[WebDavDataSource][${sourceId}] Processing ${subDirectoryTasks.length} subdirectories concurrently (limit: ${webdavDirConcurrency}) for path: ${resolvedCurrentPath}`);
            const subDirectoryResults = await asyncPool(
                webdavDirConcurrency,
                subDirectoryTasks,
                async (task) => this._recursiveListAllFiles(task.path),
                `WebDAVRecursiveList-${path.basename(resolvedCurrentPath)}`
            );
            // ... (处理 subDirectoryResults) ...
        }
        return filesFound;
    }

    async listModels(directory = null, supportedExts = []) {
        // ...
        const jsonReadConcurrency = (this.configService && typeof this.configService.getSetting === 'function' ? this.configService.getSetting('performance.webdavJsonReadConcurrency') : null) ?? DEFAULT_WEBDAV_JSON_READ_CONCURRENCY;
        // ...
        const jsonReadResults = await asyncPool(
            jsonReadConcurrency,
            jsonPathsToRead,
            // ... (iteratorFn) ...
            `WebDAVJsonRead-${directory || 'root'}`
        );
        // ... (处理 jsonReadResults) ...
        return allModels;
    }
    ```

#### 3.2. 本地数据源 (`src/data/localDataSource.js`)

**优化目标**: 改进 `listModels` 中的 `walk` 函数，对子目录的递归调用进行并发控制。

**具体修改点**:

1.  **引入 `asyncPool` 和默认并发数**:
    ```javascript
    // src/data/localDataSource.js
    const { asyncPool } = require('../common/asyncPool');
    const DEFAULT_LOCAL_DIR_CONCURRENCY = 8; // 本地目录遍历默认并发数
    ```

2.  **修改 `listModels` 和 `walk` 函数**:
    ```javascript
    // src/data/localDataSource.js
    // ...
    // constructor(config, configService) { // 假设 configService 被注入
    //   super(config);
    //   this.configService = configService;
    // }

    async listModels(directory = null, supportedExts = []) {
        // ...
        const localDirConcurrency = (this.configService && typeof this.configService.getSetting === 'function' ? this.configService.getSetting('performance.localFileConcurrency') : null) ?? DEFAULT_LOCAL_DIR_CONCURRENCY;
        log.info(`[LocalDataSource] 开始列出模型. Root: ${this.config.path}, Dir: ${directory}, Concurrency: ${localDirConcurrency}, SupportedExts: ${supportedExts}`);
        // ...
        const walk = async (currentDir) => {
            // ...
            const subDirectoryTasks = files
                .filter(f => f.isDirectory())
                .map(f => ({ path: path.join(currentDir, f.name), taskName: `LocalWalk-${f.name}` }));

            if (subDirectoryTasks.length > 0) {
                log.debug(`[LocalDataSource] Processing ${subDirectoryTasks.length} subdirectories concurrently in ${currentDir} (limit: ${localDirConcurrency})`);
                const subDirResults = await asyncPool(
                    localDirConcurrency,
                    subDirectoryTasks,
                    async (task) => walk(task.path),
                    `LocalWalk-${path.basename(currentDir)}`
                );
                // ... (处理 subDirResults 错误) ...
            }
        };
        await walk(startPath);
        // ...
        return allModels;
    }
    ```

### 4. 图片缓存优化 (`src/common/imageCache.js`)

**优化目标**: 对 `clearCache` 和 `checkAndCleanCache` 中的批量文件操作（`unlink`, `stat`, `readdir`）引入并发控制。

**具体修改点**:

1.  **引入 `asyncPool` 和默认并发数**:
    ```javascript
    // src/common/imageCache.js
    const { asyncPool } = require('./asyncPool'); // 新增导入
    const DEFAULT_IMAGE_CACHE_CONCURRENCY = 16; // 图片缓存操作默认并发数
    ```
    在模块顶部的 `config` 对象或 `defaultConfig` 中也应包含此默认值:
    ```javascript
    // src/common/imageCache.js
    const defaultConfig = {
        // ...
        imageCacheConcurrency: DEFAULT_IMAGE_CACHE_CONCURRENCY // 添加默认值
    };
    let config = { ...defaultConfig };
    ```

2.  **修改 `clearCache`**:
    ```javascript
    // src/common/imageCache.js
    async function clearCache() {
        // 从模块内部 config 读取，该 config 应通过 setConfig 更新
        const imageCacheConcurrency = config.imageCacheConcurrency || DEFAULT_IMAGE_CACHE_CONCURRENCY;
        if (fs.existsSync(config.cacheDir)) {
            log.info(`[ImageCache] Clearing all cache files in ${config.cacheDir} (concurrency: ${imageCacheConcurrency})`);
            const files = await fs.promises.readdir(config.cacheDir);
            const unlinkResults = await asyncPool(
                imageCacheConcurrency,
                files,
                // ... (iteratorFn for unlink) ...
                'ImageCacheClear'
            );
            // ... (处理 unlinkResults) ...
        } // ...
    }
    ```

3.  **修改 `checkAndCleanCache`**:
    ```javascript
    // src/common/imageCache.js
    async function checkAndCleanCache() {
        const imageCacheConcurrency = config.imageCacheConcurrency || DEFAULT_IMAGE_CACHE_CONCURRENCY;
        // ...
        const statResults = await asyncPool(
            imageCacheConcurrency,
            fileNames,
            // ... (iteratorFn for stat) ...
            'ImageCacheStat'
        );
        // ...
        if (filesToDelete.length > 0) {
            log.info(`[ImageCache] Cache size exceeds limit. Starting cleanup of ${filesToDelete.length} files (concurrency: ${imageCacheConcurrency})...`);
            const deleteResults = await asyncPool(
                imageCacheConcurrency,
                filesToDelete,
                // ... (iteratorFn for delete) ...
                'ImageCacheCleanupDelete'
            );
            // ... (处理 deleteResults) ...
        } // ...
    }
    ```

### 5. 配置与集成

1.  **配置文件 (`config.example.json` 和用户 `config.json`)**:
    在配置文件中添加 `performance` 部分来管理并发参数。

    ```json
    {
      "performance": {
        "localFileConcurrency": 8,
        "webdavConcurrency": 8,
        "webdavJsonReadConcurrency": 8,
        "imageCacheConcurrency": 16
      },
      "imageCache": {
        "cacheDir": "path/to/your/userData/ModelNestCache/images",
        "maxCacheSizeMB": 500,
        "compressQuality": 75,
        "preferredFormat": "WebP"
        // "imageCacheConcurrency" 也可以放在这里，如果 imageCache.setConfig 会处理它
      }
    }
    ```

2.  **服务层读取配置 (`src/services/configService.js`)**:
    -   `ConfigService` 的 `getSetting(key, defaultValue)` 方法应能处理当 `key` 不存在时返回 `defaultValue` 的情况。如果当前实现不支持，则需要修改。
    -   **重要**: 各模块在使用 `configService.getSetting()` 时，**必须**提供一个合理的默认值，如：
        `const concurrency = configService.getSetting('performance.localFileConcurrency', DEFAULT_LOCAL_DIR_CONCURRENCY);`
        或者使用空值合并运算符 `??` 如示例代码所示：
        `const concurrency = configService.getSetting('performance.localFileConcurrency') ?? DEFAULT_LOCAL_DIR_CONCURRENCY;`
        这是为了确保即使配置文件中缺少这些新参数，程序也能正常运行。

3.  **模块内使用配置**:
    -   在 `webdavDataSource.js`, `localDataSource.js` 中，通过注入的 `configService` 读取并发参数，并确保提供默认值。
    -   对于 `imageCache.js`，其 `config` 对象通过 `setConfig` 方法更新。`setConfig` 应能合并传入的配置，对于未传入的并发参数，则使用模块内定义的默认值。
        ```javascript
        // src/common/imageCache.js
        function setConfig(options = {}) {
            const oldConcurrency = config.imageCacheConcurrency;
            config = { ...defaultConfig, ...config, ...options }; // 合并 defaultConfig, 当前 config, 再合并 options
            // 确保 concurrency 优先级：options > existing config > defaultConfig
            if (options.imageCacheConcurrency === undefined && oldConcurrency !== undefined) {
                config.imageCacheConcurrency = oldConcurrency; // 如果 options 未提供，但之前 config 有，则保留
            }
            if (config.imageCacheConcurrency === undefined) { // 最终检查，确保有值
                config.imageCacheConcurrency = DEFAULT_IMAGE_CACHE_CONCURRENCY;
            }
            log.info('[ImageCache] Configuration updated. New concurrency:', config.imageCacheConcurrency);
        }
        ```

### 6. 预期效果与测试

(同上一版方案，强调测试时需覆盖配置存在与不存在（使用默认值）的场景。)

-   **预期效果**:
    -   显著减少大目录的遍历时间。
    -   图片缓存清理和空间检查操作更快完成。
    -   降低主线程阻塞，提升应用整体响应速度。
-   **测试建议**:
    -   **基准测试**: 优化前后，使用大目录进行 `listModels` 操作，记录耗时。分别测试有性能配置和无性能配置（触发默认值）的情况。
    -   **缓存测试**: 大缓存量下执行 `clearCache` 和 `checkAndCleanCache`，记录耗时。
    -   **压力测试**: 观察应用稳定性和资源消耗。
    -   **日志验证**: 确认并发控制按预期工作，默认值被正确使用。
    -   **功能回归**: 确保核心功能正常。

### 7. 总结

此方案通过引入可配置的异步并发池，并强调了默认值的使用，针对性地优化了数据源遍历和图片缓存管理中的性能瓶颈。

---