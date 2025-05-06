# 筛选功能重新设计计划

## 1. 引言与目标

本文档详细规划了 ModelNest 应用中筛选功能的重新设计方案。目标是实现基于 `baseModel` 和 `modelType` 的筛选，确保筛选器全局可用、通过按钮触发、筛选结果即时应用，并为未来扩展奠定良好基础。

**核心目标：**

1.  实现基于 `baseModel` 和 `modelType` 的模型筛选功能。
2.  筛选器应为全局组件，通过点击专用按钮展开和收起。
3.  筛选条件的选择应立即应用于模型列表的展示。
4.  整体设计需具备良好的可扩展性，以支持未来添加更多筛选维度。

## 2. 详细计划

### 第一阶段：数据和逻辑层准备

#### 2.1 修改模型解析器 (`src/data/modelParser.js`)

*   **目的：** 确保模型对象能够正确解析并包含 `baseModel` 信息。
*   **具体操作：**
    1.  **`parseModelDetailFromJsonContent` 函数修改：**
        *   在从 JSON 解析出的对象中，优先尝试读取 `baseModel` 字段。
        *   若 `baseModel` 字段不存在，则尝试读取 `basic` 字段作为 `baseModel` 的值。
        *   将获取到的值赋给返回对象的 `baseModel` 属性。如果两个字段均不存在，`baseModel` 可设为 `null` 或空字符串。
    2.  **`createWebDavModelObject` 函数修改：**
        *   确保从传入的 `parsedJsonDetail` 参数中，按照上述 `baseModel`/`basic` 兼容逻辑获取 `baseModel` 值，并赋给 `modelObj.baseModel`。
    3.  `modelType` 的提取逻辑保持现有机制（优先从 JSON 获取，若无则根据文件扩展名推断）。

#### 2.2 增强模型服务 (`src/services/modelService.js`)

*   **目的：** 提供获取可用筛选选项的接口，并使模型列表功能支持按条件筛选。
*   **具体操作：**
    1.  **新增方法 `getAvailableFilterOptions()`:**
        *   此异步方法将负责遍历所有已配置数据源中的全部模型。
        *   收集所有模型对象的 `baseModel` 和 `modelType` 属性值。
        *   对收集到的 `baseModel` 值列表进行去重操作。
        *   对收集到的 `modelType` 值列表进行大小写不敏感的去重操作。
        *   返回一个结构如下的对象：`{ baseModels: ['SD1.5', 'SDXL', ...], modelTypes: ['Checkpoint', 'LoRA', ...] }`。
    2.  **修改方法 `listModels(sourceId, directory, filters = {})`:**
        *   为 `listModels` 方法增加一个可选的 `filters` 对象参数。
        *   `filters` 参数结构示例：`{ baseModel?: string[], modelType?: string[] }`。
        *   在从数据源获取原始模型列表之后，应用 `filters` 中的条件进行筛选：
            *   若 `filters.baseModel` 数组存在且非空，则仅保留那些其 `baseModel` 属性值存在于该数组中的模型。
            *   若 `filters.modelType` 数组存在且非空，则仅保留那些其 `modelType` 属性值（进行大小写不敏感比较后）存在于该数组中的模型。

#### 2.3 更新 IPC 通信 (`src/ipc/modelLibraryIPC.js` 和 `preload.js`)

*   **目的：** 将新的服务层能力安全地暴露给渲染进程。
*   **具体操作：**
    1.  **`src/ipc/modelLibraryIPC.js` (`initializeModelLibraryIPC` 函数内):**
        *   注册一个新的 IPC 处理器：`ipcMain.handle('getFilterOptions', async () => { return services.modelService.getAvailableFilterOptions(); });`。
        *   调整现有的 `'listModels'` IPC 处理器，使其能够接收 `filters` 参数，并将其传递给 `services.modelService.listModels()` 调用。
    2.  **`preload.js` (或通过 `src/renderer/js/apiBridge.js` 封装后暴露):**
        *   在 `contextBridge.exposeInMainWorld('api', ...)` 中：
            *   新增暴露函数：`getFilterOptions: () => ipcRenderer.invoke('getFilterOptions')`。
            *   确保已暴露的 `listModels` 函数能够接受第三个参数 `filters`，并将其传递给 `ipcRenderer.invoke('listModels', sourceId, directory, filters)`。

### 第二阶段：用户界面实现

#### 2.4 创建筛选面板组件 (`src/renderer/js/components/filter-panel.js` - 新建)

*   **目的：** 构建用户可交互的筛选器界面。
*   **具体操作：**
    1.  创建新的 JS 文件定义筛选面板组件。
    2.  **功能职责：**
        *   组件挂载后，调用 `window.api.getFilterOptions()` 获取并存储可用的 `baseModel` 和 `modelType` 选项列表。
        *   根据获取的选项渲染筛选界面，包含“基础模型”和“模型类型”两个主要区域。每个区域可使用标签云、复选框组或多选下拉列表等形式展示选项。
        *   实现“清空筛选条件”按钮，点击后清除所有已选中的筛选条件，并触发事件通知父组件。
        *   管理当前用户选中的筛选条件。当选择发生变化时，立即触发一个自定义事件（或调用回调函数），将包含当前选中 `baseModel` 和 `modelType` 的 `filters` 对象传递出去。
    3.  UI 布局可参考用户提供的截图，初期仅实现 `baseModel` 和 `modelType` 的筛选。

