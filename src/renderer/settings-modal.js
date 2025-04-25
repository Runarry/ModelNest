import { showFeedback, clearFeedback, clearChildren } from './ui-utils.js';
import { openSourceEditModal, initSourceEditModal } from './source-edit-modal.js'; // Import functions for the sub-modal

// Assume i18n is initialized and 't' is available globally or passed/imported
const t = window.i18n?.t || ((key) => key); // Fallback

// ===== DOM Element References =====
let settingsModal;
let settingsBtn; // The button that opens the settings modal
let settingsCloseBtn;
let settingsSaveBtn;
let settingsCancelBtn;
let settingsForm;
let settingsFeedbackEl; // Feedback element specific to this modal
let sourceListContainer; // Element within the form to hold the list of sources

// ===== Module State =====
let tempModelSources = []; // Temporary state for editing sources

// ===== Initialization =====

/**
 * Initializes the settings modal module.
 * @param {object} config - Configuration object containing element IDs.
 * @param {string} config.modalId
 * @param {string} config.openBtnId - ID of the button that opens this modal.
 * @param {string} config.closeBtnId
 * @param {string} config.saveBtnId
 * @param {string} config.cancelBtnId
 * @param {string} config.formId
 * @param {string} config.feedbackElementId
 * @param {object} sourceEditModalConfig - Config object to pass to initSourceEditModal.
 */
export function initSettingsModal(config, sourceEditModalConfig) {
    settingsModal = document.getElementById(config.modalId);
    settingsBtn = document.getElementById(config.openBtnId);
    settingsCloseBtn = document.getElementById(config.closeBtnId);
    settingsSaveBtn = document.getElementById(config.saveBtnId);
    settingsCancelBtn = document.getElementById(config.cancelBtnId);
    settingsForm = document.getElementById(config.formId);
    settingsFeedbackEl = document.getElementById(config.feedbackElementId);

    if (!settingsModal || !settingsBtn || !settingsCloseBtn || !settingsSaveBtn ||
        !settingsCancelBtn || !settingsForm || !settingsFeedbackEl) {
        console.error("One or more settings modal elements not found. Check IDs:", config);
        return;
    }

    // Initialize the source edit modal (it's controlled from here)
    initSourceEditModal(sourceEditModalConfig, handleSourceSaved); // Pass the callback

    // Attach event listeners
    settingsBtn.addEventListener('click', openSettingsModal);
    settingsCloseBtn.addEventListener('click', closeSettingsModal);
    settingsCancelBtn.addEventListener('click', closeSettingsModal);
    settingsSaveBtn.addEventListener('click', handleSaveSettings);

    // Close modal if clicking on the backdrop
    settingsModal.addEventListener('click', (event) => {
        if (event.target === settingsModal) {
            closeSettingsModal();
        }
    });
}

// ===== Core Functions =====

/** Opens the settings modal and loads the current configuration. */
function openSettingsModal() {
    if (!settingsModal) return;
    console.log("Opening settings modal...");
    clearFeedback(settingsFeedbackEl);
    settingsModal.classList.add('active');
    loadConfigForSettings(); // Load config when opening
}

/** Closes the settings modal. */
function closeSettingsModal() {
    if (settingsModal) {
        settingsModal.classList.remove('active');
        // Clear temporary state when closing without saving
        tempModelSources = [];
    }
}

// ===== Internal Logic =====

/** Loads the current config from the main process and populates the settings form. */
async function loadConfigForSettings() {
    if (!settingsForm) return;
    settingsForm.innerHTML = '<p>Loading settings...</p>'; // Placeholder while loading

    try {
        const currentConfig = await window.api.getConfig();
        console.log("Loaded config for settings:", currentConfig);

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
        addSourceBtn.addEventListener('click', () => openSourceEditModal(null)); // Open sub-modal for adding
        sourcesSection.appendChild(addSourceBtn);

        // --- Render Supported Extensions ---
        const extensionsSection = document.createElement('div');
        extensionsSection.className = 'settings-section';
        extensionsSection.innerHTML = `
          <h3>${t('settings.extensions.title')}</h3>
          <div class="form-group">
            <label for="supportedExtensions">${t('settings.extensions.label')}</label>
            <textarea id="supportedExtensions" name="supportedExtensions" rows="3">${(currentConfig.supportedExtensions || []).join(', ')}</textarea>
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
            <label for="imageCacheQuality">${t('settings.imageCache.quality')} (0-100)</label>
            <input type="number" id="imageCacheQuality" name="imageCacheQuality" min="0" max="100" value="${cacheConfig.compressQuality ?? 80}">
          </div>
          <div class="form-group">
            <label for="imageCacheFormat">${t('settings.imageCache.format')}</label>
            <select id="imageCacheFormat" name="imageCacheFormat">
              <option value="jpeg" ${cacheConfig.compressFormat === 'jpeg' ? 'selected' : ''}>JPEG</option>
              <option value="webp" ${cacheConfig.compressFormat === 'webp' ? 'selected' : ''}>WebP</option>
              <option value="png" ${cacheConfig.compressFormat === 'png' ? 'selected' : ''}>PNG</option>
            </select>
          </div>
          <div class="form-group">
            <label for="imageCacheSize">${t('settings.imageCache.maxSize')} (MB)</label>
            <input type="number" id="imageCacheSize" name="imageCacheSize" min="0" value="${cacheConfig.maxCacheSizeMB ?? 500}">
          </div>
        `;
        settingsForm.appendChild(cacheSection);

    } catch (error) {
        console.error("Failed to load config for settings:", error);
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
        console.log(`[SettingsModal] Found edit button for source "${source.name}":`, editButton); // Log found button
        if (editButton) {
            editButton.addEventListener('click', (e) => {
                console.log(`[SettingsModal] Edit button clicked for source "${source.name}"`); // Log click event
                e.stopPropagation(); // Prevent li click if needed
                openSourceEditModal(source); // Pass the source object to edit
            });
        } else {
            console.error(`[SettingsModal] Could not find edit button for source "${source.name}"`);
        }
        const deleteButton = item.querySelector('.delete-btn');
        // console.log(`[SettingsModal] Found delete button for source "${source.name}":`, deleteButton); // Optional: Log delete button too
        if (deleteButton) {
            deleteButton.addEventListener('click', (e) => {
                e.stopPropagation();
                handleDeleteSource(source.id);
            });
        }

        sourceListContainer.appendChild(item);
    });
}

