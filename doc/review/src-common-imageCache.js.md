# 代码审查报告: src/common/imageCache.js

## 1. 文件概述

[`src/common/imageCache.js`](src/common/imageCache.js:1) 模块提供了一个图片缓存和压缩的解决方案，旨在统一管理本地和 WebDAV 图片资源。它支持自动压缩、基于大小限制的缓存清理（声称 LRU，实际更接近基于修改时间的清理），以及可配置的参数。

## 2. 主要功能

*   **图片压缩与缓存**: 首次加载图片时，可选择性地使用 `sharp` 库进行压缩（支持 JPEG, PNG, WebP 格式转换和调整大小），然后将处理后或原始的图片存入文件系统缓存。
*   **缓存读取**: 从文件系统缓存中读取图片。
*   **缓存管理**:
    *   **配置**: 允许设置缓存目录、最大缓存大小、压缩质量等。
    *   **清理**:
        *   支持手动清理整个缓存目录。
        *   当缓存大小超过设定阈值时，根据文件的修改时间（旧文件优先）自动清理，直到缓存大小降至目标水平（默认为最大值的90%）。
*   **统计**: 记录缓存命中率、总请求数、原始与压缩大小等统计信息。

## 3. 暴露的接口

*   `setConfig(options = {})`: void - 设置模块配置。
    *   `options`: (Object) 配置对象，如 `{ cacheDir: string, maxCacheSizeMB: number, compressQuality: number }`。
*   `getCache(libraryId: string, imageName: string)`: `Promise<{data: Buffer, mimeType: string | null}> | null` - 从缓存获取图片。
*   `setCache(libraryId: string, imageName: string, sourceBuffer: Buffer, preferredFormat: string = 'Original', originalMimeType: string | null = null)`: `Promise<void>` - 处理并缓存图片。
*   `clearCache()`: `Promise<void>` - 清空所有缓存。
*   `checkAndCleanCache()`: `Promise<void>` - 检查缓存大小并按需清理。
*   `getStats()`: `Object` - 获取缓存统计数据。
*   `getCurrentCacheSizeBytes()`: `Promise<number>` - 获取当前缓存目录的总字节大小。
*   `config`: `Object` - 当前的配置对象（直接导出）。

## 4. 代码分析与潜在问题

### 4.1 缓存策略

*   **LRU 实现不准确**: 清理逻辑 ([`checkAndCleanCache`](src/common/imageCache.js:363)) 基于文件的修改时间 (`mtime`) ([`src/common/imageCache.js:413`](src/common/imageCache.js:413)) 进行排序和删除，这更接近 FIFO 或某种形式的 LFU，而非严格的 LRU。虽然 [`getCache`](src/common/imageCache.js:117) 中尝试用 `fs.promises.utimes` 更新访问时间 (`atime`) ([`src/common/imageCache.js:154`](src/common/imageCache.js:154))，但清理时并未使用 `atime`。
*   **清理阈值**: 清理目标为最大缓存的 90% ([`src/common/imageCache.js:419`](src/common/imageCache.js:419))，这可能导致在缓存接近上限时频繁触发清理。

### 4.2 错误处理

*   **Sharp 转换失败**: 在 [`setCache`](src/common/imageCache.js:182) 中，若 `sharp` 处理失败，会回退保存原始文件 ([`src/common/imageCache.js:253-258`](src/common/imageCache.js:253-258))。虽然最终会抛出错误 ([`src/common/imageCache.js:327`](src/common/imageCache.js:327))，但调用者可能无法直接区分是转换失败还是文件写入失败。
*   **日志不统一**: [`checkAndCleanCache`](src/common/imageCache.js:363) 中部分错误使用 `console.error/warn` ([`src/common/imageCache.js:370`](src/common/imageCache.js:370), [`src/common/imageCache.js:392`](src/common/imageCache.js:392), [`src/common/imageCache.js:398`](src/common/imageCache.js:398))，而其他地方使用 `electron-log`。
*   **不完整文件删除**: [`setCache`](src/common/imageCache.js:305) 的 `catch` 块中，若 `finalCachePath` 未定义，则无法删除可能写入一半的文件 ([`src/common/imageCache.js:311`](src/common/imageCache.js:311))。

### 4.3 健壮性与性能

