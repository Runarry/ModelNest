// Import necessary initialization functions and utilities
import { initThemeSwitcher } from './ui.js';
import { initMainView, loadModels as loadModelsForView, renderSources } from './main-view.js';
import { initDetailModel, showDetailModel, hideDetailModel } from './detail-model.js';
import { initSettingsModel } from './settings-model.js';
// ui-utils are mostly used internally by other modules, but setLoading might be useful here
import { setLoading } from './ui-utils.js';

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
// i18n is loaded globally via script tag in index.html, but we can reference it
const { loadLocale, t, getCurrentLocale, getSupportedLocales } = window.i18n;

document.addEventListener('DOMContentLoaded', async () => {
  window.api.logMessage('info', "[Renderer] DOMContentLoaded - 开始初始化渲染器模块...");
  const initStartTime = Date.now();

  // ===== 1. Initialize i18n =====
  window.api.logMessage('info', "[Renderer] 初始化 i18n...");
  const languageSelect = document.getElementById('languageSelect');
  if (!languageSelect) {
      // Task 1: Error Logging
      window.api.logMessage('error', "[Renderer] 初始化失败：找不到语言选择元素 #languageSelect");
      // Optionally display a user-facing error message here
      document.body.innerHTML = '<p style="color: red; padding: 20px;">Initialization Error: UI components missing. Please check the console.</p>';
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

  // Update UI elements with data-i18n attributes (Optimized Version)
  function updateUIWithTranslations() {
    window.api.logMessage('debug', '[Renderer] 开始更新 UI 翻译 (优化版)...');
    // Use a combined selector to fetch all relevant elements at once
    const elements = document.querySelectorAll('[data-i18n-key], [data-i18n-title-key], [data-i18n-placeholder-key]');
    const startTime = performance.now(); // Optional: for performance measurement

    elements.forEach(el => {
      // Check for data-i18n-key and apply translation to textContent or value
      if (el.hasAttribute('data-i18n-key')) {
        const key = el.getAttribute('data-i18n-key');
        const translation = t(key);
        if (translation !== key) {
          // Prioritize 'value' attribute for inputs/buttons if present
          if (el.hasAttribute('value') && (el.tagName === 'INPUT' || el.tagName === 'BUTTON')) {
              el.value = translation;
          // Otherwise, update textContent for most elements
          } else if (el.textContent !== undefined && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') { // Avoid overwriting input/textarea content unless intended
              el.textContent = translation;
          }
          // Note: This logic assumes 'data-i18n-key' primarily targets text content or button values.
          // Placeholders and titles are handled by their specific attributes below.
        } else {
          window.api.logMessage('warn', `[i18n] 翻译 key 未找到: ${key} (元素: ${el.tagName}#${el.id})`);
        }
      }

      // Check for data-i18n-title-key and apply translation to title
      if (el.hasAttribute('data-i18n-title-key')) {
        const key = el.getAttribute('data-i18n-title-key');
        const translation = t(key);
        if (translation !== key) {
          el.title = translation;
        } else {
          window.api.logMessage('warn', `[i18n] 翻译 title key 未找到: ${key} (元素: ${el.tagName}#${el.id})`);
        }
      }

      // Check for data-i18n-placeholder-key and apply translation to placeholder
      if (el.hasAttribute('data-i18n-placeholder-key')) {
        const key = el.getAttribute('data-i18n-placeholder-key');
        const translation = t(key);
        if (translation !== key) {
          el.placeholder = translation;
        } else {
          window.api.logMessage('warn', `[i18n] 翻译 placeholder key 未找到: ${key} (元素: ${el.tagName}#${el.id})`);
        }
      }
    });

    const endTime = performance.now(); // Optional
    window.api.logMessage('debug', `[Renderer] UI 翻译更新完成 (优化版), 耗时: ${(endTime - startTime).toFixed(2)}ms, 处理了 ${elements.length} 个元素`);
  }


  // Load initial locale and set up listener
  try {
      window.api.logMessage('debug', `[Renderer] 加载初始区域设置: ${getCurrentLocale()}`);
      await loadLocale(getCurrentLocale());
      renderLanguageOptions();
      updateUIWithTranslations(); // Apply translations using the new function
      window.api.logMessage('info', "[Renderer] i18n 初始化完成");
  } catch (error) {
       // Task 1: Error Logging
      window.api.logMessage('error', "[Renderer] 加载初始区域设置失败:", error.message, error.stack, error);
      // Handle error appropriately, maybe default to a known locale or show error message
      showInitializationError("Failed to load language settings.");
  }

  languageSelect.addEventListener('change', async () => {
    const newLocale = languageSelect.value;
    window.api.logMessage('info', `[UI] 切换语言到: ${newLocale}`);
    setLoading(true);
    try {
        await loadLocale(newLocale);
        // Re-render necessary parts or reload data
        updateUIWithTranslations(); // Update UI with new translations
        // Reloading data might still be necessary if dynamic content relies on locale-specific data fetching/formatting
        // but for pure text translation, updateUIWithTranslations should handle most cases.
        // Let's keep loadInitialData for now as it might re-render components using t() internally.
        await loadInitialData();
        window.api.logMessage('info', `[Renderer] 语言切换成功: ${newLocale}`);
    } catch (error) {
         // Task 1: Error Logging
        window.api.logMessage('error', `[Renderer] 切换区域设置失败: ${newLocale}`, error.message, error.stack, error);
        // Optionally show feedback to the user
    } finally {
        setLoading(false);
    }
  });


  // ===== 2. Initialize UI Modules =====
  window.api.logMessage('info', "[Renderer] 初始化 UI 模块...");
  try {
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
  // Pass showDetailModel (from detail-Model module) as the callback
  initMainView(mainViewConfig, (model) => {
      const currentSourceId = document.getElementById('sourceSelect')?.value;
      if (currentSourceId) {
          showDetailModel(model, currentSourceId); // Logging inside showDetailModel
      } else {
           // Task 1: Error Logging (Should ideally not happen if UI is consistent)
          window.api.logMessage('error', "[Renderer] 无法显示详情：未选择数据源 (main-view 回调)");
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
   const settingsModelConfig = {
       ModelId: 'settingsModel',
       openBtnId: 'settingsBtn',
       closeBtnId: 'settingsClose',
       saveBtnId: 'settingsSaveBtn',
       cancelBtnId: 'settingsCancelBtn',
       formId: 'settingsForm', // Make sure index.html has form with this ID
       feedbackElementId: 'settingsFeedback'
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
   initSettingsModel(settingsModelConfig, sourceEditModelConfig); // Logging inside initSettingsModel if needed

   window.api.logMessage('info', "[Renderer] UI 模块初始化完成");

 } catch (moduleInitError) {
      // Task 1: Error Logging
      window.api.logMessage('error', "[Renderer] 初始化 UI 模块时出错:", moduleInitError.message, moduleInitError.stack, moduleInitError);
      showInitializationError("Failed to initialize UI components.");
      return; // Stop further execution
 }


 // ===== 3. Initial Data Load =====
 async function loadInitialData() {
     window.api.logMessage('info', "[Renderer] 开始加载初始数据 (配置和模型)...");
     const loadStartTime = Date.now();
     setLoading(true);
     try {
         window.api.logMessage('debug', "[Renderer] 调用 API 获取配置");
         const config = await window.api.getConfig();
         window.api.logMessage('debug', "[Renderer] 获取到的配置:", config);
         const sources = config?.modelSources || [];
         renderSources(sources); // Update the source dropdown via main-view module

         const sourceSelectElement = document.getElementById('sourceSelect');
         if (!sourceSelectElement) {
              // Task 1: Error Logging (Critical UI element missing after init)
              window.api.logMessage('error', "[Renderer] 加载初始数据失败：找不到数据源选择元素 #sourceSelect");
              throw new Error("Source selection UI element is missing.");
         }

         if (sources.length > 0) {
             // If a source was already selected, keep it, otherwise select the first
             const selectedSourceId = sourceSelectElement.value || sources[0].id;
             window.api.logMessage('info', `[Renderer] 找到 ${sources.length} 个数据源，将加载源: ${selectedSourceId}`);
             sourceSelectElement.value = selectedSourceId; // Ensure value is set
             await loadModelsForView(selectedSourceId, null); // Load models for the selected source (root dir) - logging inside this function
         } else {
             window.api.logMessage('info', "[Renderer] 未找到配置的数据源");
             // Clear model list etc. if needed (handled within loadModelsForView on error/empty)
             await loadModelsForView(null, null); // Trigger empty state rendering
         }
         document.getElementById('mainSection').style.display = 'grid'; // Show main content
         const loadDuration = Date.now() - loadStartTime;
         window.api.logMessage('info', `[Renderer] 初始数据加载成功, 耗时: ${loadDuration}ms`);
     } catch (e) {
          const loadDuration = Date.now() - loadStartTime;
          // Task 1: Error Logging
         window.api.logMessage('error', `[Renderer] 加载初始配置或模型失败, 耗时: ${loadDuration}ms`, e.message, e.stack, e);
         // Display error to user?
         showInitializationError(`Failed to load initial configuration or models: ${e.message}`);
     } finally {
         setLoading(false);
     }
 }

 await loadInitialData(); // Load data after modules are initialized


 // ===== 4. Event Listeners =====

  // Listen for configuration updates from the main process
  window.api.logMessage('info', "[Renderer] 设置事件监听器...");
  // Listen for configuration updates from the main process
  window.api.onConfigUpdated(async () => {
      window.api.logMessage('info', '[Renderer] 收到 config-updated 事件，重新加载初始数据');
      // Show feedback to the user that settings were applied?
      // Re-load sources and models
      await loadInitialData();
  });

  // Listen for model updates (e.g., after saving in detail Model)
   window.addEventListener('model-updated', (event) => {
       window.api.logMessage('info', '[Renderer] 收到 model-updated 事件:', event.detail);
       // TODO: Implement more granular update instead of full reload?
       // For now, just reload models for the current source/directory
       const currentSourceId = document.getElementById('sourceSelect')?.value;
       // Need to know the current directory from main-view state if possible,
       // otherwise, just reload the root for simplicity.
       if (currentSourceId) {
           window.api.logMessage('info', "[Renderer] 模型更新后重新加载当前数据源的模型...");
           loadModelsForView(currentSourceId, null); // Reload root for now - logging inside
       } else {
            window.api.logMessage('warn', "[Renderer] 收到 model-updated 事件，但没有选择当前数据源，无法重新加载");
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
  window.api.logMessage('info', `[Renderer] 渲染器初始化完成, 总耗时: ${initDuration}ms`);
});