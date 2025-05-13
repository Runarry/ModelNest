// src/renderer/js/components/tree-view.js
/**
 * 使用示例
 *    <div id="myTreeViewContainer" style="height: 100%; overflow: auto;"></div>
 *  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const sampleData = [
        {
          name: "AIGC",
          children: [
            { name: "生成图", count: 16 },
            { name: "工作流" },
            { name: "美图秀秀", count: 127 },
            {
              name: "角色参考",
              count: 96,
              children: [
                { name: "战士" },
                { name: "法师", count: 30 },
                { name: "牧师", children: [{name: "光明牧师"}, {name: "暗影牧师", count: 5}]}
              ],
            },
            { name: "物品参考", count: 6},
            { name: "场景参考", count: 84},
            { name: "配色参考", count: 30},
          ],
        },
        {
          name: "项目",
          children: [
            {
              name: "仙侠、武侠",
              count: 19,
              children: [
                { name: "表情包", count: 9 },
                { name: "角色", count: 8 },
              ],
            },
            {
              name: "大侠立志传",
              children: [
                { name: "特效", count: 4295 },
                { name: "Portrait", count: 1378 },
                { name: "角色", count: 28019 },
              ]
            },
            { name: "仙侠地图", count: 15 },
            { name: "训练", count: 42 },
            { name: "三国", count: 24 },
          ],
        },
        { name: "UI/UX", count: 18 },
        { name: "游戏设计参考", count: 19 },
        { name: "服饰", count: 17 },
        { name: "README.md" }
      ];

      const treeContainer = document.getElementById('myTreeViewContainer');
      if (treeContainer) {
        createTreeView(treeContainer, sampleData, {
            onNodeClick: (nodeEl) => {
                const nameSpan = nodeEl.querySelector('.tree-node-name');
                if (nameSpan) console.log('Node clicked:', nameSpan.textContent);
            },
            onNodeToggle: (nodeEl, isExpanded) => {
                const nameSpan = nodeEl.querySelector('.tree-node-name');
                if (nameSpan) console.log('Node toggled:', nameSpan.textContent, 'Expanded:', isExpanded);
            }
        });
      } else {
        console.error("Tree container #myTreeViewContainer not found.");
      }
    });
  </script>
 */

/**
 * Creates a tree view component.
 * @param {HTMLElement} container - The DOM element to render the tree into.
 * @param {Array<Object>} data - The tree data.
 * @param {Object} [options] - Optional configuration.
 * @param {Function} [options.onNodeClick] - Callback when a node is clicked.
 * @param {Function} [options.onNodeToggle] - Callback when a folder node is toggled.
 * @param {boolean} [options.showCount=true] - Whether to show the count for nodes.
 */
function createTreeView(container, data, options = {}) {
  if (!container || !Array.isArray(data)) {
    console.error("Tree view: Invalid container or data provided.");
    return;
  }

  const defaults = {
    onNodeClick: null,
    onNodeToggle: null,
    showCount: true,
  };
  const config = { ...defaults, ...options };

  container.innerHTML = ""; // Clear previous content
  container.classList.add("tree-view-container");

  const rootUl = document.createElement("ul");
  rootUl.style.listStyleType = "none";
  rootUl.style.paddingLeft = "0";
  rootUl.style.margin = "0";

  data.forEach(nodeData => {
    const nodeElement = renderNode(nodeData, 0, config);
    if (nodeElement) {
      rootUl.appendChild(nodeElement);
    }
  });

  container.appendChild(rootUl);

  // Event delegation for clicks
  rootUl.addEventListener('click', (event) => {
    const targetNodeElement = event.target.closest('.tree-node');
    if (!targetNodeElement) return;

    const nodeId = targetNodeElement.dataset.nodeId; // Assuming we'll add IDs or references
    // For now, let's handle toggle directly on the arrow/icon/name
    
    const arrow = event.target.closest('.tree-node-arrow');
    const iconOrName = event.target.closest('.tree-node-icon') || event.target.closest('.tree-node-name');

    if (arrow || (iconOrName && targetNodeElement.classList.contains('has-children'))) {
      toggleNode(targetNodeElement);
      if (typeof config.onNodeToggle === 'function') {
        // Pass more comprehensive node info later
        config.onNodeToggle(targetNodeElement, !targetNodeElement.querySelector('.tree-children').classList.contains('collapsed'));
      }
    } else if (iconOrName) { // Click on file or folder name (not for toggling)
        selectNode(targetNodeElement, rootUl);
        if (typeof config.onNodeClick === 'function') {
            // Pass more comprehensive node info later
            config.onNodeClick(targetNodeElement);
        }
    }
  });
}

/**
 * Renders a single node in the tree.
 * @param {Object} nodeData - The data for the node.
 * @param {number} level - The depth level of the node.
 * @param {Object} config - The component configuration.
 * @returns {HTMLLIElement|null} The rendered LI element or null.
 */
