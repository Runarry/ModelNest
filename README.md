# ModelNest
- ModelNest 是一款基于 Electron 的模型管理工具，主要用来管理美术AIGC的模型的。
- 它同时支持本地目录和WebDAV，可以配置多个模型仓库进行切换。
- 本项目完全是为了满足自用，目前仍在开发阶段。
- 本项目从开发文档到所有代码，几乎都是使用`Roo Code` 生成，且我个人之前没有任何前端和JS开发经验，只有少数代码是我手搓的（现学的），因此代码质量极差，且不保证代码可读性。


## 主要功能
- [x] 支持本地与 WebDAV 多数据源模型管理
- [x] 按模型类型筛选、浏览模型
- [x] 查看模型详情与图片
- [ ] 数据和模型下载
- [ ] 与ComfyUI等进行模型同步

## 使用方法
1. **下载与运行**:
   - 前往 [Releases](https://github.com/your-repo/modelnest/releases) 页面下载最新版本的预编译包（适用于 Windows）。
   - 解压下载的文件，并运行 `ModelNest` 可执行文件。
   - （或者）对于开发者：克隆本仓库，然后运行 `npm install && npm start`。

2. **配置文件**:
   - **创建配置文件**: 首次运行前，您需要在 ModelNest 的根目录下（通常是您解压应用程序的文件夹）手动创建一个名为 `config.json` 的文本文件，你也可以下载 `config.example.json`文件，并重命名为`config.json`，然后进行编辑。

   - **编辑配置文件**: `config.json` 是 ModelNest 的主要配置文件，它使用 JSON 格式。您需要根据自己的环境和需求，参考下面的基本结构和后续的“配置项详解”部分来编辑这个文件。

   **`config.json` 基本结构示例**:
   ```json
   {
     "modelSources": [
       // 在这里添加您的模型库配置, 参考下面的示例和详解
       // 例如，添加一个本地模型库:
       // {
       //   "id": "local_models",
       //   "name": "我的本地模型",
       //   "type": "local",
       //   "path": "C:/path/to/your/models" // 修改为您的实际模型路径
       // }
     ],
     "supportedExtensions": [
       ".checkpoint", ".ckpt", ".safetensors", ".pt", ".pth", ".bin"
       // 根据需要添加或删除支持的模型文件扩展名
     ],
     "imageCache": {
       // 图片缓存配置 (可选), 参考下面的详解
       // "maxCacheSizeMB": 500
     }
   }
   ```
   - **重要提示**: 请确保 `config.json` 文件是有效的 JSON 格式。您可以使用在线 JSON 验证工具检查格式是否正确。

3. **配置项详解 (`config.json`)**:

   下面是 `config.json` 中主要配置项的说明：

   ```json
   {
     "modelSources": [
       // ... 模型库来源配置 ...
     ],
     "supportedExtensions": [
       // ... 支持的模型文件扩展名 ...
     ],
     "imageCache": {
       // ... 图片缓存配置 ...
     }
   }
   ```

   *   **`modelSources`** (必需): 一个数组，用于定义一个或多个模型库的来源。每个来源是一个对象，包含以下字段：
       *   `id` (string, 必需): 模型库的唯一标识符，例如 `"local1"` 或 `"webdav_main"`。
       *   `name` (string, 必需): 在界面上显示的模型库名称，例如 `"我的本地模型"`。
       *   `type` (string, 必需): 模型库的类型，目前支持 `"local"` 和 `"webdav"`。
       *   **对于 `type: "local"`**:
           *   `path` (string, 必需): 本地模型文件夹的绝对路径，例如 `"G:/Models"` 或 `"/Users/username/models"`。请确保路径存在且程序有读取权限。
       *   **对于 `type: "webdav"`**:
           *   `url` (string, 必需): WebDAV 服务器的 URL，例如 `"https://dav.example.com/dav/"`。
           *   `username` (string, 必需): WebDAV 登录用户名。
           *   `password` (string, 必需): WebDAV 登录密码。

       **示例**:
       ```json
       "modelSources": [
         {
           "id": "local_sd_models",
           "name": "Stable Diffusion 本地库",
           "type": "local",
           "path": "D:/AI/Models/Stable-diffusion"
         },
         {
           "id": "aliyun_drive_dav",
           "name": "阿里云盘 WebDAV",
           "type": "webdav",
           "url": "https://openapi.alipan.com/dav",
           "username": "your_aliyun_username",
           "password": "your_aliyun_password"
         }
       ]
       ```

   *   **`supportedExtensions`** (必需): 一个字符串数组，定义了 ModelNest 会识别并加载的模型文件扩展名。
       **示例**:
       ```json
       "supportedExtensions": [
         ".checkpoint", ".ckpt", ".safetensors", ".pt", ".pth", ".bin", ".lora"
       ]
       ```
       您可以根据需要添加或删除支持的扩展名。

   *   **`imageCache`** (可选): 一个对象，用于配置模型预览图片的缓存设置。
       *   `debug` (boolean, 可选, 默认 `false`): 是否在控制台输出缓存相关的调试信息。
       *   `compressQuality` (number, 可选, 默认 `80`): 缓存图片的压缩质量，取值范围 0-100。数值越高，质量越好，但文件越大。
       *   `compressFormat` (string, 可选, 默认 `"jpeg"`): 缓存图片的格式，支持 `"jpeg"`, `"png"`, `"webp"`。
       *   `maxCacheSizeMB` (number, 可选, 默认 `500`): 图片缓存占用的最大磁盘空间（单位 MB）。超过此限制时，可能会清理旧的缓存文件。

       **示例**:
       ```json
       "imageCache": {
         "debug": false,
         "compressQuality": 75,
         "compressFormat": "webp",
         "maxCacheSizeMB": 1024
       }
       ```
4. **组织模型库文件**:

   为了让 ModelNest 正确识别您的模型及其相关信息，请按照以下方式在您配置的模型库目录（本地路径或 WebDAV 根目录）中组织文件：

   *   **目录结构**: 目前 ModelNest 只会扫描您在 `config.json` 中指定的 `path` 目录（对于 `local` 类型）或 WebDAV 的根目录。它**不会**递归扫描子目录。请将所有模型文件、预览图和元数据文件直接放在配置的目录下。
   *   **文件命名**:
       *   **模型文件**: 使用 `config.json` 中 `supportedExtensions` 定义的扩展名，例如 `my_cool_model.safetensors`。
       *   **预览图片 (可选)**: 如果您想为模型提供预览图，图片文件必须与模型文件具有**相同的基本名称**（不含扩展名），并且扩展名为 `.png`, `.jpg`, 或 `.jpeg`。例如，对于 `my_cool_model.safetensors`，预览图应命名为 `my_cool_model.png` 或 `my_cool_model.jpg`。
       *   **元数据文件 (可选)**: 您可以为每个模型提供一个 JSON 文件来存储额外的元数据。这个 JSON 文件也必须与模型文件具有**相同的基本名称**，并且扩展名为 `.json`。例如，`my_cool_model.json`。
   *   **元数据 JSON 文件格式 (`.json`)**:
       这是一个可选的文件，用于提供模型的详细信息。其内容是一个 JSON 对象，可以包含以下常用字段（以及任何您想添加的自定义字段）：
       *   `modelType` (string): 模型的类型（例如 "LORA", "Checkpoint", "TextualInversion"）。如果未提供，将根据文件扩展名猜测。
       *   `description` (string): 模型的描述信息。
       *   `triggerWord` (string): 使用该模型（尤其是 LORA 或 Textual Inversion）时建议的触发词。
       *   `tags` (array of strings): 与模型相关的标签，方便分类和搜索。
       *   *(其他自定义字段)*: 您可以添加任何其他键值对，它们将被存储在模型的 `extra` 属性中。

   **示例文件结构**:
   假设您的本地模型库路径配置为 `D:/AI/Models/MyModels`，目录内容可以像这样：

   ```
   D:/AI/Models/MyModels/
   ├── character_a.safetensors
   ├── character_a.png
   ├── character_a.json
   ├── style_b.ckpt
   ├── style_b.jpg
   ├── style_b.json
   ├── object_c.pt
   └── background_d.safetensors
   ```

   **`character_a.json` 文件内容示例**:
   ```json
   {
     "modelType": "LORA",
     "description": "一个可爱的动漫角色 LORA 模型。",
     "triggerWord": "charA",
     "tags": ["anime", "character", "cute"],
     "baseModel": "AnimeFinal",
     "author": "CreatorX"
   }
   ```





