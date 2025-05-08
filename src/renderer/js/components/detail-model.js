import { loadImage } from '../utils/ui-utils.js';
import { t } from '../core/i18n.js';
import { logMessage, saveModel } from '../apiBridge.js';
import { BlobUrlCache } from '../core/blobUrlCache.js';

// ===== DOM Element References =====
let detailModel;
let detailName;
let detailImage;
let detailDescriptionContainer; // The element where description/tabs/inputs are rendered
// References to pre-defined input elements in detailModel
let modelTypeInput, modelFileInput, modelJsonPathInput, modelTriggerInput, modelTagsInput, modelDescriptionTextarea, extraInfoGroupContainer, noExtraInfoP;
let detailSaveBtn, detailFeedbackEl, detailReadOnlyIndicatorEl;

let detailCloseBtn;

// ===== Module State =====
let currentModel = null; // Store the model currently being displayed/edited
let currentSourceId = null; // Store the sourceId needed for image loading/saving
let currentIsReadOnly = false; // 新增：存储当前模型的只读状态

// ===== Initialization =====

/**
 * Initializes the detail Model module.
 * @param {object} config - Configuration object.
 * @param {string} config.ModelId - ID of the Model container element.
 * @param {string} config.nameId - ID of the element displaying the model name.
 * @param {string} config.imageId - ID of the image element.
 * @param {string} config.descriptionContainerId - ID of the container for dynamic content.
 * @param {string} config.closeBtnId - ID of the close button.
 */
export function initDetailModel(config) {
    detailModel = document.getElementById(config.ModelId);
    detailName = document.getElementById(config.nameId);
    detailImage = document.getElementById(config.imageId);
    detailDescriptionContainer = document.getElementById(config.descriptionContainerId); // This is the main container for tabs and content
    detailCloseBtn = document.getElementById(config.closeBtnId);

    // Get references to specific pre-defined elements within the detailModel
    // These IDs are now defined in index.html for the static skeleton
    modelTypeInput = detailModel.querySelector('#detail-model-type');
    modelFileInput = detailModel.querySelector('#detail-model-file');
    modelJsonPathInput = detailModel.querySelector('#detail-model-jsonPath');
    modelTriggerInput = detailModel.querySelector('#detail-model-trigger');
    modelTagsInput = detailModel.querySelector('#detail-model-tags');
    modelDescriptionTextarea = detailModel.querySelector('#detail-model-description');
    extraInfoGroupContainer = detailModel.querySelector('#detail-model-extra-info-group');
    noExtraInfoP = detailModel.querySelector('#detail-model-no-extra-info');
    
    detailSaveBtn = detailModel.querySelector('#detailSaveBtn'); // Corrected ID from HTML
    detailFeedbackEl = detailModel.querySelector('#detailModelFeedback'); // Corrected ID from HTML
    detailReadOnlyIndicatorEl = detailModel.querySelector('#detailReadOnlyIndicator'); // Corrected ID from HTML


    if (!detailModel || !detailName || !detailImage || !detailDescriptionContainer || !detailCloseBtn ||
        !modelTypeInput || !modelFileInput || !modelJsonPathInput || !modelTriggerInput || !modelTagsInput ||
        !modelDescriptionTextarea || !extraInfoGroupContainer || !noExtraInfoP || !detailSaveBtn || !detailFeedbackEl || !detailReadOnlyIndicatorEl
    ) {
        // Task 1: Error Logging
        logMessage('error', "[DetailModel] 初始化失败：一个或多个必需的 DOM 元素未找到。请检查配置和 HTML 中的 ID:", {
            config,
            detailModelExists: !!detailModel,
            detailNameExists: !!detailName,
            detailImageExists: !!detailImage,
            detailDescriptionContainerExists: !!detailDescriptionContainer,
            detailCloseBtnExists: !!detailCloseBtn,
            modelTypeInputExists: !!modelTypeInput,
            modelFileInputExists: !!modelFileInput,
            modelJsonPathInputExists: !!modelJsonPathInput,
            modelTriggerInputExists: !!modelTriggerInput,
            modelTagsInputExists: !!modelTagsInput,
            modelDescriptionTextareaExists: !!modelDescriptionTextarea,
            extraInfoGroupContainerExists: !!extraInfoGroupContainer,
            noExtraInfoPExists: !!noExtraInfoP,
            detailSaveBtnExists: !!detailSaveBtn,
            detailFeedbackElExists: !!detailFeedbackEl,
            detailReadOnlyIndicatorElExists: !!detailReadOnlyIndicatorEl
        });
        return;
    }

    // Task 4: Click Event Logging
    detailCloseBtn.addEventListener('click', () => {
        logMessage('info', '[UI] 点击了详情弹窗的关闭按钮');
        hideDetailModel();
    });

    // Close Model if clicking on the backdrop
    detailModel.addEventListener('click', (event) => {
        if (event.target === detailModel) {
            // Task 4: Click Event Logging
            logMessage('info', '[UI] 点击了详情弹窗的背景遮罩');
            hideDetailModel();
        }
    });
}