*   **大量文件性能**:
    *   [`getCache`](src/common/imageCache.js:117) 通过 `readdir` 后 `filter` 查找文件 ([`src/common/imageCache.js:128-129`](src/common/imageCache.js:128-129))，在缓存文件非常多时可能较慢。
    *   未实现哈希子目录结构（注释中提及 [`src/common/imageCache.js:76-79`](src/common/imageCache.js:76-79)），大量文件在单目录下可能影响文件系统性能。
    *   [`checkAndCleanCache`](src/common/imageCache.js:363) 和 [`getCurrentCacheSizeBytes`](src/common/imageCache.js:477) 读取所有文件元数据，文件量大时内存和时间开销增加。
*   **MIME 类型处理**:
    *   MIME 与扩展名映射表 ([`mimeToExt`](src/common/imageCache.js:22), [`extToMime`](src/common/imageCache.js:32)) 硬编码，可能不全。
    *   若 `originalMimeType` 未提供且格式为 `'Original'`，[`setCache`](src/common/imageCache.js:182) 会使用默认扩展名 `.bin` ([`src/common/imageCache.js:268`](src/common/imageCache.js:268))，可能丢失原始类型信息。
*   **PNG 压缩质量**: `sharp().png({ quality: config.compressQuality })` ([`src/common/imageCache.js:225`](src/common/imageCache.js:225)) 中的 `quality` 对 PNG 的作用与 JPEG 不同，主要影响压缩级别而非视觉质量，可能需要调整。
*   **全局配置**: [`setConfig`](src/common/imageCache.js:60) 为全局单例配置，不支持多实例缓存。

### 4.4 潜在风险

*   **内存溢出**:
    *   `sharp` 处理超大图片时有内存消耗风险。
    *   缓存文件数量极大时，[`checkAndCleanCache`](src/common/imageCache.js:363) 中 `files` 数组可能占用较多内存。
*   **并发问题**:
    *   并发 `setCache` 对同一键可能导致竞争。
    *   `checkAndCleanCache` 与其他缓存读写操作并发可能导致状态不一致或操作到刚被删除/修改的文件。[`setCache`](src/common/imageCache.js:272-280) 中删除旧扩展名文件和写入新文件的操作非原子。
*   **缓存穿透**: 对不存在的资源重复请求仍会走到文件系统层面查询。

## 5. 优化建议

*   **缓存策略**:
    *   **真 LRU**: 若需严格 LRU，清理时应基于 `atime` 排序。确认 `utimes` 在目标平台上的行为。
    *   **清理水位**: 考虑引入高低水位线进行更精细的清理控制。
*   **性能**:
    *   **`getCache` 优化**: 尝试直接按常见扩展名顺序构造完整路径读取，而非 `readdir`。
    *   **哈希子目录**: 对大量文件，实现哈希子目录以分散存储。
    *   **增量统计大小**: 避免在 `getCurrentCacheSizeBytes` 或 `checkAndCleanCache` 中完整遍历，考虑增量维护缓存总大小。
*   **错误处理与健壮性**:
    *   **统一日志**: 全部改用 `electron-log`。
    *   **明确转换失败**: `setCache` 中 `sharp` 失败时应更明确地通知调用者。
    *   **并发控制**: 为写操作 (`setCache`) 和清理操作 (`checkAndCleanCache`) 引入锁机制（如 `async-mutex`）来保证原子性和避免竞争。
    *   **默认扩展名**: 改进 `originalMimeType` 未提供时的扩展名处理，可尝试从 buffer 推断。
*   **配置与API**:
    *   **多实例**: 若有需求，重构为 Class 以支持多缓存实例。
    *   **Sharp 参数**: 允许为不同输出格式配置不同的 `sharp` 参数（如 `quality`）。将固定尺寸 `1024x1024` ([`src/common/imageCache.js:209`](src/common/imageCache.js:209)) 改为可配置。
*   **统计准确性**:
    *   检查 [`getStats`](src/common/imageCache.js:462) 中 `spaceSaved` ([`src/common/imageCache.js:465`](src/common/imageCache.js:465)) 的计算，确保在 `stats.compressedSize` 为 0 时行为符合预期（当前是返回 '0%'，是合理的）。

## 6. 总结

[`src/common/imageCache.js`](src/common/imageCache.js:1) 提供了一套功能相对完善的图片缓存机制。主要优点是集成了图片压缩和自动清理。主要待改进之处在于 LRU 策略的准确性、高并发下的健壮性、大量文件时的性能以及更灵活的配置选项。通过上述建议的优化，可以使其更加高效和可靠。