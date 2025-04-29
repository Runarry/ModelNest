import { showFeedback, clearFeedback } from './ui-utils.js';

// Assume i18n is initialized and 't' is available globally or passed/imported
const t = window.i18n?.t || ((key) => key); // Fallback

// ===== DOM Element References =====
let sourceEditModal;
let sourceEditForm;
let sourceEditTitle;
let sourceEditIdInput;
let sourceEditNameInput;
let sourceEditTypeSelect;
let sourceEditLocalFields;
let sourceEditPathInput;
let sourceEditBrowseBtn;
let sourceEditWebdavFields;
let sourceEditUrlInput;
let sourceEditUsernameInput;
let sourceEditPasswordInput;
let sourceEditCloseBtn;
let sourceEditCancelBtn;
// sourceEditSaveBtn is part of the form, handled by submit event
let sourceEditFeedbackEl; // Feedback element specific to this modal

// ===== Module State =====
let _onSaveCallback = null; // Callback to notify settings modal on save

// ===== Initialization =====

/**
 * Initializes the source edit modal module.
 * @param {object} config - Configuration object containing element IDs.
 * @param {string} config.modalId
 * @param {string} config.formId
 * @param {string} config.titleId
 * @param {string} config.idInputId
 * @param {string} config.nameInputId
 * @param {string} config.typeSelectId
 * @param {string} config.localFieldsId
 * @param {string} config.pathInputId
 * @param {string} config.browseBtnId
 * @param {string} config.webdavFieldsId
 * @param {string} config.urlInputId
 * @param {string} config.usernameInputId
 * @param {string} config.passwordInputId
 * @param {string} config.closeBtnId
 * @param {string} config.cancelBtnId
 * @param {string} config.feedbackElementId
 * @param {function} onSaveCallback - Function to call when a source is saved (added/edited).
 */
export function initSourceEditModal(config, onSaveCallback) {
    sourceEditModal = document.getElementById(config.modalId);
    sourceEditForm = document.getElementById(config.formId);
    sourceEditTitle = document.getElementById(config.titleId);
    sourceEditIdInput = document.getElementById(config.idInputId);
    sourceEditNameInput = document.getElementById(config.nameInputId);
    sourceEditTypeSelect = document.getElementById(config.typeSelectId);
    sourceEditLocalFields = document.getElementById(config.localFieldsId);
    sourceEditPathInput = document.getElementById(config.pathInputId);
    sourceEditBrowseBtn = document.getElementById(config.browseBtnId);
    sourceEditWebdavFields = document.getElementById(config.webdavFieldsId);
    sourceEditUrlInput = document.getElementById(config.urlInputId);
    sourceEditUsernameInput = document.getElementById(config.usernameInputId);
    sourceEditPasswordInput = document.getElementById(config.passwordInputId);
    sourceEditCloseBtn = document.getElementById(config.closeBtnId);
    sourceEditCancelBtn = document.getElementById(config.cancelBtnId);
    sourceEditFeedbackEl = document.getElementById(config.feedbackElementId);

    if (!sourceEditModal || !sourceEditForm || !sourceEditTitle || !sourceEditIdInput ||
        !sourceEditNameInput || !sourceEditTypeSelect || !sourceEditLocalFields ||
        !sourceEditPathInput || !sourceEditBrowseBtn || !sourceEditWebdavFields ||
        !sourceEditUrlInput || !sourceEditUsernameInput || !sourceEditPasswordInput ||
        !sourceEditCloseBtn || !sourceEditCancelBtn || !sourceEditFeedbackEl) {
        // Task 1: Error Logging
        console.error("[SourceEditModal] 初始化失败：一个或多个必需的 DOM 元素未找到。请检查配置中的 ID:", config);
        return;
    }

    _onSaveCallback = onSaveCallback;

    // Attach event listeners
    sourceEditTypeSelect.addEventListener('change', handleSourceTypeChange); // Logging in handler
    // Task 4: Click Event Logging
    sourceEditBrowseBtn.addEventListener('click', () => {
        console.log('[UI] 点击了浏览文件夹按钮');
        handleBrowseFolder();
    });
    sourceEditForm.addEventListener('submit', handleSourceEditFormSubmit); // Logging in handler
    // Task 4: Click Event Logging
    sourceEditCloseBtn.addEventListener('click', () => {
        console.log('[UI] 点击了数据源编辑弹窗的关闭按钮');
        closeSourceEditModal();
    });
    sourceEditCancelBtn.addEventListener('click', () => {
        console.log('[UI] 点击了数据源编辑弹窗的取消按钮');
        closeSourceEditModal();
    });
    sourceEditModal.addEventListener('click', (event) => {
        if (event.target === sourceEditModal) {
             // Task 4: Click Event Logging
            console.log('[UI] 点击了数据源编辑弹窗的背景遮罩');
            closeSourceEditModal();
        }
    });

    // Initial setup based on default type
    handleSourceTypeChange();
}

