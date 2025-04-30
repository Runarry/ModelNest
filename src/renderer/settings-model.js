import { showFeedback, clearFeedback, clearChildren } from './ui-utils.js';
import { openSourceEditModel, initSourceEditModel } from './source-edit-model.js'; // Import functions for the sub-Model

// Assume i18n is initialized and 't' is available globally or passed/imported
const t = window.i18n?.t || ((key) => key); // Fallback

// ===== DOM Element References =====
let settingsModel;
let settingsBtn; // The button that opens the settings Model
let settingsCloseBtn;
let settingsSaveBtn;
let settingsCancelBtn;
let settingsForm;
let settingsFeedbackEl; // Feedback element specific to this Model
let sourceListContainer; // Element within the form to hold the list of sources
let updateSection; // Container for the update UI
let updateStatusEl; // Span to display update status messages
let checkUpdateButton; // Button to check for updates / quit and install

// ===== Module State =====
let tempModelSources = []; // Temporary state for editing sources
let unsubscribeUpdateStatus = null; // Function to unsubscribe from update status events

// ===== Initialization =====

/**
 * Initializes the settings Model module.
 * @param {object} config - Configuration object containing element IDs.
 * @param {string} config.ModelId
 * @param {string} config.openBtnId - ID of the button that opens this Model.
 * @param {string} config.closeBtnId
 * @param {string} config.saveBtnId
 * @param {string} config.cancelBtnId
 * @param {string} config.formId
 * @param {string} config.feedbackElementId
 * @param {object} sourceEditModelConfig - Config object to pass to initSourceEditModel.
 */
export function initSettingsModel(config, sourceEditModelConfig) {
    settingsModel = document.getElementById(config.ModelId);
    settingsBtn = document.getElementById(config.openBtnId);
    settingsCloseBtn = document.getElementById(config.closeBtnId);
    settingsSaveBtn = document.getElementById(config.saveBtnId);
    settingsCancelBtn = document.getElementById(config.cancelBtnId);
    settingsForm = document.getElementById(config.formId);
    settingsFeedbackEl = document.getElementById(config.feedbackElementId);

    if (!settingsModel || !settingsBtn || !settingsCloseBtn || !settingsSaveBtn ||
        !settingsCancelBtn || !settingsForm || !settingsFeedbackEl) {
        // Task 1: Error Logging
        window.api.logMessage('error', "[SettingsModel] 初始化失败：一个或多个必需的 DOM 元素未找到。请检查配置中的 ID:", config);
        return;
    }


    // Initialize the source edit Model (it's controlled from here)
    initSourceEditModel(sourceEditModelConfig, handleSourceSaved); // Pass the callback

    // Attach event listeners
    // Task 4: Click Event Logging
    settingsBtn.addEventListener('click', () => {
        window.api.logMessage('info', '[UI] 点击了设置按钮');
        openSettingsModel();
    });
    settingsCloseBtn.addEventListener('click', () => {
        window.api.logMessage('info', '[UI] 点击了设置弹窗的关闭按钮');
        closeSettingsModel();
    });
    settingsCancelBtn.addEventListener('click', () => {
        window.api.logMessage('info', '[UI] 点击了设置弹窗的取消按钮');
        closeSettingsModel();
    });
    settingsSaveBtn.addEventListener('click', () => {
        window.api.logMessage('info', '[UI] 点击了设置弹窗的保存按钮');
        handleSaveSettings();
    });


    // Close Model if clicking on the backdrop
    settingsModel.addEventListener('click', (event) => {
        if (event.target === settingsModel) {
            // Task 4: Click Event Logging
            window.api.logMessage('info', '[UI] 点击了设置弹窗的背景遮罩');
            closeSettingsModel();
        }
    });
}

// ===== Core Functions =====

/** Opens the settings Model and loads the current configuration. */
function openSettingsModel() {
    if (!settingsModel) {
        window.api.logMessage('error', "[SettingsModel] openSettingsModel 失败：弹窗元素未初始化");
        return;
    }
    window.api.logMessage('info', "[SettingsModel] 开始打开设置弹窗");
    clearFeedback(settingsFeedbackEl);
    settingsModel.classList.add('active');
    loadConfigForSettings(); // Load config when opening
    window.api.logMessage('info', "[SettingsModel] 设置弹窗已打开");
}

