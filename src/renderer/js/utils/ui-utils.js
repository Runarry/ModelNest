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
  const sourceId = imgElement.dataset.sourceId;
  const imagePath = imgElement.dataset.imagePath;
  const logPrefix = `[ImageLoader ${sourceId}] ${imagePath}:`;

  if (!sourceId || !imagePath) {
    logMessage('error', `${logPrefix} 加载失败 - <img> 元素缺少 data-source-id 或 data-image-path 属性`, imgElement);
    imgElement.alt = 'Error: Missing data attributes';
    imgElement.src = ''; // Clear src to prevent broken image icon
    return;
  }

  // 为该图片元素设置一个唯一的 cacheKey，以便后续可以释放
  // 注意：如果 imagePath 本身可能包含 '::'，需要选择更安全的组合方式或对 imagePath进行编码
  const cacheKey = generateCacheKey(sourceId, imagePath); // Use imported function
  imgElement.dataset.blobCacheKey = cacheKey;
  // 清除旧的 src，以防是之前的 blob url
  imgElement.src = '';


  logMessage('debug', `${logPrefix} 开始加载图片 (using BlobUrlCache)`);

  try {
    const blobUrl = await BlobUrlCache.getOrCreateBlobUrl(sourceId, imagePath);

    if (blobUrl) {
      logMessage('info', `${logPrefix} 从 BlobUrlCache 获取到 URL: ${blobUrl}`);
      imgElement.src = blobUrl;

      // onload 和 onerror 仍然有用，用于知道图片是否实际显示成功
      // 但它们不再负责 revokeObjectURL
      imgElement.onload = () => {
        logMessage('info', `${logPrefix} 图片从 Blob URL 加载成功: ${blobUrl}`);
      };
      imgElement.onerror = () => {
        logMessage('error', `${logPrefix} 从 Blob URL 加载图片失败: ${blobUrl}`);
        imgElement.alt = 'Error loading image from blob';
        // 注意：这里不应该 revoke，因为 BlobUrlCache 会管理生命周期
        // 如果加载失败，可能是 Blob 本身有问题或 URL 已被意外撤销
        // 可以考虑在这里尝试从 BlobUrlCache 中移除有问题的条目，但这需要 BlobUrlCache 提供相应接口
        // 或者让 BlobUrlCache 内部在创建时就处理好无法加载的 Blob
      };
    } else {
      logMessage('warn', `${logPrefix} BlobUrlCache未能提供 Blob URL (可能获取数据失败).`);
      imgElement.alt = 'Image not available';
    }
  } catch (error) {
    logMessage('error', `${logPrefix} 调用 BlobUrlCache.getOrCreateBlobUrl 时出错:`, error);
    imgElement.alt = 'Error loading image data';
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