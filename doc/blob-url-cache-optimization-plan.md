# Blob URL 缓存与生命周期管理优化方案

## 1. 引言与背景

为了优化应用中图片的加载性能、减少资源重复创建的开销，并更精细地管理内存，本项目计划引入 Blob URL 缓存机制。当前，图片的 Blob URL 在每次需要时可能被重复创建，并且其生命周期管理（特别是 `URL.revokeObjectURL()` 的调用时机）存在潜在的冲突和优化空间。

本方案旨在通过一个专门的缓存模块，实现对 Blob URL 的复用，并通过引用计数机制来合理管理其生命周期。

## 2. 核心思路：引入 `BlobUrlCache` 模块 (渲染进程)

在渲染进程中创建一个名为 `BlobUrlCache` 的模块，负责统一管理图片的 Blob 对象、对应的 Blob URL 及其生命周期。

## 3. `BlobUrlCache` 模块设计

该模块将包含以下核心组件和逻辑：

### 3.1. 缓存结构

*   **内部缓存**: 使用 JavaScript `Map` 对象存储缓存条目。
*   **缓存键 (Key)**: 图片的唯一标识符，例如 `sourceId` 和 `imagePath` 的组合字符串（如 `${sourceId}-${imagePath}`）。
*   **缓存值 (Value)**: 一个对象，包含：
    *   `blob: Blob`: 原始的 Blob 对象。
    *   `blobUrl: string`: 通过 `URL.createObjectURL(blob)` 生成的 URL。
    *   `refCount: number`: 当前引用此 `blobUrl` 的计数。

    ```javascript
    // 示例缓存条目结构
    // cacheEntry = {
    //   blob: Blob,
    //   blobUrl: string,
    //   refCount: number
    // };
    ```

### 3.2. `getOrCreateBlobUrl(sourceId, imagePath)` 方法

此方法用于获取指定图片的 Blob URL。

*   **输入**: `sourceId` (string), `imagePath` (string)。
*   **逻辑**:
    1.  根据 `sourceId` 和 `imagePath` 生成唯一的 `cacheKey`。
    2.  **检查缓存**:
        *   如果 `cacheKey` 存在于缓存中且对应的 `blobUrl` 有效：
            *   增加该条目的 `refCount`。
            *   返回缓存中的 `blobUrl`。
        *   如果 `cacheKey` 不存在或条目无效：
            1.  **数据获取**: 调用 `apiBridge.getModelImage(sourceId, imagePath)` 从主进程获取原始图片数据 (`imageData.data`) 和 `mimeType`。
            2.  **Blob 创建**: `new Blob([new Uint8Array(imageData.data)], { type: imageData.mimeType })`。
            3.  **Blob URL 创建**: `URL.createObjectURL(newlyCreatedBlob)`。
            4.  **存入缓存**: 将新创建的 `blob` 对象、`blobUrl` 和初始 `refCount` (设为 1) 存入缓存。
            5.  返回新创建的 `blobUrl`。
*   **并发处理**: 若多个请求同时请求同一个当前不在缓存中的图片，应确保只进行一次数据获取和 Blob 创建。后续请求应等待第一个请求完成并复用其结果。这可以通过在缓存中临时存储一个 Promise 来实现。
*   **错误处理**: 妥善处理 `apiBridge.getModelImage()` 可能发生的错误以及 Blob 创建阶段的错误，并向上层调用者传递或通知。

### 3.3. `releaseBlobUrl(sourceId, imagePath)` 或 `releaseBlobUrlByKey(cacheKey)` 方法

此方法用于通知缓存一个 `blobUrl` 的某个实例不再被需要。

*   **输入**: `sourceId` 和 `imagePath`，或直接传入 `cacheKey`。
*   **逻辑**:
    1.  生成或获取 `cacheKey`。
    2.  在缓存中查找对应的条目。
    3.  如果条目存在：
        *   将其 `refCount` 减 1。
        *   如果 `refCount` 降至 0：
            *   调用 `URL.revokeObjectURL(entry.blobUrl)` 来释放资源。
            *   从缓存中移除该条目。
    4.  如果条目不存在（可能由于错误的 key 或重复释放），记录一个警告。

### 3.4. (可选) `clearAll()` 方法

提供一个方法来清除所有缓存的 Blob URL 并撤销它们，可用于应用退出前或特定数据清理场景。

## 4. 对现有代码的修改

### 4.1. 新模块创建

*   创建文件：[`src/renderer/js/core/blobUrlCache.js`](src/renderer/js/core/blobUrlCache.js) (或类似路径)，用于实现 `BlobUrlCache` 类/对象。

### 4.2. 修改 [`src/renderer/js/utils/ui-utils.js`](src/renderer/js/utils/ui-utils.js)

