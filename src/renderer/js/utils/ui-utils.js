import { getModelImage, logMessage } from '../apiBridge.js'; // 导入 API 桥接
import { BlobUrlCache, generateCacheKey } from '../core/blobUrlCache.js';

// ===== UI Feedback Helper =====
let feedbackTimeout = null;

/**
 * Shows a feedback message in a specified element.
 * @param {HTMLElement} feedbackElement - The element to display the feedback in.
 * @param {string} message - The message to display.
 * @param {'info' | 'success' | 'error'} [type='info'] - The type of feedback (affects styling).
 * @param {number} [duration=4000] - How long to show the message (in ms). 0 for indefinite.
 */
export function showFeedback(feedbackElement, message, type = 'info', duration = 4000) {
    if (!feedbackElement) return;

    // Clear previous timeout if any
    if (feedbackTimeout) {
        clearTimeout(feedbackTimeout);
    }

    feedbackElement.textContent = message;
    feedbackElement.className = `Model-feedback feedback-${type}`; // Set class based on type

    // Auto-hide after duration (if duration is positive)
    if (duration > 0) {
        feedbackTimeout = setTimeout(() => {
            // Check if the element is still part of the document before modifying it
            if (feedbackElement && document.body.contains(feedbackElement)) {
                feedbackElement.textContent = '';
                feedbackElement.className = 'Model-feedback'; // Reset class
            }
            feedbackTimeout = null;
        }, duration);
    }
}

/**
 * Clears any active feedback message shown by showFeedback.
 * @param {HTMLElement} feedbackElement - The feedback element to clear.
 */
export function clearFeedback(feedbackElement) {
     if (!feedbackElement) return;
     if (feedbackTimeout) {
        clearTimeout(feedbackTimeout);
        feedbackTimeout = null;
     }
     feedbackElement.textContent = '';
     feedbackElement.className = 'Model-feedback';
}


// ===== DOM Manipulation =====

/**
 * Removes all child nodes from an element.
 * @param {HTMLElement} element - The element to clear.
 */
