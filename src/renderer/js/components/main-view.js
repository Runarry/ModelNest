import { clearChildren, setLoading, imageObserver, loadImage } from '../utils/ui-utils.js';
import { t } from '../core/i18n.js';
import { logMessage, listModels, listSubdirectories, getAllSourceConfigs } from '../apiBridge.js';
import { CrawlStatusModal } from './crawl-status-modal.js';
import FilterPanel from './filter-panel.js';
import { BlobUrlCache } from '../core/blobUrlCache.js';
import { VirtualScroll } from '../../vendor/js-booster/js-booster.js'; // Assuming js-booster is available

// ===== DOM Element References =====
let sourceSelect;
let openFilterPanelBtn;
let filterPanelContainer;
let modelList;
let cardViewBtn;
let listViewBtn;
let directoryTabsContainer;
let crawlInfoButton;
let sourceReadonlyIndicator;

// ===== Module State =====
let models = [];
let currentAppliedFilters = { baseModel: [], modelType: [] };
let filterPanelInstance = null;
let displayMode = 'card'; // 'card' or 'list'
let currentDirectory = null;
let subdirectories = [];
let currentSourceId = null;
let allSourceConfigs = [];
let currentSourceConfig = null;
let crawlStatusModal = null;
let globalTagsTooltip = null;

// ===== Virtual Scroll State & Constants =====
let virtualScrollInstance = null;
let cardViewResizeObserver = null;

// Card View Constants
const CARD_APPROX_WIDTH = 180;
const CARD_HEIGHT = 374;
const HORIZONTAL_CARD_GAP = 12;
const VERTICAL_ROW_GAP = 12;
const CARD_ROW_ITEM_HEIGHT = CARD_HEIGHT + VERTICAL_ROW_GAP;

// List View Constants
const LIST_ITEM_HEIGHT = 80; // Example height for a list item, adjust as needed

// ===== Initialization =====
export function initMainView(config, showDetailCallback) {
    sourceSelect = document.getElementById(config.sourceSelectId);
    openFilterPanelBtn = document.getElementById(config.openFilterPanelBtnId);
    filterPanelContainer = document.getElementById(config.filterPanelContainerId);
    modelList = document.getElementById(config.modelListId);
    cardViewBtn = document.getElementById(config.cardViewBtnId);
    listViewBtn = document.getElementById(config.listViewBtnId);
    directoryTabsContainer = document.querySelector(config.directoryTabsSelector);
    crawlInfoButton = document.getElementById(config.crawlInfoButtonId);
    sourceReadonlyIndicator = document.getElementById(config.sourceReadonlyIndicatorId);

    if (!sourceSelect || !modelList || !cardViewBtn || !listViewBtn || !directoryTabsContainer || !crawlInfoButton || !sourceReadonlyIndicator || !openFilterPanelBtn || !filterPanelContainer) {
        logMessage('error', "[MainView] Initialization failed: DOM elements missing.", config);
        return;
    }

    sourceSelect.addEventListener('change', handleSourceChange);
    modelList.addEventListener('click', handleModelClick);
    modelList.addEventListener('mouseover', handleModelListMouseOverForTagsTooltip);
    modelList.addEventListener('mouseout', handleModelListMouseOutOfTagsTooltip);
    openFilterPanelBtn.addEventListener('click', toggleFilterPanel);
    cardViewBtn.addEventListener('click', () => switchViewMode('card'));
    listViewBtn.addEventListener('click', () => switchViewMode('list'));
    crawlInfoButton.addEventListener('click', () => {
        if (crawlStatusModal) crawlStatusModal.show(currentSourceId, currentDirectory);
    });

    updateViewModeButtons();
    _showDetail = showDetailCallback;
    crawlStatusModal = new CrawlStatusModal();
    setupGlobalTagsTooltip();

    if (window.ResizeObserver && typeof VirtualScroll !== 'undefined') {
        cardViewResizeObserver = new ResizeObserver(entries => {
            for (let entry of entries) {
                if (entry.target === modelList && displayMode === 'card') { // Only for card view resize
                    logMessage('debug', '[MainView] modelList resized (card view), re-calculating virtual scroll.');
                    setupOrUpdateVirtualScroll();
                }
            }
        });
        cardViewResizeObserver.observe(modelList);
    } else {
        logMessage('warn', '[MainView] ResizeObserver or VirtualScroll not available.');
    }

    // Initial setup for virtual scroll based on current displayMode
    if (typeof VirtualScroll !== 'undefined') {
        setupOrUpdateVirtualScroll();
    }

    // Listen for model updates from the detail view
    window.addEventListener('model-updated', _handleModelUpdatedEvent);
}

