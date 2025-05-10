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
let modelTypeInput, modelBaseModelInput, modelFileInput, modelJsonPathInput, modelTriggerInput, modelTagsInput, modelDescriptionTextarea, extraInfoGroupContainer, noExtraInfoP; // Added modelBaseModelInput
let detailSaveBtn, detailFeedbackEl, detailReadOnlyIndicatorEl;

let detailCloseBtn;

// ===== Module State =====
let currentModel = null; // Store the model object (modelObj) currently being displayed/edited
let currentSourceId = null; // Store the sourceId needed for image loading/saving
let currentIsReadOnly = false; // Stores the read-only status of the current model's source

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
    detailDescriptionContainer = document.getElementById(config.descriptionContainerId);
    detailCloseBtn = document.getElementById(config.closeBtnId);

    modelTypeInput = detailModel.querySelector('#detail-model-type');
    modelBaseModelInput = detailModel.querySelector('#detail-model-base-model'); // Added for base model
    modelFileInput = detailModel.querySelector('#detail-model-file');
    modelJsonPathInput = detailModel.querySelector('#detail-model-jsonPath');
    modelTriggerInput = detailModel.querySelector('#detail-model-trigger');
    modelTagsInput = detailModel.querySelector('#detail-model-tags');
    modelDescriptionTextarea = detailModel.querySelector('#detail-model-description');
    extraInfoGroupContainer = detailModel.querySelector('#detail-model-extra-info-group');
    noExtraInfoP = detailModel.querySelector('#detail-model-no-extra-info');
    
    detailSaveBtn = detailModel.querySelector('#detailSaveBtn');
    detailFeedbackEl = detailModel.querySelector('#detailModelFeedback');
    detailReadOnlyIndicatorEl = detailModel.querySelector('#detailReadOnlyIndicator');

    const requiredElements = {
        detailModel, detailName, detailImage, detailDescriptionContainer, detailCloseBtn,
        modelTypeInput, modelFileInput, modelJsonPathInput, modelTriggerInput, modelTagsInput,
        modelDescriptionTextarea, extraInfoGroupContainer, noExtraInfoP, detailSaveBtn,
        detailFeedbackEl, detailReadOnlyIndicatorEl
        // modelBaseModelInput is optional, will be handled if null
    };

    let allEssentialFound = true;
    for (const key in requiredElements) {
        if (!requiredElements[key] && key !== 'modelBaseModelInput') { // modelBaseModelInput is not strictly essential for basic operation
            allEssentialFound = false;
            logMessage('error', `[DetailModel] 初始化失败：必需的 DOM 元素 '${key}' 未找到。`);
        }
    }
    if (!modelBaseModelInput) {
        logMessage('warn', "[DetailModel] 初始化警告：基础模型输入框 #detail-model-base-model 未找到。该字段将作为动态“其他信息”处理。");
    }


    if (!allEssentialFound) {
        logMessage('error', "[DetailModel] 由于一个或多个必需的 DOM 元素未找到，初始化中止。请检查配置和 HTML 中的 ID。");
        return;
    }

    detailCloseBtn.addEventListener('click', () => {
        logMessage('info', '[UI] 点击了详情弹窗的关闭按钮');
        hideDetailModel();
    });

    detailModel.addEventListener('click', (event) => {
        if (event.target === detailModel) {
            logMessage('info', '[UI] 点击了详情弹窗的背景遮罩');
            hideDetailModel();
        }
    });
}

// ===== Core Functions =====

/**
 * Shows the detail Modal with information for the given model object.
 * @param {object} modelObj - The model object (new structure) to display.
 * @param {string} sourceId - The ID of the source the model belongs to.
 * @param {boolean} isReadOnly - Whether the source is read-only.
 */
