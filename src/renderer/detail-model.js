import { loadImage } from './ui-utils.js'; // Assuming loadImage handles API call and blob creation

// Assume i18n is initialized and 't' is available globally or passed/imported
const t = window.i18n?.t || ((key) => key); // Fallback

// ===== DOM Element References =====
let detailModel;
let detailName;
let detailImage;
let detailDescriptionContainer; // The element where description/tabs/inputs are rendered
let detailCloseBtn;

// ===== Module State =====
let currentModel = null; // Store the model currently being displayed/edited
let currentSourceId = null; // Store the sourceId needed for image loading/saving

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

    if (!detailModel || !detailName || !detailImage || !detailDescriptionContainer || !detailCloseBtn) {
        // Task 1: Error Logging
        window.api.logMessage('error', "[DetailModel] 初始化失败：一个或多个必需的 DOM 元素未找到。请检查配置中的 ID:", config);
        return;
    }

    // Task 4: Click Event Logging
    detailCloseBtn.addEventListener('click', () => {
        window.api.logMessage('info', '[UI] 点击了详情弹窗的关闭按钮');
        hideDetailModel();
    });

    // Close Model if clicking on the backdrop
    detailModel.addEventListener('click', (event) => {
        if (event.target === detailModel) {
            // Task 4: Click Event Logging
            window.api.logMessage('info', '[UI] 点击了详情弹窗的背景遮罩');
            hideDetailModel();
        }
    });
}

// ===== Core Functions =====

/**
 * Shows the detail Model with information for the given model.
 * @param {object} model - The model object to display.
 * @param {string} sourceId - The ID of the source the model belongs to.
 */
export async function showDetailModel(model, sourceId) {
    const startTime = Date.now();
    window.api.logMessage('info', `[DetailModel] 开始显示模型详情: ${model?.name} (Source: ${sourceId})`);
    if (!detailModel) {
        window.api.logMessage('error', "[DetailModel] showDetailModel 失败：弹窗元素未初始化");
        return;
    }
     if (!model) {
        window.api.logMessage('error', "[DetailModel] showDetailModel 失败：传入的 model 为空");
        return;
    }


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
         detailImage.onload = () => {
             window.api.logMessage('debug', `[DetailModel] 图片加载成功: ${model.image}`);
             detailImage.style.display = 'block';
         };
         detailImage.onerror = () => {
             // Task 1: Error Logging
             window.api.logMessage('error', `[DetailModel] 图片加载失败: ${model.image} (Source: ${sourceId})`);
             detailImage.style.display = 'none';
         };


   } else {
       window.api.logMessage('info', `[DetailModel] 模型 ${model.name} 没有图片`);
   }

   // --- Render Dynamic Content (Tabs, Inputs) ---
   window.api.logMessage('debug', '[DetailModel] 开始渲染弹窗内容');
   renderModelContent(model);
   window.api.logMessage('debug', '[DetailModel] 弹窗内容渲染完成');

   detailModel.classList.add('active');
   const duration = Date.now() - startTime;
   window.api.logMessage('info', `[DetailModel] 显示模型详情完成: ${model.name}, 耗时: ${duration}ms`);
}

/** Hides the detail Model. */
export function hideDetailModel() {
    window.api.logMessage('info', `[DetailModel] 开始隐藏模型详情: ${currentModel?.name || '未知'}`);
    if (detailModel) {
        detailModel.classList.remove('active');
        // Optional: Clean up object URLs if created for images/blobs
        if (detailImage && detailImage.src.startsWith('blob:')) {
            window.api.logMessage('debug', `[DetailModel] 撤销 Blob URL: ${detailImage.src}`);
            URL.revokeObjectURL(detailImage.src);
            detailImage.src = '';
            detailImage.style.display = 'none';
        }
        currentModel = null; // Clear stored model
        currentSourceId = null;
        if(detailDescriptionContainer) detailDescriptionContainer.innerHTML = ''; // Clear dynamic content
        window.api.logMessage('info', '[DetailModel] 模型详情已隐藏');
    } else {
        window.api.logMessage('warn', '[DetailModel] hideDetailModel 调用时弹窗元素未初始化');
    }
}

// ===== Internal Rendering and Logic =====

/**
 * Renders the tabbed content within the Model.
 * @param {object} model - The model data.
 */
function renderModelContent(model) {
    if (!detailDescriptionContainer) return;

    const extraEntries = Object.entries(model.extra || {});
    // Filter out standard fields from the 'extra' section display
    const filteredExtraEntries = extraEntries.filter(([key]) =>
        !['name', 'type', 'modelType', 'description', 'triggerWord', 'image', 'file', 'jsonPath', 'tags', 'id', 'sourceId'].includes(key) // Added modelType, id, sourceId
    );

    const extraHtml = filteredExtraEntries.length > 0
        ? filteredExtraEntries.map(([key, value]) => renderExtraField(key, value)).join('')
        : `<p class="no-extra-info">${t('detail.noExtraInfo')}</p>`;

    detailDescriptionContainer.innerHTML = `
      <div class="detail-Model-content">
        <div class="detail-tabs">
          <button class="tab-btn active" data-tab="basic">${t('detail.tabs.basic')}</button>
          <button class="tab-btn" data-tab="description">${t('detail.tabs.description')}</button>
          <button class="tab-btn" data-tab="extra">${t('detail.tabs.extra')}</button>
        </div>

        <div class="tab-content active" id="basic-tab">
          <div class="detail-info">
            ${renderEditableField(t('detail.type'), 'model-type', model.modelType || '')}
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

        <div class="Model-actions">
             <span id="detailFeedback" class="Model-feedback"></span>
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
    const tabButtons = detailModel.querySelectorAll('.tab-btn');
    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const tabId = button.getAttribute('data-tab');
            // Task 4: Click Event Logging
            window.api.logMessage('info', `[UI] 点击了详情弹窗的标签页按钮: ${tabId}`);

            // Remove active class from all buttons and content
            detailModel.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            detailModel.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

            // Add active class to the clicked button and corresponding content
            button.classList.add('active');
            const contentToShow = detailModel.querySelector(`#${tabId}-tab`);
            if (contentToShow) {
                contentToShow.classList.add('active');
            } else {
                 // Task 1: Error Logging (Potential failure point if HTML structure is wrong)
                 window.api.logMessage('error', `[DetailModel] 找不到与标签按钮 "${tabId}" 对应的标签内容元素 (#${tabId}-tab)`);
            }
        });
    });
}

