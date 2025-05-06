// src/renderer/js/components/filter-panel.js
// import { i18n } from '../core/i18n.js'; // Temporarily commented out
// const log = window.api.logMessage; // Temporarily commented out
const consoleLog = console.log; // Use console.log for now

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
      consoleLog(`[FilterPanel] ERROR: Container element with ID '${elementId}' not found.`);
      return;
    }
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
    if (!this.container) return;

    const baseModelTitle = '基础模型'; // Hardcoded string
    const modelTypeTitle = '模型类型'; // Hardcoded string
    const clearFiltersText = '清空筛选条件'; // Hardcoded string
    const noOptionsText = '无可用选项'; // Hardcoded string

    // Avoid template strings completely - use string concatenation
    let content = '<div>Filter Panel Test</div>';

    this.container.innerHTML = content;
    this.addEventListeners();
  }

  renderOptions(options, filterKey, noOptionsText) {
    if (!options || options.length === 0) {
      return `<span class="no-options">\${noOptionsText}</span>`;
    }
    return options.map(option => `
      <label class="filter-option">
        <input type="checkbox" name="\${filterKey}" value="\${option}" 
               \${this.selectedFilters[filterKey]?.includes(option) ? 'checked' : ''}>
        \${option}
      </label>
    `).join('');
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
    if (this.container) this.container.style.display = 'block';
    consoleLog('[FilterPanel] DEBUG: Shown.');
  }

  hide() {
    if (this.container) this.container.style.display = 'none';
    consoleLog('[FilterPanel] DEBUG: Hidden.');
  }

  toggle() {
    if (this.container) {
        if (this.container.style.display === 'none' || !this.container.style.display) {
            this.show();
        } else {
            this.hide();
        }
    }
  }
}

// Temporarily removed: 
window.FilterPanel = FilterPanel;
