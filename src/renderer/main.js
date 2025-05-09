import './styles/index.css'; // 导入主 CSS 文件
// Import necessary initialization functions and utilities
import { initThemeSwitcher } from './js/utils/theme.js';
// Import updateSingleModelCard along with other functions
import { initMainView, loadModels as loadModelsForView, renderSources, updateSingleModelCard } from './js/components/main-view.js';
import { initDetailModel, showDetailModel, hideDetailModel } from './js/components/detail-model.js';
import { initsettingsModal } from './js/components/settings-modal.js';
// ui-utils are mostly used internally by other modules, but setLoading might be useful here
import { setLoading } from './js/utils/ui-utils.js';
// Import initializeI18n, t, and updateUIWithTranslations.
import { initializeI18n, t, updateUIWithTranslations } from './js/core/i18n.js';
import { logMessage } from './js/apiBridge.js';

// 全局错误与未处理 Promise 拒绝上报到主进程日志
window.onerror = function (message, source, lineno, colno, error) {
  if (window.api && typeof window.api.sendRendererError === 'function') {
    window.api.sendRendererError({
      type: 'window.onerror',
      message: message,
      stack: error && error.stack,
      source,
      lineno,
      colno,
      url: window.location.href,
      time: new Date().toISOString()
    });
  }
};
window.addEventListener('unhandledrejection', function (event) {
  if (window.api && typeof window.api.sendRendererError === 'function') {
    window.api.sendRendererError({
      type: 'unhandledrejection',
      message: event.reason && event.reason.message ? event.reason.message : String(event.reason),
      stack: event.reason && event.reason.stack,
      url: window.location.href,
      time: new Date().toISOString()
    });
  }
});
// i18n functions are now imported from the core module

