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

  // 创建根节点列表
  const rootUl = document.createElement("ul");
  rootUl.className = "tree-root-list";
  rootUl.style.listStyleType = "none";
  rootUl.style.paddingLeft = "0";
  rootUl.style.margin = "0";

  // 处理根节点和第一级目录分离
  if (data.length > 0) {
    // 提取出根节点（第一个节点通常是"全部"）
    const rootNode = data[0];
    if (rootNode) {
      // 渲染根节点
      const rootElement = renderRootNode(rootNode, config);
      if (rootElement) {
        rootUl.appendChild(rootElement);
      }

      // 把根节点的子节点提取出来与根节点同级展示
      if (rootNode.children && rootNode.children.length > 0) {
        rootNode.children.forEach(childNodeData => {
          const nodeElement = renderNode(childNodeData, 0, config);
          if (nodeElement) {
            rootUl.appendChild(nodeElement);
          }
        });
      }
    }
  }

  container.appendChild(rootUl);

  // Event delegation for clicks
  rootUl.addEventListener('click', (event) => {
    const targetNodeElement = event.target.closest('.tree-node');
    if (!targetNodeElement) return;
    
    const arrow = event.target.closest('.tree-node-arrow');
    const iconOrName = event.target.closest('.tree-node-icon') || event.target.closest('.tree-node-name');

    // 处理父目录的点击事件，同时处理选中和展开/折叠
    if (targetNodeElement.classList.contains('has-children')) {
      // 选中该节点
      selectNode(targetNodeElement, rootUl);
      
      // 如果点击的是箭头或文件夹图标，触发展开/折叠
      if (arrow || iconOrName) {
        toggleNode(targetNodeElement);
        
        if (typeof config.onNodeToggle === 'function') {
          const childrenElement = targetNodeElement.querySelector('.tree-children');
          const isExpanded = childrenElement ? !childrenElement.classList.contains('collapsed') : false;
          config.onNodeToggle(targetNodeElement, isExpanded);
        }
      }
      
      // 无论是否展开/折叠，都要触发节点选中事件
      if (typeof config.onNodeClick === 'function') {
        config.onNodeClick(targetNodeElement);
      }
    } 
    // 处理叶子节点的点击事件（无子节点的目录或文件）
    else if (iconOrName) {
      selectNode(targetNodeElement, rootUl);
      if (typeof config.onNodeClick === 'function') {
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
  // 添加路径属性用于节点选择和模型加载
  nodeElement.dataset.path = nodeData.path || '/';

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
  if (!nodeElement) return;
  
  const listItem = nodeElement.closest('.tree-node-li');
  if (!listItem) return;
  
  const childrenUl = listItem.querySelector('.tree-children');
  const arrowSpan = nodeElement.querySelector('.tree-node-arrow');

  if (childrenUl && childrenUl.classList) {
    const isCollapsed = childrenUl.classList.toggle('collapsed');
    if (arrowSpan) {
      arrowSpan.innerHTML = isCollapsed ? '&#9654;' : '&#9660;'; // ▶ or ▼
      arrowSpan.classList.toggle('expanded', !isCollapsed);
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

/**
 * 渲染根节点（"全部"节点）
 * @param {Object} rootData - 根节点数据
 * @param {Object} config - 配置
 * @returns {HTMLLIElement|null} - 渲染的根节点元素
 */
function renderRootNode(rootData, config) {
  if (!rootData || typeof rootData.name !== 'string') {
    return null;
  }

  const listItem = document.createElement("li");
  listItem.classList.add("tree-node-li", "root-node-li");

  const nodeElement = document.createElement("div");
  nodeElement.classList.add("tree-node", "root-node");
  nodeElement.dataset.path = rootData.path || '/';

  const iconSpan = document.createElement("span");
  iconSpan.classList.add("tree-node-icon", "root-icon");
  iconSpan.innerHTML = '🏠'; // 使用房子图标表示根目录
  nodeElement.appendChild(iconSpan);

  const nameSpan = document.createElement("span");
  nameSpan.classList.add("tree-node-name");
  nameSpan.textContent = rootData.name;
  nameSpan.title = rootData.name; // Tooltip for long names
  nodeElement.appendChild(nameSpan);

  if (config.showCount && typeof rootData.count === 'number') {
    const countSpan = document.createElement("span");
    countSpan.classList.add("tree-node-count");
    countSpan.textContent = rootData.count.toLocaleString();
    nodeElement.appendChild(countSpan);
  }

  listItem.appendChild(nodeElement);
  return listItem;
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

// Export the createTreeView function
export { createTreeView };