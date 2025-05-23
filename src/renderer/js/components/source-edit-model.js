import { showFeedback, clearFeedback } from '../utils/ui-utils.js';
import { t, updateUIWithTranslations } from '../core/i18n.js'; // 导入 i18n 函数和批量翻译函数
import { logMessage, openFolderDialog } from '../apiBridge.js'; // 导入 API 桥接

// ===== DOM Element References =====
let sourceEditModel;
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
let sourceEditSubdirectoryInput;
let sourceEditCloseBtn;
let sourceEditCancelBtn;
let sourceEditReadOnlyCheckbox; // 新增：只读复选框
// sourceEditSaveBtn is part of the form, handled by submit event
let sourceEditFeedbackEl; // Feedback element specific to this Model

// ===== Module State =====
let _onSaveCallback = null; // Callback to notify settings Model on save

// ===== Initialization =====

/**
 * Initializes the source edit Model module.
 * @param {object} config - Configuration object containing element IDs.
 * @param {string} config.ModelId
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
 * @param {string} config.subdirectoryInputId // 新增：WebDAV 子目录输入框 ID
 * @param {string} config.closeBtnId
 * @param {string} config.cancelBtnId
 * @param {string} config.readOnlyCheckboxId // 新增：只读复选框 ID
 * @param {string} config.feedbackElementId
 * @param {function} onSaveCallback - Function to call when a source is saved (added/edited).
 */
export function initSourceEditModel(config, onSaveCallback) {
    sourceEditModel = document.getElementById(config.ModelId);
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
    sourceEditSubdirectoryInput = document.getElementById(config.subdirectoryInputId); // 获取子目录输入框
    sourceEditCloseBtn = document.getElementById(config.closeBtnId);
    sourceEditCancelBtn = document.getElementById(config.cancelBtnId);
    sourceEditReadOnlyCheckbox = document.getElementById(config.readOnlyCheckboxId); // 获取只读复选框
    sourceEditFeedbackEl = document.getElementById(config.feedbackElementId);

    if (!sourceEditModel || !sourceEditForm || !sourceEditTitle || !sourceEditIdInput ||
        !sourceEditNameInput || !sourceEditTypeSelect || !sourceEditLocalFields ||
        !sourceEditPathInput || !sourceEditBrowseBtn || !sourceEditWebdavFields ||
        !sourceEditUrlInput || !sourceEditUsernameInput || !sourceEditPasswordInput || !sourceEditSubdirectoryInput || // 添加子目录输入框检查
        !sourceEditCloseBtn || !sourceEditCancelBtn || !sourceEditReadOnlyCheckbox || !sourceEditFeedbackEl) { // 添加只读复选框检查
        // Task 1: Error Logging
        logMessage('error', "[SourceEditModel] 初始化失败：一个或多个必需的 DOM 元素未找到。请检查配置中的 ID:", config);
        return;
    }

    _onSaveCallback = onSaveCallback;

    // Attach event listeners
    sourceEditTypeSelect.addEventListener('change', handleSourceTypeChange); // Logging in handler
    // Task 4: Click Event Logging
    sourceEditBrowseBtn.addEventListener('click', () => {
        logMessage('info', '[UI] 点击了浏览文件夹按钮');
        handleBrowseFolder();
    });
    sourceEditForm.addEventListener('submit', handleSourceEditFormSubmit); // Logging in handler
    // Task 4: Click Event Logging
    sourceEditCloseBtn.addEventListener('click', () => {
        logMessage('info', '[UI] 点击了数据源编辑弹窗的关闭按钮');
        closeSourceEditModel();
    });
    sourceEditCancelBtn.addEventListener('click', () => {
        logMessage('info', '[UI] 点击了数据源编辑弹窗的取消按钮');
        closeSourceEditModel();
    });
    sourceEditModel.addEventListener('click', (event) => {
        if (event.target === sourceEditModel) {
             // Task 4: Click Event Logging
            logMessage('info', '[UI] 点击了数据源编辑弹窗的背景遮罩');
            closeSourceEditModel();
        }
    });

    // Initial setup based on default type
    handleSourceTypeChange();
}

// ===== Core Functions =====

/**
 * Opens the Model for adding a new source or editing an existing one.
 * @param {object | null} sourceToEdit - The source object to edit, or null to add a new one.
 */