// ===== Core Functions =====

/**
 * Shows the detail Model with information for the given model.
 * @param {object} model - The model object to display.
 * @param {string} sourceId - The ID of the source the model belongs to.
 * @param {boolean} isReadOnly - Whether the source is read-only.
 */
export async function showDetailModel(model, sourceId, isReadOnly) {
    const startTime = Date.now();
    logMessage('info', `[DetailModel] 开始显示模型详情: ${model?.name} (Source: ${sourceId})`);
    if (!detailModel) {
        logMessage('error', "[DetailModel] showDetailModel 失败：弹窗元素未初始化");
        return;
    }
     if (!model) {
        logMessage('error', "[DetailModel] showDetailModel 失败：传入的 model 为空");
        return;
    }


    currentModel = model; // Store the model
    currentSourceId = sourceId; // Store the source ID
    currentIsReadOnly = isReadOnly === true; // Store the read-only status, ensure boolean
    logMessage('info', `[DetailModel] Setting read-only status to: ${currentIsReadOnly}`);
    
    detailName.textContent = model.name || '';

    // --- Load Image ---
    detailImage.src = ''; // Clear previous image
    // Keep image hidden initially, its display will be controlled by tab logic
    detailImage.style.display = 'none';
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
         detailImage.onload = () => {
             logMessage('debug', `[DetailModel] 图片加载成功: ${model.image}`);
             detailImage.style.display = 'block';
         };
         detailImage.onerror = () => {
             // Task 1: Error Logging
             logMessage('warn', `[DetailModel] 图片初始加载尝试失败 (可能稍后成功): ${model.image} (Source: ${sourceId})`);
             detailImage.style.display = 'none';
         };


   } else {
       logMessage('info', `[DetailModel] 模型 ${model.name} 没有图片`);
   }

   // --- Render Dynamic Content (Tabs, Inputs) ---
   logMessage('debug', '[DetailModel] 开始渲染弹窗内容');
   renderModelContent(model);
   logMessage('debug', '[DetailModel] 弹窗内容渲染完成');

   detailModel.classList.add('active');
   const duration = Date.now() - startTime;
   logMessage('info', `[DetailModel] 显示模型详情完成: ${model.name}, 耗时: ${duration}ms`);
}