function renderNode(nodeData, level, config) {
  if (!nodeData || typeof nodeData.name !== 'string') {
    return null;
  }

  const listItem = document.createElement("li");
  listItem.classList.add("tree-node-li"); // For potential li-specific styling

  const nodeElement = document.createElement("div");
  nodeElement.classList.add("tree-node");
  // nodeElement.dataset.nodeId = nodeData.id || generateUniqueId(); // TODO: Add unique ID

  // Indentation
  for (let i = 0; i < level; i++) {
    const indentSpan = document.createElement("span");
    indentSpan.classList.add("tree-node-indent");
    nodeElement.appendChild(indentSpan);
  }

  const arrowSpan = document.createElement("span");
  arrowSpan.classList.add("tree-node-arrow");
  nodeElement.appendChild(arrowSpan);

  const iconSpan = document.createElement("span");
  iconSpan.classList.add("tree-node-icon");
  nodeElement.appendChild(iconSpan);

  const nameSpan = document.createElement("span");
  nameSpan.classList.add("tree-node-name");
  nameSpan.textContent = nodeData.name;
  nameSpan.title = nodeData.name; // Tooltip for long names
  nodeElement.appendChild(nameSpan);

  if (config.showCount && typeof nodeData.count === 'number') {
    const countSpan = document.createElement("span");
    countSpan.classList.add("tree-node-count");
    countSpan.textContent = nodeData.count.toLocaleString();
    nodeElement.appendChild(countSpan);
  }

  listItem.appendChild(nodeElement);

  if (nodeData.children && nodeData.children.length > 0) {
    nodeElement.classList.add("has-children");
    arrowSpan.innerHTML = "&#9654;"; // Right-pointing triangle (▶)
    iconSpan.classList.add("folder");

    const childrenUl = document.createElement("ul");
    childrenUl.classList.add("tree-children", "collapsed"); // Start collapsed
    childrenUl.style.listStyleType = "none";
    childrenUl.style.paddingLeft = "0"; // CSS will handle actual indent via .tree-children
    childrenUl.style.margin = "0";


    nodeData.children.forEach(childNodeData => {
      const childNodeElement = renderNode(childNodeData, level + 1, config);
      if (childNodeElement) {
        childrenUl.appendChild(childNodeElement);
      }
    });
    listItem.appendChild(childrenUl);
  } else {
    arrowSpan.innerHTML = "&nbsp;"; // Non-breaking space for alignment
    iconSpan.classList.add("file");
  }

  return listItem;
}

/**
 * Toggles the expanded/collapsed state of a folder node.
 * @param {HTMLElement} nodeElement - The .tree-node div element.
 */
function toggleNode(nodeElement) {
  const childrenUl = nodeElement.nextElementSibling; // Assuming ul is direct sibling of the div.tree-node's parent li
  const arrowSpan = nodeElement.querySelector(".tree-node-arrow");

  if (childrenUl && childrenUl.classList.contains("tree-children")) {
    const isCollapsed = childrenUl.classList.toggle("collapsed");
    if (arrowSpan) {
      arrowSpan.innerHTML = isCollapsed ? "&#9654;" : "&#9660;"; // ▶ or ▼
      arrowSpan.classList.toggle("expanded", !isCollapsed);
    }
  }
}

/**
 * Selects a node and deselects others.
 * @param {HTMLElement} nodeElement - The .tree-node div element to select.
 * @param {HTMLElement} rootUl - The root UL element of the tree.
 */
function selectNode(nodeElement, rootUl) {
    // Deselect all other nodes
    const allNodes = rootUl.querySelectorAll('.tree-node.selected');
    allNodes.forEach(n => n.classList.remove('selected'));

    // Select the clicked node
    nodeElement.classList.add('selected');
}

// TODO: function generateUniqueId() { ... }

// Example Usage (for testing, will be moved to index.html or main.js)
/*
document.addEventListener('DOMContentLoaded', () => {
  const sampleData = [
    {
      name: "AIGC",
      children: [
        { name: "生成图", count: 16 },
        { name: "工作流" },
        {
          name: "角色参考",
          count: 96,
          children: [
            { name: "战士" },
            { name: "法师", count: 30 },
          ],
        },
      ],
    },
    {
      name: "项目",
      count: null, // Explicitly null if no count
      children: [
        {
          name: "仙侠、武侠",
          count: 19,
          children: [
            { name: "表情包", count: 9 },
            { name: "角色", count: 8 },
          ],
        },
        { name: "三国", count: 24 },
      ],
    },
    { name: "UI/UX", count: 18 },
    { name: "README.md" }
  ];

  const treeContainer = document.getElementById('tree-view-placeholder'); // Assuming an element with this ID exists
  if (treeContainer) {
    createTreeView(treeContainer, sampleData, {
        onNodeClick: (nodeEl) => console.log('Node clicked:', nodeEl.querySelector('.tree-node-name').textContent),
        onNodeToggle: (nodeEl, isExpanded) => console.log('Node toggled:', nodeEl.querySelector('.tree-node-name').textContent, 'Expanded:', isExpanded)
    });
  }
});
*/