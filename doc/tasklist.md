# ModelNest 开发任务拆解（简明版）

## 1. 配置管理
- 实现 config.json 的加载与解析，支持多数据源（本地/WebDAV）配置。
- 提供 API 获取当前配置。

## 2. 数据源抽象
- 定义统一的数据源接口（如 listModels, readModelDetail）。
- 实现本地数据源（LocalDataSource）。
- 实现 WebDAV 数据源（WebDavDataSource）。

## 3. 模型解析
- 根据配置的扩展名扫描模型文件。
- 关联同名图片（.png）与模型介绍（.json）。
- 解析模型 JSON，生成标准模型对象。

## 4. 前后端通信（IPC）
- 实现 getConfig、listModels、getModelDetail 三个 IPC 通信接口。

## 5. UI 实现
- 顶部数据源切换入口（下拉框/列表）。
- 展示当前数据源下的模型列表，支持按 modelType 筛选。
- 实现模型详情页/弹窗，展示全部字段与图片。

## 6. 代码结构与模块化
- 按建议目录结构组织代码，分层实现配置管理、数据源、模型解析、UI 渲染等模块。

---

## 任务优先级建议

1. 支持多目录来源配置与切换
2. 支持本地与 WebDAV 读取、展示
3. 支持按 modelType 筛选
4. 支持模型详情页
5. 代码结构模块化，便于扩展

---

## Mermaid 任务分解流程图

```mermaid
graph TD
  A[配置管理] --> B[数据源抽象]
  B --> C[模型解析]
  C --> D[前后端通信]
  D --> E[UI实现]
  E --> F[代码结构与模块化]