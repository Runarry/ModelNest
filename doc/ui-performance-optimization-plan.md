# UI 性能优化计划

## 1. 主视图模型列表渲染优化 ([`src/renderer/js/components/main-view.js`](src/renderer/js/components/main-view.js))

*   **核心策略：实现虚拟滚动 (Virtual Scrolling)**
    *   **目标**：无论模型数量多少，只渲染用户视口内可见的列表项及少量缓冲区项，大幅减少DOM数量和操作。
    *   **关键步骤**：
        1.  在 `loadModels` 后，不立即渲染所有模型到DOM。
        2.  计算列表容器高度、单个列表项的预估/固定高度。
        3.  根据滚动条位置，动态计算当前应显示的列表项的索引范围。
        4.  仅为该范围内的模型数据创建/复用DOM元素并填充内容，更新其在列表容器内的绝对定位 (transform: translateY)。
        5.  维护一个总高度的占位元素以保证滚动条的正确性。
        6.  监听列表容器的滚动事件，触发上述计算和渲染更新。
        7.  考虑图片懒加载与虚拟滚动的协同，确保新出现的列表项中的图片能正确触发加载。
    *   **技术选型考虑**：鉴于项目是原生JavaScript，可以实现一个轻量级的虚拟滚动逻辑，或者调研是否有小巧、无依赖的第三方库可以辅助。

## 2. 过滤面板渲染优化 ([`src/renderer/js/components/filter-panel.js`](src/renderer/js/components/filter-panel.js))

*   **核心策略：增量DOM更新与优化的事件处理**
    *   **目标**：避免`innerHTML`全量重建，只更新实际变化的DOM部分，并确保事件监听高效。
    *   **关键步骤**：
        1.  **`render()`/`updateOptions()` 优化**：
            *   首次 `render()` 时，使用 `document.createElement` 等DOM API构建面板的基本骨架（如标题、各个筛选组的容器）。
            *   `renderOptions()` 函数改造：不再返回HTML字符串，而是直接操作DOM。对于每个筛选组（如Base Models, Model Types），比较新的选项数据和当前DOM中的选项：
                *   **新增选项**：创建新的 `label` 和 `input[type="checkbox"]` 元素并插入到对应的筛选组容器。
                *   **删除选项**：从DOM中移除不再存在的选项元素。
                *   **现有选项**：仅更新其状态（如 `checked` 属性、文本内容如有变化）。
        2.  **`clearFilters()` 优化**：
            *   不清空 `this.selectedFilters` 后调用 `this.render()`，而是直接遍历当前DOM中的所有复选框，将其 `checked` 属性设为 `false`。
        3.  **事件监听**：
            *   继续使用事件委托，将 `change` 事件监听器绑定在稳定的父级元素（如各个 `.filter-options-group`）上。由于这些父级元素不再被 `innerHTML` 重建，监听器也无需在每次渲染后重新绑定。

## 3. 弹窗内容优化

### 3.1. 详情页弹窗 ([`src/renderer/js/components/detail-model.js`](src/renderer/js/components/detail-model.js))

*   **核心策略：使用 `<template>` 元素进行模板克隆与数据填充**
    *   **目标**：避免 `innerHTML` 构建整个内容区域，提高渲染效率。
    *   **关键步骤**：
        1.  在 `index.html` 中，为详情弹窗的动态内容区域（如基本信息、描述、附加信息等标签页的骨架，以及内部的表单字段结构）定义 `<template>` 标签。
        2.  修改 `renderModelContent` 函数：
            *   不再拼接HTML字符串。
            *   根据需要显示的内容，选择对应的 `<template>`。
            *   使用 `templateElement.content.cloneNode(true)` 克隆模板内容。
            *   遍历克隆出的DOM片段，通过 `querySelector` 等找到目标子元素，并使用 `textContent`、`value`、`setAttribute` 等API填充模型数据。
            *   将填充好的DOM片段追加到 `detailDescriptionContainer`。
            *   事件监听（如标签页切换、保存按钮）在稳定的父元素上进行委托，或者在克隆并填充内容后，针对性地添加到必要的元素上。

### 3.2. 设置页弹窗 - 数据源部分 ([`src/renderer/js/components/settings-modal.js`](src/renderer/js/components/settings-modal.js))

*   **核心策略：对数据源列表采用增量DOM更新，对添加/编辑表单可考虑模板克隆或DOM API构建。**
    *   **目标**：优化数据源列表的渲染，特别是当数据源数量较多时。
    *   **关键步骤 (`renderSourceListForSettings`)**：
        1.  不再完全清空列表后用 `innerHTML` 重建每一项。
        2.  比较 `tempModelSources` 数组与当前DOM中已存在的列表项（可通过 `data-id` 属性匹配）。
        3.  **新增数据源**：调用一个辅助函数（如 `_createDataSourceListItemDOM(source)`），该函数使用 `document.createElement` 等API从头构建一个新的 `<li>` 元素及其内部结构（包括显示信息和隐藏的编辑表单结构），然后将其追加到 `dataSourceListEl`。
        4.  **删除数据源**：找到对应的 `<li>` 元素并从DOM中移除。
        5.  **更新数据源**（如果支持列表内直接修改某些信息，或者编辑后刷新该项）：找到对应 `<li>`，更新其内部显示信息的DOM节点内容。
    *   **关键步骤 (添加/编辑表单 - `showAddDataSourceForm`, 行内编辑表单的创建)**：
        1.  避免使用 `innerHTML` 生成整个表单。
        2.  方案一 (模板克隆)：在 `index.html` 中为添加表单和行内编辑表单各定义一个 `<template>`。需要时克隆模板，填充少量初始值（如编辑时），然后显示。
        3.  方案二 (DOM API)：动态创建表单的各个字段和按钮。

## 4. 通用检查点

*   **Blob URL 管理**：确保所有通过 `BlobUrlCache` 创建的 URL 在相关图片元素从 DOM 中移除或不再需要时，都通过 `BlobUrlCache.releaseBlobUrl` 或 `BlobUrlCache.releaseBlobUrlByKey` 及时释放，防止内存泄漏。检查 `main-view.js` 的 `_releaseBlobUrlForCardElement` 和 `detail-model.js` 的 `hideDetailModel` 中的逻辑是否覆盖所有场景。
*   **事件监听器清理**：在元素被销毁或不再需要时，确保移除相关的事件监听器，特别是在不使用事件委托的场景下。