export function openSourceEditModel(sourceToEdit = null) {
    if (!sourceEditModel || !sourceEditForm) {
        logMessage('error', "[SourceEditModel] openSourceEditModel 失败：弹窗或表单元素未初始化");
        return;
    }
    const mode = sourceToEdit ? '编辑' : '添加';
    logMessage('info', `[SourceEditModel] 开始打开数据源编辑弹窗 (${mode}模式)`);
    clearFeedback(sourceEditFeedbackEl);
    sourceEditForm.reset(); // Clear form fields
    handleSourceTypeChange(); // Ensure correct fields are shown initially

    if (sourceToEdit) {
        // Editing existing source
        logMessage('info', `[SourceEditModel] 填充表单以编辑数据源: ${sourceToEdit.name} (ID: ${sourceToEdit.id})`);
        sourceEditTitle.textContent = t('settings.modelSources.editTitle');
        sourceEditIdInput.value = sourceToEdit.id;
        sourceEditNameInput.value = sourceToEdit.name;
        sourceEditTypeSelect.value = sourceToEdit.type;
        sourceEditReadOnlyCheckbox.checked = sourceToEdit.readOnly === true; // 设置只读复选框状态
        if (sourceToEdit.type === 'local') {
            sourceEditPathInput.value = sourceToEdit.path || '';
        } else if (sourceToEdit.type === 'webdav') {
            sourceEditUrlInput.value = sourceToEdit.url || '';
            sourceEditUsernameInput.value = sourceToEdit.username || '';
            sourceEditPasswordInput.value = sourceToEdit.password || ''; // Be cautious with passwords
            sourceEditSubdirectoryInput.value = sourceToEdit.subDirectory || ''; // 填充子目录
        }
        handleSourceTypeChange(); // Update visible fields based on loaded type
    } else {
        // Adding new source
        logMessage('info', '[SourceEditModel] 准备表单以添加新数据源');
        sourceEditTitle.textContent = t('settings.modelSources.addTitle');
        sourceEditIdInput.value = ''; // Ensure ID is empty for new source
    }
    sourceEditModel.classList.add('active');
    logMessage('info', '[SourceEditModel] 数据源编辑弹窗已打开');
    // 修复：弹窗显示后再刷新 i18n
    updateUIWithTranslations();
    try {
        sourceEditNameInput.focus(); // Focus the name field
        logMessage('debug', '[SourceEditModel] 已聚焦名称输入框');
    } catch (focusError) {
         // Task 1: Error Logging
        logMessage('error', '[SourceEditModel] 聚焦名称输入框时出错:', focusError);
    }
}

/** Closes the source edit Model. */
export function closeSourceEditModel() {
    logMessage('info', '[SourceEditModel] 开始关闭数据源编辑弹窗');
    if (sourceEditModel) {
        sourceEditModel.classList.remove('active');
         logMessage('info', '[SourceEditModel] 数据源编辑弹窗已关闭');
    } else {
        logMessage('warn', '[SourceEditModel] closeSourceEditModel 调用时弹窗元素未初始化');
    }
}

// ===== Event Handlers and Internal Logic =====

/** Handles changes in the source type dropdown to show/hide relevant fields. */
function handleSourceTypeChange() {
    if (!sourceEditTypeSelect || !sourceEditLocalFields || !sourceEditWebdavFields || !sourceEditPathInput || !sourceEditUrlInput) {
         logMessage('error', "[SourceEditModel] handleSourceTypeChange 失败：一个或多个必需的表单字段元素未初始化");
        return;
    }

    const selectedType = sourceEditTypeSelect.value;
     // Task 4: Click Event Logging (Implicit via change)
    logMessage('info', `[UI] 切换数据源类型: ${selectedType}`);
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
        logMessage('warn', `[SourceEditModel] 未知的数据源类型被选中: ${selectedType}`);
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
          logMessage('error', "[SourceEditModel] handleBrowseFolder 失败：浏览按钮或路径输入框未初始化");
         return;
     }
     logMessage('info', "[SourceEditModel] 开始处理浏览文件夹操作");
     sourceEditBrowseBtn.disabled = true; // Disable button during operation
     clearFeedback(sourceEditFeedbackEl);

     try {
         logMessage('info', "[SourceEditModel] 调用 API 打开文件夹选择对话框");
         const selectedPath = await openFolderDialog(); // 使用导入的函数
         if (selectedPath) {
             logMessage('info', `[SourceEditModel] 用户选择了文件夹: ${selectedPath}`);
             sourceEditPathInput.value = selectedPath;
         } else {
              logMessage('info', "[SourceEditModel] 用户取消了文件夹选择");
         }
     } catch (error) {
          // Task 1: Error Logging
         logMessage('error', "[SourceEditModel] 打开文件夹对话框失败:", error.message, error.stack, error);
         showFeedback(sourceEditFeedbackEl, t('settings.folderDialogError', { message: error.message }), 'error');
     } finally {
         sourceEditBrowseBtn.disabled = false; // Re-enable button
         logMessage('info', "[SourceEditModel] 浏览文件夹操作完成");
     }
}

