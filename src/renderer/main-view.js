import { clearChildren, setLoading, imageObserver, loadImage } from './ui-utils.js';

// Assume i18n is initialized and 't' is available globally or passed/imported
const t = window.i18n?.t || ((key) => key); // Fallback if i18n isn't ready/global

// ===== DOM Element References =====
// These might be passed during initialization or queried within functions
let sourceSelect;
let filterSelect;
let modelList;
let cardViewBtn;
let listViewBtn;
let directoryTabsContainer; // The container for directory tabs (e.g., '.directory-tabs')

// ===== Module State =====
let models = [];
let filterType = '';
let displayMode = 'card'; // 'card' or 'list'
let currentDirectory = null; // Currently selected directory
let subdirectories = []; // List of subdirectories for the current source
let currentSourceId = null; // Keep track of the currently selected source ID

// ===== Initialization =====

/**
 * Initializes the main view module, setting up references and event listeners.
 * @param {object} config - Configuration object.
 * @param {string} config.sourceSelectId - ID of the source select element.
 * @param {string} config.filterSelectId - ID of the filter select element.
 * @param {string} config.modelListId - ID of the model list container.
 * @param {string} config.cardViewBtnId - ID of the card view button.
 * @param {string} config.listViewBtnId - ID of the list view button.
 * @param {string} config.directoryTabsSelector - Selector for the directory tabs container.
 * @param {function} showDetailCallback - Callback function to show model details.
 */
export function initMainView(config, showDetailCallback) {
    sourceSelect = document.getElementById(config.sourceSelectId);
    filterSelect = document.getElementById(config.filterSelectId);
    modelList = document.getElementById(config.modelListId);
    cardViewBtn = document.getElementById(config.cardViewBtnId);
    listViewBtn = document.getElementById(config.listViewBtnId);
    directoryTabsContainer = document.querySelector(config.directoryTabsSelector);

    if (!sourceSelect || !filterSelect || !modelList || !cardViewBtn || !listViewBtn || !directoryTabsContainer) {
        console.error("One or more main view elements not found. Check IDs/Selectors:", config);
        return;
    }

    // Attach event listeners
    sourceSelect.addEventListener('change', handleSourceChange);
    filterSelect.addEventListener('change', handleFilterChange);
    cardViewBtn.addEventListener('click', () => switchViewMode('card'));
    listViewBtn.addEventListener('click', () => switchViewMode('list'));

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
}

// Internal reference to the showDetail function provided by the main module
let _showDetail = (model) => {
    console.warn("showDetailCallback not initialized in main-view.js");
};


// ===== Data Loading =====

/**
 * Loads models for a given source and optional directory.
 * Updates the internal state and triggers UI rendering.
 * @param {string} sourceId - The ID of the source to load models from.
 * @param {string|null} [directory=null] - The specific directory to load, or null for the root.
 */
export async function loadModels(sourceId, directory = null) {
  setLoading(true);
  currentSourceId = sourceId; // Update current source ID
  currentDirectory = directory; // Update current directory
  try {
    models = await window.api.listModels(sourceId, directory);
    // If loading the root directory, also fetch subdirectories
    if (directory === null) {
      subdirectories = await window.api.listSubdirectories(sourceId);
      renderDirectoryTabs(); // Render tabs only when loading root
    }
    renderFilterTypes(); // Update filters based on loaded models
    renderModels(); // Render the models
  } catch (e) {
    console.error('加载模型失败:', e);
    models = []; // Clear models on error
    subdirectories = []; // Clear subdirectories on error
    renderModels(); // Render empty list
    renderDirectoryTabs(); // Render empty tabs
    renderFilterTypes(); // Render empty filters
    // Optionally show an error message to the user using showFeedback
  }
  setLoading(false);
}

// ===== Rendering Functions =====

/**
 * Renders the source options in the source select dropdown.
 * @param {Array<object>} sourcesData - Array of source objects {id, name, type}.
 */