/** Closes the settings Model. */
function closeSettingsModel() {
    window.api.logMessage('info', "[SettingsModel] 开始关闭设置弹窗");
    if (settingsModel) {
        settingsModel.classList.remove('active');
        // Clear temporary state when closing without saving
        tempModelSources = [];
        // Clean up IPC listener when closing Model
        if (unsubscribeUpdateStatus) {
            window.api.logMessage('info', "[SettingsModel] 取消订阅更新状态事件");
            unsubscribeUpdateStatus();
            unsubscribeUpdateStatus = null;
        }
         window.api.logMessage('info', "[SettingsModel] 设置弹窗已关闭");
    } else {
         window.api.logMessage('warn', "[SettingsModel] closeSettingsModel 调用时弹窗元素未初始化");
    }
}

// ===== Internal Logic =====

/** Loads the current config from the main process and populates the settings form. */
async function loadConfigForSettings() {
    if (!settingsForm) {
        window.api.logMessage('error', "[SettingsModel] loadConfigForSettings 失败：表单元素未初始化");
        return;
    }
    window.api.logMessage('info', "[SettingsModel] 开始加载配置到设置表单");
    settingsForm.innerHTML = `<p>${t('settings.loading')}</p>`; // Placeholder while loading
    const startTime = Date.now();

    try {
        const currentConfig = await window.api.getConfig();
        window.api.logMessage('info', "[SettingsModel] 从主进程获取的配置:", currentConfig);

        // Deep clone sources into temporary state for editing
        // Ensure it's always an array
        tempModelSources = currentConfig.modelSources ? JSON.parse(JSON.stringify(currentConfig.modelSources)) : [];


        settingsForm.innerHTML = ''; // Clear loading message

        // --- Render Model Sources Section ---
        const sourcesSection = document.createElement('div');
        sourcesSection.className = 'settings-section source-settings'; // Added class for specific styling
        sourcesSection.innerHTML = `<h3>${t('settings.modelSources.title')}</h3>`;
        settingsForm.appendChild(sourcesSection);

        // Create container for the list
        sourceListContainer = document.createElement('ul');
        sourceListContainer.className = 'source-list';
        sourcesSection.appendChild(sourceListContainer);

        renderSourceListForSettings(); // Render the list using temp state

        const addSourceBtn = document.createElement('button');
        addSourceBtn.textContent = t('settings.modelSources.add');
        addSourceBtn.className = 'btn btn-secondary add-source-btn';
        addSourceBtn.type = 'button'; // Prevent form submission
        // Task 4: Click Event Logging
        addSourceBtn.addEventListener('click', () => {
            window.api.logMessage('info', '[UI] 点击了添加数据源按钮');
            openSourceEditModel(null); // Open sub-Model for adding
        });
        sourcesSection.appendChild(addSourceBtn);

        // --- Render Supported Extensions ---
        const extensionsSection = document.createElement('div');
        extensionsSection.className = 'settings-section';
        extensionsSection.innerHTML = `
          <h3>${t('settings.extensions.title')}</h3>
          <div class="form-group">
            <label for="supportedExtensions">${t('settings.extensions.label')}</label>
            <textarea id="supportedExtensions" name="supportedExtensions" rows="3">${(currentConfig.supportedExtensions && currentConfig.supportedExtensions.length > 0) ? currentConfig.supportedExtensions.join(', ') : '.checkpoint, .ckpt, .safetensors, .pt, .pth, .bin'}</textarea>
            <small>${t('settings.extensions.hint')}</small>
          </div>
        `;
        settingsForm.appendChild(extensionsSection);

        // --- Render Image Cache Settings ---
        const cacheSection = document.createElement('div');
        cacheSection.className = 'settings-section';
        const cacheConfig = currentConfig.imageCache || {};
        cacheSection.innerHTML = `
          <h3>${t('settings.imageCache.title')}</h3>
          <div class="form-group form-group-checkbox">
            <label>
              <input type="checkbox" id="imageCacheDebug" name="imageCacheDebug" ${cacheConfig.debug ? 'checked' : ''}>
              ${t('settings.imageCache.debug')}
            </label>
          </div>
          <div class="form-group">
            <label for="imageCacheQuality">${t('settings.imageCache.quality')} ${t('settings.imageCache.qualityHint')}</label>
            <input type="number" id="imageCacheQuality" name="imageCacheQuality" min="0" max="100" value="${cacheConfig.compressQuality ?? 80}">
          </div>
          <div class="form-group">
            <label for="imageCacheFormat">${t('settings.imageCache.format')}</label>
            <select id="imageCacheFormat" name="imageCacheFormat">
              <option value="jpeg" ${cacheConfig.compressFormat === 'jpeg' ? 'selected' : ''}>${t('settings.imageCache.formatJpeg')}</option>
              <option value="webp" ${cacheConfig.compressFormat === 'webp' ? 'selected' : ''}>${t('settings.imageCache.formatWebp')}</option>
              <option value="png" ${cacheConfig.compressFormat === 'png' ? 'selected' : ''}>${t('settings.imageCache.formatPng')}</option>
            </select>
          </div>
          <div class="form-group">
            <label for="imageCacheSize">${t('settings.imageCache.maxSize')} ${t('settings.imageCache.maxSizeHint')}</label>
            <input type="number" id="imageCacheSize" name="imageCacheSize" min="0" value="${cacheConfig.maxCacheSizeMB ?? 500}">
          </div>
        `;
        settingsForm.appendChild(cacheSection);

        // --- Render Update Section ---
        updateSection = document.createElement('div');
        updateSection.className = 'settings-section update-section';
        updateSection.innerHTML = `
          <h3>${t('settings.update.title')}</h3>
          <div class="update-controls">
            <span id="update-status">${t('settings.update.statusIdle')}</span>
            <button id="check-update-button" type="button" class="btn btn-secondary">${t('settings.update.check')}</button>
          </div>
          <small>${t('settings.update.hint')}</small>
        `;
        settingsForm.appendChild(updateSection);

        // Get references to update elements
        updateStatusEl = updateSection.querySelector('#update-status');
        checkUpdateButton = updateSection.querySelector('#check-update-button');

        if (!updateStatusEl || !checkUpdateButton) {
            // Task 1: Error Logging
            window.api.logMessage('error', "[SettingsModel] 初始化更新 UI 失败：状态或按钮元素未找到");
        } else {
             // Add event listener for the update button
            checkUpdateButton.addEventListener('click', handleUpdateButtonClick); // Logging is inside the handler

            // Register listener for update status changes from main process
            // Ensure previous listener is removed if Model is reopened
            if (unsubscribeUpdateStatus) {
                unsubscribeUpdateStatus();
            }
            unsubscribeUpdateStatus = window.api.onUpdateStatus(handleUpdateStatus);
            window.api.logMessage('info', "[SettingsModel] 已订阅更新状态事件");
        }
        const duration = Date.now() - startTime;
        window.api.logMessage('info', `[SettingsModel] 配置加载和表单渲染完成, 耗时: ${duration}ms`);

    } catch (error) {
        const duration = Date.now() - startTime;
        // Task 1: Error Logging
        window.api.logMessage('error', `[SettingsModel] 加载配置到设置表单失败, 耗时: ${duration}ms`, error.message, error.stack, error);
        settingsForm.innerHTML = `<p class="error-message">${t('settings.loadError', { message: error.message })}</p>`;
    }
}

