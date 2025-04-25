import { loadImage } from './ui-utils.js'; // Assuming loadImage handles API call and blob creation

// Assume i18n is initialized and 't' is available globally or passed/imported
const t = window.i18n?.t || ((key) => key); // Fallback

// ===== DOM Element References =====
let detailModal;
let detailName;
let detailImage;
let detailDescriptionContainer; // The element where description/tabs/inputs are rendered
let detailCloseBtn;

// ===== Module State =====
let currentModel = null; // Store the model currently being displayed/edited
let currentSourceId = null; // Store the sourceId needed for image loading/saving

// ===== Initialization =====

/**
 * Initializes the detail modal module.
 * @param {object} config - Configuration object.
 * @param {string} config.modalId - ID of the modal container element.
 * @param {string} config.nameId - ID of the element displaying the model name.
 * @param {string} config.imageId - ID of the image element.
 * @param {string} config.descriptionContainerId - ID of the container for dynamic content.
 * @param {string} config.closeBtnId - ID of the close button.
 */
export function initDetailModal(config) {
    detailModal = document.getElementById(config.modalId);
    detailName = document.getElementById(config.nameId);
    detailImage = document.getElementById(config.imageId);
    detailDescriptionContainer = document.getElementById(config.descriptionContainerId);
    detailCloseBtn = document.getElementById(config.closeBtnId);

    if (!detailModal || !detailName || !detailImage || !detailDescriptionContainer || !detailCloseBtn) {
        console.error("One or more detail modal elements not found. Check IDs:", config);
        return;
    }

    detailCloseBtn.addEventListener('click', hideDetailModal);

    // Close modal if clicking on the backdrop
    detailModal.addEventListener('click', (event) => {
        if (event.target === detailModal) {
            hideDetailModal();
        }
    });
}

// ===== Core Functions =====

/**
 * Shows the detail modal with information for the given model.
 * @param {object} model - The model object to display.
 * @param {string} sourceId - The ID of the source the model belongs to.
 */
export async function showDetailModal(model, sourceId) {
    if (!detailModal || !model) return;

    currentModel = model; // Store the model
    currentSourceId = sourceId; // Store the source ID

    detailName.textContent = model.name || '';

    // --- Load Image ---
    detailImage.src = ''; // Clear previous image
    detailImage.style.display = 'none'; // Hide initially
    if (model.image) {
        // Use ui-utils loadImage, passing the img element and necessary data
        detailImage.setAttribute('data-image-path', model.image);
        detailImage.setAttribute('data-source-id', sourceId);
        detailImage.alt = model.name || t('modelImageAlt');
        await loadImage(detailImage); // loadImage should handle setting src and display
        // We might need loadImage to return a promise that resolves when the image is set or fails
        // For simplicity, we assume loadImage sets display style or handles errors internally.
        // If loadImage doesn't handle display, uncomment the line below after await.
        // if (detailImage.src && detailImage.src !== window.location.href) detailImage.style.display = 'block';
         if (detailImage.complete && detailImage.naturalHeight !== 0 && detailImage.style.display !== 'block') {
             // If loadImage finished synchronously and successfully (e.g., cached), ensure it's visible
             detailImage.style.display = 'block';
         } else if (!detailImage.src || detailImage.src === window.location.href) {
             // Ensure it's hidden if loadImage failed or didn't set src
             detailImage.style.display = 'none';
         }
         // Add onload listener to ensure display is set correctly after async loading
         detailImage.onload = () => { detailImage.style.display = 'block'; };
         detailImage.onerror = () => { detailImage.style.display = 'none'; };


    }

    // --- Render Dynamic Content (Tabs, Inputs) ---
    renderModalContent(model);

    detailModal.classList.add('active');
}

/** Hides the detail modal. */
export function hideDetailModal() {
    if (detailModal) {
        detailModal.classList.remove('active');
        // Optional: Clean up object URLs if created for images/blobs
        if (detailImage && detailImage.src.startsWith('blob:')) {
            URL.revokeObjectURL(detailImage.src);
            detailImage.src = '';
            detailImage.style.display = 'none';
        }
        currentModel = null; // Clear stored model
        currentSourceId = null;
        if(detailDescriptionContainer) detailDescriptionContainer.innerHTML = ''; // Clear dynamic content
    }
}

// ===== Internal Rendering and Logic =====

/**
 * Renders the tabbed content within the modal.
 * @param {object} model - The model data.
 */
