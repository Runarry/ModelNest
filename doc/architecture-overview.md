# ModelNest 架构概览

## 1. 引言与概述

ModelNest 是一款跨平台的 AIGC (AI Generated Content) 模型管理与浏览工具。其主要目标是为用户提供一个统一的界面来管理、浏览和快速预览存储在不同位置（本地磁盘、WebDAV 服务器等）的 AIGC 模型文件。

核心功能包括：

*   **多数据源支持:** 支持从本地文件夹和 WebDAV 服务器加载模型。
*   **模型浏览:** 以列表或卡片视图展示模型，并显示基本元数据。
*   **模型预览:** 快速加载和显示模型的预览图（如果存在）。
*   **元数据管理:** 读取和展示与模型文件关联的元数据（通常存储在同名 `.json` 文件中）。
*   **图片缓存:** 对模型预览图进行缓存和压缩，优化加载速度和存储空间。
*   **配置化:** 通过配置文件管理数据源、支持的模型扩展名和缓存策略。

## 2. 高层架构

ModelNest 基于 **Electron** 框架构建，采用了经典的主进程 (Main Process) / 渲染进程 (Renderer Process) 模型。

```mermaid
graph TD
    subgraph 主进程 (Main Process)
        M[main.js] --> IPC_M(IPC Handler);
        M --> CM(ConfigManager);
        M --> IC(ImageCache);
        M --> Log(Logging);
        M --> Update(Updater);
        M --> WM(Window Management);
    end

    subgraph 渲染进程 (Renderer Process)
        R[renderer/main.js] --> UI(UI Components);
        R --> IPC_R(IPC Requester);
        UI --> IPC_R;
    end

    subgraph 安全边界
        P[preload.js (contextBridge)];
    end

    IPC_M <-- 安全IPC --> P;
    P <-- 安全IPC --> IPC_R;

    style 主进程 fill:#f9f,stroke:#333,stroke-width:2px;
    style 渲染进程 fill:#ccf,stroke:#333,stroke-width:2px;
    style 安全边界 fill:#eee,stroke:#333,stroke-width:1px,stroke-dasharray: 5 5;
```

*   **主进程 (`main.js`):** 运行在 Node.js 环境中，拥有完整的操作系统访问权限。负责应用的生命周期管理、窗口创建与管理、核心服务的初始化（如配置加载、日志、缓存、自动更新）以及处理来自渲染进程的 IPC 请求。
*   **渲染进程 (`src/renderer/`):** 运行在 Chromium 环境中，负责渲染用户界面 (HTML/CSS/JS) 和处理用户交互。出于安全考虑，渲染进程不能直接访问 Node.js API 或系统资源。
*   **预加载脚本 (`preload.js`):** 在渲染进程加载网页之前运行，并且可以访问 Node.js API 和 `window` 对象。它作为主进程和渲染进程之间的安全桥梁，通过 `contextBridge` 选择性地将主进程的功能暴露给渲染进程。

## 3. 主进程详解

主进程是应用的入口点和核心协调者。

*   **入口文件:** `main.js`
*   **核心职责:**
    *   **应用生命周期:** 控制应用的启动、退出、窗口管理 (创建、销毁、状态管理)。
    *   **服务初始化:**
        *   **配置管理 (`src/configManager.js`):** 加载、合并（默认配置与用户配置）、验证和提供应用配置。监听配置文件变化并通知渲染进程。
        *   **图片缓存 (`src/common/imageCache.js`):** 初始化和管理模型预览图的本地缓存。使用 `sharp` 库进行图片读取、缩放、压缩 (JPEG/WEBP) 和存储。提供清理过期或超出大小限制缓存的功能。
        *   **日志 (`electron-log`):** 配置和初始化日志系统，用于记录应用运行时的信息和错误。
        *   **自动更新 (`electron-updater`):** 配置和检查应用更新。
    *   **IPC 通信:** 设置 `ipcMain` 监听器 (`handle`) 来响应渲染进程通过 `invoke` 发送的请求，例如加载模型列表、获取配置、保存配置、打开文件对话框等。使用 `webContents.send` 向特定窗口发送事件通知，例如配置已更新、发现新版本等。

## 4. 渲染进程详解

渲染进程负责用户能看到和交互的一切。