/** Renders the list of model sources based on the `tempModelSources` state. */
function renderSourceListForSettings() {
    if (!sourceListContainer) return;

    clearChildren(sourceListContainer); // Clear existing list items

    if (tempModelSources.length === 0) {
        sourceListContainer.innerHTML = `<li class="no-sources-message">${t('settings.modelSources.none')}</li>`;
        return;
    }

    tempModelSources.forEach(source => {
        const item = document.createElement('li');
        item.className = 'source-item';
        item.dataset.sourceId = source.id; // Store ID for edit/delete

        const typeText = source.type === 'local' ? t('settings.modelSources.typeLocal') : t('settings.modelSources.typeWebdav');
        const pathOrUrl = source.type === 'local' ? source.path : source.url;

        item.innerHTML = `
          <div class="source-item-details">
            <span class="source-item-name">${source.name} (${typeText})</span>
            <span class="source-item-path" title="${pathOrUrl}">${pathOrUrl}</span>
          </div>
          <div class="source-item-actions">
            <button type="button" class="edit-btn icon-btn" title="${t('settings.modelSources.edit')}">✏️</button>
            <button type="button" class="delete-btn icon-btn" title="${t('settings.modelSources.delete')}">🗑️</button>
          </div>
        `;

        // Add event listeners for edit/delete buttons
        const editButton = item.querySelector('.edit-btn');
        window.api.logMessage('info', `[SettingsModel] Found edit button for source "${source.name}":`, editButton); // Log found button
        if (editButton) {
            // Task 4: Click Event Logging
            editButton.addEventListener('click', (e) => {
                window.api.logMessage('info', `[UI] 点击了编辑数据源按钮: ${source.name} (ID: ${source.id})`);
                e.stopPropagation(); // Prevent li click if needed
                openSourceEditModel(source); // Pass the source object to edit
            });
        } else {
             // Task 1: Error Logging (Minor issue, maybe log as warning)
            window.api.logMessage('warn', `[SettingsModel] 未找到数据源 "${source.name}" 的编辑按钮`);
        }
        const deleteButton = item.querySelector('.delete-btn');
        if (deleteButton) {
             // Task 4: Click Event Logging
            deleteButton.addEventListener('click', (e) => {
                 window.api.logMessage('info', `[UI] 点击了删除数据源按钮: ${source.name} (ID: ${source.id})`);
                e.stopPropagation();
                handleDeleteSource(source.id);
            });
        } else {
             window.api.logMessage('warn', `[SettingsModel] 未找到数据源 "${source.name}" 的删除按钮`);
        }

        sourceListContainer.appendChild(item);
    });
}

