# 代码审查报告: scripts/remove-locales.js

**审查日期:** 2025/5/12
**审查员:** Roo
**文件路径:** [`scripts/remove-locales.js`](scripts/remove-locales.js)

## 1. 文件概述

该脚本使用 Node.js 编写，主要目的是在应用程序构建完成后，从指定的输出目录中移除未使用的本地化 (`.pak`) 文件，以减小最终的打包体积。脚本默认保留英文 (`en-US.pak`) 和中文 (`zh-CN.pak`) 的本地化文件。

## 2. 主要功能

-   **减少包体积**: 通过删除不需要的语言包来优化应用的最终大小。
-   **构建后处理**: 设计为在构建流程中，针对应用输出目录 (`appOutDir`) 进行操作。

## 3. 操作逻辑和依赖

### 操作逻辑

1.  接收一个包含 `appOutDir` (应用输出目录) 路径的对象作为参数。
2.  构造 `locales` 目录的完整路径：`path.join(appOutDir, 'locales')`。
3.  定义一个硬编码的列表 `keepLocales`，包含需要保留的本地化文件名 (`['en-US.pak', 'zh-CN.pak']`)。
4.  同步读取 `locales` 目录下的所有文件名。
5.  遍历读取到的文件列表：
    *   如果文件名不在 `keepLocales` 列表中，则同步删除该文件。

### 依赖

-   **Node.js 环境**: 脚本在此环境下执行。
-   **`fs` 模块**: 用于文件系统操作，如读取目录内容 (`readdirSync`) 和删除文件 (`unlinkSync`)。
-   **`path` 模块**: 用于处理和规范化文件路径 (`path.join`)。
-   **构建流程**: 脚本依赖于构建过程传入 `appOutDir` 参数。

## 4. 潜在问题、错误和不健壮之处

### a. 错误处理

-   **缺乏显式错误处理**: 脚本中的 `fs.readdirSync` 和 `fs.unlinkSync` 是同步操作。如果 `localesDir` 不存在、不可读，或删除文件时遇到权限问题等，这些操作会直接抛出错误，可能导致整个构建过程意外中断。没有使用 `try...catch` 块来捕获和处理这些潜在的文件系统错误。

### b. 路径和文件假设

-   **`locales` 目录必须存在**: 脚本假设 `path.join(appOutDir, 'locales')` 目录总是存在。如果该目录因故缺失，`fs.readdirSync(localesDir)` 将失败。
-   **文件类型假设**: 脚本不检查文件的扩展名。它会尝试删除 `locales` 目录下所有文件名不在 `keepLocales` 列表中的文件，无论它们是否为 `.pak` 文件。虽然 `locales` 目录通常只包含本地化资源，但这仍是一个微小的风险，可能误删非 `.pak` 文件（如果存在的话）。

### c. 硬编码配置

-   **保留列表硬编码**: `keepLocales` 列表直接在代码中定义。如果未来需要支持更多语言或更改保留的语言集，必须直接修改脚本代码，降低了灵活性。

### d. 同步操作

-   **阻塞操作**: 使用同步的文件系统操作 (`readdirSync`, `unlinkSync`)。对于构建脚本来说，这通常是可接受的，因为它们需要按顺序执行。但在极少数情况下，如 `locales` 目录异常庞大或磁盘 I/O 性能极差，可能会轻微拖慢构建速度。不过，对于典型的 `locales` 目录大小，影响可以忽略不计。

## 5. 潜在风险

-   **误删文件**:
    *   如果 `locales` 目录中存在非 `.pak` 文件且其名称未包含在 `keepLocales` 中，这些文件将被删除。
    *   如果传入的 `appOutDir` 路径不正确，脚本可能会在错误的目录结构下尝试操作（尽管 `path.join` 和 `locales` 子目录限制了范围）。
-   **构建中断**: 由于缺乏错误处理，任何文件系统操作的失败都可能导致构建过程提前终止，且没有明确的错误提示信息说明是此脚本导致的问题。
-   **维护性**: 硬编码的 `keepLocales` 列表在需要调整支持语言时，需要直接修改代码，增加了维护成本和出错风险。