document.addEventListener('DOMContentLoaded', async () => {
  logMessage('info', "[Renderer] DOMContentLoaded - 开始初始化渲染器模块...");
  const initStartTime = Date.now();

  // ===== 1. Initialize i18n =====
  logMessage('info', "[Renderer] 初始化 i18n...");

  // Removed definition of updateUIWithTranslations() from here, it's now imported from i18n.js


  // Call the new initialization function
  try {
      await initializeI18n(); // This handles loading the correct locale based on config/defaults
      updateUIWithTranslations(); // Apply translations after successful initialization
      logMessage('info', "[Renderer] i18n 初始化完成");
  } catch (error) {
      // Error logging is handled within initializeI18n and loadLocale
      logMessage('error', "[Renderer] i18n 初始化过程中发生未捕获错误:", error.message, error.stack);
      showInitializationError("Failed to initialize language settings.");
      // Stop further initialization if i18n fails critically
      return;
  }

  // Removed languageSelect related code (renderLanguageOptions, event listener) as it's moved to settings

  // ===== 2. Initialize UI Modules =====
  logMessage('info', "[Renderer] 初始化 UI 模块...");
  try {
      initThemeSwitcher();

      // Configuration for main view module
      const mainViewConfig = {
        sourceSelectId: 'sourceSelect',
        // filterSelectId: 'filterSelect', // Old filter, no longer actively used by main-view.js for new filter panel
        modelListId: 'modelList',
        cardViewBtnId: 'cardViewBtn',
        listViewBtnId: 'listViewBtn',
        directoryTabsSelector: '.directory-tabs', // Selector for the container
        crawlInfoButtonId: 'crawl-info-button', // 新增：爬虫按钮 ID
        sourceReadonlyIndicatorId: 'source-readonly-indicator', // 新增：只读指示器 ID
        openFilterPanelBtnId: 'open-filter-panel-btn', // ID for the button that opens the new filter panel
        filterPanelContainerId: 'filter-panel-main-container' // ID for the div that will contain the filter panel
      };
  // Pass showDetailModel (from detail-Model module) as the callback
  initMainView(mainViewConfig, (modelData, sourceId, isReadOnlyFlag) => { // Accept all params from main-view's _showDetail call
      // Use the sourceId and isReadOnlyFlag passed directly from main-view
      if (sourceId) {
          showDetailModel(modelData, sourceId, isReadOnlyFlag);
      } else {
           // Task 1: Error Logging (Should ideally not happen if UI is consistent)
          logMessage('error', "[Renderer] 无法显示详情：main-view 未能在回调中提供 sourceId");
          // Optionally show user feedback
      }
  });

  // Configuration for detail Model module
  const detailModelConfig = {
    ModelId: 'detailModel',
    nameId: 'detailName',
    imageId: 'detailImage',
    descriptionContainerId: 'detailDescription', // Container for tabs/inputs
    closeBtnId: 'detailClose'
  };
  initDetailModel(detailModelConfig);

   // Configuration for settings Model module, including sub-Model config
   const settingsModalConfig = {
       ModelId: 'settingsModal',
       openBtnId: 'settingsBtn',
       closeBtnId: 'settingsClose',
       // Removed: saveBtnId, cancelBtnId, formId, feedbackElementId as they are no longer used globally
       // The new structure handles actions within specific panes or via the close button.
   };
   const sourceEditModelConfig = { // Config for the sub-Model
       ModelId: 'sourceEditModel',
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
   initsettingsModal(settingsModalConfig, sourceEditModelConfig); // Logging inside initsettingsModal if needed

   logMessage('info', "[Renderer] UI 模块初始化完成");

 } catch (moduleInitError) {
      // Task 1: Error Logging
      logMessage('error', "[Renderer] 初始化 UI 模块时出错:", moduleInitError.message, moduleInitError.stack, moduleInitError);
      showInitializationError("Failed to initialize UI components.");
      return; // Stop further execution
 }


 // ===== 3. Initial Data Load =====
 async function loadInitialData() {
     logMessage('info', "[Renderer] 开始加载初始数据 (配置和模型)...");
     const loadStartTime = Date.now();
     setLoading(true);
     try {
         logMessage('debug', "[Renderer] 调用 API 获取配置");
         const config = await window.api.getConfig();
         logMessage('debug', "[Renderer] 获取到的配置:", config);
         const sources = config?.modelSources || [];
         renderSources(sources); // Update the source dropdown via main-view module

         const sourceSelectElement = document.getElementById('sourceSelect');
         if (!sourceSelectElement) {
              // Task 1: Error Logging (Critical UI element missing after init)
              logMessage('error', "[Renderer] 加载初始数据失败：找不到数据源选择元素 #sourceSelect");
              throw new Error("Source selection UI element is missing.");
         }

         if (sources.length > 0) {
             // If a source was already selected, keep it, otherwise select the first
             const selectedSourceId = sourceSelectElement.value || sources[0].id;
             logMessage('info', `[Renderer] 找到 ${sources.length} 个数据源，将加载源: ${selectedSourceId}`);
             sourceSelectElement.value = selectedSourceId; // Ensure value is set
             await loadModelsForView(selectedSourceId, null); // Load models for the selected source (root dir) - logging inside this function
         } else {
             logMessage('info', "[Renderer] 未找到配置的数据源");
             // Clear model list etc. if needed (handled within loadModelsForView on error/empty)
             await loadModelsForView(null, null); // Trigger empty state rendering
         }
         document.getElementById('mainSection').style.display = 'grid'; // Show main content
         const loadDuration = Date.now() - loadStartTime;
         logMessage('info', `[Renderer] 初始数据加载成功, 耗时: ${loadDuration}ms`);
     } catch (e) {
          const loadDuration = Date.now() - loadStartTime;
          // Task 1: Error Logging
         logMessage('error', `[Renderer] 加载初始配置或模型失败, 耗时: ${loadDuration}ms`, e.message, e.stack, e);
         // Display error to user?
         showInitializationError(`Failed to load initial configuration or models: ${e.message}`);
     } finally {
         setLoading(false);
     }
 }

 await loadInitialData(); // Load data after modules are initialized


 // ===== 4. Event Listeners =====

  // Listen for configuration updates from the main process
  logMessage('info', "[Renderer] 设置事件监听器...");
  // Listen for configuration updates from the main process
  window.api.onConfigUpdated(async () => {
      logMessage('info', '[Renderer] 收到 config-updated 事件，重新加载初始数据');
      // Show feedback to the user that settings were applied?
      // Re-load sources and models
      await loadInitialData();
  });

  // Listen for model updates (e.g., after saving in detail Model)
   window.addEventListener('model-updated', (event) => {
       logMessage('info', '[Renderer] 收到 model-updated 事件:', event.detail);
       // Call the new function to update only the specific card
       if (event.detail) {
           updateSingleModelCard(event.detail);
       } else {
           logMessage('warn', '[Renderer] 收到 model-updated 事件，但 event.detail 为空，无法更新卡片');
       }
   });

  // Helper function to display critical initialization errors
   function showInitializationError(message) {
        const mainSection = document.getElementById('mainSection');
        const loadingIndicator = document.getElementById('loadingIndicator');
        if (loadingIndicator) loadingIndicator.style.display = 'none'; // Hide loading indicator
        if (mainSection) {
            mainSection.innerHTML = `<p class="error-message" style="padding: 20px; text-align: center;">${message}<br>Please check the developer console (Ctrl+Shift+I) for more details.</p>`;
            mainSection.style.display = 'block'; // Ensure the error is visible
        } else {
            // Fallback if even mainSection is missing
            document.body.innerHTML = `<p style="color: red; padding: 20px;">${message}</p>`;
        }
   }

  const initDuration = Date.now() - initStartTime;
  logMessage('info', `[Renderer] 渲染器初始化完成, 总耗时: ${initDuration}ms`);
});