/** Handles the deletion of a model source from the temporary list. */
function handleDeleteSource(sourceId) {
    window.api.logMessage('info', `[SettingsModel] 尝试删除临时列表中的数据源: ${sourceId}`);
    // TODO: Replace confirm with a custom confirmation UI later
    if (!confirm(t('settings.modelSources.deleteConfirm', { name: tempModelSources.find(s => s.id === sourceId)?.name || sourceId }))) {
         window.api.logMessage('info', `[SettingsModel] 用户取消删除数据源: ${sourceId}`);
        return;
    }
    const index = tempModelSources.findIndex(s => s.id === sourceId);
    if (index !== -1) {
        tempModelSources.splice(index, 1);
        window.api.logMessage('info', `[SettingsModel] 已从临时列表中删除数据源: ${sourceId}`);
        renderSourceListForSettings(); // Re-render the list
    } else {
        // Task 1: Error Logging
        window.api.logMessage('error', `[SettingsModel] 删除失败：在临时列表中未找到数据源 ID: ${sourceId}`);
    }
}

/**
 * Callback function passed to source-edit-Model.
 * Updates the temporary list when a source is added or edited.
 * @param {object} savedSourceData - The source data returned from the edit Model.
 */
function handleSourceSaved(savedSourceData) {
    const existingIndex = tempModelSources.findIndex(s => s.id === savedSourceData.id);
    if (existingIndex !== -1) {
        // Editing existing: Replace in temp list
        window.api.logMessage('info', `[SettingsModel] 更新临时列表中的数据源: ${savedSourceData.name} (ID: ${savedSourceData.id})`);
        tempModelSources[existingIndex] = savedSourceData;
    } else {
        // Adding new: Push to temp list
         window.api.logMessage('info', `[SettingsModel] 向临时列表添加新数据源: ${savedSourceData.name} (ID: ${savedSourceData.id})`);
        tempModelSources.push(savedSourceData);
    }
    renderSourceListForSettings(); // Re-render the list in the settings Model
}


