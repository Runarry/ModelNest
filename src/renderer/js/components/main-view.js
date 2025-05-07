import { clearChildren, setLoading, imageObserver, loadImage } from '../utils/ui-utils.js';
import { t } from '../core/i18n.js'; // 导入 i18n 函数
import { logMessage, listModels, listSubdirectories,getAllSourceConfigs } from '../apiBridge.js'; // 导入 API 桥接
import { CrawlStatusModal } from './crawl-status-modal.js'; // 导入弹窗组件 (稍后创建)
import FilterPanel from './filter-panel.js'; // New: Import FilterPanel component

// ===== DOM Element References =====
// These might be passed during initialization or queried within functions
let sourceSelect;
// let filterSelect; // This will be removed/phased out - REMOVED
let openFilterPanelBtn; // New: Button to open the filter panel
let filterPanelContainer; // New: Container for the FilterPanel component
let modelList;
let cardViewBtn;
let listViewBtn;
let directoryTabsContainer; // The container for directory tabs (e.g., '.directory-tabs')
let crawlInfoButton; // 新增：补全模型信息按钮
let sourceReadonlyIndicator; // 新增：只读状态指示器

// ===== Module State =====
let models = [];
// let filterType = ''; // This will be removed/phased out - REMOVED
let currentAppliedFilters = { baseModel: [], modelType: [] }; // New: Applied filters
let filterPanelInstance = null; // New: Instance of FilterPanel
let displayMode = 'card'; // 'card' or 'list'
let currentDirectory = null; // Currently selected directory
let subdirectories = []; // List of subdirectories for the current source
let currentSourceId = null; // Keep track of the currently selected source ID
let allSourceConfigs = []; // 新增：存储所有数据源的完整配置
let currentSourceConfig = null; // 新增：存储当前选定数据源的配置
let crawlStatusModal = null; // 新增：弹窗实例
let cachedFilterOptionsBySource = {}; // New: Cache for filter options, keyed by sourceId

// ===== Initialization =====

/**
 * Initializes the main view module, setting up references and event listeners.
 * @param {object} config - Configuration object.
 * @param {string} config.sourceSelectId - ID of the source select element.
 * @param {string} config.filterSelectId - ID of the filter select element. (Will be removed)
 * @param {string} config.openFilterPanelBtnId - ID of the button to open the filter panel.
 * @param {string} config.filterPanelContainerId - ID of the container for the filter panel.
 * @param {string} config.modelListId - ID of the model list container.
 * @param {string} config.cardViewBtnId - ID of the card view button.
 * @param {string} config.listViewBtnId - ID of the list view button.
 * @param {string} config.directoryTabsSelector - Selector for the directory tabs container.
 * @param {string} config.crawlInfoButtonId - ID of the crawl info button.
 * @param {string} config.sourceReadonlyIndicatorId - ID of the source readonly indicator span.
 * @param {function} showDetailCallback - Callback function to show model details.
 */
