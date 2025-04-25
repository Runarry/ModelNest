# Config.json 配置界面开发计划

## 1. 目标

为 Electron 应用中的 `config.json` 文件创建一个用户友好的图形界面，允许用户查看和修改配置设置。

## 2. UI 设计与入口

*   **入口点:** 在 `src/renderer/index.html` 的顶部菜单栏 (`<nav class="top-menu-bar">`) 右侧，靠近语言选择和主题切换按钮的位置，添加一个新的“设置”按钮或图标。
*   **界面容器:** 创建一个新的 HTML 元素（例如，一个 `div` 作为模态框 `#settingsModal`）来容纳配置选项。
*   **表单元素:**
    *   **模型来源 (`modelSources`):**
        *   使用列表或表格展示当前模型来源。
        *   为每个来源提供编辑和删除按钮。
        *   提供“添加来源”按钮，允许用户选择类型（本地/WebDAV）并填写相应字段。
        *   本地路径字段旁边添加一个按钮，点击后调用主进程打开系统文件夹选择对话框。
        *   WebDAV 密码字段使用 `type="password"`。
    *   **支持的扩展名 (`supportedExtensions`):**
        *   使用一个文本区域或标签输入框让用户编辑逗号分隔的扩展名列表。
    *   **图片缓存 (`imageCache`):**
        *   `debug`: 复选框。
        *   `compressQuality`: 数字输入框或滑块 (0-100)。
        *   `compressFormat`: 下拉选择框 (jpeg, png, webp)。
        *   `maxCacheSizeMB`: 数字输入框。
*   **操作按钮:** 添加“保存”和“取消”按钮。

## 3. 样式

*   在 `src/renderer/style.css` 或创建新的 `settings.css` 文件中添加样式，确保界面风格与应用整体（包括亮/暗主题）一致。

## 4. 界面逻辑 (Renderer Process - `src/renderer/renderer.js` 或 `settings.js`)

*   **加载:** 点击设置按钮时，显示配置界面，并通过 IPC 向主进程请求当前 `config.json` 内容。
*   **填充:** 收到配置数据后，填充到 HTML 表单。
*   **交互:** 处理添加/编辑/删除模型来源、调用文件夹选择对话框等。
*   **验证:** 保存前进行输入验证。
*   **保存:** 点击“保存”时，收集数据，通过 IPC 发送给主进程。
*   **反馈:** 显示保存成功/失败消息。保存成功后，触发模型列表的重新加载。

## 5. 文件读写与主进程逻辑 (Main Process - `main.js`)

*   **IPC 监听器:**
    *   `'read-config'`: 读取 `config.json` (或 `config.example.json` / 默认值)，返回数据。
    *   `'write-config'`: 接收配置数据，写入 `config.json`。处理文件写入错误。
    *   `'open-folder-dialog'`: (新增) 响应渲染进程请求，打开系统文件夹选择对话框，并将选择的路径返回。
*   **通知:** 写入成功后，可以向渲染进程发送一个事件（如 `'config-updated'`)，告知其重新加载模型列表。

## 6. 生效机制

*   用户点击“保存”并成功写入 `config.json` 后，渲染进程应立即触发模型列表的重新加载逻辑，以应用新的配置（特别是模型来源的更改）。

## 7. 流程图

```mermaid
graph TD
    subgraph 用户界面 (Renderer: index.html, renderer.js/settings.js)
        A[用户点击设置按钮 (顶部菜单栏右侧)] --> B[显示配置界面];
        B --> C{请求当前配置};
        C -- IPC --> D[主进程];
        D -- 返回配置 --> E[填充界面表单];
        E --> F{用户修改配置 / 添加/删除模型源 (本地路径使用文件夹选择器)};
        F -- 请求选择文件夹 --> F_Dialog[主进程];
        F_Dialog -- 返回路径 --> F;
        F --> G[验证输入];
        G -- 无效 --> H[显示错误提示];
        G -- 有效 & 用户点击保存 --> I{收集表单数据};
        I --> J{发送保存请求};
        J -- IPC --> K[主进程];
        K -- 保存成功 --> L[显示成功消息 / 关闭界面 / 触发模型列表重新加载];
        K -- 保存失败 --> M[显示错误消息];
        B --> N[用户点击取消 / 关闭];
        N --> O[关闭界面];
    end

    subgraph 后端逻辑 (Main: main.js)
        D[接收 'read-config' 请求] --> P[读取 config.json];
        P --> Q[返回配置数据];
        F_Dialog[接收 'open-folder-dialog' 请求] --> F_Action[打开文件夹对话框];
        F_Action --> F_Result[返回选中路径];
        K[接收 'write-config' 请求] --> R[写入 config.json];
        R -- 成功 --> S[返回成功状态 & 通知渲染进程 'config-updated'];
        R -- 失败 --> T[返回失败状态];
    end

    style D fill:#f9f,stroke:#333,stroke-width:2px
    style K fill:#f9f,stroke:#333,stroke-width:2px
    style F_Dialog fill:#f9f,stroke:#333,stroke-width:2px