/** Hides the detail Model. */
export function hideDetailModel() {
    logMessage('info', `[DetailModel] 开始隐藏模型详情: ${currentModel?.name || '未知'}`);
    if (detailModel) {
        detailModel.classList.remove('active');

        // --- Release Blob URL using BlobUrlCache ---
        // We need to release the blob URL that was potentially loaded for the currentModel's image.
        // The loadImage function in ui-utils.js now stores the cacheKey in imgElement.dataset.blobCacheKey,
        // but it's safer to use the sourceId and imagePath that were used to load it,
        // as detailImage element might be reused or its dataset manipulated elsewhere.
        if (currentModel && currentModel.image && currentSourceId && detailImage) {
            logMessage('debug', `[DetailModel] Preparing to release Blob URL for image: ${currentModel.image} from source: ${currentSourceId}`);
            // It's good practice to clear the src *before* releasing,
            // though BlobUrlCache handles the actual revoke.
            // Clearing src prevents the browser from trying to access a (soon-to-be) revoked URL.
            if (detailImage.src.startsWith('blob:')) {
                 // We can directly use currentSourceId and currentModel.image as these were used to load it.
                BlobUrlCache.releaseBlobUrl(currentSourceId, currentModel.image);
                logMessage('debug', `[DetailModel] Called BlobUrlCache.releaseBlobUrl for ${currentSourceId}::${currentModel.image}`);
            }
            detailImage.src = ''; // Clear src
            detailImage.removeAttribute('data-blob-cache-key'); // Remove the key if it was set
            detailImage.style.display = 'none';
        } else if (detailImage && detailImage.src.startsWith('blob:')) {
            // Fallback if currentModel/currentSourceId somehow became null but image still has a blob src
            // This case is less ideal as we might not have the original sourceId/imagePath
            // but if data-blob-cache-key was reliably set, we could use that.
            // For now, we'll log a warning if this less specific path is taken.
            logMessage('warn', `[DetailModel] currentModel/currentSourceId is null, but detailImage.src is a blob. Cannot reliably release via BlobUrlCache without original key. Old revoke logic removed.`);
            // Old logic: URL.revokeObjectURL(detailImage.src);
            detailImage.src = '';
            detailImage.style.display = 'none';
        }
        // --- End Release Blob URL ---

        const performCleanup = () => {
            clearModelInputs(); // Clear specific input fields
            currentModel = null;
            currentSourceId = null;
            logMessage('info', '[DetailModel] 模型详情已隐藏和清理完毕');
        };

        // Check if there's a transition defined for the modal.
        // This is a simple check; a more robust way might involve checking computed styles.
        const style = window.getComputedStyle(detailModel);
        if (style.transitionDuration && parseFloat(style.transitionDuration) > 0) {
            detailModel.addEventListener('transitionend', function cleanupAfterTransition() {
                // Ensure this listener only acts on the 'opacity' or 'transform' transition,
                // or whatever property is used for the hide animation.
                // For simplicity, we assume any transitionend after removing 'active' is the one we want.
                performCleanup();
                detailModel.removeEventListener('transitionend', cleanupAfterTransition); // Clean up listener
            }, { once: true }); // Use {once: true} if appropriate, or manage removal manually.
                               // Note: {once: true} might not be suitable if multiple properties transition.
                               // A more robust approach might be needed if multiple transitions occur.
                               // For now, we'll rely on a single 'transitionend' or a timeout.
        } else {
            // If no transition, or to be safe, also use a short timeout.
            // This also acts as a fallback if transitionend doesn't fire for some reason.
            setTimeout(performCleanup, 300); // Adjust timeout as needed, e.g., to match typical transition duration
        }
    } else {
        logMessage('warn', '[DetailModel] hideDetailModel 调用时弹窗元素未初始化');
    }
}

// ===== Internal Rendering and Logic =====

/**
 * Clears all input fields in the detail modal.
 */
function clearModelInputs() {
    if (modelTypeInput) modelTypeInput.value = '';
    if (modelFileInput) modelFileInput.textContent = '';
    if (modelJsonPathInput) modelJsonPathInput.textContent = '';
    if (modelTriggerInput) modelTriggerInput.value = '';
    if (modelTagsInput) modelTagsInput.value = '';
    if (modelDescriptionTextarea) modelDescriptionTextarea.value = '';
    if (extraInfoGroupContainer) extraInfoGroupContainer.innerHTML = ''; // Clear dynamically added extra fields
    if (noExtraInfoP) noExtraInfoP.style.display = 'none';
    if (detailFeedbackEl) detailFeedbackEl.textContent = '';

    // Reset image
    if (detailImage) {
        const imageTabContainer = detailModel.querySelector('#image-tab .image-container');
        if (imageTabContainer && imageTabContainer.contains(detailImage)) {
            // Only remove if it's currently in the image tab
            // It might have already been removed or not added yet if no image
        }
        detailImage.src = '';
        detailImage.style.display = 'none';
        detailImage.removeAttribute('data-image-path');
        detailImage.removeAttribute('data-source-id');
        detailImage.alt = '';
    }
}


