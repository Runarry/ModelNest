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
    feedbackElement.className = `modal-feedback feedback-${type}`; // Set class based on type

    // Auto-hide after duration (if duration is positive)
    if (duration > 0) {
        feedbackTimeout = setTimeout(() => {
            feedbackElement.textContent = '';
            feedbackElement.className = 'modal-feedback'; // Reset class
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
     feedbackElement.className = 'modal-feedback';
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
      console.warn('Loading div or main section not found for setLoading');
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
  if (!imgElement.dataset.sourceId || !imgElement.dataset.imagePath) {
      console.warn('Image element missing data-source-id or data-image-path', imgElement);
      // Optionally set a placeholder/error state on the imgElement
      return;
  }
  try {
    const imageData = await window.api.getModelImage({
      sourceId: imgElement.dataset.sourceId,
      imagePath: imgElement.dataset.imagePath
    });
    if (imageData && imageData.data) {
      try {
          const blob = new Blob([new Uint8Array(imageData.data)], { type: imageData.mimeType });
          const objectUrl = URL.createObjectURL(blob);
          imgElement.src = objectUrl;
          // Optional: Clean up the object URL when the image is no longer needed
          // imgElement.onload = () => URL.revokeObjectURL(objectUrl); // Example cleanup
          imgElement.onerror = () => { // Handle cases where the blob URL itself fails to load
              console.error('Failed to load image from blob URL:', objectUrl);
              URL.revokeObjectURL(objectUrl); // Clean up failed URL
          };
      } catch (blobError) {
          console.error('Error creating Blob or Object URL:', blobError, 'for image:', imgElement.dataset.imagePath);
      }
    } else {
        // Handle case where API returns no image data (e.g., image not found on backend)
        console.warn('No image data received for:', imgElement.dataset.imagePath);
        // Optionally set a placeholder/error state
    }
  } catch (apiError) {
    console.error('API error loading image:', apiError, 'for image:', imgElement.dataset.imagePath);
    // Optionally set a placeholder/error state
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