export function initMainView(config, showDetailCallback) {
    sourceSelect = document.getElementById(config.sourceSelectId);
    // filterSelect = document.getElementById(config.filterSelectId); // To be removed - REMOVED
    openFilterPanelBtn = document.getElementById(config.openFilterPanelBtnId);
    filterPanelContainer = document.getElementById(config.filterPanelContainerId);
    modelList = document.getElementById(config.modelListId);
    cardViewBtn = document.getElementById(config.cardViewBtnId);
    listViewBtn = document.getElementById(config.listViewBtnId);
    directoryTabsContainer = document.querySelector(config.directoryTabsSelector);
    crawlInfoButton = document.getElementById(config.crawlInfoButtonId); // 获取按钮
    sourceReadonlyIndicator = document.getElementById(config.sourceReadonlyIndicatorId); // 获取只读指示器

    // Updated error check to remove filterSelect
    if (!sourceSelect || !modelList || !cardViewBtn || !listViewBtn || !directoryTabsContainer || !crawlInfoButton || !sourceReadonlyIndicator || !openFilterPanelBtn || !filterPanelContainer) {
        // Task 1: Error Logging
        logMessage('error', "[MainView] 初始化失败：一个或多个必需的 DOM 元素未找到。请检查配置中的 ID/选择器:", config);
        return;
    }

    // Attach event listeners
    sourceSelect.addEventListener('change', handleSourceChange); // Logged within handler
    // filterSelect.addEventListener('change', handleFilterChange); // Old filter - REMOVED

    openFilterPanelBtn.addEventListener('click', async () => {
        logMessage('info', '[UI] 点击了打开/关闭筛选面板按钮');
        if (filterPanelInstance) {
            if (filterPanelContainer.style.display != 'block')
            {
                await filterPanelInstance.updateOptions(currentSourceId);
            }
            filterPanelInstance.toggle();
            // After toggling, check visibility to add/remove outside click listener
            if (filterPanelContainer.style.display === 'block') {
                document.addEventListener('mousedown', handleOutsideClickForFilterPanel);
                logMessage('debug', '[MainView] Filter panel shown, added outside click listener.');
              
            } else {
                document.removeEventListener('mousedown', handleOutsideClickForFilterPanel);
                logMessage('debug', '[MainView] Filter panel hidden, removed outside click listener.');
            }
        } else {
            // 首次点击时初始化 filter-panel，初始化完成后再显示
            try {
                filterPanelInstance = new FilterPanel(
                    filterPanelContainer.id,
                    handleFiltersApplied,
                    null
                );
                // 先隐藏，等 options 加载后再显示
                filterPanelInstance.hide();
                logMessage('info', '[MainView] 首次点击已初始化 FilterPanel，开始加载筛选项...');
                // 异步加载 filter options，加载完成后再显示
                await filterPanelInstance.updateOptions(currentSourceId);
                filterPanelInstance.show();
                document.addEventListener('mousedown', handleOutsideClickForFilterPanel);
                logMessage('debug', '[MainView] 首次点击后 FilterPanel 初始化并显示，已添加 outside click listener。');
            } catch (error) {
                logMessage('error', '[MainView] 首次点击初始化 FilterPanel 失败:', error.message, error.stack);
                filterPanelInstance = null;
            }
        }
    });

    // Task 4: Click Event Logging
    cardViewBtn.addEventListener('click', () => {
        logMessage('info', '[UI] 点击了卡片视图按钮');
        switchViewMode('card');
    });
    listViewBtn.addEventListener('click', () => {
        logMessage('info', '[UI] 点击了列表视图按钮');
        switchViewMode('list');
    });
    crawlInfoButton.addEventListener('click', () => {
        logMessage('info', '[UI] 点击了补全模型信息按钮');
        if (crawlStatusModal) {
            // 传递当前数据源 ID 和目录给弹窗
            crawlStatusModal.show(currentSourceId, currentDirectory);
        }
    });

    // Set initial active view button
    if (displayMode === 'card') {
        cardViewBtn.classList.add('active');
        listViewBtn.classList.remove('active');
    } else {
        listViewBtn.classList.add('active');
        cardViewBtn.classList.remove('active');
    }

    // Store the callback for showing details
    _showDetail = showDetailCallback;

    // 初始化弹窗实例 (稍后创建 CrawlStatusModal 类)
    crawlStatusModal = new CrawlStatusModal();

    // 初始化新的筛选面板实例 (使用导入的类，并传入可能的缓存选项)
    // 延后 FilterPanel 的初始化到模型加载和主页面渲染完毕后
    filterPanelInstance = null;

    // Initial fetch of filter options will be triggered by the first call to loadModels
    // (e.g., via handleSourceChange after renderSources sets an initial source)
}

// Internal reference to the showDetail function provided by the main module
let _showDetail = (model) => {
    logMessage('warn', "showDetailCallback not initialized in main-view.js");
};


// Callback function for FilterPanel
function handleFiltersApplied(newFilters) {
    logMessage('info', '[MainView] Filters applied from panel:', newFilters);
    currentAppliedFilters = newFilters || { baseModel: [], modelType: [] }; // Ensure it's always an object
    // Reload models with the new filters for the current source and directory
    if (currentSourceId) {
        loadModels(currentSourceId, currentDirectory);
    } else {
        logMessage('warn', '[MainView] Cannot apply filters: currentSourceId is not set.');
    }
}

// ===== Click Outside Handler for Filter Panel =====
/**
 * Handles clicks outside the filter panel to close it.
 * @param {MouseEvent} event - The mousedown event.
 */