/** Handles saving the entire settings configuration. */
async function handleSaveSettings() {
    // Logging for click is handled by the event listener setup in init
    if (!settingsForm) {
         window.api.logMessage('error', "[SettingsModel] handleSaveSettings 失败：表单元素未初始化");
        return;
    }
    window.api.logMessage('info', "[SettingsModel] 开始保存设置");
    const startTime = Date.now();

    clearFeedback(settingsFeedbackEl);
    settingsSaveBtn.disabled = true;
    settingsSaveBtn.textContent = t('settings.saving'); // Indicate progress

    try {
        // 1. Construct the new config object using tempModelSources
        window.api.logMessage('debug', "[SettingsModel] 开始构建新的配置对象");
        const newConfig = {
            modelSources: tempModelSources, // Use the edited list
            supportedExtensions: [],
            imageCache: {}
        };

        // 2. Collect data from other form elements using FormData
        const formData = new FormData(settingsForm);

        // Supported Extensions
        const extensionsText = formData.get('supportedExtensions') || '';
        newConfig.supportedExtensions = extensionsText.split(',')
            .map(ext => ext.trim()) // Trim only, keep leading dots
            .filter(ext => ext.length > 0);

        // Image Cache
        newConfig.imageCache.debug = formData.has('imageCacheDebug'); // Checkbox value
        const quality = parseInt(formData.get('imageCacheQuality') || '80', 10);
        const size = parseInt(formData.get('imageCacheSize') || '500', 10);
        newConfig.imageCache.compressFormat = formData.get('imageCacheFormat') || 'jpeg';

        // 3. Basic validation for numbers
        window.api.logMessage('debug', "[SettingsModel] 验证表单数据");
        if (isNaN(quality) || quality < 0 || quality > 100) {
            // Task 1: Error Logging (Validation Failure)
            const errorMsg = t('settings.validation.qualityError');
            window.api.logMessage('error', `[SettingsModel] 保存失败：验证错误 - ${errorMsg}`);
            showFeedback(settingsFeedbackEl, errorMsg, 'error');
            settingsForm.querySelector('#imageCacheQuality')?.focus();
            throw new Error(t('settings.validation.failed')); // Throw to prevent saving
        }
        newConfig.imageCache.compressQuality = quality;

        if (isNaN(size) || size < 0) {
             // Task 1: Error Logging (Validation Failure)
            const errorMsg = t('settings.validation.sizeError');
            window.api.logMessage('error', `[SettingsModel] 保存失败：验证错误 - ${errorMsg}`);
            showFeedback(settingsFeedbackEl, errorMsg, 'error');
            settingsForm.querySelector('#imageCacheSize')?.focus();
            throw new Error(t('settings.validation.failed')); // Throw to prevent saving
        }
        newConfig.imageCache.maxCacheSizeMB = size;

        window.api.logMessage('info', "[SettingsModel] 构造的新配置对象:", newConfig);

        // 4. Send to main process
        window.api.logMessage('info', "[SettingsModel] 调用 API 保存配置");
        const apiStartTime = Date.now();
        await window.api.saveConfig(newConfig);
        const apiDuration = Date.now() - apiStartTime;
        window.api.logMessage('info', `[SettingsModel] API 保存配置成功, 耗时: ${apiDuration}ms`);

        // 5. Handle success
        const duration = Date.now() - startTime;
        window.api.logMessage('info', `[SettingsModel] 设置保存成功, 总耗时: ${duration}ms`);
        showFeedback(settingsFeedbackEl, t('settings.saveSuccess'), 'success', 2000);
        setTimeout(closeSettingsModel, 2100); // Close after feedback
        // Main process should notify renderer via 'config-updated' to reload state

    } catch (error) {
         const duration = Date.now() - startTime;
         // Task 1: Error Logging
        window.api.logMessage('error', `[SettingsModel] 保存设置失败, 总耗时: ${duration}ms`, error.message, error.stack, error);
        // Don't show feedback if validation already did
        if (!settingsFeedbackEl.textContent || settingsFeedbackEl.textContent === t('settings.saving')) {
             showFeedback(settingsFeedbackEl, t('settings.saveError', { message: error.message }), 'error');
        }
    } finally {
        // Re-enable button and restore text only if Model didn't close
         if (settingsModel && settingsModel.classList.contains('active')) {
            settingsSaveBtn.disabled = false;
            settingsSaveBtn.textContent = t('settings.save');
         }
    }
}
// ===== Update Handling Functions =====