let _showDetail = (model) => logMessage('warn', "showDetailCallback not initialized.");

/**
 * Handles the 'model-updated' event dispatched from the detail view.
 * @param {CustomEvent} event - The event object.
 * @param {object} event.detail - The updated model object.
 */
function _handleModelUpdatedEvent(event) {
    if (event.detail) {
        logMessage('info', `[MainView] Received 'model-updated' event for: ${event.detail.name}`);
        updateSingleModelCard(event.detail);
    } else {
        logMessage('warn', "[MainView] Received 'model-updated' event without detail.");
    }
}

function handleModelClick(event) {
    // Find the clicked model card or list item's row
    const clickedCardElement = event.target.closest('.model-card');
    const rowElement = event.target.closest('.list-item-row, .virtual-scroll-row');

    let modelIdentifierStr = null;

    if (clickedCardElement && clickedCardElement.dataset.modelIdentifier) {
        modelIdentifierStr = clickedCardElement.dataset.modelIdentifier;
    } else if (rowElement && rowElement.dataset.modelIdentifier) {
        modelIdentifierStr = rowElement.dataset.modelIdentifier;
    }

    if (modelIdentifierStr) {
        try {
            const modelIdentifier = JSON.parse(modelIdentifierStr); // { file, jsonPath, sourceId }
            const model = models.find(m =>
                m.file === modelIdentifier.file &&
                m.jsonPath === modelIdentifier.jsonPath &&
                m.sourceId === modelIdentifier.sourceId
            );
            if (model && _showDetail) {
                logMessage('info', `[UI] Clicked model: ${model.name}`);
                const isReadOnly = currentSourceConfig?.readOnly === true;
                // Pass the full modelObj, its sourceId (already part of modelObj but explicit for clarity), and readOnly status
                _showDetail(model, model.sourceId, isReadOnly);
            } else {
                logMessage('warn', '[MainView] Clicked model not found in state or _showDetail missing for identifier:', modelIdentifierStr);
            }
        } catch (e) {
            logMessage('error', '[MainView] Error parsing modelIdentifier from dataset:', e, modelIdentifierStr);
        }
    } else if (rowElement || clickedCardElement) {
        logMessage('warn', '[MainView] Click detected on a row or card, but no modelIdentifier data found.', {
            clickedCardDataset: clickedCardElement?.dataset,
            rowElementDataset: rowElement?.dataset
        });
    }
}


async function toggleFilterPanel() {
    logMessage('info', '[UI] Toggling filter panel.');
    if (filterPanelInstance) {
        if (filterPanelContainer.style.display !== 'block') {
            await filterPanelInstance.updateOptions(currentSourceId);
        }
        filterPanelInstance.toggle();
        if (filterPanelContainer.style.display === 'block') {
            document.addEventListener('mousedown', handleOutsideClickForFilterPanel);
        } else {
            document.removeEventListener('mousedown', handleOutsideClickForFilterPanel);
        }
    } else {
        try {
            filterPanelInstance = new FilterPanel(filterPanelContainer.id, handleFiltersApplied, null);
            filterPanelInstance.hide();
            await filterPanelInstance.updateOptions(currentSourceId);
            filterPanelInstance.show();
            document.addEventListener('mousedown', handleOutsideClickForFilterPanel);
        } catch (error) {
            logMessage('error', '[MainView] FilterPanel init failed:', error);
            filterPanelInstance = null;
        }
    }
}