/**
 * Populates the pre-defined DOM elements with model data.
 * @param {object} model - The model data.
 */
function renderModelContent(model) {
    if (!detailModel) { // Check if the main modal element is available
        logMessage('error', "[DetailModel] renderModelContent called but detailModel is not initialized.");
        return;
    }

    // --- Populate Basic Info Tab ---
    if (modelTypeInput) modelTypeInput.value = model.modelType || '';
    if (modelFileInput) modelFileInput.textContent = model.file || t('notAvailable');
    if (modelJsonPathInput) modelJsonPathInput.textContent = model.jsonPath || t('notAvailable');
    if (modelTriggerInput) modelTriggerInput.value = model.triggerWord || '';
    if (modelTagsInput) modelTagsInput.value = (model.tags || []).join(', ');

    // --- Populate Description Tab ---
    if (modelDescriptionTextarea) {
        modelDescriptionTextarea.value = model.description || '';
    }

    // --- Populate Extra Info Tab ---
    if (extraInfoGroupContainer && noExtraInfoP) {
        extraInfoGroupContainer.innerHTML = ''; // Clear previous extra fields
        const extraEntries = Object.entries(model.extra || {});
        const filteredExtraEntries = extraEntries.filter(([key]) =>
            !['name', 'type', 'modelType', 'description', 'triggerWord', 'image', 'file', 'jsonPath', 'tags', 'id', 'sourceId'].includes(key)
        );

        if (filteredExtraEntries.length > 0) {
            renderExtraFieldsContainer(filteredExtraEntries, extraInfoGroupContainer);
            noExtraInfoP.style.display = 'none';
        } else {
            noExtraInfoP.textContent = t('detail.noExtraInfo');
            noExtraInfoP.style.display = 'block';
        }
    } else {
        logMessage('warn', "[DetailModel] Extra info container or noExtraInfoP element not found.");
    }


    // Use setTimeout to ensure elements are in the DOM and populated before further actions
    setTimeout(() => {
        // Move the existing detailImage element into the image tab's container
        const imageTabPane = detailModel.querySelector('#image-tab .image-container');
        if (imageTabPane && detailImage) {
            if (!imageTabPane.contains(detailImage)) { // Append only if not already there
                imageTabPane.appendChild(detailImage);
            }
            // Visibility is controlled by tab logic and image loading success
            // Ensure it's visible if the image tab is active and image is loaded
            const imageTabButton = detailModel.querySelector('.tab-btn[data-tab="image"]');
            if (detailImage.src && detailImage.src !== window.location.href && imageTabButton && imageTabButton.classList.contains('active')) {
                detailImage.style.display = 'block';
            } else if (!detailImage.src || detailImage.src === window.location.href) {
                 detailImage.style.display = 'none';
            }
        } else {
            logMessage('warn', '[DetailModel] Could not find image tab container or detailImage element to move.');
        }

        attachTabListeners();
        attachSaveListener(); // Ensure save listener is (re)attached or correctly configured
        applyReadOnlyState();

        // --- Textarea Auto Height ---
        if (modelDescriptionTextarea) {
            function autoResize() {
                modelDescriptionTextarea.style.height = 'auto';
                modelDescriptionTextarea.style.height = (modelDescriptionTextarea.scrollHeight + 10) + 'px';
            }
            requestAnimationFrame(autoResize); // Initial resize
            modelDescriptionTextarea.removeEventListener('input', autoResize); // Remove previous if any
            modelDescriptionTextarea.addEventListener('input', autoResize);

            // Adjust on tab switch (ensure this doesn't add multiple listeners over time)
            // This part of tab listener should be idempotent or managed carefully
            // For now, we assume attachTabListeners handles tab switching correctly and autoResize is called if description tab becomes active.
            // Or, better, trigger resize when the description tab becomes active.
            // The existing tab listener logic in attachTabListeners might need a hook for this,
            // or we can rely on the description tab itself to trigger resize when it becomes visible.
            // For simplicity, the input event is the primary trigger.

            modelDescriptionTextarea.style.resize = 'none';
            modelDescriptionTextarea.style.overflowY = 'hidden';
            // Read-only state for textarea is handled by applyReadOnlyState
        } else {
            logMessage('warn', '[DetailModel] Could not find description textarea #detail-model-description for auto-height.');
        }
        // --- End Textarea Auto Height ---
         // Ensure the first tab (image) is active and its content visible
        const firstTabButton = detailModel.querySelector('.tab-btn[data-tab="image"]');
        const firstTabContent = detailModel.querySelector('#image-tab');
        if (firstTabButton && firstTabContent) {
            detailModel.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            detailModel.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            firstTabButton.classList.add('active');
            firstTabContent.classList.add('active');
            if (detailImage.src && detailImage.src !== window.location.href) {
                 detailImage.style.display = 'block';
            } else {
                 detailImage.style.display = 'none';
            }
        }


    }, 0);
}