function renderModalContent(model) {
    if (!detailDescriptionContainer) return;

    const extraEntries = Object.entries(model.extra || {});
    // Filter out standard fields from the 'extra' section display
    const filteredExtraEntries = extraEntries.filter(([key]) =>
        !['name', 'type', 'description', 'triggerWord', 'image', 'file', 'jsonPath', 'tags'].includes(key)
    );

    const extraHtml = filteredExtraEntries.length > 0
        ? filteredExtraEntries.map(([key, value]) => renderExtraField(key, value)).join('')
        : `<p class="no-extra-info">${t('detail.noExtraInfo')}</p>`;

    detailDescriptionContainer.innerHTML = `
      <div class="detail-modal-content">
        <div class="detail-tabs">
          <button class="tab-btn active" data-tab="basic">${t('detail.tabs.basic')}</button>
          <button class="tab-btn" data-tab="description">${t('detail.tabs.description')}</button>
          <button class="tab-btn" data-tab="extra">${t('detail.tabs.extra')}</button>
        </div>

        <div class="tab-content active" id="basic-tab">
          <div class="detail-info">
            ${renderEditableField(t('detail.type'), 'model-type', model.type || '')}
            ${renderReadonlyField(t('detail.filePath'), model.file || t('notAvailable'))}
            ${renderReadonlyField(t('detail.jsonPath'), model.jsonPath || t('notAvailable'))}
            ${renderEditableField(t('detail.triggerWord'), 'model-trigger', model.triggerWord || '')}
            ${renderEditableField(t('detail.tags'), 'model-tags', (model.tags || []).join(', '))}
          </div>
        </div>

        <div class="tab-content" id="description-tab">
          <div class="detail-info">
            <textarea id="model-description" class="description-textarea" rows="8" placeholder="${t('detail.descriptionPlaceholder')}">${model.description || ''}</textarea>
          </div>
        </div>

        <div class="tab-content" id="extra-tab">
          <div class="detail-info">
            <div class="extra-info-group">
              ${extraHtml}
            </div>
          </div>
        </div>

        <div class="modal-actions">
             <span id="detailFeedback" class="modal-feedback"></span>
             <button id="saveDetailBtn" class="btn btn-primary">${t('detail.save')}</button>
        </div>
      </div>
    `;

    // Use setTimeout to ensure elements are in the DOM before attaching listeners
    setTimeout(() => {
        attachTabListeners();
        attachSaveListener();
    }, 0);
}

/** Renders a simple readonly field row. */
function renderReadonlyField(label, value) {
    return `
        <div class="detail-row readonly">
            <label>${label}:</label>
            <span class="readonly-text">${value}</span>
        </div>
    `;
}

/** Renders an editable text input field row. */
function renderEditableField(label, inputId, value) {
     // Only render tags input if model actually had tags initially or it's a standard field
     if (inputId === 'model-tags' && !currentModel?.tags?.length && label === t('detail.tags')) {
         // If tags are empty initially, maybe don't show the field unless explicitly needed
         // Or provide a button to add tags? For now, let's show it based on label.
         // return ''; // Option: Hide if no tags initially
     }
    return `
        <div class="detail-row editable">
            <label for="${inputId}">${label}:</label>
            <input type="text" id="${inputId}" value="${value}" class="editable-input">
        </div>
    `;
}


/**
 * Recursively renders fields for the 'extra' data section.
 * @param {string} key - The key/label for the field.
 * @param {any} value - The value, which can be a primitive or a nested object.
 * @param {string} [parentKey=''] - The prefix for nested input IDs.
 */
function renderExtraField(key, value, parentKey = '') {
    const inputId = `extra-${parentKey}${key.replace(/\s+/g, '-')}`; // Create a unique ID
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) { // Render nested object
        const nestedEntries = Object.entries(value);
        return `
          <div class="extra-item nested">
            <label class="nested-label">${key}:</label>
            <div class="nested-content">
              ${nestedEntries.map(([k, v]) => renderExtraField(k, v, `${parentKey}${key}.`)).join('')}
            </div>
          </div>
        `;
    } else { // Render simple input for primitives or arrays (arrays rendered as comma-separated string)
        const displayValue = Array.isArray(value) ? value.join(', ') : value;
        return `
          <div class="extra-item simple">
            <label for="${inputId}">${key}:</label>
            <input type="text" id="${inputId}" value="${displayValue}" class="extra-input editable-input">
          </div>
        `;
    }
}