export async function show(modelObj, sourceId, isReadOnly) { // Renamed from showDetailModel
    const startTime = Date.now();
    logMessage('info', `[DetailModel] 开始显示模型详情: ${modelObj?.name} (Source: ${sourceId})`);
    if (!detailModel) {
        logMessage('error', "[DetailModel] show 失败：弹窗元素未初始化");
        return;
    }
    if (!modelObj) {
        logMessage('error', "[DetailModel] show 失败：传入的 modelObj 为空");
        return;
    }

    currentModel = modelObj; // Store the full modelObj
    currentSourceId = sourceId;
    currentIsReadOnly = isReadOnly === true;
    logMessage('debug', `[DetailModel] Setting read-only status to: ${currentIsReadOnly}`);

    clearModelInputs(); // Clear previous inputs before populating

    // --- 基础信息 (通常不可编辑或从 modelBaseInfo 获取) ---
    detailName.textContent = modelObj.name || '';
    if (modelFileInput) modelFileInput.textContent = modelObj.file || t('notAvailable');
    if (modelJsonPathInput) modelJsonPathInput.textContent = modelObj.jsonPath || t('notAvailable');

    // --- 预览图 ---
    detailImage.src = '';
    detailImage.style.display = 'none';
    if (modelObj.image) {
        detailImage.setAttribute('data-image-path', modelObj.image);
        detailImage.setAttribute('data-source-id', sourceId);
        detailImage.alt = modelObj.name || t('modelImageAlt');
        await loadImage(detailImage);
        if (detailImage.complete && detailImage.naturalHeight !== 0 && detailImage.style.display !== 'block') {
            detailImage.style.display = 'block';
        } else if (!detailImage.src || detailImage.src === window.location.href) {
            detailImage.style.display = 'none';
        }
        detailImage.onload = () => {
            logMessage('debug', `[DetailModel] 图片加载成功: ${modelObj.image}`);
            detailImage.style.display = 'block';
        };
        detailImage.onerror = () => {
            logMessage('warn', `[DetailModel] 图片加载失败: ${modelObj.image} (Source: ${sourceId})`);
            detailImage.style.display = 'none';
        };
    } else {
        logMessage('info', `[DetailModel] 模型 ${modelObj.name} 没有图片`);
    }

    const modelJson = modelObj.modelJsonInfo || {};

    // --- 可编辑的核心元数据 (来自 modelJsonInfo) ---
    if (modelTypeInput) modelTypeInput.value = modelJson.modelType || '';
    if (modelBaseModelInput) { // If dedicated input exists
        modelBaseModelInput.value = modelJson.baseModel || modelJson.basic || '';
    }
    if (modelTriggerInput) modelTriggerInput.value = modelJson.triggerWord || '';
    if (modelTagsInput) modelTagsInput.value = (modelJson.tags || []).join(', ');

    // --- 详情描述 (来自 modelJsonInfo) ---
    if (modelDescriptionTextarea) {
        modelDescriptionTextarea.value = modelJson.description || '';
    }

    // --- 其他信息 (动态字段，来自 modelJsonInfo) ---
    if (extraInfoGroupContainer && noExtraInfoP) {
        extraInfoGroupContainer.innerHTML = ''; // Clear previous extra fields
        const processedKeys = new Set([
            'modelType', 'baseModel', 'basic', 'triggerWord', 'tags', 'description',
            'name', 'image', // These are typically not in modelJsonInfo or handled by other parts
            '_id', '_rev', // Internal fields from some DBs, should not be user-editable here
            // modelObj top-level keys like 'file', 'jsonPath', 'sourceId' are not in modelJsonInfo
        ]);

        // If modelBaseModelInput doesn't exist, 'baseModel' and 'basic' should not be in processedKeys
        // so they can be rendered dynamically if present in modelJson.
        if (!modelBaseModelInput) {
            processedKeys.delete('baseModel');
            processedKeys.delete('basic');
        }

        const dynamicEntries = Object.entries(modelJson).filter(([key]) => !processedKeys.has(key));

        if (dynamicEntries.length > 0) {
            renderExtraFieldsContainer(dynamicEntries, extraInfoGroupContainer);
            noExtraInfoP.style.display = 'none';
        } else {
            noExtraInfoP.textContent = t('detail.noExtraInfo');
            noExtraInfoP.style.display = 'block';
        }
    } else {
        logMessage('warn', "[DetailModel] Extra info container or noExtraInfoP element not found.");
    }
    
    // --- UI 更新和事件监听器 ---
    detailModel.classList.add('active');
    
    setTimeout(() => {
        const imageTabPane = detailModel.querySelector('#image-tab .image-container');
        if (imageTabPane && detailImage) {
            if (!imageTabPane.contains(detailImage)) {
                imageTabPane.appendChild(detailImage);
            }
            const imageTabButton = detailModel.querySelector('.tab-btn[data-tab="image"]');
            if (detailImage.src && detailImage.src !== window.location.href && imageTabButton && imageTabButton.classList.contains('active')) {
                detailImage.style.display = 'block';
            } else if (!detailImage.src || detailImage.src === window.location.href) {
                 detailImage.style.display = 'none';
            }
        }

        attachTabListeners();
        attachSaveListener(); // Ensure save listener is correctly configured for the new model data
        applyReadOnlyState(); // Apply read-only state based on currentIsReadOnly

        if (modelDescriptionTextarea) {
            function autoResize() {
                modelDescriptionTextarea.style.height = 'auto';
                modelDescriptionTextarea.style.height = (modelDescriptionTextarea.scrollHeight + 10) + 'px';
            }
            requestAnimationFrame(autoResize); // Initial resize
            modelDescriptionTextarea.removeEventListener('input', autoResize); // Remove previous if any
            modelDescriptionTextarea.addEventListener('input', autoResize);
            modelDescriptionTextarea.style.resize = 'none';
            modelDescriptionTextarea.style.overflowY = 'hidden';
        }

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
        const duration = Date.now() - startTime;
        logMessage('info', `[DetailModel] 显示模型详情完成: ${modelObj.name}, 耗时: ${duration}ms`);
    }, 0);
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
    if (modelBaseModelInput) modelBaseModelInput.value = ''; // Clear base model input
    if (modelFileInput) modelFileInput.textContent = ''; // Use textContent for display elements
    if (modelJsonPathInput) modelJsonPathInput.textContent = ''; // Use textContent for display elements
    if (modelTriggerInput) modelTriggerInput.value = '';
    if (modelTagsInput) modelTagsInput.value = '';
    if (modelDescriptionTextarea) modelDescriptionTextarea.value = '';
    if (extraInfoGroupContainer) extraInfoGroupContainer.innerHTML = ''; // Clear dynamically added extra fields
    if (noExtraInfoP) noExtraInfoP.style.display = 'none'; // Hide 'no extra info' message
    if (detailFeedbackEl) detailFeedbackEl.textContent = ''; // Clear feedback message

    // Reset image
    if (detailImage) {
        // The image is moved into a tab, so direct removal from a fixed parent might not be needed.
        // Clearing src and hiding is generally sufficient.
        detailImage.src = '';
        detailImage.style.display = 'none';
        detailImage.removeAttribute('data-image-path');
        detailImage.removeAttribute('data-source-id');
        detailImage.alt = '';
    }
}