/**
 * Renders the container for extra fields.
 * @param {Array} entries - Array of [key, value] pairs for extra data.
 * @param {HTMLElement} parentElement - The DOM element to append the fields to.
 */
function renderExtraFieldsContainer(entries, parentElement) {
    entries.forEach(([key, value]) => {
        createExtraFieldElement(key, value, parentElement);
    });
}

/**
 * Creates and appends DOM elements for a single extra field (can be nested).
 * @param {string} key - The key/label for the field.
 * @param {any} value - The value, which can be a primitive or a nested object.
 * @param {HTMLElement} parentElement - The DOM element to append the new field to.
 * @param {string} [parentKey=''] - The prefix for nested input IDs and keys.
 */
function createExtraFieldElement(key, value, parentElement, parentKey = '') {
    const fieldContainer = document.createElement('div');
    const label = document.createElement('label');
    label.textContent = `${key}:`;

    const fullKeyPath = parentKey ? `${parentKey}.${key}` : key;
    // Sanitize key for use in ID - replace non-alphanumeric with underscore
    const sanitizedKeyForId = fullKeyPath.replace(/[^a-zA-Z0-9_]/g, '_');
    const inputId = `extra-${sanitizedKeyForId}`;


    if (typeof value === 'object' && value !== null && !Array.isArray(value)) { // Nested object
        fieldContainer.className = 'extra-item nested';
        label.className = 'nested-label';
        fieldContainer.appendChild(label);

        const nestedContentDiv = document.createElement('div');
        nestedContentDiv.className = 'nested-content';
        Object.entries(value).forEach(([k, v]) => {
            createExtraFieldElement(k, v, nestedContentDiv, fullKeyPath);
        });
        fieldContainer.appendChild(nestedContentDiv);
    } else { // Simple input (primitive or array)
        fieldContainer.className = 'extra-item simple';
        const input = document.createElement('input');
        input.type = 'text';
        input.id = inputId;
        input.value = Array.isArray(value) ? value.join(', ') : (value !== null && value !== undefined ? String(value) : '');
        input.className = 'extra-input editable-input'; // Keep class for styling and read-only logic
        label.htmlFor = inputId;

        fieldContainer.appendChild(label);
        fieldContainer.appendChild(input);
    }
    parentElement.appendChild(fieldContainer);
}