function setupGlobalTagsTooltip() {
    globalTagsTooltip = document.createElement('div');
    globalTagsTooltip.className = 'global-tags-tooltip';
    Object.assign(globalTagsTooltip.style, { display: 'none', position: 'absolute', zIndex: '1001' });
    document.body.appendChild(globalTagsTooltip);
}

function handleFiltersApplied(newFilters) {
    logMessage('info', '[MainView] Filters applied:', newFilters);
    currentAppliedFilters = newFilters || { baseModel: [], modelType: [] };
    if (currentSourceId) loadModels(currentSourceId, currentDirectory);
}

function handleOutsideClickForFilterPanel(event) {
    if (!filterPanelInstance || !filterPanelContainer.contains(event.target) && !openFilterPanelBtn.contains(event.target)) {
        filterPanelInstance.hide();
        document.removeEventListener('mousedown', handleOutsideClickForFilterPanel);
    }
}

async function fetchAndStoreSourceConfigs() {
    try {
        allSourceConfigs = await getAllSourceConfigs() || [];
        logMessage('info', `[MainView] Fetched ${allSourceConfigs.length} source configs.`);
    } catch (error) {
        logMessage('error', '[MainView] Failed to fetch source configs:', error);
        allSourceConfigs = [];
    }
}

export async function loadModels(sourceId, directory = null) {
    logMessage('info', `[MainView] Loading models: sourceId=${sourceId}, directory=${directory ?? 'root'}`);
    setLoading(true);
    currentSourceId = sourceId;
    currentDirectory = directory;

    try {
        models = await listModels(sourceId, directory, currentAppliedFilters);
        if (directory === null) {
            subdirectories = await listSubdirectories(sourceId);
            renderDirectoryTabs();
        }
        // Setup or update virtual scroll regardless of mode, as it handles both now
        if (typeof VirtualScroll !== 'undefined') {
            setupOrUpdateVirtualScroll();
        }
        renderModels(); // This will now mostly defer to VirtualScroll or handle empty
        logMessage('info', `[MainView] Loaded ${models.length} models.`);
    } catch (e) {
        logMessage('error', `[MainView] Failed to load models:`, e);
        models = [];
        subdirectories = [];
        if (typeof VirtualScroll !== 'undefined') {
            setupOrUpdateVirtualScroll(); // Update with empty models
        }
        renderModels();
        renderDirectoryTabs();
    } finally {
        setLoading(false);
    }
}

// ===== Virtual Scroll Helper Functions =====

/** Transforms models into items suitable for VirtualScroll based on displayMode. */
function _transformModelsToVirtualScrollItems() {
    if (displayMode === 'card') {
        if (!models || models.length === 0) return [];
        const containerWidth = modelList.clientWidth;
        // Ensure effectiveCardWidth is positive to avoid division by zero or negative results
        const effectiveCardWidth = Math.max(1, CARD_APPROX_WIDTH + HORIZONTAL_CARD_GAP);
        const itemsPerRow = containerWidth > 0 ? Math.max(1, Math.floor(containerWidth / effectiveCardWidth)) : 1;

        const rows = [];
        for (let i = 0; i < models.length; i += itemsPerRow) {
            rows.push(models.slice(i, i + itemsPerRow));
        }
        return rows;
    } else if (displayMode === 'list') {
        return models; // For list view, each model is an item
    }
    return [];
}

/** Renders a row of cards for card view. */
function _renderVirtualCardRow(rowModels) {
    const rowElement = document.createElement('div');
    // Use a more specific class for card rows if needed, or keep generic
    rowElement.className = 'virtual-scroll-row card-row-container';
    // For card view, the row itself doesn't carry a single model's data,
    // as it contains multiple cards. Each card will have its own dataset.
    rowModels.forEach(model => {
        const cardElement = _renderSingleModelElement(model); // Returns <li> with dataset.modelFile
        rowElement.appendChild(cardElement);
    });
    return rowElement;
}