function handleOutsideClickForFilterPanel(event) {
    if (!filterPanelInstance || !filterPanelContainer || !openFilterPanelBtn) return;

    // Check if the click is outside the filter panel and not on the toggle button
    const isClickInsidePanel = filterPanelContainer.contains(event.target);
    const isClickOnToggleButton = openFilterPanelBtn.contains(event.target);

    if (!isClickInsidePanel && !isClickOnToggleButton) {
        logMessage('debug', '[MainView] Clicked outside filter panel and toggle button. Hiding panel.');
        filterPanelInstance.hide();
        document.removeEventListener('mousedown', handleOutsideClickForFilterPanel);
        logMessage('debug', '[MainView] Filter panel hidden by outside click, removed listener.');
    }
}

// ===== UI Update Functions =====

/**
 * Updates UI elements related to write actions based on the read-only status.
 * @param {boolean} isReadOnly - Whether the current source is read-only.
 */
function updateWriteActionUI(isReadOnly) {
    // 假设“添加模型”按钮的 ID 是 'add-model-button'
    // TODO: 未来可以在这里添加对其他写入操作 UI（如添加、删除、重命名按钮）的控制
    // 目前没有 'add-model-button'，因此移除相关代码。
    // 未来可以在这里添加对其他写入操作 UI（如删除、重命名按钮）的控制
}

// ===== Data Loading & Source Management =====

/**
 * Fetches all source configurations and stores them.
 * @returns {Promise<void>}
 */
async function fetchAndStoreSourceConfigs() {
    try {
        logMessage('info', '[MainView] 开始获取所有数据源配置');
        // 假设 apiBridge 提供了 getAllSourceConfigs 方法
        const configs = await getAllSourceConfigs();
        allSourceConfigs = configs || [];
        logMessage('info', `[MainView] 获取到 ${allSourceConfigs.length} 个数据源配置`);
    } catch (error) {
        logMessage('error', '[MainView] 获取所有数据源配置失败:', error);
        allSourceConfigs = []; // 出错时清空
    }
}

/**
 * Loads models for a given source and optional directory.
 * Updates the internal state and triggers UI rendering.
 * @param {string} sourceId - The ID of the source to load models from.
 * @param {string|null} [directory=null] - The specific directory to load, or null for the root.
 */
export async function loadModels(sourceId, directory = null) {
  const startTime = Date.now();
  logMessage('info', `[MainView] 开始加载模型: sourceId=${sourceId}, directory=${directory ?? 'root'}`);
  setLoading(true);
  currentSourceId = sourceId; // Update current source ID
  currentDirectory = directory; // Update current directory
  let modelCount = 0;
  let subdirCount = 0;
  try {
    // Pass currentAppliedFilters to listModels
    models = await listModels(sourceId, directory, currentAppliedFilters);
    modelCount = models.length;
    // If loading the root directory, also fetch subdirectories
    if (directory === null) {
      logMessage('debug', `[MainView] 加载根目录，同时获取子目录: sourceId=${sourceId}`);
      subdirectories = await listSubdirectories(sourceId); // 使用导入的函数
      subdirCount = subdirectories.length;
      logMessage('debug', `[MainView] 获取到 ${subdirCount} 个子目录`);
      renderDirectoryTabs(); // Render tabs only when loading root
    }
    // renderFilterTypes(); // Update filters based on loaded models - REMOVED
    renderModels(); // Render the models
    const duration = Date.now() - startTime;
    logMessage('info', `[MainView] 模型加载成功: sourceId=${sourceId}, directory=${directory ?? 'root'}, 耗时: ${duration}ms, 模型数: ${modelCount}, 子目录数: ${subdirCount}`);

    // 主页面和模型渲染完毕后再初始化 FilterPanel
    // 懒加载模式下，不在模型加载后自动初始化 FilterPanel

    // 使用requestAnimationFrame延迟加载filter options，确保首屏渲染完成
    // 懒加载模式下，不在模型加载后自动刷新筛选项

  } catch (e) {
    const duration = Date.now() - startTime;
    logMessage('error', `[MainView] 加载模型失败: sourceId=${sourceId}, directory=${directory ?? 'root'}, 耗时: ${duration}ms`, e.message, e.stack, e);
    models = []; // Clear models on error
    subdirectories = []; // Clear subdirectories on error
    renderModels(); // Render empty list
    renderDirectoryTabs(); // Render empty tabs
    // renderFilterTypes(); // Render empty filters - REMOVED
    // Optionally show an error message to the user using showFeedback
    // showFeedback(`Error loading models: ${e.message}`, 'error');
    
    // 在错误情况下也延迟加载filter options
    // 懒加载模式下，不在模型加载失败后自动刷新筛选项
  } finally { // Ensure setLoading(false) is always called
      setLoading(false);
  }
}