// renderModelContent function is removed as its logic is integrated into the new show() function.

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

    const inputs = detailModel.querySelectorAll('.editable-input, .extra-input, #detail-model-description, #detail-model-base-model');
    // Note: #detail-model-base-model might be null if not found, querySelectorAll handles this gracefully.
    
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
    if (detailSaveBtn) {
        // Clone and replace to remove old listeners, ensuring a fresh listener for the current state.
        const newSaveBtn = detailSaveBtn.cloneNode(true);
        detailSaveBtn.parentNode.replaceChild(newSaveBtn, detailSaveBtn);
        detailSaveBtn = newSaveBtn; // Update reference

        detailSaveBtn.addEventListener('click', async () => {
            if (currentIsReadOnly) {
                logMessage('warn', `[DetailModel] 保存操作被阻止，因为数据源是只读的 (Model: ${currentModel?.name})`);
                if (detailFeedbackEl) {
                    detailFeedbackEl.textContent = t('errors.readOnlyDataSource');
                    detailFeedbackEl.className = 'Model-feedback feedback-error';
                }
                return;
            }

            logMessage('info', `[UI] 点击了详情弹窗的保存按钮 (Model: ${currentModel?.name})`);

            if (!currentModel || !currentSourceId) {
                logMessage('error', "[DetailModel] 保存失败：currentModel 或 currentSourceId 丢失");
                if (detailFeedbackEl) {
                    detailFeedbackEl.textContent = t('detail.saveErrorMissingData');
                    detailFeedbackEl.className = 'Model-feedback feedback-error';
                }
                return;
            }

            detailSaveBtn.disabled = true;
            if (detailFeedbackEl) {
                detailFeedbackEl.textContent = t('detail.saving');
                detailFeedbackEl.className = 'Model-feedback feedback-info';
            }

            // --- Collect Updated Data for modelJsonInfo ---
            logMessage('debug', '[DetailModel] 开始收集更新后的模型JSON数据');
            
            // Create a deep copy of the original modelJsonInfo to modify.
            // This ensures we only update modelJsonInfo and don't alter other parts of currentModel unintentionally yet.
            const updatedJsonInfo = JSON.parse(JSON.stringify(currentModel.modelJsonInfo || {}));

            // --- Collect Standard Editable Data for modelJsonInfo ---
            if (modelTypeInput) updatedJsonInfo.modelType = modelTypeInput.value.trim();
            if (modelBaseModelInput) { // If dedicated input exists
                updatedJsonInfo.baseModel = modelBaseModelInput.value.trim();
                // If 'basic' was the original key and it's different from baseModel, decide how to handle.
                // For now, assume baseModel is the primary key. 'basic' might be an alias.
                // If 'basic' existed and baseModel is now the source, remove 'basic' if it's not the same.
                if (currentModel.modelJsonInfo && typeof currentModel.modelJsonInfo.basic !== 'undefined' &&
                    updatedJsonInfo.baseModel !== currentModel.modelJsonInfo.basic) {
                    // If 'basic' was just an alias for 'baseModel', and we now use 'baseModel',
                    // we might want to remove 'basic' to avoid redundancy if they were meant to be the same.
                    // Or, if they are distinct concepts, keep 'basic' if it's not empty.
                    // For now, if baseModel is set, it takes precedence.
                    // If 'basic' was the key used for input, this logic might need adjustment.
                    // Assuming 'baseModel' is the canonical key now.
                }
            }
            if (modelTriggerInput) updatedJsonInfo.triggerWord = modelTriggerInput.value.trim();
            if (modelTagsInput) {
                updatedJsonInfo.tags = (modelTagsInput.value || '')
                    .split(',')
                    .map(tag => tag.trim())
                    .filter(tag => tag.length > 0);
            }
            if (modelDescriptionTextarea) updatedJsonInfo.description = modelDescriptionTextarea.value.trim();

            // --- Collect "Other Information" (Dynamic Fields) for modelJsonInfo ---
            const dynamicData = collectExtraData(extraInfoGroupContainer); // collectExtraData should return flat key-value pairs for modelJsonInfo
            for (const key in dynamicData) {
                if (Object.prototype.hasOwnProperty.call(dynamicData, key)) {
                    // Ensure not to overwrite already processed core fields if dynamicData somehow contains them
                    // (though renderExtraFieldsContainer should filter them out)
                    if (!['modelType', 'baseModel', 'basic', 'triggerWord', 'tags', 'description'].includes(key)) {
                         updatedJsonInfo[key] = dynamicData[key]; // Assuming dynamicData values are already trimmed if necessary
                    } else if (key === 'baseModel' && !modelBaseModelInput && dynamicData.baseModel) {
                        // If baseModel was rendered dynamically because no dedicated input
                        updatedJsonInfo.baseModel = dynamicData.baseModel.trim();
                    }
                }
            }
            
            logMessage('debug', "[DetailModel] 更新后的 modelJsonInfo:", updatedJsonInfo);

            // Construct the model object to be saved. Start with a shallow copy of the currentModel (original modelObj),
            // then replace its modelJsonInfo property with the updatedJsonInfo.
            const modelToSave = {
                ...currentModel, // This includes name, file, jsonPath, image, sourceId (if part of modelObj), and the *old* modelJsonInfo
                modelJsonInfo: updatedJsonInfo // This overwrites modelJsonInfo with the new data
            };
            
            // Ensure essential non-editable fields from modelBaseInfo are preserved.
            // Spread operator (...) on currentModel should handle this.
            // modelToSave.name, .file, .jsonPath, .image should be from the original currentModel.

            logMessage('debug', "[DetailModel] 最终发送给 saveModel 的对象:", modelToSave);

            // --- Call API ---
            const saveStartTime = Date.now();
            logMessage('info', `[DetailModel] 调用 API 保存模型: ${modelToSave.name}`);
            try {
                await saveModel(modelToSave); // Pass the entire updated modelObj (currentModel with new modelJsonInfo)
                const saveDuration = Date.now() - saveStartTime;
                logMessage('info', `[DetailModel] API 保存模型成功: ${modelToSave.name}, 耗时: ${saveDuration}ms`);
                
                if (detailFeedbackEl) {
                    detailFeedbackEl.textContent = t('detail.saveSuccess');
                    detailFeedbackEl.className = 'Model-feedback feedback-success';
                }
                
                setTimeout(() => {
                    if (detailModel.classList.contains('active')) {
                         hideDetailModel();
                         logMessage('info', `[DetailModel] 触发 model-updated 事件: ${modelToSave.name}`);
                         // Dispatch event with the fully updated model object (modelToSave)
                         window.dispatchEvent(new CustomEvent('model-updated', { detail: modelToSave }));
                    }
                }, 1500);

            } catch (e) {
                const saveDuration = Date.now() - saveStartTime;
                logMessage('error', `[DetailModel] API 保存模型失败: ${modelToSave.name}, 耗时: ${saveDuration}ms`, e.message, e.stack, e);
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