/** Attaches event listeners to the tab buttons. */
function attachTabListeners() {
    const tabButtons = detailModel.querySelectorAll('.detail-tabs .tab-btn'); // More specific selector
    // Remove existing listeners to prevent duplication if called multiple times
    // This is a simple way; a more robust way would be to store and remove specific listeners.
    tabButtons.forEach(button => {
        const newButton = button.cloneNode(true); // Clone to remove old listeners
        button.parentNode.replaceChild(newButton, button);
        newButton.addEventListener('click', () => {
            const tabId = newButton.getAttribute('data-tab');
            logMessage('info', `[UI] 点击了详情弹窗的标签页按钮: ${tabId}`);

            // Deactivate all tabs and content
            detailModel.querySelectorAll('.detail-tabs .tab-btn').forEach(btn => btn.classList.remove('active'));
            detailModel.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

            // Activate clicked tab and its content
            newButton.classList.add('active');
            const contentToShow = detailModel.querySelector(`.tab-content#${tabId}-tab`);
            if (contentToShow) {
                contentToShow.classList.add('active');

                // Image visibility logic
                if (detailImage) { // Ensure detailImage is defined
                    if (tabId === 'image' && detailImage.src && detailImage.src !== window.location.href) {
                        detailImage.style.display = 'block';
                    } else {
                        detailImage.style.display = 'none';
                    }
                }

                // Auto-resize textarea if description tab is activated
                if (tabId === 'description' && modelDescriptionTextarea) {
                    requestAnimationFrame(() => { // Ensure DOM is updated
                        modelDescriptionTextarea.style.height = 'auto';
                        modelDescriptionTextarea.style.height = (modelDescriptionTextarea.scrollHeight + 10) + 'px';
                    });
                }

            } else {
                logMessage('error', `[DetailModel] Could not find content element for tab: #${tabId}-tab`);
            }
        });
    });
}


/** Applies disabled state to inputs and button if the source is read-only. */
function applyReadOnlyState() {
    if (!detailModel) return;
    const isReadOnly = currentIsReadOnly;
    logMessage('debug', `[DetailModel] Applying read-only state: ${isReadOnly}`);

    const inputs = detailModel.querySelectorAll('.editable-input, .extra-input, #detail-model-description'); // Use specific ID for textarea
    // const saveBtn = detailModel.querySelector('#detailSaveBtn'); // Already referenced as detailSaveBtn
    // const readOnlyIndicator = detailModel.querySelector('#detailReadOnlyIndicator'); // Already referenced as detailReadOnlyIndicatorEl

    inputs.forEach(input => {
        if (input) input.disabled = isReadOnly;
    });

    if (detailSaveBtn) {
        detailSaveBtn.disabled = isReadOnly;
        detailSaveBtn.style.display = isReadOnly ? 'none' : 'inline-block';
    }

    if (detailReadOnlyIndicatorEl) {
        detailReadOnlyIndicatorEl.style.display = isReadOnly ? 'inline' : 'none';
    }
}