// ===== Rendering Functions =====

/**
 * Renders the source options in the source select dropdown.
 * @param {Array<object>} sourcesData - Array of source objects {id, name, type}. (Note: This might become redundant if we fetch configs separately)
 */
export async function renderSources(sourcesData) { // Make async to fetch configs
  if (!sourceSelect) return;

  // --- 获取并存储完整配置 ---
  await fetchAndStoreSourceConfigs();
  // 使用 allSourceConfigs 作为数据源，而不是传入的 sourcesData，以确保包含 readOnly 标志
  const sourcesToRender = allSourceConfigs;
  // ---

  const currentVal = sourceSelect.value; // Preserve selection if possible
  clearChildren(sourceSelect);
  sourcesToRender.forEach(src => {
    const option = document.createElement('option');
    option.value = src.id;
    option.textContent = src.name;
    // Add CSS class based on source type
    if (src.type === 'local') {
      option.classList.add('source-option-local');
    } else if (src.type === 'webdav') {
      option.classList.add('source-option-webdav');
    }
    sourceSelect.appendChild(option);
  });
  // Restore selection or select first if previous value is gone
  // --- 使用 sourcesToRender 进行判断 ---
  if (sourcesToRender.some(s => s.id === currentVal)) {
      sourceSelect.value = currentVal;
  } else if (sourcesToRender.length > 0) {
      sourceSelect.value = sourcesToRender[0].id;
      // Trigger change event manually if selection defaulted to first
      // This ensures the initial models are loaded when the app starts or sources change
      handleSourceChange();
  } else {
      // No sources available, ensure write actions are disabled
      // 并且隐藏爬虫按钮
      updateWriteActionUI(true);
      if (crawlInfoButton) crawlInfoButton.style.display = 'none';
      if (sourceReadonlyIndicator) sourceReadonlyIndicator.style.display = 'none';
  }
}


// Old renderFilterTypes function is removed.

/**
 * Renders a single model card/list item element.
 * @param {object} model - The model data object.
 * @returns {HTMLElement} The created list item element.
 */
