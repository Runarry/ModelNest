// Import necessary initialization functions and utilities
import { initThemeSwitcher } from './ui.js';
import { initMainView, loadModels as loadModelsForView, renderSources } from './main-view.js';
import { initDetailModal, showDetailModal, hideDetailModal } from './detail-modal.js';
import { initSettingsModal } from './settings-modal.js';
// ui-utils are mostly used internally by other modules, but setLoading might be useful here
import { setLoading } from './ui-utils.js';

// i18n is loaded globally via script tag in index.html, but we can reference it
const { loadLocale, t, getCurrentLocale, getSupportedLocales } = window.i18n;

document.addEventListener('DOMContentLoaded', async () => {
  console.log("Renderer DOMContentLoaded - Initializing application modules...");

  // ===== 1. Initialize i18n =====
  const languageSelect = document.getElementById('languageSelect');
  if (!languageSelect) {
      console.error("Language select element not found!");
      return; // Stop initialization if critical elements are missing
  }

  // Render language dropdown options
  function renderLanguageOptions() {
    const locales = getSupportedLocales();
    languageSelect.innerHTML = ''; // Use clearChildren if preferred
    locales.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = l.name;
      languageSelect.appendChild(opt);
    });
    languageSelect.value = getCurrentLocale();
  }

  // Set initial texts based on loaded locale
  function setStaticI18nTexts() {
      // Only set texts not handled by specific modules during their rendering
      document.getElementById('appTitle').textContent = t('appTitle');
      document.getElementById('cardViewBtn').title = t('viewCard');
      document.getElementById('listViewBtn').title = t('viewList');
      document.getElementById('loadingModels').textContent = t('loadingModels');
      document.getElementById('settingsBtn').title = t('settings.title');
      // Detail modal image alt is set dynamically within detail-modal
      // Settings/SourceEdit modal static texts are set within their respective modules if needed,
      // but ideally defined directly in index.html with data-i18n attributes.
      // Let's assume most static texts are now in HTML or handled by modules.
  }

  // Load initial locale and set up listener
  try {
      await loadLocale(getCurrentLocale());
      renderLanguageOptions();
      setStaticI18nTexts(); // Set initial static texts
  } catch (error) {
      console.error("Failed to load initial locale:", error);
      // Handle error appropriately, maybe default to a known locale
  }

  languageSelect.addEventListener('change', async () => {
    setLoading(true);
    try {
        await loadLocale(languageSelect.value);
        // Re-render necessary parts or reload data
        setStaticI18nTexts(); // Update static texts
        // Reloading data will trigger re-renders in modules which use 't'
        await loadInitialData();
        // Potentially notify modules if they need explicit refresh beyond data reload
    } catch (error) {
        console.error("Failed to switch locale:", error);
    } finally {
        setLoading(false);
    }
  });


  // ===== 2. Initialize UI Modules =====
  initThemeSwitcher();

  // Configuration for main view module
  const mainViewConfig = {
    sourceSelectId: 'sourceSelect',
    filterSelectId: 'filterSelect',
    modelListId: 'modelList',
    cardViewBtnId: 'cardViewBtn',
    listViewBtnId: 'listViewBtn',
    directoryTabsSelector: '.directory-tabs' // Selector for the container
  };
  // Pass showDetailModal (from detail-modal module) as the callback
  initMainView(mainViewConfig, (model) => {
      const currentSourceId = document.getElementById('sourceSelect')?.value;
      if (currentSourceId) {
          showDetailModal(model, currentSourceId);
      } else {
          console.error("Cannot show detail, no source selected.");
          // Optionally show user feedback
      }
  });

  // Configuration for detail modal module
  const detailModalConfig = {
    modalId: 'detailModal',
    nameId: 'detailName',
    imageId: 'detailImage',
    descriptionContainerId: 'detailDescription', // Container for tabs/inputs
    closeBtnId: 'detailClose'
  };
  initDetailModal(detailModalConfig);

   // Configuration for settings modal module, including sub-modal config
   const settingsModalConfig = {
       modalId: 'settingsModal',
       openBtnId: 'settingsBtn',
       closeBtnId: 'settingsClose',
       saveBtnId: 'settingsSaveBtn',
       cancelBtnId: 'settingsCancelBtn',
       formId: 'settingsForm', // Make sure index.html has form with this ID
       feedbackElementId: 'settingsFeedback'
   };
   const sourceEditModalConfig = { // Config for the sub-modal
       modalId: 'sourceEditModal',
       formId: 'sourceEditForm',
       titleId: 'sourceEditTitle',
       idInputId: 'sourceEditId',
       nameInputId: 'sourceEditName',
       typeSelectId: 'sourceEditType',
       localFieldsId: 'sourceEditLocalFields',
       pathInputId: 'sourceEditPath',
       browseBtnId: 'sourceEditBrowseBtn',
       webdavFieldsId: 'sourceEditWebdavFields',
       urlInputId: 'sourceEditUrl',
       usernameInputId: 'sourceEditUsername',
       passwordInputId: 'sourceEditPassword',
       closeBtnId: 'sourceEditClose',
       cancelBtnId: 'sourceEditCancelBtn',
       feedbackElementId: 'sourceEditFeedback'
   };
   initSettingsModal(settingsModalConfig, sourceEditModalConfig);


  // ===== 3. Initial Data Load =====
  async function loadInitialData() {
      console.log("Loading initial data (sources and models)...");
      setLoading(true);
      try {
          const config = await window.api.getConfig();
          const sources = config.modelSources || [];
          renderSources(sources); // Update the source dropdown via main-view module

          const sourceSelectElement = document.getElementById('sourceSelect');
          if (sources.length > 0 && sourceSelectElement) {
              // If a source was already selected, keep it, otherwise select the first
              const selectedSourceId = sourceSelectElement.value || sources[0].id;
              sourceSelectElement.value = selectedSourceId; // Ensure value is set
              await loadModelsForView(selectedSourceId, null); // Load models for the selected source (root dir)
          } else {
              console.log("No sources found or source select element missing.");
              // Clear model list etc. if needed (handled within loadModelsForView on error/empty)
              await loadModelsForView(null, null); // Trigger empty state rendering
          }
          document.getElementById('mainSection').style.display = 'grid'; // Show main content
      } catch (e) {
          console.error('加载初始配置或模型失败:', e);
          // Display error to user?
          document.getElementById('mainSection').innerHTML = `<p class="error-message">Failed to load initial configuration: ${e.message}</p>`;
      } finally {
          setLoading(false);
      }
  }

  await loadInitialData(); // Load data after modules are initialized


  // ===== 4. Event Listeners =====

  // Listen for configuration updates from the main process
  window.api.onConfigUpdated(async () => {
      console.log('[Renderer] Received config-updated event. Reloading initial data.');
      // Show feedback to the user that settings were applied?
      // Re-load sources and models
      await loadInitialData();
  });

  // Listen for model updates (e.g., after saving in detail modal)
   window.addEventListener('model-updated', (event) => {
       console.log('[Renderer] Received model-updated event:', event.detail);
       // TODO: Implement more granular update instead of full reload?
       // For now, just reload models for the current source/directory
       const currentSourceId = document.getElementById('sourceSelect')?.value;
       // Need to know the current directory from main-view state if possible,
       // otherwise, just reload the root for simplicity.
       if (currentSourceId) {
           console.log("Reloading models for current source after update...");
           loadModelsForView(currentSourceId, null); // Reload root for now
       }
   });


  console.log("Renderer initialization complete.");
});