# 模型库配置新增只读选项 - 功能规划方案

本文档详细规划了在 ModelNest 项目中为模型库配置添加 `readOnly` 选项的功能实现方案。

**1. `readOnly` 标志的存储位置**

*   **配置文件:** `readOnly` 标志（布尔类型）将添加到项目根目录下的 `config.json` 文件中。
*   **数据结构:** 在 `config.json` 的 `modelSources` 数组中，为每个数据源配置对象添加一个 `readOnly` 字段。例如：
    ```json
    {
      "modelSources": [
        {
          "id": "local-default",
          "name": "本地模型库",
          "type": "local",
          "path": "./models",
          "readOnly": false // 新增字段，默认为 false
        },
        {
          "id": "webdav-readonly",
          "name": "只读 WebDAV 库",
          "type": "webdav",
          "url": "https://example.com/dav",
          "username": "user",
          "password": "password_encrypted",
          "readOnly": true // 标记为只读
        }
      ],
      // ... 其他配置
    }
    ```
*   **服务层:**
    *   `ConfigService` (`src/services/configService.js`) 需要能够正确读取和保存包含 `readOnly` 字段的配置。当读取旧配置（没有 `readOnly` 字段）时，应将其视为 `false`。
    *   `DataSourceService` (`src/services/dataSourceService.js`) 在提供数据源配置信息时（如通过 `getSourceConfig(id)` 或 `getAllSourceConfigs()`），需要包含 `readOnly` 字段。

**2. 数据源层 (`src/data/`) 实现只读检查**

*   **检查点:** 只读检查的核心逻辑将放在 `src/data/dataSourceInterface.js` 中。这是所有数据源操作的统一入口，便于集中管理。
*   **检查时机:** 在调用任何执行 *写入* 操作的具体数据源方法之前进行检查。当前主要涉及 `writeModelJson` 方法，未来可能扩展到删除、重命名等操作。
*   **实现逻辑:**
    1.  在 `dataSourceInterface.js` 中需要执行写入操作的函数（如 `writeModelJson`）内部：
    2.  首先，调用 `getDataSourceInstance(sourceConfig)` 获取对应的数据源实例。
    3.  然后，检查实例关联的配置 `sourceConfig.readOnly` 是否为 `true`。
    4.  如果 `readOnly` 为 `true`，则立即抛出一个自定义的、明确的错误，例如 `ReadOnlyError`，并附带描述信息（如：“数据源 '{sourceConfig.name}' 是只读的，无法执行写入操作。”）。这个错误将阻止后续实际的写入操作。
    5.  如果 `readOnly` 为 `false`，则继续调用具体数据源实例（`LocalDataSource` 或 `WebDavDataSource`）的相应写入方法。
*   **错误传递:** 抛出的 `ReadOnlyError` 会沿着调用链（`dataSourceInterface` -> `ModelService` -> `IPC Layer` -> `Preload`）传递回渲染进程。

**3. UI 层 (`src/renderer/`) - 添加设置选项**

*   **组件:** 修改 `src/renderer/js/components/source-edit-model.js` 及其关联的 HTML 模板（可能在 `index.html` 中或单独文件）。
*   **UI 控件:** 在数据源编辑表单中，添加一个复选框（Checkbox），标签为“只读”（需要添加 i18n 支持）。
*   **逻辑:**
    *   **加载:** 当编辑现有数据源时，`source-edit-model.js` 从传入的配置对象中读取 `readOnly` 的值，并设置复选框的选中状态。
    *   **保存:** 当用户点击保存按钮时，`source-edit-model.js` 读取复选框的当前状态（`true` 或 `false`），并将其作为 `readOnly` 字段添加到要保存的数据源配置对象中，然后通过 `window.api` 发送给主进程进行保存。
*   **国际化:** 更新 `src/renderer/locales/zh-CN.json` 和 `en-US.json` 文件，为新的“只读”复选框添加相应的翻译文本。

**4. UI 层 (`src/renderer/`) - 禁用/隐藏写入操作**

*   **目标组件:** 主要涉及 `src/renderer/js/components/main-view.js`（模型列表/卡片视图）和 `src/renderer/js/components/detail-model.js`（模型详情视图）。
*   **获取只读状态:** 渲染进程需要知道当前浏览的数据源是否为只读。推荐的方式是：
    *   当渲染进程通过 `window.api.getAllSourceConfigs()` 或类似方法获取数据源配置列表时，主进程的 `DataSourceService` 确保返回的配置对象中包含 `readOnly` 状态。
    *   渲染进程可以将这些配置信息缓存起来（例如，存储在某个全局状态或 `main-view.js` 的实例变量中）。