export function clearChildren(element) {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

/**
 * Sets the loading overlay visibility.
 * @param {boolean} isLoading - Whether to show the loading overlay.
 */
export function setLoading(isLoading) {
  const loadingDiv = document.getElementById('loading');
  const mainSection = document.getElementById('mainSection'); // Assuming mainSection exists
  if (!loadingDiv || !mainSection) {
      logMessage('warn', 'Loading div or main section not found for setLoading');
      return;
  }
  if (isLoading) {
    loadingDiv.style.display = 'flex';
    mainSection.style.opacity = '0.5';
  } else {
    loadingDiv.style.display = 'none';
    mainSection.style.opacity = '1';
  }
}


// ===== Image Loading =====

/**
 * Loads an image using the API and sets the src of the img element.
 * Handles potential errors during image fetching or blob creation.
 * @param {HTMLImageElement} imgElement - The image element to load the source for.
 *                                        Requires `data-source-id` and `data-image-path`.
 */
export async function loadImage(imgElement) {
  // 入口处的 isLoadingCancelled 检查
  if (imgElement.dataset.isLoadingCancelled === 'true') {
    // logMessage('debug', `[loadImage] Initial load cancelled for ${imgElement.dataset.imagePath || 'unknown image'}`);
    return;
  }

  const sourceId = imgElement.dataset.sourceId;
  const imagePath = imgElement.dataset.imagePath;

  if (!sourceId || !imagePath) {
    logMessage('error', `[ImageLoader] 加载失败 - <img> 元素缺少 data-source-id 或 data-image-path 属性`, imgElement);
    imgElement.alt = 'Error: Missing data attributes';
    imgElement.src = ''; // Clear src to prevent broken image icon
    if (imgElement.dataset.blobCacheKey) {
        delete imgElement.dataset.blobCacheKey;
    }
    return;
  }

  
  if (imgElement.dataset.blobCacheKey) {
    // logMessage('debug', `[loadImage] Clearing old blobCacheKey: ${imgElement.dataset.blobCacheKey} for ${imagePath}`);
    delete imgElement.dataset.blobCacheKey;
  }

  const currentCacheKey = generateCacheKey(sourceId, imagePath);
  const logPrefix = `[loadImage ${currentCacheKey}]`;

  // logMessage('debug', `${logPrefix} 开始加载图片 (using BlobUrlCache)`);

  try {
    const blobUrl = await BlobUrlCache.getOrCreateBlobUrl(sourceId, imagePath);

    // 获取 blobUrl 后，再次检查 isLoadingCancelled
    if (imgElement.dataset.isLoadingCancelled === 'true') {
      if (blobUrl) {
        // logMessage('debug', `${logPrefix} Load cancelled after fetch, before src set. Releasing blob URL.`);
        BlobUrlCache.releaseBlobUrlByKey(currentCacheKey); // 我们创建了这个 blobUrl，所以我们负责释放
      }
      return;
    }

    if (blobUrl) {
      // logMessage('info', `${logPrefix} 从 BlobUrlCache 获取到 URL.`);
      imgElement.dataset.blobCacheKey = currentCacheKey; // 存储 cacheKey
      imgElement.src = blobUrl;

      imgElement.onload = () => {
        // logMessage('info', `${logPrefix} 图片从 Blob URL 加载成功.`);
        imgElement.alt = ''; // 清除可能存在的错误提示
      };
      imgElement.onerror = () => {
        // logMessage('error', `${logPrefix} 从 Blob URL 加载图片失败.`);
        imgElement.alt = 'Error loading image from blob';
        // 清除与此失败加载相关的 key
        if (imgElement.dataset.blobCacheKey === currentCacheKey) {
            delete imgElement.dataset.blobCacheKey;
        }
        // 注意：BlobUrlCache 内部可能已经处理了错误，但如果 onerror 触发，
        // 意味着这个特定的 src (blobUrl) 无法被 img 元素加载。
        // 可以考虑是否需要主动调用 BlobUrlCache.releaseBlobUrlByKey(currentCacheKey)
      };
    } else {
      // logMessage('warn', `${logPrefix} BlobUrlCache未能提供 Blob URL (可能获取数据失败).`);
      imgElement.alt = 'Image not available';
      delete imgElement.dataset.blobCacheKey; // 确保清除 key
      if (imgElement.dataset.isLoadingCancelled === 'true') return; // 再次检查，以防异步操作间隙状态改变
      if (imgElement.onerror) imgElement.onerror(); else imgElement.style.display = 'none';
    }
  } catch (error) {
    // logMessage('error', `${logPrefix} 调用 BlobUrlCache.getOrCreateBlobUrl 时出错:`, error);
    imgElement.alt = 'Error loading image data';
    delete imgElement.dataset.blobCacheKey; // 确保清除 key
    if (imgElement.dataset.isLoadingCancelled === 'true') return; // 再次检查
    if (imgElement.onerror) imgElement.onerror(); else imgElement.style.display = 'none';
  }
}

/**
 * @typedef {object} ImageLoadHandle
 * @property {string | null} blobUrl - The Blob URL for the image, or null if loading failed or was cancelled.
 * @property {string | null} cacheKey - The cache key used for this image.
 * @property {() => void} release - A function to release the Blob URL from the cache. Call this when the image is no longer needed.
 * @property {any} [error] - An error object or message if loading failed or was cancelled.
 */

/**
 * Loads an image and returns a handle for managing its Blob URL.
 * This function does NOT directly manipulate the imgElement's src or event handlers.
 * The caller is responsible for setting the src from blobUrl and managing the lifecycle via the release method.
 *
 * @param {HTMLImageElement} imgElement - The image element, used to check `dataset.isLoadingCancelled`.
 *                                        It's NOT directly modified by this function for src or events.
 * @param {string} imagePath - The path of the image to load.
 * @param {string} sourceId - The ID of the image source.
 * @returns {Promise<ImageLoadHandle>} A promise that resolves to an ImageLoadHandle.
 */
export async function loadImageWithHandle(imgElement, imagePath, sourceId) {
  const cacheKey = generateCacheKey(sourceId, imagePath);
  const logPrefix = `[loadImageWithHandle ${cacheKey}]`;

  // Check for cancellation at the very beginning
  if (imgElement.dataset.isLoadingCancelled === 'true') {
    // logMessage('debug', `${logPrefix} Load cancelled at entry for ${imagePath}`);
    return { blobUrl: null, cacheKey, release: () => {}, error: 'cancelled_at_entry' };
  }

  // logMessage('debug', `${logPrefix} Attempting to load image ${imagePath} from source ${sourceId}`);

  try {
    const blobUrl = await BlobUrlCache.getOrCreateBlobUrl(sourceId, imagePath);

    // Check for cancellation again after the blob URL has been fetched (or attempted)
    if (imgElement.dataset.isLoadingCancelled === 'true') {
      if (blobUrl) {
        // logMessage('debug', `${logPrefix} Load cancelled after fetch for ${imagePath}. Releasing fetched blob URL.`);
        BlobUrlCache.releaseBlobUrlByKey(cacheKey); // Release the just-acquired blob
      } else {
        // logMessage('debug', `${logPrefix} Load cancelled after failed fetch for ${imagePath}.`);
      }
      return { blobUrl: null, cacheKey, release: () => {}, error: 'cancelled_after_fetch' };
    }

    if (blobUrl) {
      // logMessage('info', `${logPrefix} Successfully obtained blob URL for ${imagePath}`);
      return {
        blobUrl,
        cacheKey,
        release: () => {
          // logMessage('debug', `${logPrefix} Releasing blob URL for ${imagePath} via handle.`);
          BlobUrlCache.releaseBlobUrlByKey(cacheKey);
        },
      };
    } else {
      // logMessage('warn', `${logPrefix} Failed to obtain blob URL for ${imagePath} (BlobUrlCache returned null).`);
      return { blobUrl: null, cacheKey, release: () => {}, error: 'fetch_failed_cache_returned_null' };
    }
  } catch (error) {
    // logMessage('error', `${logPrefix} Error during loadImageWithHandle for ${imagePath}:`, error);
    // Check for cancellation one last time in case it happened during the error handling itself
    // or if the error itself is due to a cancellation that wasn't caught earlier.
    if (imgElement.dataset.isLoadingCancelled === 'true') {
        // logMessage('debug', `${logPrefix} Load cancelled during error handling for ${imagePath}.`);
        // If a blobUrl was somehow created before the error and cancellation, it should have been handled by BlobUrlCache.
        // No explicit release here unless we are sure a blob was created AND not yet released.
        // Given the flow, if an error occurs in getOrCreateBlobUrl, blobUrl would be null or undefined.
        return { blobUrl: null, cacheKey, release: () => {}, error: 'cancelled_during_error_handling' };
    }
    return { blobUrl: null, cacheKey, release: () => {}, error: error || 'fetch_failed_exception' };
  }
}

// Intersection Observer for lazy loading images
export const imageObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const img = entry.target;
      loadImage(img); // Use the exported loadImage function
      imageObserver.unobserve(img); // Stop observing once loading starts
    }
  });
}, { threshold: 0.1 }); // Adjust threshold as needed