*   **入口文件:** `src/renderer/index.html`, `src/renderer/main.js`
*   **核心职责:**
    *   **UI 渲染:** 构建和展示应用界面，包括模型列表、详情、设置等。
    *   **用户交互:** 响应用户的点击、滚动、输入等操作。
    *   **与主进程通信:** 通过 `preload.js` 暴露的 API (`window.electronAPI`) 调用主进程功能 (如请求模型数据、触发缓存清理)，并使用 `ipcRenderer.on` 监听来自主进程的事件通知。
*   **UI 组件结构 (`src/renderer/js/components/`):**
    *   `main-view.js`: 应用的主视图，负责展示模型列表（支持卡片和列表模式切换）和基本交互（搜索、排序、切换数据源）。
    *   `detail-model.js`: 以模态框形式展示选定模型的详细信息，包括预览大图、元数据等。
    *   `settings-model.js`: 设置模态框，允许用户配置数据源、缓存选项等。
    *   `source-edit-model.js`: 作为设置模态框的子组件，用于添加或编辑数据源（本地或 WebDAV）。
*   **辅助模块:**
    *   `ui-utils.js`: 提供 UI 相关的辅助函数。
    *   `i18n.js`: 处理国际化和本地化。
    *   `theme.js`: 管理应用的主题（亮色/暗色）。

## 5. 数据管理策略

ModelNest 设计了一套灵活的数据管理策略来支持不同的模型存储方式。

*   **数据源抽象 (`src/data/dataSourceInterface.js`):** 定义了一个标准接口，所有具体的数据源实现都必须遵循此接口。这确保了上层逻辑可以统一处理来自不同来源的数据。接口通常包含 `getModels()`, `getModelDetails(modelId)` 等方法。
*   **数据源实现:**
    *   **本地数据源 (`src/data/dataSource.js` 或类似文件):** 实现接口，通过 Node.js 的 `fs` 模块扫描指定本地目录，查找符合 `supportedExtensions` 配置的模型文件。
    *   **WebDAV 数据源 (`src/data/webdavDataSource.js`):** 实现接口，使用 `webdav` 库连接到用户配置的 WebDAV 服务器，列出目录内容并查找模型文件。处理身份验证和网络请求。
*   **模型解析 (`src/data/modelParser.js`):** 负责将找到的模型文件路径或信息转换为标准化的模型对象。它会尝试查找与模型文件同名的 `.json` 文件（或其他元数据文件），解析其中的元数据（如描述、标签、预览图文件名等），并结合文件信息（名称、路径、大小、修改时间）生成最终的模型对象供 UI 层使用。
*   **元数据存储:** 约定将模型的详细元数据存储在与模型文件同名、扩展名为 `.json` 的文件中。例如，`mymodel.safetensors` 的元数据存储在 `mymodel.json` 中。
*   **图片缓存 (`src/common/imageCache.js`):** 在主进程中运行，为渲染进程提供模型预览图。当渲染进程请求预览图时，缓存模块会检查本地缓存是否存在有效图片。如果不存在或已过期，它会尝试从数据源（本地或 WebDAV）加载原始预览图（可能根据元数据指定），生成缩略图，进行压缩，存入缓存，然后将图片数据返回给渲染进程。

## 6. 进程间通信 (IPC) 机制

Electron 的 IPC 机制是主进程和渲染进程协作的关键。ModelNest 利用了现代且安全的 IPC 实践。

*   **安全桥梁 (`preload.js` + `contextBridge`):** `preload.js` 是唯一可以直接访问 Node.js API 和 `window` 对象的地方。它使用 `contextBridge.exposeInMainWorld('electronAPI', { ... })` 将一组经过筛选和封装的主进程功能安全地暴露给渲染进程，挂载在 `window.electronAPI` 对象下。这避免了将整个 `ipcRenderer` 或其他敏感 API 暴露给渲染进程，降低了安全风险。
*   **通信模式:**
    *   **请求/响应 (Invoke/Handle):** 用于渲染进程需要从主进程获取数据或执行操作并得到结果的场景。
        *   渲染进程: `const result = await window.electronAPI.someFunction(args);` (内部调用 `ipcRenderer.invoke`)
        *   主进程: `ipcMain.handle('channel-name', async (event, args) => { /* ... perform action ... */; return result; });`
        *   示例: `load-models`, `get-config`, `save-config`, `clear-cache`, `open-dialog`。
    *   **事件通知 (Send/On):** 用于主进程需要主动向渲染进程发送消息，而不需要渲染进程响应的场景。
        *   主进程: `mainWindow.webContents.send('event-name', data);`
        *   渲染进程: `window.electronAPI.onEventName((data) => { /* ... handle event ... */ });` (内部调用 `ipcRenderer.on`)
        *   示例: `config-updated`, `update-available`, `download-progress`, `log-message`。