// ===== Core Functions =====

/**
 * Opens the modal for adding a new source or editing an existing one.
 * @param {object | null} sourceToEdit - The source object to edit, or null to add a new one.
 */
export function openSourceEditModal(sourceToEdit = null) {
    if (!sourceEditModal || !sourceEditForm) {
        console.error("[SourceEditModal] openSourceEditModal 失败：弹窗或表单元素未初始化");
        return;
    }
    const mode = sourceToEdit ? '编辑' : '添加';
    console.log(`[SourceEditModal] 开始打开数据源编辑弹窗 (${mode}模式)`);
    clearFeedback(sourceEditFeedbackEl);
    sourceEditForm.reset(); // Clear form fields
    handleSourceTypeChange(); // Ensure correct fields are shown initially

    if (sourceToEdit) {
        // Editing existing source
        console.log(`[SourceEditModal] 填充表单以编辑数据源: ${sourceToEdit.name} (ID: ${sourceToEdit.id})`);
        sourceEditTitle.textContent = t('settings.modelSources.editTitle');
        sourceEditIdInput.value = sourceToEdit.id;
        sourceEditNameInput.value = sourceToEdit.name;
        sourceEditTypeSelect.value = sourceToEdit.type;
        if (sourceToEdit.type === 'local') {
            sourceEditPathInput.value = sourceToEdit.path || '';
        } else if (sourceToEdit.type === 'webdav') {
            sourceEditUrlInput.value = sourceToEdit.url || '';
            sourceEditUsernameInput.value = sourceToEdit.username || '';
            sourceEditPasswordInput.value = sourceToEdit.password || ''; // Be cautious with passwords
        }
        handleSourceTypeChange(); // Update visible fields based on loaded type
    } else {
        // Adding new source
        console.log('[SourceEditModal] 准备表单以添加新数据源');
        sourceEditTitle.textContent = t('settings.modelSources.addTitle');
        sourceEditIdInput.value = ''; // Ensure ID is empty for new source
    }
    sourceEditModal.classList.add('active');
    console.log('[SourceEditModal] 数据源编辑弹窗已打开');
    try {
        sourceEditNameInput.focus(); // Focus the name field
        console.debug('[SourceEditModal] 已聚焦名称输入框');
    } catch (focusError) {
         // Task 1: Error Logging
        console.error('[SourceEditModal] 聚焦名称输入框时出错:', focusError);
    }
}

/** Closes the source edit modal. */
export function closeSourceEditModal() {
    console.log('[SourceEditModal] 开始关闭数据源编辑弹窗');
    if (sourceEditModal) {
        sourceEditModal.classList.remove('active');
         console.log('[SourceEditModal] 数据源编辑弹窗已关闭');
    } else {
        console.warn('[SourceEditModal] closeSourceEditModal 调用时弹窗元素未初始化');
    }
}

// ===== Event Handlers and Internal Logic =====

/** Handles changes in the source type dropdown to show/hide relevant fields. */
function handleSourceTypeChange() {
    if (!sourceEditTypeSelect || !sourceEditLocalFields || !sourceEditWebdavFields || !sourceEditPathInput || !sourceEditUrlInput) {
         console.error("[SourceEditModal] handleSourceTypeChange 失败：一个或多个必需的表单字段元素未初始化");
        return;
    }

    const selectedType = sourceEditTypeSelect.value;
     // Task 4: Click Event Logging (Implicit via change)
    console.log(`[UI] 切换数据源类型: ${selectedType}`);
    if (selectedType === 'local') {
        sourceEditLocalFields.style.display = 'block';
        sourceEditWebdavFields.style.display = 'none';
        sourceEditPathInput.required = true;
        sourceEditUrlInput.required = false;
    } else if (selectedType === 'webdav') {
        sourceEditLocalFields.style.display = 'none';
        sourceEditWebdavFields.style.display = 'block';
        sourceEditPathInput.required = false;
        sourceEditUrlInput.required = true;
        // Username/Password are optional for WebDAV usually
    } else {
        // Handle potential unknown type or default state
        console.warn(`[SourceEditModal] 未知的数据源类型被选中: ${selectedType}`);
        sourceEditLocalFields.style.display = 'none';
        sourceEditWebdavFields.style.display = 'none';
        sourceEditPathInput.required = false;
        sourceEditUrlInput.required = false;
    }
}