/**
 * Attempts to load images that are currently visible in the viewport but haven't been loaded yet.
 * Useful for initial load or after dynamic content changes.
 */
export function loadVisibleImages() {
    // Select images that are potentially lazy-loadable and don't have a src yet
    const images = document.querySelectorAll('img[data-image-path]:not([src])');
    images.forEach(img => {
      const rect = img.getBoundingClientRect();
      // Check if the image is at least partially within the viewport
      if (
        rect.top < window.innerHeight &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.right > 0
      ) {
        // Optionally, you could directly call loadImage(img) here
        // or ensure the observer picks it up if it wasn't already observed.
        // Using the observer is generally preferred.
        imageObserver.observe(img);
      }
    });
}
// ===== Confirmation Dialog =====

/**
 * Displays a non-blocking confirmation dialog.
 * Requires i18n 't' function to be available (globally or imported).
 * @param {string} message - The message to display in the dialog.
 * @param {function} onConfirm - Callback function to execute if the user confirms.
 * @param {function} [onCancel] - Optional callback function to execute if the user cancels.
 */
export function showConfirmationDialog(message, onConfirm, onCancel) {
    // Ensure i18n function 't' is available or provide fallbacks
    let translate;
    if (typeof t === 'function') {
        translate = t;
    } else if (window.t === 'function') {
        translate = window.t;
    }
    else {
        translate = (key, fallback) => fallback || key; // Simple fallback
        console.warn('[UI Utils] i18n function "t" not found, using fallback for confirmation dialog.');
        // Attempt to import dynamically if needed, though less reliable
        // import('../core/i18n.js').then(i18n => translate = i18n.t).catch(() => {});
    }


    // Remove existing dialog if any
    const existingDialog = document.getElementById('confirmation-dialog-overlay');
    if (existingDialog) {
        existingDialog.remove();
    }

    // Create dialog elements
    const dialogOverlay = document.createElement('div');
    dialogOverlay.id = 'confirmation-dialog-overlay';
    // Use existing backdrop style if available, otherwise provide basic fallback
    dialogOverlay.style.position = 'fixed';
    dialogOverlay.style.top = '0';
    dialogOverlay.style.left = '0';
    dialogOverlay.style.width = '100%';
    dialogOverlay.style.height = '100%';
    dialogOverlay.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
    dialogOverlay.style.display = 'flex';
    dialogOverlay.style.justifyContent = 'center';
    dialogOverlay.style.alignItems = 'center';
    dialogOverlay.style.zIndex = '1050'; // Ensure it's above most content
    dialogOverlay.style.opacity = '0';
    dialogOverlay.style.transition = 'opacity 0.3s ease';


    const dialogBox = document.createElement('div');
    dialogBox.id = 'confirmation-dialog';
    // Use existing Model content style if available, otherwise provide basic fallback
    dialogBox.style.padding = '25px';
    dialogBox.style.backgroundColor = 'var(--background-color-secondary, #fff)'; // Use theme variable or fallback
    dialogBox.style.borderRadius = '8px';
    dialogBox.style.boxShadow = '0 5px 15px rgba(0,0,0,0.2)';
    dialogBox.style.textAlign = 'center';
    dialogBox.style.maxWidth = '400px';
    dialogBox.style.color = 'var(--text-color-primary, #333)'; // Use theme variable or fallback


    const messageElement = document.createElement('p');
    messageElement.textContent = message;
    messageElement.style.marginBottom = '20px';
    messageElement.style.fontSize = '1rem'; // Adjust as needed


    const buttonGroup = document.createElement('div');
    buttonGroup.style.display = 'flex';
    buttonGroup.style.justifyContent = 'center';
    buttonGroup.style.gap = '15px';


    const confirmButton = document.createElement('button');
    confirmButton.textContent = translate('dialog.confirm', 'Confirm');
    // Basic button styling, ideally use project's button classes
    confirmButton.style.padding = '8px 16px';
    confirmButton.style.border = 'none';
    confirmButton.style.borderRadius = '4px';
    confirmButton.style.cursor = 'pointer';
    confirmButton.style.backgroundColor = 'var(--color-danger, #dc3545)'; // Use theme variable or fallback
    confirmButton.style.color = '#fff';
    confirmButton.className = 'btn btn-danger'; // Add project's class if available


    const cancelButton = document.createElement('button');
    cancelButton.textContent = translate('dialog.cancel', 'Cancel');
     // Basic button styling, ideally use project's button classes
    cancelButton.style.padding = '8px 16px';
    cancelButton.style.border = 'none';
    cancelButton.style.borderRadius = '4px';
    cancelButton.style.cursor = 'pointer';
    cancelButton.style.backgroundColor = 'var(--color-secondary, #6c757d)'; // Use theme variable or fallback
    cancelButton.style.color = '#fff';
    cancelButton.className = 'btn btn-secondary'; // Add project's class if available


    // Append elements
    buttonGroup.appendChild(cancelButton); // Cancel first visually often
    buttonGroup.appendChild(confirmButton);
    dialogBox.appendChild(messageElement);
    dialogBox.appendChild(buttonGroup);
    dialogOverlay.appendChild(dialogBox);
    document.body.appendChild(dialogOverlay);

    // Add event listeners
    const closeDialog = () => {
         dialogOverlay.style.opacity = '0';
         setTimeout(() => {
            if (dialogOverlay.parentNode) {
                 dialogOverlay.remove();
            }
         }, 300); // Match transition duration
    };

    confirmButton.addEventListener('click', () => {
        closeDialog();
        if (typeof onConfirm === 'function') {
            onConfirm();
        }
    });

    cancelButton.addEventListener('click', () => {
        closeDialog();
        if (typeof onCancel === 'function') {
            onCancel();
        }
    });

     // Also close if clicking the overlay itself
     dialogOverlay.addEventListener('click', (event) => {
        if (event.target === dialogOverlay) {
            closeDialog();
             if (typeof onCancel === 'function') {
                onCancel(); // Treat overlay click as cancel
            }
        }
    });


    // Make overlay active (fade in)
    requestAnimationFrame(() => {
        dialogOverlay.style.opacity = '1';
    });
}

