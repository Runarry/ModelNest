(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
  typeof define === 'function' && define.amd ? define(['exports'], factory) :
  (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.JsBooster = {}));
})(this, (function (exports) { 'use strict';

  /**
   * js-booster - High-performance frontend library
   * VirtualScroll - Virtual scrolling implementation
   * @version 1.1.2-recycled
   * @author https://cg-zhou.top/
   * @license MIT
   */

  const defaultItemStyles = {
    padding: '8px',
    borderBottom: '1px solid #eee'
  };

  class VirtualScroll {
    /**
     * Create a virtual scroll instance
     * @param {Object} options Configuration options
     * @param {HTMLElement} options.container Scroll container element
     * @param {Array} options.items Data items to display
     * @param {number} [options.itemHeight=20] Height of each list item (pixels)
     * @param {number} [options.bufferSize=10] Number of buffer items outside the visible area
     * @param {Function} [options.renderItem] Custom item rendering function (item, index) => Node | string
     * @param {Function} [options.renderHeader] Custom header rendering function
     * @param {number} [options.maxHeight=26840000] Maximum height in pixels for the content wrapper
     */
    constructor(options) {
      this.container = options.container;
      this.items = options.items || [];
      this.itemHeight = options.itemHeight || 20;
      this.bufferSize = options.bufferSize || 10;
      this.customRenderItem = options.renderItem;
      this.customRenderHeader = options.renderHeader;
      this.maxHeight = options.maxHeight || 26840000;

      this.visibleStartIndex = 0;
      this.visibleEndIndex = 0;
      this.scrollContainer = null;
      this.contentWrapper = null;
      this.contentContainer = null;
      this.totalHeight = this.items.length * this.itemHeight;
      this.heightScale = 1;

      this.nodePool = []; // Pool for recycled DOM nodes
      this.visibleNodes = new Map(); // Map of itemIndex to its DOM node for currently visible items

      if (this.totalHeight > this.maxHeight) {
        this.heightScale = this.maxHeight / this.totalHeight;
      }

      this.initialize();
    }

    initialize() {
      this.container.innerHTML = '';

      this.scrollContainer = document.createElement('div');
      Object.assign(this.scrollContainer.style, {
        flex: '1',
        overflow: 'auto',
        position: 'relative',
        minHeight: '0',
        height: '100%',
        boxSizing: 'border-box'
      });

      if (this.customRenderHeader) {
        const header = this.customRenderHeader();
        if (header) {
          this.scrollContainer.appendChild(header);
        }
      }

      this.contentWrapper = document.createElement('div');
      Object.assign(this.contentWrapper.style, {
        position: 'relative',
        width: '100%'
      });
      const scaledHeight = this.totalHeight * this.heightScale;
      this.contentWrapper.style.height = `${scaledHeight}px`;

      this.contentContainer = document.createElement('div');
      Object.assign(this.contentContainer.style, {
        position: 'absolute',
        width: '100%',
        left: '0'
      });

      this.scrollContainer.addEventListener('scroll', this.handleScroll.bind(this));

      this.contentWrapper.appendChild(this.contentContainer);
      this.scrollContainer.appendChild(this.contentWrapper);
      this.container.appendChild(this.scrollContainer);

      // Initial render: Use a smaller count for initial render if performance is critical
      const initialEndIndex = Math.min(Math.floor(this.scrollContainer.clientHeight / (this.itemHeight * this.heightScale)) + this.bufferSize * 2, this.items.length);
      this.renderVisibleItems(0, initialEndIndex);
    }

    handleScroll() {
      const scrollTop = this.scrollContainer.scrollTop;
      const containerHeight = this.scrollContainer.clientHeight;
      const realScrollTop = scrollTop / this.heightScale;

      const startIndex = Math.max(0, Math.floor(realScrollTop / this.itemHeight) - this.bufferSize);
      const endIndex = Math.min(
        this.items.length,
        Math.ceil((realScrollTop + containerHeight / this.heightScale) / this.itemHeight) + this.bufferSize
      );

      if (startIndex !== this.visibleStartIndex || endIndex !== this.visibleEndIndex) {
        this.renderVisibleItems(startIndex, endIndex);
        this.visibleStartIndex = startIndex;
        this.visibleEndIndex = endIndex;
      }
    }

    renderVisibleItems(startIndex, endIndex) {
      const newVisibleNodeMap = new Map();
      const fragment = document.createDocumentFragment();

      // Phase 1: Prepare nodes for the new visible range
      for (let i = startIndex; i < endIndex; i++) {
        if (i < 0 || i >= this.items.length) continue; // Boundary check

        const item = this.items[i];
        let itemElement = this.visibleNodes.get(i); // Check if node for this index is already rendered and visible

        if (itemElement) { // Node is already part of the currently visible set
          this.visibleNodes.delete(i); // Remove from old map to signify it's processed and kept
          // Update content if necessary
          if (this.customRenderItem) {
            // Assuming customRenderItem might need to update the element's content.
            // For robust update, customRenderItem should ideally handle diffing or be idempotent.
            // Here, we clear and re-append content from customRenderItem.
            itemElement.innerHTML = ''; // Clear previous custom content
            const newContent = this.customRenderItem(item, i);
            if (newContent instanceof Node) {
              itemElement.appendChild(newContent);
            } else if (typeof newContent === 'string') {
              itemElement.innerHTML = newContent;
            }
          } else { // Default rendering, update textContent if changed
            const newTextContent = JSON.stringify(item);
            if (itemElement.textContent !== newTextContent) {
              itemElement.textContent = newTextContent;
            }
            // Ensure default styles are applied (in case it was a custom item before)
            Object.assign(itemElement.style, defaultItemStyles);
          }
        } else { // Node is not currently visible, try to recycle or create new
          itemElement = this.nodePool.pop(); // Try to get a node from the pool

          if (itemElement) { // Successfully recycled a node
            itemElement.innerHTML = ''; // Clear previous content from recycled node
          } else { // Pool is empty, create a brand new shell
            itemElement = document.createElement('div');
          }

          // Populate the (new or recycled) itemElement
          if (this.customRenderItem) {
            const content = this.customRenderItem(item, i);
            if (content instanceof Node) {
              itemElement.appendChild(content);
            } else if (typeof content === 'string') {
              itemElement.innerHTML = content;
            }
            // Ensure default styles are NOT applied to custom items
            itemElement.style.padding = '';
            itemElement.style.borderBottom = '';
          } else {
            itemElement.textContent = JSON.stringify(item);
            Object.assign(itemElement.style, defaultItemStyles);
          }

          // Apply common styles managed by VirtualScroll to the shell
          Object.assign(itemElement.style, {
            height: `${this.itemHeight * this.heightScale}px`,
            boxSizing: 'border-box',
            width: '100%',
          });
        }

        if (itemElement) {
          newVisibleNodeMap.set(i, itemElement);
          fragment.appendChild(itemElement); // Add to fragment for ordered append
        }
      }

      // Phase 2: Recycle nodes that are no longer visible
      // These are nodes that were in this.visibleNodes (old set) but not carried over to newVisibleNodeMap
      this.visibleNodes.forEach((nodeToRecycle) => {
        this.nodePool.push(nodeToRecycle);
      });

      // Phase 3: Update DOM
      // Efficiently update contentContainer: remove all children then append the new fragment.
      // This is generally faster than trying to diff and move individual nodes for this specific case.
      while (this.contentContainer.firstChild) {
        this.contentContainer.removeChild(this.contentContainer.firstChild);
      }
      this.contentContainer.appendChild(fragment);
      this.contentContainer.style.transform = `translateY(${startIndex * this.itemHeight * this.heightScale}px)`;

      this.visibleNodes = newVisibleNodeMap; // Update the map of currently visible nodes
    }

    updateItems(items) {
      this.items = items || [];
      this.totalHeight = this.items.length * this.itemHeight;

      this.heightScale = 1;
      if (this.totalHeight > this.maxHeight) {
        this.heightScale = this.maxHeight / this.totalHeight;
      }

      // Recycle all currently visible nodes before clearing
      this.visibleNodes.forEach(node => this.nodePool.push(node));
      this.visibleNodes.clear();
      // Optionally, clear the nodePool if item structure might change drastically,
      // but for now, we keep it to maximize reuse.
      // this.nodePool = [];

      if (this.contentContainer) {
        this.contentContainer.innerHTML = ''; // Clear displayed items
      }
      if (this.contentWrapper) {
        this.contentWrapper.style.height = `${this.totalHeight * this.heightScale}px`;
      }

      this.visibleStartIndex = 0;
      this.visibleEndIndex = 0;
      this.scrollContainer.scrollTop = 0; // Reset scroll position
      this.handleScroll(); // Force recalculation and re-render
    }

    scrollToIndex(index) {
      if (index >= 0 && index < this.items.length) {
        this.scrollContainer.scrollTop = index * this.itemHeight * this.heightScale;
      }
    }

    destroy() {
      if (this.scrollContainer) {
        this.scrollContainer.removeEventListener('scroll', this.handleScroll);
      }
      if (this.container) {
        this.container.innerHTML = ''; // Clears everything
      }
      this.items = null;
      this.container = null;
      this.scrollContainer = null;
      this.contentWrapper = null;
      this.contentContainer = null;

      this.nodePool = []; // Clear the pool
      this.visibleNodes.clear(); // Clear visible nodes map
    }

    refresh() {
      // Re-calculate visible items based on current scroll and render them
      this.handleScroll();
    }

    getScrollContainer() {
      return this.scrollContainer;
    }
  }

  // If in browser environment, add to global object
  if (typeof window !== 'undefined') {
    window.JsBooster = {
      VirtualScroll
    };
  }

  exports.VirtualScroll = VirtualScroll;

}));