/** Attaches event listeners to the tab buttons. */
function attachTabListeners() {
    const tabButtons = detailModal.querySelectorAll('.tab-btn');
    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            // Remove active class from all buttons and content
            detailModal.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            detailModal.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

            // Add active class to the clicked button and corresponding content
            button.classList.add('active');
            const tabId = button.getAttribute('data-tab');
            const contentToShow = detailModal.querySelector(`#${tabId}-tab`);
            if (contentToShow) {
                contentToShow.classList.add('active');
            }
        });
    });
}

/** Attaches the event listener to the save button. */
function attachSaveListener() {
    const saveBtn = detailModal.querySelector('#saveDetailBtn');
    const feedbackEl = detailModal.querySelector('#detailFeedback'); // Get feedback element

    if (saveBtn) {
        saveBtn.onclick = async () => {
            if (!currentModel || !currentSourceId) {
                console.error("Cannot save, model or sourceId missing.");
                if (feedbackEl) feedbackEl.textContent = t('detail.saveErrorMissingData');
                return;
            }

            saveBtn.disabled = true;
            if (feedbackEl) feedbackEl.textContent = t('detail.saving'); // Indicate saving

            // --- Collect Updated Data ---
            const updatedModelData = {
                ...currentModel, // Start with original model data
                id: currentModel.id, // Ensure ID is preserved
                sourceId: currentSourceId, // Include sourceId for the backend
                name: detailName.textContent, // Name is from the title element
                type: detailModal.querySelector('#model-type')?.value || currentModel.type,
                triggerWord: detailModal.querySelector('#model-trigger')?.value || currentModel.triggerWord,
                description: detailModal.querySelector('#model-description')?.value || currentModel.description,
                tags: (detailModal.querySelector('#model-tags')?.value || '')
                        .split(',')
                        .map(tag => tag.trim())
                        .filter(tag => tag.length > 0),
                extra: collectExtraData(detailModal.querySelector('.extra-info-group'))
            };
             // Clean up extra data: remove standard keys if they somehow got in
             const standardKeys = ['name', 'type', 'description', 'triggerWord', 'image', 'file', 'jsonPath', 'tags', 'id', 'sourceId'];
             for (const key of standardKeys) {
                 delete updatedModelData.extra[key];
             }


            console.log("Saving updated model data:", updatedModelData);

            // --- Call API ---
            try {
                await window.api.saveModel(updatedModelData);
                if (feedbackEl) {
                    feedbackEl.textContent = t('detail.saveSuccess');
                    feedbackEl.className = 'modal-feedback feedback-success';
                }
                // Optionally close modal after a short delay
                setTimeout(() => {
                    // Check if modal is still open before hiding
                    if (detailModal.classList.contains('active')) {
                         hideDetailModal();
                         // TODO: Notify the main view to potentially reload/refresh the specific model card
                         // This might involve emitting a custom event or calling a callback
                         window.dispatchEvent(new CustomEvent('model-updated', { detail: updatedModelData }));
                    }
                }, 1500);

            } catch (e) {
                console.error('Failed to save model:', e);
                if (feedbackEl) {
                    feedbackEl.textContent = t('detail.saveFail', { message: e.message });
                    feedbackEl.className = 'modal-feedback feedback-error';
                }
                saveBtn.disabled = false; // Re-enable button on error
            }
            // Do not re-enable button on success, as modal will close
        };
    } else {
        console.error('Save button #saveDetailBtn not found in detail modal.');
    }
}

/**
 * Recursively collects data from the 'extra' input fields.
 * @param {HTMLElement} container - The container element holding the extra fields.
 * @returns {object} - An object representing the collected extra data.
 */
function collectExtraData(container) {
    const data = {};
    if (!container) return data;

    // Select direct children items to avoid collecting too deep in one go
    const items = container.querySelectorAll(':scope > .extra-item');

    items.forEach(item => {
        const labelElement = item.querySelector(':scope > label');
        if (!labelElement) return; // Skip if no label found

        const key = labelElement.textContent.replace(/:$/, '').trim();

        if (item.classList.contains('nested')) {
            const nestedContent = item.querySelector(':scope > .nested-content');
            if (nestedContent) {
                data[key] = collectExtraData(nestedContent); // Recurse
            }
        } else if (item.classList.contains('simple')) {
            const inputElement = item.querySelector(':scope > input.extra-input');
            if (inputElement) {
                // Attempt to parse arrays back if they contain commas, otherwise store as string
                const value = inputElement.value;
                // Basic check for comma separation, might need refinement
                // if (value.includes(',')) {
                //     data[key] = value.split(',').map(s => s.trim()).filter(s => s.length > 0);
                // } else {
                    data[key] = value; // Store as string
                // }
            }
        }
    });
    return data;
}