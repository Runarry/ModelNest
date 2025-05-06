// src/renderer/js/components/filter-panel.js
import { t } from '../core/i18n.js'; // Import the translation function
// Assuming logMessage is available via apiBridge or directly if preload exposes it
// For now, we'll stick to consoleLog for simplicity in this diff,
// but ideally, it should use the project's logging mechanism.
const consoleLog = console.log;

class FilterPanel {
  constructor(elementId, onFilterChangeCallback) {
    this.container = document.getElementById(elementId);
    this.onFilterChange = onFilterChangeCallback;
    this.availableFilters = {
      baseModels: [],
      modelTypes: [],
    };
    this.selectedFilters = {
      baseModel: [],
      modelType: [],
    };

    if (!this.container) {
      // Ensuring this line is clean
      consoleLog(`[FilterPanel] ERROR: Constructor - Container element with ID '${elementId}' not found.`);
      return;
    }
    consoleLog(`[FilterPanel] INFO: Constructor - Container element found:`, this.container);
    consoleLog('[FilterPanel] INFO: FilterPanel initialized.');
    this.init();
  }

  async init() {
    try {
      // Assuming window.api is still available for getFilterOptions
      const options = await window.api.getFilterOptions();
      this.availableFilters.baseModels = options.baseModels || [];
      this.availableFilters.modelTypes = options.modelTypes || [];
      consoleLog('[FilterPanel] DEBUG: Fetched filter options:', this.availableFilters);
    } catch (error) {
      consoleLog('[FilterPanel] ERROR: Error fetching filter options:', error.message, error.stack);
    }
    this.render();
  }

  render() {
    if (!this.container) {
        consoleLog('[FilterPanel] ERROR: Render - Container not found.');
        return;
    }

    // Use i18n for titles and texts
    const baseModelTitle = t('filterPanel.baseModelTitle', 'Base Models');
    const modelTypeTitle = t('filterPanel.modelTypeTitle', 'Model Types');
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
        <div class="filter-actions">
          <button id="clear-filters-btn" class="filter-panel-button">${clearFiltersText}</button>
        </div>
      </div>
    `;

    this.container.innerHTML = content;
    consoleLog(`[FilterPanel] DEBUG: Render - Container innerHTML updated with dynamic content.`);
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
          consoleLog(`[FilterPanel] DEBUG: \${filterKey} selection changed:`, this.selectedFilters[filterKey]);
          this.triggerFilterChange();
        }
      });
    });
  }

  clearFilters() {
    this.selectedFilters.baseModel = [];
    this.selectedFilters.modelType = [];
    consoleLog('[FilterPanel] INFO: Filters cleared.');
    this.render(); // Re-render to uncheck checkboxes
    this.triggerFilterChange();
  }

  triggerFilterChange() {
    if (this.onFilterChange && typeof this.onFilterChange === 'function') {
      const filtersToApply = JSON.parse(JSON.stringify(this.selectedFilters));
      this.onFilterChange(filtersToApply);
      consoleLog('[FilterPanel] DEBUG: onFilterChange triggered with:', filtersToApply);
    }
  }

  show() {
    consoleLog('[FilterPanel] DEBUG: show() called.');
    if (this.container) {
        consoleLog(`[FilterPanel] DEBUG: show() - Current display: ${this.container.style.display}`);
        this.container.style.display = 'block';
        consoleLog(`[FilterPanel] DEBUG: show() - New display: ${this.container.style.display}`);
    } else {
        consoleLog('[FilterPanel] WARN: show() - Container not found.');
    }
    consoleLog('[FilterPanel] DEBUG: Shown.'); // Keep original log too
  }

  hide() {
    consoleLog('[FilterPanel] DEBUG: hide() called.');
    if (this.container) {
        consoleLog(`[FilterPanel] DEBUG: hide() - Current display: ${this.container.style.display}`);
        this.container.style.display = 'none';
        consoleLog(`[FilterPanel] DEBUG: hide() - New display: ${this.container.style.display}`);
    } else {
        consoleLog('[FilterPanel] WARN: hide() - Container not found.');
    }
    consoleLog('[FilterPanel] DEBUG: Hidden.'); // Keep original log too
  }

  toggle() {
    consoleLog('[FilterPanel] DEBUG: toggle() called.');
    if (this.container) {
        const currentDisplay = this.container.style.display;
        consoleLog(`[FilterPanel] DEBUG: toggle() - Current display: ${currentDisplay}`);
        if (currentDisplay === 'none' || !currentDisplay) {
            this.show();
        } else {
            this.hide();
        }
    }
  }
}

// Export the class using ES6 module syntax
export default FilterPanel;
// Removed: window.FilterPanel = FilterPanel;