## 7. 关键库和依赖

根据 `package.json`，项目依赖以下关键库：

*   **运行时依赖 (`dependencies`):**
    *   `electron-log`: (^5.3.4) 提供强大的文件和控制台日志记录功能。
    *   `electron-updater`: (^6.6.2) 实现应用的自动更新功能，支持多种发布源（如 GitHub）。
    *   `sharp`: (^0.34.1) 高性能 Node.js 图像处理库，用于生成和压缩模型预览图缓存。
    *   `webdav`: (^5.8.0) 功能完善的 WebDAV 客户端库，用于与 WebDAV 服务器交互。
*   **开发依赖 (`devDependencies`):**
    *   `electron`: (^36.0.0) Electron 框架本身。
    *   `electron-builder`: (^26.0.13) 用于将 Electron 应用打包成可分发的安装程序 (NSIS, DMG, AppImage 等) 或压缩包。
    *   `cross-env`: (^7.0.3) 用于在不同操作系统上以一致的方式设置环境变量（例如 `IS_DEV_MODE`）。

## 8. 配置管理

应用的配置由 `src/configManager.js` 模块管理。

*   **配置文件:** 用户特定的配置通常存储在 Electron 的用户数据目录下的 `config.json` 文件中。如果用户配置文件不存在，会使用项目根目录下的 `config.example.json` 作为模板或默认值。
*   **配置结构 (`config.example.json`):**
    *   `modelSources`: 一个数组，定义了所有的数据源，每个数据源包含 `id`, `name`, `type` (`local` 或 `webdav`) 以及特定于类型的参数（如 `path` 或 `url`, `username`, `password`）。
    *   `supportedExtensions`: 一个字符串数组，列出了应用识别为模型文件的扩展名。
    *   `imageCache`: 一个对象，包含图片缓存的配置，如 `debug` 模式、压缩质量 (`compressQuality`)、压缩格式 (`compressFormat`) 和最大缓存大小 (`maxCacheSizeMB`)。
*   **管理逻辑 (`configManager.js`):**
    *   加载默认配置和用户配置。
    *   合并配置，用户配置优先。
    *   提供获取当前配置 (`getConfig`) 和保存配置 (`saveConfig`) 的接口（通过 IPC 暴露给渲染进程）。
    *   监听配置文件的变化，并在变化时重新加载配置并通过 IPC 通知渲染进程 (`config-updated` 事件)。

## 9. 构建与打包

项目使用 `electron-builder` 进行构建和打包，配置存储在 `electron-builder.yml` 文件中。

*   **配置要点:**
    *   `appId`: 应用的唯一标识符 (`com.banazzle.modelnest`)。
    *   `productName`: 应用的名称 (`ModelNest`)。
    *   `files`: 定义了打包时需要包含的文件和目录。
    *   `asar`: 设置为 `true`，将应用源代码打包进 asar 归档，提高读取性能。
    *   `win`: Windows 平台的特定配置。
        *   `target`: 定义了输出的目标格式，包括 `nsis` (创建 NSIS 安装程序) 和 `zip` (创建压缩包)。
        *   `arch`: 指定目标架构 (`x64`)。
    *   `nsis`: NSIS 安装程序的详细配置（如非一键安装、允许更改安装目录）。
    *   `publish`: 配置了自动更新的发布源为 GitHub Releases，指定了 `owner` 和 `repo`。
*   **构建命令 (参考 `package.json`):**
    *   `npm run pack`: 使用 `electron-builder` 打包应用到输出目录（通常是 `dist/`），但不创建安装程序。
    *   `npm run dist`: 使用 `electron-builder` 创建可分发的安装程序或包。

## 10. (可选) 潜在改进点

*   **测试覆盖:** 增加单元测试和集成测试，特别是针对数据源、模型解析和 IPC 通信逻辑。
*   **UI 状态管理:** 对于更复杂的 UI 交互，可以考虑引入状态管理库（如 Redux, Zustand）来更清晰地管理渲染进程的状态。
*   **错误处理:** 增强错误处理和用户反馈机制，特别是在处理文件 I/O、网络请求和图片处理时。
*   **性能优化:** 对大数据量模型库的加载和渲染进行性能分析和优化。
*   **插件系统:** 考虑设计插件系统以支持更多类型的数据源或元数据格式。