*   **UI 反馈:**
    *   **`main-view.js`:** 在渲染模型列表或目录结构时，检查当前激活的数据源配置的 `readOnly` 状态。如果为 `true`，则：
        *   禁用（设置 `disabled` 属性）或隐藏与写入操作相关的按钮，如“添加模型/目录”（如果支持）、“删除”、“重命名”等。优先考虑禁用，并可能添加 `title` 提示说明原因。
    *   **`detail-model.js`:** 在显示模型详情时，检查该模型所属数据源的 `readOnly` 状态。如果为 `true`，则：
        *   禁用或隐藏“编辑元数据”、“保存元数据”等按钮。
        *   （可选）在模型详情页面添加一个明显的“只读”标签或图标，提示用户当前模型不可编辑。
    *   **设置界面:** 在 `settings-model.js` 的数据源列表中，可以考虑为标记为 `readOnly` 的数据源添加一个视觉指示（如图标或文字标签）。
*   **错误处理:** 即使用户通过某种方式触发了写入操作（例如，UI 禁用逻辑有疏漏），后端的只读检查也会生效。渲染进程需要捕获从主进程返回的 `ReadOnlyError`，并使用 UI 工具（如 `src/renderer/js/utils/ui-utils.js` 中的通知或弹窗）向用户显示清晰的错误信息，告知操作因数据源只读而失败。

**5. 架构遵循与影响**

*   该方案遵循现有的分层架构，修改点分布在各自对应的层级（配置、数据访问、服务、IPC、UI）。
*   利用了 `dataSourceInterface.js` 作为统一入口的优势来集中处理只读检查。
*   对 `config.json` 的修改是向后兼容的。
*   只读检查仅影响写入操作，不影响模型的浏览、搜索、读取详情和图片等核心读取功能。
*   UI 层的修改主要是增加选项和根据状态禁用/隐藏元素，对现有布局和功能影响可控。

**6. 架构图示**

```mermaid
graph TD
    subgraph "配置层 (config.json)"
        C["modelSources[].readOnly: boolean"]
    end

    subgraph "服务层 (src/services/)"
        CS[ConfigService] -->|读/写| C
        DS[DataSourceService] -->|读取配置| CS
        DS -- 提供配置(含readOnly) --> MS[ModelService]
        DS -- 提供配置(含readOnly) --> IS[ImageService]
        MS -- 调用 --> DI
        IS -- 调用 --> DI
    end

    subgraph "数据访问层 (src/data/)"
        DI[dataSourceInterface.js] -->|获取实例| Factory("getDataSourceInstance()")
        Factory -->|创建/返回| LDS(LocalDataSource)
        Factory -->|创建/返回| WDS(WebDavDataSource)
        DI -- 调用写入方法前检查 --> CheckReadOnly{sourceConfig.readOnly?}
        CheckReadOnly -- true --> ThrowError(抛出 ReadOnlyError)
        CheckReadOnly -- false --> CallWriteMethod("调用 LDS/WDS 的写入方法")
        LDS -- 继承 --> BDS(BaseDataSource)
        WDS -- 继承 --> BDS
    end

    subgraph "IPC & Preload"
        IPC[IPC Handlers (modelLibraryIPC.js)] -->|调用服务| MS
        IPC -->|调用服务| DS
        API[window.api (preload.js)] <--> IPC
    end

    subgraph "渲染进程 UI (src/renderer/)"
        Settings[settings-model.js] -->|获取/保存配置| API
        SourceEdit[source-edit-model.js] -->|读/写 readOnly UI| Settings
        SourceEdit -->|保存配置(含readOnly)| API
        MainView[main-view.js] -->|获取配置(含readOnly)| API
        DetailView[detail-model.js] -->|获取配置(含readOnly)| API
        MainView -- readOnly? --> DisableWriteUI("禁用/隐藏 写入按钮")
        DetailView -- readOnly? --> DisableEditUI("禁用/隐藏 编辑/保存按钮")
        UIUtils[ui-utils.js] -->|显示错误| User(用户)
        API -- 返回 ReadOnlyError --> ErrorHandler("UI 错误处理")
        ErrorHandler --> UIUtils
    end

    style ThrowError fill:#f99,stroke:#333,stroke-width:2px
    style CheckReadOnly fill:#ffcc00,stroke:#333,stroke-width:1px