/** Renders a single list item for list view by wrapping the original model card structure. */
function _renderVirtualListItem(model) {
    // 1. Create the outer container for virtual scroll positioning
    const listItemRow = document.createElement('div');
    listItemRow.className = 'list-item-row'; // Class for the virtual scroll item row
    // Set dataset on the row for click handling delegation
    // Store { file, jsonPath, sourceId } as the identifier
    listItemRow.dataset.modelIdentifier = JSON.stringify({
        file: model.file,
        jsonPath: model.jsonPath,
        sourceId: model.sourceId
    });

    // 2. Render the original card structure using the existing function
    //    _renderSingleModelElement returns an <li> element with class 'model-card'
    //    This element will be styled by `.list-view .model-card` rules from list-view.css
    const modelCardElement = _renderSingleModelElement(model);

    // 3. Append the original card structure inside the virtual scroll row container
    listItemRow.appendChild(modelCardElement);

    // IMPORTANT:
    // - CSS must style `.list-item-row` with `height: LIST_ITEM_HEIGHT;` (e.g., 70px)
    //   and potentially `overflow: hidden;`
    // - CSS in list-view.css targeting `.list-view .model-card` should now apply
    //   to the element inside `.list-item-row`.
    // - Ensure the rendered height of the inner `.model-card` (styled by list-view.css)
    //   does not exceed LIST_ITEM_HEIGHT. If it can, apply `max-height` and `overflow: hidden`
    //   to `.list-view .list-item-row .model-card` or specific inner elements like the tags container.

    return listItemRow;
}


function setupOrUpdateVirtualScroll() {
    if (!modelList || typeof VirtualScroll === 'undefined') {
        logMessage('warn', '[MainView] VirtualScroll setup skipped: modelList or VirtualScroll lib not available.');
        if (virtualScrollInstance) { // If lib was available but now isn't, or modelList gone
            virtualScrollInstance.destroy();
            virtualScrollInstance = null;
        }
        return;
    }

    const itemsData = _transformModelsToVirtualScrollItems();
    const itemHeight = displayMode === 'card' ? CARD_ROW_ITEM_HEIGHT : LIST_ITEM_HEIGHT;
    const renderFunction = displayMode === 'card' ? _renderVirtualCardRow : _renderVirtualListItem;

    logMessage('debug', `[MainView] VirtualScroll setup: mode=${displayMode}, items=${itemsData.length}, itemHeight=${itemHeight}`);

    if (models.length === 0) {
        if (virtualScrollInstance) {
            virtualScrollInstance.updateItems([]);
        }
        // renderModels will handle showing the empty message
        return;
    }

    // If instance exists and config (itemHeight/renderFn) might change due to mode switch, destroy and recreate
    let needsRecreation = false;
    if (virtualScrollInstance) {
        // Check if critical parameters that require recreation have changed
        // Note: Accessing internal properties like _itemHeight might be fragile.
        // A safer approach is to always recreate if the mode changes, as handled in switchViewMode.
        // Here, we only check if an instance exists but maybe wasn't configured for the current mode yet.
        if (virtualScrollInstance._itemHeight !== itemHeight || virtualScrollInstance._renderItem !== renderFunction) {
             logMessage('debug', '[MainView] VirtualScroll config mismatch detected, scheduling recreation.');
             needsRecreation = true;
        }
    }

    if (needsRecreation && virtualScrollInstance) {
        logMessage('debug', '[MainView] Recreating VirtualScroll instance due to config mismatch.');
        virtualScrollInstance.destroy();
        virtualScrollInstance = null;
    }

    if (!virtualScrollInstance) {
        logMessage('info', `[MainView] Initializing VirtualScroll for ${displayMode} view.`);
        virtualScrollInstance = new VirtualScroll({
            container: modelList,
            items: itemsData,
            itemHeight: itemHeight,
            renderItem: renderFunction,
            bufferSize: displayMode === 'card' ? 4 : 10, // Different buffer for card vs list
        });
    } else {
        logMessage('debug', `[MainView] Updating VirtualScroll items for ${displayMode} view.`);
        virtualScrollInstance.updateItems(itemsData);
    }
    // Always refresh after creation or update to ensure correct rendering
    if (virtualScrollInstance) {
        virtualScrollInstance.refresh();
    }
}