#### 2.5 集成筛选功能到主视图 (`src/renderer/js/components/main-view.js` 或相关父级组件)

*   **目的：** 在应用中提供筛选入口，并根据用户选择动态更新模型列表。
*   **具体操作：**
    1.  **添加全局筛选按钮：** 在应用全局区域（如主导航栏、固定头部，或 `main-view.js` 模板顶部）放置一个“筛选”图标按钮。
    2.  **控制筛选面板显隐：** 点击“筛选”按钮时，切换 `filter-panel.js` 组件的显示状态。
    3.  **筛选状态管理：** `main-view.js` (或其承担状态管理的父组件) 需维护当前激活的筛选条件状态，例如：`currentFilters = { baseModel: [], modelType: [] }`。
    4.  **监听筛选面板事件：** 监听 `filter-panel.js` 组件派发的筛选条件变更事件。接收到新的 `filters` 对象后，更新 `currentFilters` 状态。
    5.  **重新加载模型列表：** 每当 `currentFilters` 状态发生变化（包括初始加载和清空筛选时），调用 `window.api.listModels(currentSourceId, currentDirectory, currentFilters)` 获取筛选后的模型数据，并刷新模型列表UI。
    6.  初始加载或清空筛选时，`currentFilters` 应为空对象或不包含有效筛选字段，以确保加载所有模型。

#### 2.6 国际化 (`src/renderer/locales/*.json` 及 `src/renderer/js/core/i18n.js`)

*   **目的：** 确保筛选界面的所有静态文本内容支持多语言。
*   **具体操作：**
    1.  为筛选面板中所有用户可见的静态文本（如各筛选区域的标题“基础模型”、“模型类型”，按钮文字“清空筛选条件”等）在 `zh-CN.json`、`en-US.json` 及其他已支持的语言资源文件中添加相应的翻译键和翻译文本。
    2.  在 `filter-panel.js` 组件的渲染逻辑中，使用 `i18n.t('your.translation.key')` 的方式来获取和显示翻译后的文本。

## 3. Mermaid 流程图

```mermaid
graph TD
    subgraph A[用户界面 (渲染进程)]
        U1[全局筛选按钮] -- 点击 --> U2{切换筛选面板显隐}
        U2 -- 显示 --> P1[筛选面板组件 (filter-panel.js)]
        P1 -- 初始化 --> C1[调用 window.api.getFilterOptions()]
        P1 -- 渲染 --> P2[显示 baseModel 和 modelType 选项]
        P2 -- 用户选择/取消选择 --> P3{更新内部已选筛选条件}
        P3 -- 触发事件 (筛选条件变更) --> M1[主视图 (main-view.js) 或父组件]
        M1 -- 更新自身筛选状态 --> M2[调用 window.api.listModels(source, dir, newFilters)]
        M2 -- 结果返回 --> M3[更新模型列表UI]
        P1 -- 点击“清空” --> P3_Clear{清空内部筛选条件}
    end

    subgraph B[主进程]
        subgraph B1[IPC 层 (preload & modelLibraryIPC)]
            C1_Invoke["preload: api.getFilterOptions()"] --> IPC1["ipcMain.handle('getFilterOptions')"]
            M2_Invoke["preload: api.listModels()"] --> IPC2["ipcMain.handle('listModels')"]
        end

        subgraph B2[服务层 (modelService.js)]
            IPC1 --> S1[modelService.getAvailableFilterOptions()]
            S1 -- 遍历所有模型 --> S2[收集并去重 baseModel/modelType 值]
            S2 -- 返回 --> C1_Invoke

            IPC2 -- 传入 filters --> S3[modelService.listModels(source, dir, filters)]
            S3 -- 应用 filters 筛选 --> S4[返回筛选后的模型列表]
            S4 -- 返回 --> M2_Invoke
        end

        subgraph B3[数据层 (modelParser.js)]
            S1 -- 依赖模型数据 --> D1[modelParser.js (已修改)]
            D1 -- 解析 JSON (含 baseModel/basic) --> D2[模型元数据文件]
        end
    end
```

## 4. 后续扩展考虑

*   **UI 结构：** 筛选面板的 HTML 和 CSS 结构应采用模块化设计，方便未来平滑地增加新的筛选区域和条件。
*   **`filters` 对象：** 当前传递给 `listModels` 的 `filters` 对象结构应保持灵活性，以便将来轻松扩展，例如加入 `filters.author = ['authorA']` 等新筛选维度。
*   **`getAvailableFilterOptions` 方法：** 此服务层方法也应设计为易于扩展，以便将来能够返回更多不同筛选条件的可用选项列表。

此计划旨在首先稳健地实现核心筛选功能，同时为后续的功能迭代和增强预留清晰的扩展路径。