// ===== Missing functions needed by main-view.js =====

/**
 * Formats a file size in bytes to a human-readable string with appropriate units.
 * @param {number} bytes - The file size in bytes
 * @param {number} [decimals=2] - Number of decimal places to show
 * @returns {string} Formatted file size with units (KB, MB, GB, etc.)
 */
export function formatFileSize(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

/**
 * Checks if an image source is invalid (empty, undefined, etc.)
 * @param {string} src - The image source URL to check
 * @returns {boolean} True if the source is invalid, false otherwise
 */
export function isInvalidImageSrc(src) {
    return !src || src === 'undefined' || src === 'null' || src === '';
}

/**
 * Shows a toast notification message that automatically disappears after a duration.
 * @param {string} message - The message to display in the toast
 * @param {'info'|'success'|'error'|'warning'} [type='info'] - The type of toast message
 * @param {number} [duration=3000] - How long to show the toast (in ms)
 */
export function showToast(message, type = 'info', duration = 3000) {
    // Check if toast container exists, create if not
    let toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        toastContainer.style.position = 'fixed';
        toastContainer.style.bottom = '20px';
        toastContainer.style.right = '20px';
        toastContainer.style.zIndex = '1000';
        document.body.appendChild(toastContainer);
    }
    
    // Create toast element
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toast.style.backgroundColor = type === 'error' ? '#f44336' : 
                                 type === 'success' ? '#4caf50' : 
                                 type === 'warning' ? '#ff9800' : '#2196f3';
    toast.style.color = '#fff';
    toast.style.padding = '12px 16px';
    toast.style.margin = '8px 0';
    toast.style.borderRadius = '4px';
    toast.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    
    // Add to container
    toastContainer.appendChild(toast);
    
    // Animate in
    setTimeout(() => {
        toast.style.opacity = '1';
    }, 10);
    
    // Automatically remove after duration
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
            
            // Remove container if empty
            if (toastContainer.childNodes.length === 0) {
                document.body.removeChild(toastContainer);
            }
        }, 300); // Match transition duration
    }, duration);
}

/**
 * Returns a default thumbnail image path for models without images
 * @param {string} [modelType='unknown'] - The type of model
 * @returns {string} Path to the default thumbnail image
 */
export function getDefaultThumbnail(modelType = 'unknown') {
    // Define default thumbnails based on model type
    const defaults = {
        'checkpoint': '../../../assets/images/defaults/checkpoint.png',
        'lora': '../../../assets/images/defaults/lora.png',
        'vae': '../../../assets/images/defaults/vae.png',
        'embedding': '../../../assets/images/defaults/embedding.png',
        'controlnet': '../../../assets/images/defaults/controlnet.png',
        'upscaler': '../../../assets/images/defaults/upscaler.png',
        'unknown': '../../../assets/images/defaults/unknown.png'
    };
    
    // Return the appropriate default thumbnail or the unknown one if type not found
    return defaults[modelType] || defaults['unknown'];
}