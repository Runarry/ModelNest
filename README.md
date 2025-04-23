# ModelNest

ModelNest 是一款基于 Electron 的跨平台桌面工具，简洁高效地管理和浏览本地或 WebDAV 的多种 AI 模型文件。支持多数据源配置、模型筛选、详情查看，适合个人和团队模型资源管理。

## 主要功能

- 支持本地与 WebDAV 多数据源模型管理
- 按模型类型筛选、浏览模型
- 查看模型详情与图片
- 配置文件集中管理数据源与扩展名
- 代码结构清晰，易于扩展

## 目录结构

详见 `设计文档.md`，核心目录如下：

```
main.js
preload.js
config.json
src/
  data/
    dataSource.js
    modelParser.js
  renderer/
    index.html
    renderer.js
    ui.js
  common/
    constants.js
    utils.js
```

## 启动方式

1. 安装依赖

   ```
   npm install
   ```

2. 启动应用

   ```
   npm start
   ```

## 配置

编辑根目录下 `config.json`，可自定义本地或 WebDAV 数据源及支持的模型扩展名。

## 设计与开发说明

详见 `设计文档.md` 和 `tasklist.md`。