/** Handles the deletion of a model source from the temporary list. */
function handleDeleteSource(sourceId) {
    // TODO: Replace confirm with a custom confirmation UI later
    if (!confirm(t('settings.modelSources.deleteConfirm'))) {
        return;
    }
    const index = tempModelSources.findIndex(s => s.id === sourceId);
    if (index !== -1) {
        tempModelSources.splice(index, 1);
        console.log("Deleted source with ID from temp list:", sourceId);
        renderSourceListForSettings(); // Re-render the list
    } else {
        console.error("Source ID not found for deletion in temp list:", sourceId);
    }
}

/**
 * Callback function passed to source-edit-modal.
 * Updates the temporary list when a source is added or edited.
 * @param {object} savedSourceData - The source data returned from the edit modal.
 */
function handleSourceSaved(savedSourceData) {
    const existingIndex = tempModelSources.findIndex(s => s.id === savedSourceData.id);
    if (existingIndex !== -1) {
        // Editing existing: Replace in temp list
        tempModelSources[existingIndex] = savedSourceData;
        console.log("Updated source in temp list:", savedSourceData);
    } else {
        // Adding new: Push to temp list
        tempModelSources.push(savedSourceData);
        console.log("Added new source to temp list:", savedSourceData);
    }
    renderSourceListForSettings(); // Re-render the list in the settings modal
}


/** Handles saving the entire settings configuration. */
async function handleSaveSettings() {
    if (!settingsForm) return;
    console.log("Save settings clicked...");

    clearFeedback(settingsFeedbackEl);
    settingsSaveBtn.disabled = true;
    settingsSaveBtn.textContent = t('settings.saving'); // Indicate progress

    try {
        // 1. Construct the new config object using tempModelSources
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
            .map(ext => ext.trim().replace(/^\./, '')) // Trim and remove leading dots
            .filter(ext => ext.length > 0);

        // Image Cache
        newConfig.imageCache.debug = formData.has('imageCacheDebug'); // Checkbox value
        const quality = parseInt(formData.get('imageCacheQuality') || '80', 10);
        const size = parseInt(formData.get('imageCacheSize') || '500', 10);
        newConfig.imageCache.compressFormat = formData.get('imageCacheFormat') || 'jpeg';

        // 3. Basic validation for numbers
        if (isNaN(quality) || quality < 0 || quality > 100) {
            showFeedback(settingsFeedbackEl, t('settings.validation.qualityError'), 'error');
            settingsForm.querySelector('#imageCacheQuality')?.focus();
            throw new Error("Validation failed"); // Throw to prevent saving
        }
        newConfig.imageCache.compressQuality = quality;

        if (isNaN(size) || size < 0) {
            showFeedback(settingsFeedbackEl, t('settings.validation.sizeError'), 'error');
            settingsForm.querySelector('#imageCacheSize')?.focus();
            throw new Error("Validation failed"); // Throw to prevent saving
        }
        newConfig.imageCache.maxCacheSizeMB = size;


        console.log("Saving new config:", newConfig);

        // 4. Send to main process
        await window.api.saveConfig(newConfig);

        // 5. Handle success
        showFeedback(settingsFeedbackEl, t('settings.saveSuccess'), 'success', 2000);
        setTimeout(closeSettingsModal, 2100); // Close after feedback
        // Main process should notify renderer via 'config-updated' to reload state

    } catch (error) {
        console.error("Failed to save settings:", error);
        // Don't show feedback if validation already did
        if (!settingsFeedbackEl.textContent) {
             showFeedback(settingsFeedbackEl, t('settings.saveError', { message: error.message }), 'error');
        }
    } finally {
        // Re-enable button and restore text only if modal didn't close
         if (settingsModal.classList.contains('active')) {
            settingsSaveBtn.disabled = false;
            settingsSaveBtn.textContent = t('settings.save');
         }
    }
}