function _renderSingleModelElement(model) {
    const card = document.createElement('li');
    card.className = 'model-card'; // Base class, specific styles handled by parent view class
    card.dataset.modelFile = model.file; // Add unique identifier

    const MAX_VISIBLE_TAGS = 6; // Maximum tags to show initially

    // --- Image ---
    let imageElement;
    if (model.image) {
        imageElement = document.createElement('img');
        imageElement.setAttribute('data-image-path', model.image);
        imageElement.setAttribute('data-source-id', currentSourceId);
        imageElement.alt = model.name || t('modelImageAlt');
        imageElement.className = 'model-image';
        imageElement.loading = 'lazy';
        imageObserver.observe(imageElement);
    } else {
        imageElement = document.createElement('div');
        imageElement.className = 'model-image model-image-placeholder';
        imageElement.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="placeholder-icon"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`;
    }
    card.appendChild(imageElement);

    // --- Content (Name, Type) ---
    const contentDiv = document.createElement('div');
    contentDiv.className = 'model-info';

    const nameH3 = document.createElement('h3');
    nameH3.className = 'model-name';
    nameH3.textContent = model.name;

    const typeSpan = document.createElement('span');
    typeSpan.className = 'model-type';
    typeSpan.textContent = model.modelType ? model.modelType.toUpperCase() : t('uncategorized').toUpperCase();

    contentDiv.appendChild(nameH3);
    contentDiv.appendChild(typeSpan);
    card.appendChild(contentDiv);

    // --- Tags ---
    const tagsContainer = document.createElement('div');
    tagsContainer.className = 'tags-container';
    card.appendChild(tagsContainer);

    if (model.tags && model.tags.length > 0) {
        model.tags.forEach((tag, index) => {
            const tagElement = document.createElement('span');
            tagElement.className = 'tag';
            tagElement.textContent = tag;
            if (index >= MAX_VISIBLE_TAGS) {
                tagElement.classList.add('tag-hidden');
            }
            tagsContainer.appendChild(tagElement);
        });

        if (model.tags.length > MAX_VISIBLE_TAGS) {
            const moreBtn = document.createElement('button');
            moreBtn.className = 'tag-more-btn';
            moreBtn.textContent = t('showMore');
            moreBtn.onclick = (event) => {
                logMessage('info', `[UI] 点击了模型 "${model.name}" 的 "显示更多/更少" 标签按钮`);
                event.stopPropagation();
                const container = event.target.closest('.tags-container');
                const isExpanded = container.classList.toggle('expanded');
                event.target.textContent = isExpanded ? t('showLess') : t('showMore');
            };
            tagsContainer.appendChild(moreBtn);
        }
    }

    // --- Click Event ---
    card.addEventListener('click', () => {
        logMessage('info', `[UI] 点击了模型卡片: ${model.name} (Type: ${model.modelType}, Source: ${currentSourceId})`);
        if (_showDetail) {
            const isReadOnly = currentSourceConfig?.readOnly === true;
            logMessage('debug', `[MainView] 打开详情，传递 readOnly 状态: ${isReadOnly}`);
            _showDetail(model, currentSourceId, isReadOnly);
        } else {
            logMessage('error', '[MainView] _showDetail 回调函数未初始化，无法显示模型详情');
        }
    });

    return card;
}

/** Renders the model list based on the current filter, display mode, and models data. */
function renderModels() {
  if (!modelList) return;
  clearChildren(modelList);
  // The 'models' array is now pre-filtered by loadModels via modelService.
  // No need for client-side filtering here based on the old filterType.
  const filteredModels = models;

  // Set container class based on display mode
  const mainSection = modelList.closest('#mainSection') || document.body; // Find parent or default to body
  if (displayMode === 'list') {
    mainSection.classList.add('list-view');
    mainSection.classList.remove('card-view');
  } else { // displayMode === 'card'
    mainSection.classList.add('card-view');
    mainSection.classList.remove('list-view');
  }

  if (filteredModels.length === 0) {
      modelList.innerHTML = `<p class="empty-list-message">${t('noModelsFound')}</p>`; // Show a message if empty
      return;
  }

  filteredModels.forEach(model => {
    const cardElement = _renderSingleModelElement(model); // Use the helper function
    modelList.appendChild(cardElement);
  });
}

/**
 * Updates a single model card in the list or adds it if it's new (and matches current filter).
 * @param {object} updatedModelData - The updated model data object.
 */
export function updateSingleModelCard(updatedModelData) {
    if (!modelList || !updatedModelData || !updatedModelData.file) {
        logMessage('warn', '[MainView] updateSingleModelCard: 列表元素或更新数据无效', updatedModelData);
        return;
    }
    logMessage('info', `[MainView] 尝试更新单个模型卡片: ${updatedModelData.name} (${updatedModelData.file})`);

    // 1. Update internal state
    const modelIndex = models.findIndex(m => m.file === updatedModelData.file);
    if (modelIndex !== -1) {
        logMessage('debug', `[MainView] 在内部模型数组中找到并更新模型: ${updatedModelData.file}`);
        models[modelIndex] = updatedModelData;
    } else {
        // If the model wasn't in the original list (e.g., newly created/synced?),
        // we might need to add it if it matches the current directory/filter.
        // For simplicity now, we only update existing ones.
        // TODO: Consider adding logic to insert new models if applicable.
        logMessage('warn', `[MainView] 更新的模型 ${updatedModelData.file} 不在当前加载的内部模型数组中，跳过更新。`);
        // return; // Or proceed to check if it should be added to the view
    }

    // 2. Check if the updated model should be visible based on the current filter
    const modelTypeUpper = updatedModelData.modelType ? updatedModelData.modelType.toUpperCase() : t('uncategorized').toUpperCase();
    const shouldBeVisible = !filterType || modelTypeUpper === filterType;

    // 3. Find existing DOM element
    // Use JSON.stringify to properly escape the file path for the CSS selector
    const escapedFilePath = JSON.stringify(updatedModelData.file);
    const selector = `li[data-model-file=${escapedFilePath}]`;
    logMessage('debug', `[MainView] Attempting to find card with selector: ${selector}`);
    const existingCard = modelList.querySelector(selector);
    logMessage('debug', `[MainView] Found existing card for ${updatedModelData.file}:`, existingCard ? 'Yes' : 'No');

    if (existingCard) {
        if (shouldBeVisible) {
            // Model exists and should be visible: Replace it
            logMessage('debug', `[MainView] 找到现有 DOM 卡片，将替换: ${updatedModelData.file}`);
            const newCardElement = _renderSingleModelElement(updatedModelData);
            existingCard.replaceWith(newCardElement);
        } else {
            // Model exists but should NO LONGER be visible: Remove it
            logMessage('debug', `[MainView] 找到现有 DOM 卡片，但不再符合过滤器，将移除: ${updatedModelData.file}`);
            existingCard.remove();
        }
    } else if (shouldBeVisible) {
        // Model does NOT exist in DOM, but SHOULD be visible: Add it
        // This handles cases where a model might be added/synced while viewing the list
        logMessage('debug', `[MainView] 未找到现有 DOM 卡片，但模型符合过滤器，将添加: ${updatedModelData.file}`);
        const newCardElement = _renderSingleModelElement(updatedModelData);
        modelList.appendChild(newCardElement);
        // Remove the "empty list" message if it exists
        const emptyMsg = modelList.querySelector('.empty-list-message');
        if (emptyMsg) emptyMsg.remove();
    } else {
         logMessage('debug', `[MainView] 模型 ${updatedModelData.file} 不存在于 DOM 且不符合当前过滤器，无需操作。`);
    }

    // 4. Re-render filter types in case the updated model introduced/removed a type - REMOVED
    //    (This is less efficient but ensures filter dropdown is accurate)
    // renderFilterTypes(); // This function is removed
}


/** Renders the directory navigation tabs based on the current subdirectories list. */
function renderDirectoryTabs() {
  if (!directoryTabsContainer) return;
  const tabList = directoryTabsContainer.querySelector('.tab-list'); // Assuming a .tab-list inside
  if (!tabList) {
      logMessage('warn', "'.tab-list' not found within directory tabs container:", directoryTabsContainer);
      return;
  }

  clearChildren(tabList);

  // "All" Tab
  const allTab = document.createElement('div');
  allTab.className = `tab-item ${currentDirectory === null ? 'active' : ''}`;
  allTab.textContent = t('all'); // Use translation key 'all'
  allTab.onclick = () => {
    // Task 4: Click Event Logging
    logMessage('info', `[UI] 点击了目录标签: "全部" (Source: ${currentSourceId})`);
    if (currentDirectory !== null) {
      setActiveTab(allTab);
      loadModels(currentSourceId, null); // Load root directory
    }
  };
  tabList.appendChild(allTab);

  // Subdirectory Tabs
  subdirectories.sort(); // Sort directories alphabetically
  subdirectories.forEach(dir => {
    const tab = document.createElement('div');
    tab.className = `tab-item ${currentDirectory === dir ? 'active' : ''}`;
    tab.textContent = dir; // Directory names likely don't need translation
    tab.onclick = () => {
      // Task 4: Click Event Logging
      logMessage('info', `[UI] 点击了目录标签: "${dir}" (Source: ${currentSourceId})`);
      if (currentDirectory !== dir) {
        setActiveTab(tab);
        loadModels(currentSourceId, dir); // Load specific directory
      }
    };
    tabList.appendChild(tab);
  });

  // Show/hide the tab container based on whether there are subdirectories
  directoryTabsContainer.style.display = subdirectories.length > 0 ? 'block' : 'none';
}

/** Helper to set the active class on a clicked tab. */
function setActiveTab(activeTabElement) {
    const tabList = activeTabElement.parentNode;
    tabList.querySelectorAll('.tab-item').forEach(item => {
        item.classList.remove('active');
    });
    activeTabElement.classList.add('active');
}

// ===== Event Handlers =====

/** Handles the change event for the source select dropdown. */
async function handleSourceChange() {
  if (!sourceSelect) {
      logMessage('warn', '[MainView] handleSourceChange: sourceSelect 元素不存在');
      return;
  }
  const selectedSourceId = sourceSelect.value;
  logMessage('info', `[UI] handleSourceChange started. Selected Source ID: ${selectedSourceId}`); // Added log

  // --- 更新当前数据源配置 ---
  currentSourceConfig = allSourceConfigs.find(config => config.id === selectedSourceId) || null;
  logMessage('debug', `[MainView] Found config for ID ${selectedSourceId}:`, currentSourceConfig); // Added log

  if (currentSourceConfig) {
      logMessage('info', `[MainView] 当前数据源配置已更新: ${currentSourceConfig.name}, ReadOnly: ${currentSourceConfig.readOnly}, Type: ${currentSourceConfig.type}`); // Enhanced log
  } else if (selectedSourceId) {
      logMessage('warn', `[MainView] 未找到 ID 为 ${selectedSourceId} 的数据源配置`);
  }
  // ---
  // 更新写入操作相关的 UI 状态 (这部分可能需要根据实际的 updateWriteActionUI 调整或移除)
  // updateWriteActionUI(currentSourceConfig?.readOnly ?? false);

  // --- 控制爬虫按钮和只读指示器的显隐 ---
  logMessage('debug', `[MainView] Checking button/indicator elements. Button: ${!!crawlInfoButton}, Indicator: ${!!sourceReadonlyIndicator}`); // Added log
  if (crawlInfoButton && sourceReadonlyIndicator) {
    const isReadOnly = currentSourceConfig?.readOnly === true;
    const isLocal = currentSourceConfig?.type?.toUpperCase() === 'LOCAL';
    logMessage('debug', `[MainView] Display logic check: isReadOnly=${isReadOnly}, isLocal=${isLocal}`); // Added log

    if (isReadOnly) {
        logMessage('debug', '[MainView] Setting UI for ReadOnly source.'); // Added log
        crawlInfoButton.style.display = 'none';
        sourceReadonlyIndicator.style.display = 'inline-flex';
    } else {
        logMessage('debug', '[MainView] Setting UI for Writable source.'); // Added log
        sourceReadonlyIndicator.style.display = 'none';
        if (isLocal) {
            logMessage('debug', '[MainView] Source is LOCAL, showing crawl button.'); // Added log
            crawlInfoButton.style.display = 'inline-block';
        } else {
            logMessage('debug', '[MainView] Source is NOT LOCAL, hiding crawl button.'); // Added log
            crawlInfoButton.style.display = 'none';
        }
    }
  } else {
      logMessage('warn', '[MainView] 无法控制按钮/指示器显隐，DOM 元素未找到');
  }
  // ---

  if (selectedSourceId) {
    logMessage('info', `[MainView] Calling loadModels for source: ${selectedSourceId}`); // Added log
    await loadModels(selectedSourceId, null);
    logMessage('info', `[MainView] loadModels finished for source: ${selectedSourceId}`); // Added log
  } else {
      // Handle case where no source is selected (e.g., empty list)
      logMessage('info', '[MainView] 没有选择数据源，清空视图');
      models = [];
      subdirectories = [];
      renderModels();
      renderDirectoryTabs();
      // renderFilterTypes(); // REMOVED
      // 隐藏爬虫按钮
      if (crawlInfoButton) crawlInfoButton.style.display = 'none';
      if (sourceReadonlyIndicator) sourceReadonlyIndicator.style.display = 'none';
  }
  logMessage('info', `[UI] handleSourceChange finished for Source ID: ${selectedSourceId}`); // Added log
}

// Old handleFilterChange function is removed.

/** Handles switching between card and list view modes. */
function switchViewMode(newMode) {
if (displayMode !== newMode) {
  // Task 4: Click Event Logging (Handled by callers)
  logMessage('info', `[UI] 切换视图模式到: ${newMode}`);
  displayMode = newMode;
  // Update button active states
  if (newMode === 'card') {
    cardViewBtn.classList.add('active');
    listViewBtn.classList.remove('active');
  } else {
    listViewBtn.classList.add('active');
    cardViewBtn.classList.remove('active');
  }
  // Re-render the model list with the new view mode class
  renderModels();
}
}

// ===== Filter Options Caching =====