/** Handles the submission of the source edit form. */
function handleSourceEditFormSubmit(event) {
    event.preventDefault(); // Prevent default HTML form submission
     // Task 4: Click Event Logging (Implicit via submit)
    logMessage('info', '[UI] 提交了数据源编辑表单');
    if (!_onSaveCallback) {
         // Task 1: Error Logging
        logMessage('error', "[SourceEditModel] 保存失败：_onSaveCallback 未定义");
        showFeedback(sourceEditFeedbackEl, t('sourceEdit.error.saveCallbackUndefined'), 'error'); // Provide generic user feedback
        return;
    }

    clearFeedback(sourceEditFeedbackEl);
    logMessage('info', '[SourceEditModel] 开始处理表单提交和验证');

    const sourceId = sourceEditIdInput.value;
    const sourceType = sourceEditTypeSelect.value;

    // --- Basic Validation ---
    const sourceName = sourceEditNameInput.value.trim();
    if (!sourceName) {
        // Task 1: Error Logging (Validation)
        const errorMsg = t('settings.validation.sourceNameRequired');
        logMessage('warn', `[SourceEditModel] 验证失败: ${errorMsg}`);
        showFeedback(sourceEditFeedbackEl, errorMsg, 'error');
        sourceEditNameInput.focus();
        return;
    }

    const newSourceData = {
        id: sourceId || Date.now().toString(), // Generate new ID if adding
        name: sourceName,
        type: sourceType,
        readOnly: sourceEditReadOnlyCheckbox.checked, // 从复选框获取只读状态
    };
    logMessage('debug', `[SourceEditModel] 基本数据: ID=${newSourceData.id}, Name=${newSourceData.name}, Type=${newSourceData.type}, ReadOnly=${newSourceData.readOnly}`);

    // --- Type-Specific Validation and Data ---
    if (sourceType === 'local') {
        const pathValue = sourceEditPathInput.value.trim();
        if (!pathValue) {
             // Task 1: Error Logging (Validation)
            const errorMsg = t('settings.validation.pathRequired');
            logMessage('warn', `[SourceEditModel] 验证失败 (local): ${errorMsg}`);
            showFeedback(sourceEditFeedbackEl, errorMsg, 'error');
            sourceEditPathInput.focus();
            return;
        }
        newSourceData.path = pathValue;
        logMessage('debug', `[SourceEditModel] 本地路径: ${pathValue}`);
    } else if (sourceType === 'webdav') {
        const urlValue = sourceEditUrlInput.value.trim();
        if (!urlValue) {
             // Task 1: Error Logging (Validation)
            const errorMsg = t('settings.validation.urlRequired');
            logMessage('warn', `[SourceEditModel] 验证失败 (webdav): ${errorMsg}`);
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
            logMessage('warn', `[SourceEditModel] 验证失败 (webdav): ${errorMsg} - ${urlValue}`);
            showFeedback(sourceEditFeedbackEl, errorMsg, 'error');
            sourceEditUrlInput.focus();
            return;
        }
        newSourceData.url = urlValue;
        newSourceData.username = sourceEditUsernameInput.value.trim();
        newSourceData.password = sourceEditPasswordInput.value; // Get password value (don't trim)
        const subDirectoryValue = sourceEditSubdirectoryInput.value.trim();
        if (subDirectoryValue && !subDirectoryValue.startsWith('/')) {
            // Task 1: Error Logging (Validation)
            const errorMsg = t('settings.validation.subdirectoryInvalidFormat');
            logMessage('warn', `[SourceEditModel] 验证失败 (webdav): ${errorMsg} - ${subDirectoryValue}`);
            showFeedback(sourceEditFeedbackEl, errorMsg, 'error');
            sourceEditSubdirectoryInput.focus();
            return;
        }
        if (subDirectoryValue) {
            newSourceData.subDirectory = subDirectoryValue;
        } else {
            // Ensure subDirectory is not present or is undefined if empty
            delete newSourceData.subDirectory;
        }
        logMessage('debug', `[SourceEditModel] WebDAV URL: ${urlValue}, Username: ${newSourceData.username}, SubDirectory: ${newSourceData.subDirectory}`);
    } else {
         // Task 1: Error Logging (Should not happen)
        const errorMsg = t('settings.validation.typeRequired');
        logMessage('error', `[SourceEditModel] 验证失败：无效的数据源类型 "${sourceType}"`);
        showFeedback(sourceEditFeedbackEl, errorMsg, 'error');
        return; // Should not happen if dropdown is set up correctly
    }

    // --- Call the Save Callback ---
    logMessage('info', `[SourceEditModel] 验证通过，调用保存回调函数，数据:`, newSourceData);
    // The callback provided by settings-modal will handle updating the temp list
    _onSaveCallback(newSourceData);

    closeSourceEditModel(); // Close the Model on successful save
}