import { getModelImage, logMessage } from '../apiBridge.js'; // 假设 apiBridge.js 提供 getModelImage 和 logMessage

const cache = new Map(); // Stores { blob, blobUrl, refCount, mimeType, revocationTimerId }
// pendingRequests 用于处理对同一资源并发请求的情况
const pendingRequests = new Map();
const REVOCATION_DELAY_MS = 60000; // block缓存丢弃时间。

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
        // If a revocation timer is pending for this entry, cancel it
        if (entry.revocationTimerId) {
            clearTimeout(entry.revocationTimerId);
            entry.revocationTimerId = null;
            logMessage('debug', `${logPrefix} Cancelled pending revocation timer.`);
        }
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
                    mimeType: imageData.mimeType || 'application/octet-stream',
                    revocationTimerId: null // Initialize revocation timer ID
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
    const cacheKey = generateCacheKey(sourceId, imagePath);
    _performRelease(cacheKey);
}

/**
 * 根据缓存键释放对 Blob URL 的一次引用.
 * @param {string} cacheKey - 由 generateCacheKey 生成的缓存键.
 */
function releaseBlobUrlByKey(cacheKey) {
    _performRelease(cacheKey);
}

/**
 * 内部函数，处理实际的释放和延迟撤销逻辑.
 * @param {string} cacheKey
 */
function _performRelease(cacheKey) {
    const logPrefix = `[BlobUrlCache Release for ${cacheKey}]`;

    if (!cacheKey) {
        logMessage('warn', `${logPrefix} Attempted to release with an undefined or empty cacheKey.`);
        return;
    }

    if (cache.has(cacheKey)) {
        const entry = cache.get(cacheKey);
        if (entry.refCount > 0) { // Only decrement if refCount is positive
            entry.refCount--;
        }
        logMessage('debug', `${logPrefix} Decremented refCount. New refCount: ${entry.refCount}.`);

        if (entry.refCount === 0) {
            // Clear any existing timer for this key before starting a new one
            if (entry.revocationTimerId) {
                clearTimeout(entry.revocationTimerId);
                logMessage('debug', `${logPrefix} Cleared existing revocation timer.`);
            }

            logMessage('info', `${logPrefix} refCount is 0. Scheduling revocation for URL: ${entry.blobUrl} in ${REVOCATION_DELAY_MS}ms.`);
            entry.revocationTimerId = setTimeout(() => {
                // Re-fetch entry from cache in case it was modified (e.g., re-referenced)
                const currentEntry = cache.get(cacheKey);
                if (currentEntry && currentEntry.refCount === 0) {
                    logMessage('info', `${logPrefix} Revocation timer expired. refCount still 0. Revoking URL: ${currentEntry.blobUrl} and removing from cache.`);
                    URL.revokeObjectURL(currentEntry.blobUrl);
                    cache.delete(cacheKey);
                } else if (currentEntry) {
                    logMessage('debug', `${logPrefix} Revocation timer expired, but refCount is now ${currentEntry.refCount}. URL will not be revoked.`);
                    currentEntry.revocationTimerId = null; // Clear the timerId as it's no longer pending
                } else {
                    logMessage('debug', `${logPrefix} Revocation timer expired, but entry no longer in cache (possibly cleared by clearAll).`);
                }
            }, REVOCATION_DELAY_MS);
        }
    } else {
        logMessage('warn', `${logPrefix} Attempted to release a non-cached or already fully released URL.`);
    }
}


/**
 * (可选) 清除所有缓存的 Blob URL.
 * 主要用于调试或特殊清理场景.
 */
function clearAllBlobUrls() {
    logMessage('info', '[BlobUrlCache] Clearing all cached Blob URLs.');
    for (const [key, entry] of cache) {
        if (entry.revocationTimerId) {
            clearTimeout(entry.revocationTimerId); // Clear any pending revocation timers
        }
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