export function renderSources(sourcesData) {
  if (!sourceSelect) return;
  const currentVal = sourceSelect.value; // Preserve selection if possible
  clearChildren(sourceSelect);
  sourcesData.forEach(src => {
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
  if (sourcesData.some(s => s.id === currentVal)) {
      sourceSelect.value = currentVal;
  } else if (sourcesData.length > 0) {
      sourceSelect.value = sourcesData[0].id;
      // Trigger change event manually if selection defaulted to first
      handleSourceChange();
  }
}


/** Renders the filter options based on unique types found in the current models list. */
function renderFilterTypes() {
  if (!filterSelect) return;
  const currentVal = filterSelect.value; // Preserve selection
  clearChildren(filterSelect);
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = t('all'); // Use translation key 'all'
  filterSelect.appendChild(allOption);

  const types = Array.from(new Set(models.map(m => m.type).filter(Boolean)));
  types.sort(); // Sort types alphabetically
  types.forEach(type => {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = type; // Assuming type names don't need translation for now
    filterSelect.appendChild(option);
  });

  // Restore selection
  if (types.includes(currentVal)) {
      filterSelect.value = currentVal;
  } else {
      filterSelect.value = ''; // Default to 'All'
  }
  filterType = filterSelect.value; // Update internal state
}

/** Renders the model list based on the current filter, display mode, and models data. */
function renderModels() {
  if (!modelList) return;
  clearChildren(modelList);
  const filteredModels = filterType ? models.filter(m => m.type === filterType) : models;
  const MAX_VISIBLE_TAGS = 6; // Maximum tags to show initially

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
    const card = document.createElement('li');
    card.className = 'model-card'; // Base class, specific styles handled by parent view class

    // --- Image ---
    let imageElement;
    if (model.image) {
      imageElement = document.createElement('img');
      // Set data attributes but not src initially for lazy loading
      imageElement.setAttribute('data-image-path', model.image);
      imageElement.setAttribute('data-source-id', currentSourceId); // Use currentSourceId
      imageElement.alt = model.name || t('modelImageAlt'); // Use model name or generic alt text
      imageElement.className = 'model-image';
      imageElement.loading = 'lazy'; // Browser-level lazy loading hint
      imageObserver.observe(imageElement); // Use observer from ui-utils
    } else {
      // Placeholder for models without images
      imageElement = document.createElement('div');
      imageElement.className = 'model-image model-image-placeholder';
      imageElement.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="placeholder-icon"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`;
    }
    card.appendChild(imageElement);

    // --- Content (Name, Type) ---
    const contentDiv = document.createElement('div');
    contentDiv.className = 'model-content';

    const nameH3 = document.createElement('h3');
    nameH3.className = 'model-name';
    nameH3.textContent = model.name;

    const typeSpan = document.createElement('span');
    typeSpan.className = 'model-type';
    typeSpan.textContent = model.type || t('uncategorized');

    contentDiv.appendChild(nameH3);
    contentDiv.appendChild(typeSpan);
    card.appendChild(contentDiv);

    // --- Tags ---
    if (model.tags && model.tags.length > 0) {
      const tagsContainer = document.createElement('div');
      tagsContainer.className = 'tags-container';

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
          event.stopPropagation();
          const container = event.target.closest('.tags-container');
          const isExpanded = container.classList.toggle('expanded');
          event.target.textContent = isExpanded ? t('showLess') : t('showMore');
        };
        tagsContainer.appendChild(moreBtn);
      }
      card.appendChild(tagsContainer);
    }

    // --- Click Event ---
    card.addEventListener('click', () => {
        // Call the callback provided during initialization
        if (_showDetail) {
            _showDetail(model);
        }
    });

    modelList.appendChild(card);
  });
}


/** Renders the directory navigation tabs based on the current subdirectories list. */
function renderDirectoryTabs() {
  if (!directoryTabsContainer) return;
  const tabList = directoryTabsContainer.querySelector('.tab-list'); // Assuming a .tab-list inside
  if (!tabList) {
      console.warn("'.tab-list' not found within directory tabs container:", directoryTabsContainer);
      return;
  }

  clearChildren(tabList);

  // "All" Tab
  const allTab = document.createElement('div');
  allTab.className = `tab-item ${currentDirectory === null ? 'active' : ''}`;
  allTab.textContent = t('all'); // Use translation key 'all'
  allTab.onclick = () => {
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
  if (!sourceSelect) return;
  const selectedSourceId = sourceSelect.value;
  if (selectedSourceId) {
    // Reset directory and load models for the new source
    await loadModels(selectedSourceId, null);
  } else {
      // Handle case where no source is selected (e.g., empty list)
      models = [];
      subdirectories = [];
      renderModels();
      renderDirectoryTabs();
      renderFilterTypes();
  }
}

/** Handles the change event for the filter select dropdown. */
function handleFilterChange() {
  if (!filterSelect) return;
  const newFilterType = filterSelect.value;
  if (filterType !== newFilterType) {
    filterType = newFilterType;
    setLoading(true); // Show loading indicator briefly for visual feedback
    // Use setTimeout to allow the loading indicator to render before blocking the thread
    setTimeout(() => {
      renderModels();
      setLoading(false);
    }, 50); // Short delay
  }
}

/** Handles switching between card and list view modes. */
function switchViewMode(newMode) {
  if (displayMode !== newMode) {
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