// ===== Rendering Functions =====
export async function renderSources() {
    if (!sourceSelect) return;
    await fetchAndStoreSourceConfigs();
    const sourcesToRender = allSourceConfigs;
    const currentVal = sourceSelect.value;
    clearChildren(sourceSelect);
    sourcesToRender.forEach(src => {
        const option = document.createElement('option');
        option.value = src.id;
        option.textContent = src.name;
        option.classList.add(src.type === 'local' ? 'source-option-local' : 'source-option-webdav');
        sourceSelect.appendChild(option);
    });
    if (sourcesToRender.some(s => s.id === currentVal)) {
        sourceSelect.value = currentVal;
    } else if (sourcesToRender.length > 0) {
        sourceSelect.value = sourcesToRender[0].id;
        handleSourceChange();
    } else {
        if (crawlInfoButton) crawlInfoButton.style.display = 'none';
        if (sourceReadonlyIndicator) sourceReadonlyIndicator.style.display = 'none';
    }
}

const MAX_VISIBLE_TAGS = 6; // Keep consistent or define separately for list/card if needed

function _renderSingleModelElement(modelObj) { // Renders the core card structure, used by both views now
    const card = document.createElement('li'); // Use LI as it was likely styled as such
    card.className = 'model-card'; // Keep the original class for styling
    // Set dataset here for both card view and list view's inner card element
    // Store { file, jsonPath, sourceId } as the identifier
    card.dataset.modelIdentifier = JSON.stringify({
        file: modelObj.file,
        jsonPath: modelObj.jsonPath,
        sourceId: modelObj.sourceId
    });

    const fragment = document.createDocumentFragment();

    // --- Image ---
    const imageContainer = document.createElement('div');
    imageContainer.className = 'model-card-image-container';
    let imageElement;
    if (modelObj.image) {
        imageElement = document.createElement('img');
        imageElement.className = 'model-image';
        imageElement.setAttribute('data-image-path', modelObj.image);
        // currentSourceId is still relevant for loadImage if image path is relative to source
        // but modelObj.sourceId should be the definitive source for this model's image.
        // Assuming loadImage can handle absolute paths or uses modelObj.sourceId if provided.
        imageElement.setAttribute('data-source-id', modelObj.sourceId);
        imageElement.alt = modelObj.name || t('modelImageAlt');
        imageElement.loading = 'lazy';
        imageObserver.observe(imageElement);
    } else {
        imageElement = document.createElement('div');
        imageElement.className = 'model-image model-image-placeholder';
        imageElement.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`;
    }
    imageContainer.appendChild(imageElement);
    if (displayMode === 'card' && modelObj.baseModel) {
        let overlay = document.createElement('span');
        overlay.className = 'custom-img-overlay';
        overlay.textContent = modelObj.baseModel;
        imageContainer.appendChild(overlay);
    }
    fragment.appendChild(imageContainer);

    // --- Info ---
    const contentDiv = document.createElement('div');
    contentDiv.className = 'model-info';
    const nameH3 = document.createElement('h3');
    nameH3.className = 'model-name';
    nameH3.textContent = modelObj.name;
    const typeSpan = document.createElement('span');
    typeSpan.className = 'model-type';
    typeSpan.textContent = modelObj.modelType ? modelObj.modelType.toUpperCase() : t('uncategorized').toUpperCase();
    contentDiv.appendChild(nameH3);
    contentDiv.appendChild(typeSpan);

    // Description (conditionally for list view, or if design changes)
    // if (displayMode === 'list' && modelObj.modelJsonInfo && modelObj.modelJsonInfo.description) {
    //     const descriptionP = document.createElement('p');
    //     descriptionP.className = 'model-description-list-view'; // Specific class for styling
    //     descriptionP.textContent = modelObj.modelJsonInfo.description.substring(0, 100) + (modelObj.modelJsonInfo.description.length > 100 ? '...' : ''); // Example: truncate
    //     contentDiv.appendChild(descriptionP);
    // }
    fragment.appendChild(contentDiv);


    // --- Tags ---
    const tagsContainer = document.createElement('div');
    tagsContainer.className = 'tags-container';
    const tags = modelObj.modelJsonInfo && modelObj.modelJsonInfo.tags ? modelObj.modelJsonInfo.tags : [];
    if (tags.length > 0) {
        const isCardView = displayMode === 'card';
        const maxTagsToShow = isCardView ? MAX_VISIBLE_TAGS : Infinity;

        tags.forEach((tagText, index) => {
            if (index < maxTagsToShow) {
                const tagElementVisible = document.createElement('span');
                tagElementVisible.className = 'tag';
                tagElementVisible.textContent = tagText;
                tagsContainer.appendChild(tagElementVisible);
            }
        });

        if (isCardView && tags.length > maxTagsToShow) {
            const ellipsis = document.createElement('span');
            ellipsis.className = 'tag tag-ellipsis';
            ellipsis.textContent = '...';
            tagsContainer.appendChild(ellipsis);
        }
    }
    fragment.appendChild(tagsContainer);

    card.appendChild(fragment);
    return card;
}


function _releaseBlobUrlForCardElement(cardElement) { // This is generic enough
    if (!cardElement) return;
    // Find image within the card/list item structure
    const imgElement = cardElement.querySelector('.model-image[data-blob-cache-key]');
    if (imgElement) {
        const cacheKey = imgElement.dataset.blobCacheKey;
        if (cacheKey) BlobUrlCache.releaseBlobUrlByKey(cacheKey);
        delete imgElement.dataset.blobCacheKey;
    }
}

function renderModels() {
    if (!modelList) return;
    const mainSection = modelList.closest('#mainSection') || document.body;

    // Add/remove view-specific classes on mainSection and modelList
    if (displayMode === 'card') {
        mainSection.classList.add('card-view');
        mainSection.classList.remove('list-view');
        modelList.classList.add('virtual-scroll-container'); // Ensure this class is present for CSS
        modelList.classList.remove('list-view-virtual-scroll'); // Remove list specific if any
    } else if (displayMode === 'list') {
        mainSection.classList.add('list-view');
        mainSection.classList.remove('card-view');
        modelList.classList.add('virtual-scroll-container'); // List view also uses this for height/overflow
        modelList.classList.add('list-view-virtual-scroll'); // Add specific class for list styling
    }

    if (typeof VirtualScroll === 'undefined') {
        logMessage('error', '[MainView] VirtualScroll library not available. Cannot render with virtual scrolling.');
        clearChildren(modelList);
        modelList.innerHTML = `<p class="empty-list-message">${t('errorMissingLibrary', { library: 'VirtualScroll' })}</p>`;
        return;
    }

    // VirtualScroll instance handles rendering its items into modelList.
    // We just need to ensure it's updated. setupOrUpdateVirtualScroll() is called from loadModels or switchViewMode.
    if (models.length === 0) {
        if (virtualScrollInstance) virtualScrollInstance.updateItems([]);
        clearChildren(modelList); // Explicitly clear if library doesn't on empty items
        modelList.innerHTML = `<p class="empty-list-message">${t('noModelsFound')}</p>`;
    } else if (!virtualScrollInstance && models.length > 0) {
        logMessage('warn', `[MainView] renderModels called for ${displayMode} view with models, but no virtualScrollInstance. Attempting setup.`);
        setupOrUpdateVirtualScroll(); // Attempt to set it up
         if (!virtualScrollInstance) { // If still no instance
            clearChildren(modelList);
            modelList.innerHTML = `<p class="empty-list-message">${t('virtualScrollError')}</p>`;
         }
    }
    // If virtualScrollInstance exists and models.length > 0, the library handles rendering.
}


export function updateSingleModelCard(updatedModelObj) {
    if (!updatedModelObj || !updatedModelObj.file || !updatedModelObj.jsonPath || !updatedModelObj.sourceId) {
        logMessage('warn', '[MainView] updateSingleModelCard called with incomplete model identifier.', updatedModelObj);
        return;
    }
    logMessage('info', `[MainView] Updating single model item: ${updatedModelObj.name}`);

logMessage('debug', `[MainView updateSingleModelCard] Comparing with updatedModelObj: file='${updatedModelObj.file}', jsonPath='${updatedModelObj.jsonPath}', sourceId='${updatedModelObj.sourceId}'`);

    logMessage('debug', '[MainView updateSingleModelCard] Iterating current models array for comparison:');
    models.forEach((m, index) => {
        logMessage('debug', `  [${index}] model in array: file='${m.file}', jsonPath='${m.jsonPath}', sourceId='${m.sourceId}'`);
    });
    const modelIndex = models.findIndex(m =>
        m.file === updatedModelObj.file &&
        m.jsonPath === updatedModelObj.jsonPath &&
        m.sourceId === updatedModelObj.sourceId
    );

    if (modelIndex !== -1) {
        // updatedModelObj is the fully fresh model object from the service/event
        models[modelIndex] = updatedModelObj; // Directly replace with the fresh object

        if (virtualScrollInstance) {
            const newItemsData = _transformModelsToVirtualScrollItems();
            virtualScrollInstance.updateItems(newItemsData);
            virtualScrollInstance.refresh();
        }
    } else {
        logMessage('warn', `[MainView] Updated model (file: ${updatedModelObj.file}, json: ${updatedModelObj.jsonPath}, source: ${updatedModelObj.sourceId}) not in current models array.`);
    }
}

function renderDirectoryTabs() {
    if (!directoryTabsContainer) return;
    const tabList = directoryTabsContainer.querySelector('.tab-list');
    if (!tabList) return;
    clearChildren(tabList);

    const allTab = document.createElement('div');
    allTab.className = `tab-item ${currentDirectory === null ? 'active' : ''}`;
    allTab.textContent = t('all');
    allTab.onclick = () => {
        if (currentDirectory !== null) {
            setActiveTab(allTab);
            loadModels(currentSourceId, null);
        }
    };
    tabList.appendChild(allTab);

    subdirectories.sort().forEach(dir => {
        const tab = document.createElement('div');
        tab.className = `tab-item ${currentDirectory === dir ? 'active' : ''}`;
        tab.textContent = dir;
        tab.onclick = () => {
            if (currentDirectory !== dir) {
                setActiveTab(tab);
                loadModels(currentSourceId, dir);
            }
        };
        tabList.appendChild(tab);
    });
    directoryTabsContainer.style.display = subdirectories.length > 0 ? 'block' : 'none';
}

function setActiveTab(activeTabElement) {
    activeTabElement.parentNode.querySelectorAll('.tab-item').forEach(item => item.classList.remove('active'));
    activeTabElement.classList.add('active');
}

async function handleSourceChange() {
    if (!sourceSelect) return;
    const selectedSourceId = sourceSelect.value;
    logMessage('info', `[UI] Source changed to: ${selectedSourceId}`);
    currentSourceConfig = allSourceConfigs.find(config => config.id === selectedSourceId) || null;

    if (crawlInfoButton && sourceReadonlyIndicator) {
        const isReadOnly = currentSourceConfig?.readOnly === true;
        const isLocal = currentSourceConfig?.type?.toUpperCase() === 'LOCAL';
        sourceReadonlyIndicator.style.display = isReadOnly ? 'inline-flex' : 'none';
        crawlInfoButton.style.display = (!isReadOnly && isLocal) ? 'inline-block' : 'none';
    }

    if (selectedSourceId) {
        await loadModels(selectedSourceId, null);
    } else {
        models = [];
        subdirectories = [];
        if (typeof VirtualScroll !== 'undefined') setupOrUpdateVirtualScroll();
        renderModels();
        renderDirectoryTabs();
        if (crawlInfoButton) crawlInfoButton.style.display = 'none';
        if (sourceReadonlyIndicator) sourceReadonlyIndicator.style.display = 'none';
    }
}

function switchViewMode(newMode) {
    if (displayMode !== newMode) {
        logMessage('info', `[UI] Switching view mode to: ${newMode}`);
        displayMode = newMode; // Set new mode first

        if (virtualScrollInstance) { // Destroy existing instance before re-setup
            logMessage('debug', '[MainView] Mode changed, destroying existing VirtualScroll instance.');
            virtualScrollInstance.destroy();
            virtualScrollInstance = null;
            // Don't clear children here, renderModels will handle it or VirtualScroll will overwrite
        }

        updateViewModeButtons();

        if (typeof VirtualScroll !== 'undefined') {
            setupOrUpdateVirtualScroll(); // Setup/Recreate for the new mode
        }
        renderModels(); // Render with new mode (will use virtual scroll if setup)
    }
}

function updateViewModeButtons() {
    if (displayMode === 'card') {
        cardViewBtn.classList.add('active');
        listViewBtn.classList.remove('active');
    } else {
        listViewBtn.classList.add('active');
        cardViewBtn.classList.remove('active');
    }
}


function handleModelListMouseOverForTagsTooltip(event) {
    if (displayMode !== 'card' || !globalTagsTooltip) return; // Tooltip only for card view for now
    const tagsContainer = event.target.closest('.tags-container');
    if (!tagsContainer) return;
    const cardElement = tagsContainer.closest('.model-card');
    if (!cardElement || !cardElement.dataset.modelIdentifier) {
        return;
    }

    const modelIdentifierStr = cardElement.dataset.modelIdentifier;

    try {
        const modelIdentifier = JSON.parse(modelIdentifierStr);
        const modelObj = models.find(m =>
            m.file === modelIdentifier.file &&
            m.jsonPath === modelIdentifier.jsonPath &&
            m.sourceId === modelIdentifier.sourceId
        );

        const tags = modelObj && modelObj.modelJsonInfo && modelObj.modelJsonInfo.tags ? modelObj.modelJsonInfo.tags : [];

        if (tags.length > MAX_VISIBLE_TAGS) {
            clearChildren(globalTagsTooltip);
            tags.forEach(tagText => {
                const tagElementFull = document.createElement('span');
                tagElementFull.className = 'tag';
                tagElementFull.textContent = tagText;
                globalTagsTooltip.appendChild(tagElementFull);
            });
            const rect = tagsContainer.getBoundingClientRect();
            let top = rect.bottom + window.scrollY + 5;
            let left = rect.left + window.scrollX;
            globalTagsTooltip.style.display = 'flex';
            const tooltipRect = globalTagsTooltip.getBoundingClientRect();
            if (left + tooltipRect.width > window.innerWidth) left = window.innerWidth - tooltipRect.width - 10;
            if (top + tooltipRect.height > window.innerHeight) top = rect.top + window.scrollY - tooltipRect.height - 5;
            if (left < 0) left = 10;
            if (top < 0) top = 10;
            globalTagsTooltip.style.left = `${left}px`;
            globalTagsTooltip.style.top = `${top}px`;
            globalTagsTooltip.classList.add('tooltip-active');
        }
    } catch (e) {
        logMessage('error', '[MainView] Error for tags tooltip:', e, modelIdentifierStr);
    }
}


function handleModelListMouseOutOfTagsTooltip(event) {
    if (displayMode !== 'card' || !globalTagsTooltip) return;
    const toElement = event.relatedTarget;
    if (toElement && (globalTagsTooltip.contains(toElement) || globalTagsTooltip === toElement)) return;
    const currentTargetTagsContainer = event.target.closest('.tags-container');
    if (currentTargetTagsContainer) {
        if (!toElement || (!toElement.closest('.tags-container') && !globalTagsTooltip.contains(toElement))) {
            globalTagsTooltip.style.display = 'none';
            globalTagsTooltip.classList.remove('tooltip-active');
        }
    } else if (globalTagsTooltip.classList.contains('tooltip-active') && (!toElement || !globalTagsTooltip.contains(toElement))) {
        globalTagsTooltip.style.display = 'none';
        globalTagsTooltip.classList.remove('tooltip-active');
    }
}

export function cleanupMainView() {
    if (cardViewResizeObserver && modelList) cardViewResizeObserver.unobserve(modelList);
    if (virtualScrollInstance) virtualScrollInstance.destroy();
    document.removeEventListener('mousedown', handleOutsideClickForFilterPanel);
    window.removeEventListener('model-updated', _handleModelUpdatedEvent); // Remove event listener
    logMessage('debug', '[MainView] Cleaned up.');
}