/** Attaches the event listener to the save button. */
function attachSaveListener() {
    const saveBtn = detailModel.querySelector('#saveDetailBtn');
    const feedbackEl = detailModel.querySelector('#detailFeedback'); // Get feedback element

    if (saveBtn) {
        saveBtn.onclick = async () => {
            // Task 4: Click Event Logging
            window.api.logMessage('info', `[UI] 点击了详情弹窗的保存按钮 (Model: ${currentModel?.name})`);

            if (!currentModel || !currentSourceId) {
                // Task 1: Error Logging
                window.api.logMessage('error', "[DetailModel] 保存失败：currentModel 或 currentSourceId 丢失");
                if (feedbackEl) {
                    feedbackEl.textContent = t('detail.saveErrorMissingData');
                    feedbackEl.className = 'Model-feedback feedback-error';
                }
                return;
            }

            saveBtn.disabled = true;
            if (feedbackEl) {
                feedbackEl.textContent = t('detail.saving'); // Indicate saving
                feedbackEl.className = 'Model-feedback feedback-info'; // Use info class
            }

            // --- Collect Updated Data ---
            window.api.logMessage('debug', '[DetailModel] 开始收集更新后的模型数据');
            // --- Collect Standard Data ---
            const standardData = {
                id: currentModel.id, // Ensure ID is preserved
                sourceId: currentSourceId, // Include sourceId for the backend
                jsonPath: currentModel.jsonPath, // Make sure jsonPath is included for saving
                name: detailName.textContent, // Name is from the title element
                modelType: detailModel.querySelector('#model-type')?.value || currentModel.modelType, // Use modelType
                triggerWord: detailModel.querySelector('#model-trigger')?.value || currentModel.triggerWord,
                description: detailModel.querySelector('#model-description')?.value || currentModel.description,
                tags: (detailModel.querySelector('#model-tags')?.value || '')
                        .split(',')
                        .map(tag => tag.trim())
                        .filter(tag => tag.length > 0),
                // DO NOT include file and image when saving metadata
                // file: currentModel.file, // Removed
                // image: currentModel.image, // Removed
            };

            // --- Collect Extra Data ---
            const extraData = collectExtraData(detailModel.querySelector('.extra-info-group'));
            window.api.logMessage('debug', "[DetailModel] 收集到的额外数据:", extraData);

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

            window.api.logMessage('debug', "[DetailModel] 最终发送的模型数据:", updatedModelData);

            // --- Call API ---
            const saveStartTime = Date.now();
            window.api.logMessage('info', `[DetailModel] 调用 API 保存模型: ${updatedModelData.name}`);
            try {
                await window.api.saveModel(updatedModelData);
                const saveDuration = Date.now() - saveStartTime;
                window.api.logMessage('info', `[DetailModel] API 保存模型成功: ${updatedModelData.name}, 耗时: ${saveDuration}ms`);
                if (feedbackEl) {
                    feedbackEl.textContent = t('detail.saveSuccess');
                    feedbackEl.className = 'Model-feedback feedback-success';
                }
                // Optionally close Model after a short delay
                setTimeout(() => {
                    // Check if Model is still open before hiding
                    if (detailModel.classList.contains('active')) {
                         hideDetailModel();
                         // Notify the main view to potentially reload/refresh the specific model card
                         window.api.logMessage('info', `[DetailModel] 触发 model-updated 事件: ${updatedModelData.name}`);
                         window.dispatchEvent(new CustomEvent('model-updated', { detail: updatedModelData }));
                    }
                }, 1500);

            } catch (e) {
                 const saveDuration = Date.now() - saveStartTime;
                // Task 1: Error Logging
                window.api.logMessage('error', `[DetailModel] API 保存模型失败: ${updatedModelData.name}, 耗时: ${saveDuration}ms`, e.message, e.stack, e);
                if (feedbackEl) {
                    feedbackEl.textContent = t('detail.saveFail', { message: e.message });
                    feedbackEl.className = 'Model-feedback feedback-error';
                }
                saveBtn.disabled = false; // Re-enable button on error
            }
            // Do not re-enable button on success, as Model will close
        };
    } else {
         // Task 1: Error Logging
        window.api.logMessage('error', '[DetailModel] 初始化保存监听器失败：找不到保存按钮 #saveDetailBtn');
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