/** Handles the click event for the browse folder button (for local sources). */
async function handleBrowseFolder() {
     // Logging for click is handled by the event listener setup in init
    if (!sourceEditBrowseBtn || !sourceEditPathInput) {
         console.error("[SourceEditModal] handleBrowseFolder 失败：浏览按钮或路径输入框未初始化");
        return;
    }
    console.log("[SourceEditModal] 开始处理浏览文件夹操作");
    sourceEditBrowseBtn.disabled = true; // Disable button during operation
    clearFeedback(sourceEditFeedbackEl);

    try {
        console.log("[SourceEditModal] 调用 API 打开文件夹选择对话框");
        const selectedPath = await window.api.openFolderDialog();
        if (selectedPath) {
            console.log(`[SourceEditModal] 用户选择了文件夹: ${selectedPath}`);
            sourceEditPathInput.value = selectedPath;
        } else {
             console.log("[SourceEditModal] 用户取消了文件夹选择");
        }
    } catch (error) {
         // Task 1: Error Logging
        console.error("[SourceEditModal] 打开文件夹对话框失败:", error.message, error.stack, error);
        showFeedback(sourceEditFeedbackEl, t('settings.folderDialogError', { message: error.message }), 'error');
    } finally {
        sourceEditBrowseBtn.disabled = false; // Re-enable button
        console.log("[SourceEditModal] 浏览文件夹操作完成");
    }
}

/** Handles the submission of the source edit form. */
function handleSourceEditFormSubmit(event) {
    event.preventDefault(); // Prevent default HTML form submission
     // Task 4: Click Event Logging (Implicit via submit)
    console.log('[UI] 提交了数据源编辑表单');
    if (!_onSaveCallback) {
         // Task 1: Error Logging
        console.error("[SourceEditModal] 保存失败：_onSaveCallback 未定义");
        showFeedback(sourceEditFeedbackEl, '内部错误：保存回调未设置', 'error'); // Provide generic user feedback
        return;
    }

    clearFeedback(sourceEditFeedbackEl);
    console.log('[SourceEditModal] 开始处理表单提交和验证');

    const sourceId = sourceEditIdInput.value;
    const sourceType = sourceEditTypeSelect.value;

    // --- Basic Validation ---
    const sourceName = sourceEditNameInput.value.trim();
    if (!sourceName) {
        // Task 1: Error Logging (Validation)
        const errorMsg = t('settings.validation.sourceNameRequired');
        console.warn(`[SourceEditModal] 验证失败: ${errorMsg}`);
        showFeedback(sourceEditFeedbackEl, errorMsg, 'error');
        sourceEditNameInput.focus();
        return;
    }

    const newSourceData = {
        id: sourceId || Date.now().toString(), // Generate new ID if adding
        name: sourceName,
        type: sourceType,
    };
    console.debug(`[SourceEditModal] 基本数据: ID=${newSourceData.id}, Name=${newSourceData.name}, Type=${newSourceData.type}`);

    // --- Type-Specific Validation and Data ---
    if (sourceType === 'local') {
        const pathValue = sourceEditPathInput.value.trim();
        if (!pathValue) {
             // Task 1: Error Logging (Validation)
            const errorMsg = t('settings.validation.pathRequired');
            console.warn(`[SourceEditModal] 验证失败 (local): ${errorMsg}`);
            showFeedback(sourceEditFeedbackEl, errorMsg, 'error');
            sourceEditPathInput.focus();
            return;
        }
        newSourceData.path = pathValue;
        console.debug(`[SourceEditModal] 本地路径: ${pathValue}`);
    } else if (sourceType === 'webdav') {
        const urlValue = sourceEditUrlInput.value.trim();
        if (!urlValue) {
             // Task 1: Error Logging (Validation)
            const errorMsg = t('settings.validation.urlRequired');
            console.warn(`[SourceEditModal] 验证失败 (webdav): ${errorMsg}`);
            showFeedback(sourceEditFeedbackEl, errorMsg, 'error');
            sourceEditUrlInput.focus();
            return;
        }
        // Basic URL validation (optional but recommended)
        try {
            new URL(urlValue); // Check if it's a valid URL structure
        } catch (_) {
             // Task 1: Error Logging (Validation)
            const errorMsg = t('settings.validation.urlInvalid');
            console.warn(`[SourceEditModal] 验证失败 (webdav): ${errorMsg} - ${urlValue}`);
            showFeedback(sourceEditFeedbackEl, errorMsg, 'error');
            sourceEditUrlInput.focus();
            return;
        }
        newSourceData.url = urlValue;
        newSourceData.username = sourceEditUsernameInput.value.trim();
        newSourceData.password = sourceEditPasswordInput.value; // Get password value (don't trim)
        console.debug(`[SourceEditModal] WebDAV URL: ${urlValue}, Username: ${newSourceData.username}`);
    } else {
         // Task 1: Error Logging (Should not happen)
        const errorMsg = t('settings.validation.typeRequired');
        console.error(`[SourceEditModal] 验证失败：无效的数据源类型 "${sourceType}"`);
        showFeedback(sourceEditFeedbackEl, errorMsg, 'error');
        return; // Should not happen if dropdown is set up correctly
    }

    // --- Call the Save Callback ---
    console.log(`[SourceEditModal] 验证通过，调用保存回调函数，数据:`, newSourceData);
    // The callback provided by settings-modal will handle updating the temp list
    _onSaveCallback(newSourceData);

    closeSourceEditModal(); // Close the modal on successful save
}