/**
 * Handles clicks on the "Check for Updates" / "Restart & Install" button.
 */
function handleUpdateButtonClick() {
    if (!checkUpdateButton || !updateStatusEl) {
        window.api.logMessage('error', "[SettingsModel] handleUpdateButtonClick 失败：更新按钮或状态元素未初始化");
        return;
    }

    // Read the current button text to determine the action
    const currentActionText = checkUpdateButton.textContent;

    // Compare with translated strings to decide action
    if (currentActionText === t('settings.update.install')) {
        // Task 4: Click Event Logging
        window.api.logMessage('info', "[UI] 点击了更新按钮：执行退出并安装");
        window.api.quitAndInstall();
    } else {
         // Task 4: Click Event Logging
        window.api.logMessage('info', "[UI] 点击了更新按钮：执行检查更新");
        window.api.checkForUpdate();
    }
}

/**
 * Callback function to handle update status updates from the main process.
 * Updates the UI elements (status text and button) accordingly.
 * @param {string} status - The update status code (e.g., 'checking', 'downloaded').
 * @param {...any} args - Additional arguments depending on the status (e.g., error message, progress info).
 */
function handleUpdateStatus(status, ...args) {
    if (!updateStatusEl || !checkUpdateButton) {
        window.api.logMessage('warn', `[SettingsModel] 无法处理更新状态 '${status}'：UI 元素不可用`);
        return;
    }
    window.api.logMessage('info', `[SettingsModel] 收到更新状态: ${status}`, args);

    // Reset button state initially, enable by default unless specified otherwise
    checkUpdateButton.disabled = false;
    checkUpdateButton.textContent = t('settings.update.check'); // Default text

    switch (status) {
        case 'checking':
            updateStatusEl.textContent = t('settings.update.statusChecking');
            checkUpdateButton.disabled = true;
            checkUpdateButton.textContent = t('settings.update.checking'); // Change button text while checking
            break;
        case 'available':
            // This state might be brief, often followed by 'downloading'.
            updateStatusEl.textContent = t('settings.update.statusAvailable');
            // Keep button as "Check for Updates" or let 'downloading' state handle it.
            // Button remains enabled here, allowing another check if desired, though unlikely needed.
            break;
        case 'not-available':
            updateStatusEl.textContent = t('settings.update.statusNotAvailable');
            // Button remains enabled with "Check for Updates" text.
            break;
        case 'downloading':
            const progress = args[0]?.percent; // Progress info is usually the first arg
            const progressText = progress ? `(${progress.toFixed(1)}%)` : '';
            updateStatusEl.textContent = `${t('settings.update.statusDownloading')} ${progressText}`;
            checkUpdateButton.disabled = true;
            checkUpdateButton.textContent = t('settings.update.downloading'); // Change button text while downloading
            break;
        case 'downloaded':
            updateStatusEl.textContent = t('settings.update.statusDownloaded');
            checkUpdateButton.disabled = false; // Enable button for install action
            checkUpdateButton.textContent = t('settings.update.install'); // Change button text to prompt install
            break;
        case 'error':
            const error = args[0]; // Error object or message is usually the first arg
            const errorMessage = error instanceof Error ? error.message : String(error || t('settings.update.unknownError'));
             // Task 1: Error Logging (Update Error)
            window.api.logMessage('error', `[SettingsModel] 更新过程中发生错误: ${errorMessage}`, error);
            updateStatusEl.textContent = t('settings.update.statusError', { message: errorMessage });
            // Button remains enabled with "Check for Updates" text.
            break;
        default:
            // Optional: Handle any unexpected status or reset to a known idle state
            window.api.logMessage('warn', `[SettingsModel] 未处理的更新状态: ${status}`);
            // updateStatusEl.textContent = t('settings.update.statusIdle'); // Uncomment to reset explicitly
            break;
    }
}