/** Attaches the event listener to the save button. */
function attachSaveListener() {
    // const saveBtn = detailModel.querySelector('#detailSaveBtn'); // Already referenced as detailSaveBtn
    // const feedbackEl = detailModel.querySelector('#detailModelFeedback'); // Already referenced as detailFeedbackEl

    if (detailSaveBtn) {
        // Remove previous listener before adding a new one to prevent multiple executions
        const newSaveBtn = detailSaveBtn.cloneNode(true);
        detailSaveBtn.parentNode.replaceChild(newSaveBtn, detailSaveBtn);
        detailSaveBtn = newSaveBtn; // Update reference

        detailSaveBtn.addEventListener('click', async () => {
            // --- Read-only Check ---
            if (currentIsReadOnly) {
                logMessage('warn', `[DetailModel] 保存操作被阻止，因为数据源是只读的 (Model: ${currentModel?.name})`);
                return; // Do not proceed if read-only
            }
            // ---

            // Task 4: Click Event Logging
            logMessage('info', `[UI] 点击了详情弹窗的保存按钮 (Model: ${currentModel?.name})`);

            if (!currentModel || !currentSourceId) {
                // Task 1: Error Logging
                logMessage('error', "[DetailModel] 保存失败：currentModel 或 currentSourceId 丢失");
                if (detailFeedbackEl) {
                    detailFeedbackEl.textContent = t('detail.saveErrorMissingData');
                    detailFeedbackEl.className = 'Model-feedback feedback-error';
                }
                return;
            }

            detailSaveBtn.disabled = true;
            if (detailFeedbackEl) {
                detailFeedbackEl.textContent = t('detail.saving'); // Indicate saving
                detailFeedbackEl.className = 'Model-feedback feedback-info'; // Use info class
            }

            // --- Collect Updated Data ---
            logMessage('debug', '[DetailModel] 开始收集更新后的模型数据');
            // --- Collect Standard Data ---
            const standardData = {
                id: currentModel.id,
                sourceId: currentSourceId,
                jsonPath: currentModel.jsonPath, // Preserved from original model
                name: detailName.textContent, // Name is from the modal title
                modelType: modelTypeInput?.value || currentModel.modelType,
                triggerWord: modelTriggerInput?.value || currentModel.triggerWord,
                description: modelDescriptionTextarea?.value || currentModel.description,
                tags: (modelTagsInput?.value || '')
                    .split(',')
                    .map(tag => tag.trim())
                    .filter(tag => tag.length > 0),
                // file and image are not part of the editable form, they are part of model identity
            };

            // --- Collect Extra Data ---
            // extraInfoGroupContainer is the direct parent of .extra-item elements
            const extraData = collectExtraData(extraInfoGroupContainer);
            logMessage('debug', "[DetailModel] 收集到的额外数据:", extraData);

            // --- Combine Data ---
            // Start with an empty object, spread collected extra data, then standard data.
            // Standard data comes last to ensure its values overwrite any conflicting keys from extraData.
            // Also include essential original fields like file paths if they aren't editable here.
            const updatedModelData = {
                ...extraData, // Spread extra fields first
                ...standardData, // Spread standard fields, overwriting any conflicts
            };

            // Remove the 'extra' container property if it exists from original model spread (no longer needed)
            // delete updatedModelData.extra; // This is no longer needed as we build from scratch

            logMessage('debug', "[DetailModel] 最终发送的模型数据:", updatedModelData);

            // --- Call API ---
            const saveStartTime = Date.now();
            logMessage('info', `[DetailModel] 调用 API 保存模型: ${updatedModelData.name}`);
            try {
                await saveModel(updatedModelData); // 使用导入的函数
                const saveDuration = Date.now() - saveStartTime;
                logMessage('info', `[DetailModel] API 保存模型成功: ${updatedModelData.name}, 耗时: ${saveDuration}ms`);
                if (detailFeedbackEl) {
                    detailFeedbackEl.textContent = t('detail.saveSuccess');
                    detailFeedbackEl.className = 'Model-feedback feedback-success';
                }
                // Optionally close Model after a short delay
                setTimeout(() => {
                    // Check if Model is still open before hiding
                    if (detailModel.classList.contains('active')) {
                         // Prepare data specifically for the event, including the file path
                         const eventDetail = {
                             ...updatedModelData,
                             file: currentModel.file, // Add the original file path back for identification
                             image: currentModel.image // Add image path back in case card re-render needs it
                         };
                         hideDetailModel();
                         // Notify the main view to potentially reload/refresh the specific model card
                         logMessage('info', `[DetailModel] 触发 model-updated 事件: ${eventDetail.name}`);
                         window.dispatchEvent(new CustomEvent('model-updated', { detail: eventDetail }));
                    }
                }, 1500);

            } catch (e) {
                 const saveDuration = Date.now() - saveStartTime;
                // Task 1: Error Logging
                logMessage('error', `[DetailModel] API 保存模型失败: ${updatedModelData.name}, 耗时: ${saveDuration}ms`, e.message, e.stack, e);
                if (detailFeedbackEl) {
                    if (e.message && (e.message.includes('read-only') || e.message.includes('只读'))) {
                        detailFeedbackEl.textContent = t('errors.readOnlyDataSource');
                    } else {
                        detailFeedbackEl.textContent = t('detail.saveFail', { message: e.message });
                    }
                    detailFeedbackEl.className = 'Model-feedback feedback-error';
                }
                if (detailSaveBtn) detailSaveBtn.disabled = false; // Re-enable button on error
            }
        });
    } else {
        logMessage('error', '[DetailModel] 初始化保存监听器失败：找不到保存按钮 #detailSaveBtn');
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

