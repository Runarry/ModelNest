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
        console.error("One or more source edit modal elements not found. Check IDs:", config);
        return;
    }

    _onSaveCallback = onSaveCallback;

    // Attach event listeners
    sourceEditTypeSelect.addEventListener('change', handleSourceTypeChange);
    sourceEditBrowseBtn.addEventListener('click', handleBrowseFolder);
    sourceEditForm.addEventListener('submit', handleSourceEditFormSubmit);
    sourceEditCloseBtn.addEventListener('click', closeSourceEditModal);
    sourceEditCancelBtn.addEventListener('click', closeSourceEditModal);
    sourceEditModal.addEventListener('click', (event) => {
        if (event.target === sourceEditModal) {
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
    if (!sourceEditModal || !sourceEditForm) return;
    clearFeedback(sourceEditFeedbackEl);
    sourceEditForm.reset(); // Clear form fields
    handleSourceTypeChange(); // Ensure correct fields are shown initially

    if (sourceToEdit) {
        // Editing existing source
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
        sourceEditTitle.textContent = t('settings.modelSources.addTitle');
        sourceEditIdInput.value = ''; // Ensure ID is empty for new source
    }
    console.log('[SourceEditModal] Attempting to open modal. Element:', sourceEditModal);
    sourceEditModal.classList.add('active');
    console.log('[SourceEditModal] Added "active" class. Current classes:', sourceEditModal.className);
    try {
        sourceEditNameInput.focus(); // Focus the name field
        console.log('[SourceEditModal] Focused on name input.');
    } catch (focusError) {
        console.error('[SourceEditModal] Error focusing name input:', focusError);
    }
}

/** Closes the source edit modal. */
export function closeSourceEditModal() {
    if (sourceEditModal) {
        sourceEditModal.classList.remove('active');
    }
}

// ===== Event Handlers and Internal Logic =====

/** Handles changes in the source type dropdown to show/hide relevant fields. */
function handleSourceTypeChange() {
    if (!sourceEditTypeSelect || !sourceEditLocalFields || !sourceEditWebdavFields || !sourceEditPathInput || !sourceEditUrlInput) return;

    const selectedType = sourceEditTypeSelect.value;
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
        sourceEditLocalFields.style.display = 'none';
        sourceEditWebdavFields.style.display = 'none';
        sourceEditPathInput.required = false;
        sourceEditUrlInput.required = false;
    }
}

/** Handles the click event for the browse folder button (for local sources). */
async function handleBrowseFolder() {
    if (!sourceEditBrowseBtn || !sourceEditPathInput) return;

    sourceEditBrowseBtn.disabled = true; // Disable button during operation
    clearFeedback(sourceEditFeedbackEl);

    try {
        const selectedPath = await window.api.openFolderDialog();
        if (selectedPath) {
            sourceEditPathInput.value = selectedPath;
        }
    } catch (error) {
        console.error("Failed to open folder dialog:", error);
        showFeedback(sourceEditFeedbackEl, t('settings.folderDialogError', { message: error.message }), 'error');
    } finally {
        sourceEditBrowseBtn.disabled = false; // Re-enable button
    }
}

/** Handles the submission of the source edit form. */
function handleSourceEditFormSubmit(event) {
    event.preventDefault(); // Prevent default HTML form submission
    if (!_onSaveCallback) {
        console.error("onSaveCallback is not defined in source-edit-modal");
        return;
    }

    clearFeedback(sourceEditFeedbackEl);

    const sourceId = sourceEditIdInput.value;
    const sourceType = sourceEditTypeSelect.value;

    // --- Basic Validation ---
    const sourceName = sourceEditNameInput.value.trim();
    if (!sourceName) {
        showFeedback(sourceEditFeedbackEl, t('settings.validation.sourceNameRequired'), 'error');
        sourceEditNameInput.focus();
        return;
    }

    const newSourceData = {
        id: sourceId || Date.now().toString(), // Generate new ID if adding
        name: sourceName,
        type: sourceType,
    };

    // --- Type-Specific Validation and Data ---
    if (sourceType === 'local') {
        const pathValue = sourceEditPathInput.value.trim();
        if (!pathValue) {
            showFeedback(sourceEditFeedbackEl, t('settings.validation.pathRequired'), 'error');
            sourceEditPathInput.focus();
            return;
        }
        newSourceData.path = pathValue;
    } else if (sourceType === 'webdav') {
        const urlValue = sourceEditUrlInput.value.trim();
        if (!urlValue) {
            showFeedback(sourceEditFeedbackEl, t('settings.validation.urlRequired'), 'error');
            sourceEditUrlInput.focus();
            return;
        }
        // Basic URL validation (optional but recommended)
        try {
            new URL(urlValue); // Check if it's a valid URL structure
        } catch (_) {
            showFeedback(sourceEditFeedbackEl, t('settings.validation.urlInvalid'), 'error');
            sourceEditUrlInput.focus();
            return;
        }
        newSourceData.url = urlValue;
        newSourceData.username = sourceEditUsernameInput.value.trim();
        newSourceData.password = sourceEditPasswordInput.value; // Get password value (don't trim)
    } else {
        showFeedback(sourceEditFeedbackEl, t('settings.validation.typeRequired'), 'error');
        return; // Should not happen if dropdown is set up correctly
    }

    // --- Call the Save Callback ---
    // The callback provided by settings-modal will handle updating the temp list
    _onSaveCallback(newSourceData);

    closeSourceEditModal(); // Close the modal on successful save
}