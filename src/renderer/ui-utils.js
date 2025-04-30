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
            feedbackElement.textContent = '';
            feedbackElement.className = 'Model-feedback'; // Reset class
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
      api.logMessage('warn', 'Loading div or main section not found for setLoading');
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
      // Task 1: Error Logging
      api.logMessage('error', `${logPrefix} 加载失败 - <img> 元素缺少 data-source-id 或 data-image-path 属性`, imgElement);
      // Optionally set a placeholder/error state on the imgElement
      imgElement.alt = 'Error: Missing data attributes'; // Provide feedback
      return;
  }
  api.logMessage('debug', `${logPrefix} 开始加载图片`);
  try {
    const imageData = await window.api.getModelImage({ sourceId, imagePath });

    if (imageData && imageData.data) {
       api.logMessage('debug', `${logPrefix} 从 API 收到图片数据, 大小: ${imageData.data?.length} bytes, 类型: ${imageData.mimeType}`);
      try {
          const blob = new Blob([new Uint8Array(imageData.data)], { type: imageData.mimeType });
          const objectUrl = URL.createObjectURL(blob);
          api.logMessage('debug', `${logPrefix} 创建 Blob URL: ${objectUrl}`);
          imgElement.src = objectUrl;
          // Optional: Clean up the object URL when the image is no longer needed
          // imgElement.onload = () => URL.revokeObjectURL(objectUrl); // Example cleanup
          imgElement.onerror = () => { // Handle cases where the blob URL itself fails to load
               // Task 1: Error Logging
              api.logMessage('error', `${logPrefix} 从 Blob URL 加载图片失败: ${objectUrl}`);
              URL.revokeObjectURL(objectUrl); // Clean up failed URL
              imgElement.alt = 'Error loading image from blob'; // Provide feedback
          };
           imgElement.onload = () => { // Add onload for successful logging and cleanup
               api.logMessage('debug', `${logPrefix} 图片从 Blob URL 加载成功: ${objectUrl}`);
               // Revoke the object URL once the image is loaded to free up memory
               URL.revokeObjectURL(objectUrl);
               api.logMessage('debug', `${logPrefix} Blob URL 已撤销: ${objectUrl}`);
           };
      } catch (blobError) {
           // Task 1: Error Logging
          api.logMessage('error', `${logPrefix} 创建 Blob 或 Object URL 时出错:`, blobError.message, blobError.stack, blobError);
          imgElement.alt = 'Error creating image blob'; // Provide feedback
      }
    } else {
        // Handle case where API returns no image data (e.g., image not found on backend)
         // Task 1: Error Logging (Potential failure point)
        api.logMessage('warn', `${logPrefix} API 未返回图片数据 (可能未找到)`);
        // Optionally set a placeholder/error state
        imgElement.alt = 'Image not found'; // Provide feedback
    }
  } catch (apiError) {
     // Task 1: Error Logging
    api.logMessage('error', `${logPrefix} 调用 API getModelImage 时出错:`, apiError.message, apiError.stack, apiError);
    // Optionally set a placeholder/error state
     imgElement.alt = 'Error loading image data'; // Provide feedback
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