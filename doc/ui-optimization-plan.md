# UI 优化计划

**目标:** 改善信息布局、可读性，将设置相关功能移至独立区域，并优化模型卡片的宽高比，提升整体视觉协调性。

**实施步骤:**

1.  **新增顶部菜单栏 (HTML & CSS & JS):**
    *   **HTML:** 在 `<body>` 或 `#app` 内，现有 `<header>` 之前，添加 `<nav class="top-menu-bar">`。
    *   **HTML/JS:** 将语言选择下拉框 (`#languageSelect`) 从 `.filters` 移动到 `<nav class="top-menu-bar">`。
    *   **HTML/JS:** 确认当前主题切换方式。将主题切换按钮（或新建一个）放入 `<nav class="top-menu-bar">`。更新/添加相应的 JavaScript 事件监听和处理逻辑。
    *   **CSS:** 为 `.top-menu-bar` 编写样式，定义背景、内边距、元素对齐（例如，Logo/标题居左，设置项居右）。

2.  **调整现有 Header (HTML & CSS):**
    *   **HTML:** 从 `<div class="filters">` 中移除 `#languageSelect` 的 HTML 结构。
    *   **CSS:** 检查并调整 `.filters` 的样式（如 `gap`, `justify-content`），确保剩余元素（数据源、过滤器、视图切换）布局合理。

3.  **优化卡片尺寸与宽高比 (CSS):**
    *   **CSS:** 在 `src/renderer/style.css` 中找到 `.model-image` 规则 (line 308 附近)。
        *   移除 `min-height: 220px;`。
        *   添加 `aspect-ratio: 16 / 9;` (或其他选定的比例)。
    *   **CSS:** 找到 `.model-card` 规则 (line 289 附近)。
        *   移除或大幅减小 `min-height: 240px;`。
    *   **CSS (可选):** 找到 `#modelList` 规则 (line 281 附近)。根据应用宽高比后的视觉效果，考虑是否需要调整 `grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));` 中的 `220px` 值。

4.  **优化卡片内部信息布局 (CSS & JS):**
    *   **CSS:** 找到 `.model-name` 规则 (line 327 附近)，增大 `font-size` (例如 `1.15rem` 或 `1.2rem`)。
    *   **CSS:** 找到 `.model-type` 规则 (line 335 附近)，考虑使用稍浅的颜色或减小字号以弱化显示。
    *   **CSS:** 找到 `.tags-container` 规则 (line 347 附近)，移除 `max-height: 60px;` 和 `overflow-y: auto;`。
    *   **JS:** 修改 `src/renderer/renderer.js` 或 `src/renderer/ui.js` 中渲染模型卡片标签的逻辑：
        *   计算并只显示适合第一行（或固定行数）的标签。
        *   如果标签总数超出，显示 "..." 或 "更多" 指示符。
        *   为指示符添加点击事件，用于展开/收起所有标签。
    *   **CSS:** 审视 `.model-content` 的 `padding` 及内部元素的 `margin`，确保间距舒适。

5.  **整体视觉微调 (CSS):**
    *   **CSS:** 微调 `.model-card` 的 `box-shadow`，使其更柔和。
    *   **CSS:** 优化 `.tag` 的 `padding`, `border-radius`, `font-size` 等细节。
    *   **CSS:** 为 `select` 元素添加 `:hover` 效果。

**计划概览 (Mermaid):**

```mermaid
graph TD
    A[分析现有代码] --> NEW_MENU{1. 新增顶部菜单栏};
    NEW_MENU --> NM1(HTML: 添加容器);
    NEW_MENU --> NM2(HTML/JS: 移动语言选择);
    NEW_MENU --> NM3(HTML/JS: 添加/移动主题切换);
    NEW_MENU --> NM4(CSS: 菜单栏样式);

    A --> ADJ_HEADER(2. 调整现有 Header);
    ADJ_HEADER --> AH1(HTML: 移除元素);
    ADJ_HEADER --> AH2(CSS: 调整布局);

    A --> CARD_ASPECT{3. 优化卡片宽高比};
    CARD_ASPECT --> CA1(CSS: 移除图片 min-height);
    CARD_ASPECT --> CA2(CSS: 添加图片 aspect-ratio);
    CARD_ASPECT --> CA3(CSS: 移除/调整卡片 min-height);
    CARD_ASPECT --> CA4(CSS: (可选)调整 Grid 最小宽度);

    A --> CARD_INTERNAL{4. 优化卡片内部布局};
    CARD_INTERNAL --> CI1(CSS: 突出模型名称);
    CARD_INTERNAL --> CI2(CSS: 调整模型类型);
    CARD_INTERNAL --> CI3(CSS/JS: 改进标签显示);
    CARD_INTERNAL --> CI4(CSS: 调整内部间距);

    NEW_MENU & ADJ_HEADER & CARD_ASPECT & CARD_INTERNAL --> D(5. 整体视觉微调 - CSS);
    D --> E(完成);

    style NEW_MENU fill:#f9f,stroke:#333,stroke-width:2px
    style ADJ_HEADER fill:#f9f,stroke:#333,stroke-width:2px
    style CARD_ASPECT fill:#f9f,stroke:#333,stroke-width:2px
    style CARD_INTERNAL fill:#f9f,stroke:#333,stroke-width:2px
    style D fill:#ccf,stroke:#333,stroke-width:1px
    style CI3 fill:#f9d,stroke:#333,stroke-width:1px