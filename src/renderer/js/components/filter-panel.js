import { t } from '../core/i18n.js'; 
import { logMessage, getFilterOptions } from '../apiBridge.js';

class FilterPanel {
  /**
   * Creates an instance of FilterPanel.
   * @param {string} elementId - The ID of the container element for the panel.
   * @param {function} onFilterChangeCallback - Callback function when filters change.
   * @param {object} [initialOptions=null] - Optional pre-fetched filter options { baseModels: [], modelTypes: [] }.
   */
  constructor(elementId, onFilterChangeCallback, initialOptions = null) {
    this.container = document.getElementById(elementId);
    this.onFilterChange = onFilterChangeCallback;
    this.availableFilters = {
      baseModels: [],
      modelTypes: [],
      tags: [],
    };
    this.selectedFilters = {
      baseModel: [],
      modelType: [],
      tags: [],
    };

    if (!this.container) {
      logMessage('error', `[FilterPanel] Constructor - Container element with ID '${elementId}' not found.`);
      return; // Stop initialization if container is missing
    }

    let shouldFetchOptions = true;
    if (initialOptions && initialOptions.baseModels && initialOptions.modelTypes) {
        this.availableFilters.baseModels = initialOptions.baseModels;
        this.availableFilters.modelTypes = initialOptions.modelTypes;
        shouldFetchOptions = false; // Don't fetch if initial options are provided
        this.render(); // Render immediately with initial options
    } else {
        // Render initially with potentially empty options (or a loading state)
        this.render();
    }

    // Fetch options only if they weren't provided initially
    if (shouldFetchOptions) {
        this.init(); // Asynchronously fetch options
    }
  }

  /**
   * Asynchronously fetches filter options if they weren't provided initially.
   */
  async init() {
    try {
      // const options = await getFilterOptions();
      // this.availableFilters.baseModels = options.baseModels || [];
      // this.availableFilters.modelTypes = options.modelTypes || [];
      // this.availableFilters.tags = options.tags || [];
      // // Re-render with the fetched options
      this.render();
    } catch (error) {
      logMessage('error', '[FilterPanel] init() - Error fetching filter options:', error.message, error.stack);
      // Keep existing (likely empty) options and render state
      this.render();
    }
  }

  render() {
    if (!this.container) {
        logMessage('error', '[FilterPanel] Render - Container not found.');
        return;
    }

    // Use i18n for titles and texts
    const baseModelTitle = t('filterPanel.baseModelTitle', 'Base Models');
    const modelTypeTitle = t('filterPanel.modelTypeTitle', 'Model Types');
    const tagsTitle = t('filterPanel.tagsTitle', 'Tags');
    const clearFiltersText = t('filterPanel.clearFilters', 'Clear Filters');
    const noOptionsText = t('filterPanel.noOptionsAvailable', 'No options available');

    let content = `
      <div class="filter-panel-content">
        <div class="filter-section">
          <h4>${baseModelTitle}</h4>
          <div class="filter-options-group" data-filter-key="baseModel">
            ${this.renderOptions(this.availableFilters.baseModels, 'baseModel', noOptionsText)}
          </div>
        </div>
        <div class="filter-section">
          <h4>${modelTypeTitle}</h4>
          <div class="filter-options-group" data-filter-key="modelType">
            ${this.renderOptions(this.availableFilters.modelTypes, 'modelType', noOptionsText)}
          </div>
        </div>
        <div class="filter-section">
          <h4>${tagsTitle}</h4>
          <div class="filter-options-group" data-filter-key="tags">
            ${this.renderOptions(this.availableFilters.tags, 'tags', noOptionsText)}
          </div>
        </div>
        <div class="filter-actions">
          <button id="clear-filters-btn" class="filter-panel-button">${clearFiltersText}</button>
        </div>
      </div>
    `;

    this.container.innerHTML = content;
    this.addEventListeners(); // Re-attach event listeners to the new content
  }

  renderOptions(options, filterKey, noOptionsText) {
    if (!options || options.length === 0) {
      return `<span class="no-options">${noOptionsText}</span>`; // Use the passed noOptionsText
    }
    // Ensure option values are properly escaped if they can contain special HTML characters,
    // though for typical filter values this might not be an issue.
    return options.map(option => {
      const isChecked = this.selectedFilters[filterKey]?.includes(option) ? 'checked' : '';
      // Sanitize option text if necessary, for now assuming it's safe
      const displayOption = option;
      return `
        <label class="filter-option">
          <input type="checkbox" name="${filterKey}" value="${option}" ${isChecked}>
          ${displayOption}
        </label>
      `;
    }).join('');
  }

  addEventListeners() {
    const clearButton = this.container.querySelector('#clear-filters-btn');
    if (clearButton) {
      clearButton.addEventListener('click', () => this.clearFilters());
    }

    const optionGroups = this.container.querySelectorAll('.filter-options-group');
    optionGroups.forEach(group => {
      group.addEventListener('change', (event) => {
        if (event.target.type === 'checkbox') {
          const filterKey = group.dataset.filterKey;
          const value = event.target.value;
          const isChecked = event.target.checked;

          if (!this.selectedFilters[filterKey]) {
            this.selectedFilters[filterKey] = [];
          }

          if (isChecked) {
            if (!this.selectedFilters[filterKey].includes(value)) {
              this.selectedFilters[filterKey].push(value);
            }
          } else {
            this.selectedFilters[filterKey] = this.selectedFilters[filterKey].filter(item => item !== value);
          }
          this.triggerFilterChange();
        }
      });
    });
  }

  clearFilters() {
    this.selectedFilters.baseModel = [];
    this.selectedFilters.modelType = [];
    this.selectedFilters.tags = [];
    logMessage('info', '[FilterPanel] Filters cleared.');
    this.render(); // Re-render to uncheck checkboxes
    this.triggerFilterChange();
  }

  triggerFilterChange() {
    if (this.onFilterChange && typeof this.onFilterChange === 'function') {
      const filtersToApply = JSON.parse(JSON.stringify(this.selectedFilters));
      this.onFilterChange(filtersToApply);
    }
  }

  show() {
    if (this.container) {
        this.container.style.display = 'block';
    } else {
        logMessage('warn', '[FilterPanel] show() - Container not found.');
    }
  }

  hide() {
    if (this.container) {
        this.container.style.display = 'none';
    } else {
        logMessage('warn', '[FilterPanel] hide() - Container not found.');
    }
  }

  toggle() {
    if (this.container) {
        const currentDisplay = this.container.style.display;
        if (currentDisplay === 'none' || !currentDisplay) {
            this.show();
        } else {
            this.hide();
        }
    }
  }

  /**
   * Updates the available filter options and re-renders the panel.
   * @param {object} newOptions - The new filter options { baseModels: [], modelTypes: [] }.
   */
  async updateOptions(sourceIdToFetch) {
    const options = await getFilterOptions(sourceIdToFetch);
    const baseModelsArray = Array.from(options.baseModels ||[]);
    const modelTypesArray = Array.from(options.modelTypes ||[]);
    const tagsArray = Array.from(options.tags ||[]);


    this.availableFilters.baseModels = baseModelsArray;
    this.availableFilters.modelTypes = modelTypesArray;
    this.availableFilters.tags = tagsArray;
    this.render();
  }
}

// Export the class using ES6 module syntax
export default FilterPanel;
// Removed: window.FilterPanel = FilterPanel;
