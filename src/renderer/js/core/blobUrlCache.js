import { getModelImage, logMessage } from '../apiBridge.js'; // 假设 apiBridge.js 提供 getModelImage 和 logMessage

const cache = new Map();
// pendingRequests 用于处理对同一资源并发请求的情况
const pendingRequests = new Map();

/**
 * 生成缓存键.
 * @param {string} sourceId
 * @param {string} imagePath
 * @returns {string}
 */
export function generateCacheKey(sourceId, imagePath) { // Export this function
    return `${sourceId}::${imagePath}`;
}

/**
 * 获取或创建指定图片的 Blob URL.
 * 如果缓存中已存在，则增加引用计数并返回缓存的 URL.
 * 否则，从 API 获取图片数据，创建 Blob 和 URL，存入缓存并返回.
 * @param {string} sourceId - 数据源 ID.
 * @param {string} imagePath - 图片在数据源中的路径.
 * @returns {Promise<string|null>} 返回 Blob URL，如果发生错误则返回 null.
 */
async function getOrCreateBlobUrl(sourceId, imagePath) {
    const cacheKey = generateCacheKey(sourceId, imagePath);
    const logPrefix = `[BlobUrlCache ${cacheKey}]`;

    if (pendingRequests.has(cacheKey)) {
        logMessage('debug', `${logPrefix} Request is pending, awaiting existing promise.`);
        return pendingRequests.get(cacheKey);
    }

    if (cache.has(cacheKey)) {
        const entry = cache.get(cacheKey);
        entry.refCount++;
        logMessage('debug', `${logPrefix} Cache HIT. New refCount: ${entry.refCount}. URL: ${entry.blobUrl}`);
        return entry.blobUrl;
    }

    logMessage('debug', `${logPrefix} Cache MISS. Fetching image data.`);

    const requestPromise = (async () => {
        try {
            const imageData = await getModelImage({ sourceId, imagePath });

            if (imageData && imageData.data) {
                logMessage('debug', `${logPrefix} Received image data from API. Size: ${imageData.data?.length} bytes, Type: ${imageData.mimeType}`);
                const blob = new Blob([new Uint8Array(imageData.data)], { type: imageData.mimeType || 'application/octet-stream' });
                const blobUrl = URL.createObjectURL(blob);

                cache.set(cacheKey, {
                    blob: blob,
                    blobUrl: blobUrl,
                    refCount: 1,
                    mimeType: imageData.mimeType || 'application/octet-stream'
                });
                logMessage('info', `${logPrefix} Created and cached. refCount: 1. URL: ${blobUrl}`);
                return blobUrl;
            } else {
                logMessage('warn', `${logPrefix} API did not return image data.`);
                return null;
            }
        } catch (error) {
            logMessage('error', `${logPrefix} Error fetching or creating blob:`, error);
            return null;
        } finally {
            pendingRequests.delete(cacheKey); // 清理 pending request
        }
    })();

    pendingRequests.set(cacheKey, requestPromise);
    return requestPromise;
}

/**
 * 释放对指定图片 Blob URL 的一次引用.
 * 如果引用计数降为 0，则撤销 Blob URL 并从缓存中移除.
 * @param {string} sourceId - 数据源 ID.
 * @param {string} imagePath - 图片在数据源中的路径.
 */
function releaseBlobUrl(sourceId, imagePath) {
    return;
    const cacheKey = generateCacheKey(sourceId, imagePath);
    const logPrefix = `[BlobUrlCache ${cacheKey}]`;

    if (cache.has(cacheKey)) {
        const entry = cache.get(cacheKey);
        entry.refCount--;
        logMessage('debug', `${logPrefix} Released. New refCount: ${entry.refCount}.`);

        if (entry.refCount === 0) {
            logMessage('info', `${logPrefix} refCount is 0. Revoking URL: ${entry.blobUrl} and removing from cache.`);
            URL.revokeObjectURL(entry.blobUrl);
            cache.delete(cacheKey);
        }
    } else {
        logMessage('warn', `${logPrefix} Attempted to release a non-cached or already fully released URL.`);
    }
}

/**
 * 根据缓存键释放对 Blob URL 的一次引用.
 * @param {string} cacheKey - 由 generateCacheKey 生成的缓存键.
 */
function releaseBlobUrlByKey(cacheKey) {
    const logPrefix = `[BlobUrlCache Key: ${cacheKey}]`;
    if (!cacheKey) {
        logMessage('warn', `${logPrefix} Attempted to release with an undefined or empty cacheKey.`);
        return;
    }

    if (cache.has(cacheKey)) {
        const entry = cache.get(cacheKey);
        entry.refCount--;
        logMessage('debug', `${logPrefix} Released by key. New refCount: ${entry.refCount}.`);

        if (entry.refCount === 0) {
            logMessage('info', `${logPrefix} refCount is 0. Revoking URL: ${entry.blobUrl} and removing from cache by key.`);
            URL.revokeObjectURL(entry.blobUrl);
            cache.delete(cacheKey);
        }
    } else {
        logMessage('warn', `${logPrefix} Attempted to release by key a non-cached or already fully released URL.`);
    }
}

/**
 * (可选) 清除所有缓存的 Blob URL.
 * 主要用于调试或特殊清理场景.
 */
function clearAllBlobUrls() {
    logMessage('info', '[BlobUrlCache] Clearing all cached Blob URLs.');
    for (const [key, entry] of cache) {
        logMessage('debug', `[BlobUrlCache ClearAll] Revoking ${entry.blobUrl} for key ${key}`);
        URL.revokeObjectURL(entry.blobUrl);
    }
    cache.clear();
    pendingRequests.clear(); // 也清除所有待处理的请求
    logMessage('info', '[BlobUrlCache] All Blob URLs cleared.');
}

export const BlobUrlCache = {
    getOrCreateBlobUrl,
    releaseBlobUrl,
    releaseBlobUrlByKey, // Export new method
    clearAllBlobUrls,
    // generateCacheKey is already exported as a named export
    // 辅助函数，用于测试或调试
    _getCacheEntryForTesting: (sourceId, imagePath) => cache.get(generateCacheKey(sourceId, imagePath)),
    _getCacheSizeForTesting: () => cache.size,
    _getPendingRequestsSizeForTesting: () => pendingRequests.size
};