## 6. 优化和改进建议

### a. 增强错误处理

-   使用 `try...catch` 块包裹文件系统操作，以捕获潜在错误，并提供更友好的错误提示或允许构建过程继续（如果适用）。

    ```javascript
    // 示例:
    const fs = require('fs');
    const path = require('path');

    module.exports = async ({ appOutDir }) => {
        const localesDir = path.join(appOutDir, 'locales');
        const keepLocales = ['en-US.pak', 'zh-CN.pak'];

        if (!fs.existsSync(localesDir)) {
            console.warn(`[remove-locales] Locales directory not found: ${localesDir}. Skipping removal.`);
            return;
        }

        console.log(`[remove-locales] Cleaning up locales in: ${localesDir}`);
        try {
            const files = fs.readdirSync(localesDir);
            files.forEach(file => {
                if (!keepLocales.includes(file)) {
                    const filePath = path.join(localesDir, file);
                    try {
                        fs.unlinkSync(filePath);
                        console.log(`[remove-locales] Removed: ${file}`);
                    } catch (unlinkError) {
                        console.error(`[remove-locales] Failed to remove ${filePath}:`, unlinkError);
                    }
                }
            });
        } catch (readDirError) {
            console.error(`[remove-locales] Error reading locales directory ${localesDir}:`, readDirError);
        }
        console.log('[remove-locales] Finished locale cleanup.');
    };
    ```

### b. 提高健壮性

-   **检查 `locales` 目录是否存在**: 在尝试读取目录前，使用 `fs.existsSync(localesDir)` 进行检查。如果目录不存在，可以打印一条警告信息并跳过后续操作。
-   **校验文件扩展名 (可选)**: 如果需要更严格的控制，可以在删除前检查文件扩展名是否为 `.pak`。
    ```javascript
    // 示例:
    // ...
    if (path.extname(file).toLowerCase() === '.pak' && !keepLocales.includes(file)) {
        // ...删除操作
    }
    // ...
    ```

### c. 改进日志输出

-   增加更详细的日志记录，例如：
    *   开始和结束执行脚本的日志。
    *   成功删除每个文件的日志。
    *   发生错误时的详细错误信息。
    *   当 `locales` 目录未找到时的提示。
    (已在上述错误处理示例中部分体现)

### d. 提高配置灵活性

-   **外部化 `keepLocales`**: 将 `keepLocales` 列表的配置移出脚本。可以考虑的方式：
    *   从 `package.json` 的自定义字段读取。
    *   从一个专门的 JSON 或 JS 配置文件读取。
    *   通过环境变量传入 (例如 `KEEP_LOCALES="en-US.pak,zh-CN.pak"` 然后在脚本中解析)。
    这样可以使语言支持的调整更加方便，无需修改脚本本身。

### e. 使用异步操作 (可选，视场景而定)

-   对于此特定场景，同步操作通常是简单且足够的。但如果未来 `locales` 目录可能包含大量文件，或者构建环境对非阻塞 I/O 有要求，可以考虑使用 `fs.promises` API 将操作转换为异步。

    ```javascript
    // 示例 (部分):
    const fsPromises = require('fs').promises;
    // ...
    // const files = await fsPromises.readdir(localesDir);
    // await Promise.all(files.map(async file => { /* ... */ }));
    ```
    (注意: 上述异步示例仅为概念演示，实际应用需完整改写)

### f. 代码注释和文档

-   虽然现有注释已说明基本用途，但可以为导出的模块函数添加 JSDoc 风格的注释，明确说明其参数 (`appOutDir`)、行为和预期。

## 7. 总结

[`scripts/remove-locales.js`](scripts/remove-locales.js) 脚本目标明确，实现简洁，能够有效地减少因包含未使用本地化文件而导致的包体积增大问题。主要的改进方向在于增强其健壮性（通过错误处理和目录检查）、提高配置的灵活性以及改进日志输出，使其在构建过程中更可靠、更易于维护和调试。