*   **`loadImage(imgElement)` 函数**:
    *   导入并使用 `BlobUrlCache` 模块。
    *   从 `imgElement.dataset` (如 `data-source-id`, `data-image-path`) 获取图片标识。
    *   调用 `BlobUrlCache.getOrCreateBlobUrl(sourceId, imagePath)` 获取 `blobUrl`。
    *   将返回的 `blobUrl` 赋值给 `imgElement.src`。
    *   移除 `loadImage` 函数内部原有的 `URL.revokeObjectURL()` 调用逻辑。
    *   `imgElement.onload` 和 `imgElement.onerror` 可以保留用于日志记录或UI反馈，但不再负责 URL 的撤销。
    *   考虑在 `imgElement` 上存储 `cacheKey` (例如 `imgElement.dataset.cacheKey = cacheKey;`)，以便图片消费者组件在需要时可以方便地获取并调用 `releaseBlobUrlByKey`。

### 4.3. 修改图片消费者组件

所有使用图片（特别是通过 `loadImage` 或直接操作 `<img>` 标签 `src` 为 Blob URL）的组件都需要调整。

*   **例如 [`src/renderer/js/components/detail-model.js`](src/renderer/js/components/detail-model.js)**:
    *   在 `showDetailModel` 调用 `loadImage` 后，确保能获取到图片的 `cacheKey` (或 `sourceId` 和 `imagePath`)。
    *   在 `hideDetailModel` 方法中，当 `detailImage` 被清理或弹窗关闭导致图片不再显示时，必须调用 `BlobUrlCache.releaseBlobUrlByKey(key)` 或 `BlobUrlCache.releaseBlobUrl(sourceId, imagePath)`。
*   **其他组件 (如卡片视图、列表视图中的图片)**:
    *   识别图片何时不再被需要（例如，卡片从视图中移除、组件销毁、图片源被替换）。
    *   在这些确切的时机调用 `BlobUrlCache` 的释放方法。
    *   对于使用 `IntersectionObserver` 懒加载的图片，当元素被 `unobserve` 或从 DOM 中移除时，也需要确保对应的 Blob URL 被释放。

## 5. 方案图示 (Mermaid Sequence Diagram)

```mermaid
sequenceDiagram
    participant Component as UI Component (e.g., detail-model)
    participant UIUtils as ui-utils.js (loadImage)
    participant BlobCache as BlobUrlCache
    participant APIBridge as apiBridge.js
    participant ImageService as ImageService (Main Process)

    Component->>+UIUtils: loadImage(imgElement)
    UIUtils->>+BlobCache: getOrCreateBlobUrl(sourceId, imagePath)
    alt Cache Hit (blobUrl exists for key & refCount > 0)
        BlobCache-->>BlobCache: refCount++
        BlobCache-->>-UIUtils: blobUrl (from cache)
    else Cache Miss (or refCount was 0, or key not found)
        BlobCache->>+APIBridge: getModelImage(sourceId, imagePath)
        APIBridge->>+ImageService: getImage(sourceId, imagePath)
        ImageService-->>-APIBridge: {data: Buffer, mimeType}
        APIBridge-->>-BlobCache: {imageData, mimeType}
        BlobCache->>BlobCache: Create new Blob & new Blob URL
        BlobCache->>BlobCache: Store in cache {blob, blobUrl, refCount=1}
        BlobCache-->>-UIUtils: newBlobUrl
    end
    UIUtils->>UIUtils: imgElement.src = blobUrl # Set image source
    UIUtils-->>-Component: (loadImage may set img src and return cacheKey)

    Note over Component, BlobCache: Later, when image is no longer needed by this specific instance
    Component->>+BlobCache: releaseBlobUrl(sourceId, imagePath) # or releaseBlobUrlByKey(cacheKey)
    BlobCache->>BlobCache: Find cache entry by key
    alt Entry found
        BlobCache->>BlobCache: refCount--
        if refCount === 0
            BlobCache->>BlobCache: URL.revokeObjectURL(blobUrl)
            BlobCache->>BlobCache: Remove entry from cache
        end
    end
    BlobCache-->>-Component: (release completes)
```

## 6. 优点

*   **资源复用**: 对同一张图片，`Blob` 对象和 `Blob URL` 只会创建一次（在其生命周期内），后续请求直接复用。
*   **潜在性能提升**: 减少了重复的 `Blob` 创建和 `URL.createObjectURL` 调用开销。如果 `Blob` 数据已在内存中，图片显示可能更快。
*   **精细的生命周期管理**: 通过引用计数，可以确保 `Blob URL` 在确实没有任何地方使用它时才被撤销，解决了之前 `revokeObjectURL` 时机不统一的问题，有效避免内存泄漏。

## 7. 潜在挑战与风险点

*   **引用计数管理的准确性**: 这是方案成功的核心。必须确保所有使用 `Blob URL` 的地方，在其不再需要该 URL 时，都能正确、无遗漏地调用 `releaseBlobUrl`。错误的计数将导致内存泄漏（`refCount` 未降至0）或错误（`refCount` 过早降至0后仍尝试使用已撤销的URL）。
*   **组件间协调与所有权**: 需要清晰定义哪个组件或逻辑“拥有”对 Blob URL 的一次引用，并在其生命周期结束时负责释放。
*   **异步与并发**: `getOrCreateBlobUrl` 中涉及异步数据获取，需要妥善处理并发请求，避免对同一资源重复执行获取和创建操作。
*   **调试复杂性**: 如果出现 Blob URL 相关的问题，追踪引用计数的变更路径可能会比较复杂。