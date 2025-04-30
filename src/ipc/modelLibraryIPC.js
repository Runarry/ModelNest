const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const log = require('electron-log');
// Remove direct imports of specific data sources
// const { LocalDataSource } = require('../data/dataSource');
// const { WebDavDataSource } = require('../data/webdavDataSource');
const imageCache = require('../common/imageCache'); // Adjusted path
const { parseModelDetailFromJsonContent, prepareModelDataForSaving } = require('../data/modelParser'); // Adjusted path
// Import all necessary functions from the interface
const dataSourceInterface = require('../data/dataSourceInterface'); // Adjusted path

// 注意：config 将作为参数传递给 initializeModelLibraryIPC

function initializeModelLibraryIPC(config) {
  log.info('[IPC] Initializing Model Library IPC Handlers...');


  // --- Model Saving ---
  ipcMain.handle('saveModel', async (event, model) => {
    log.debug('[IPC saveModel] Received model data from renderer:', JSON.stringify(model, null, 2)); // 添加详细日志，检查前端发送的数据
    log.info('[IPC] saveModel 请求', { jsonPath: model && model.jsonPath });
    try {
      if (!model.jsonPath) throw new Error('模型JSON路径不存在');
      // 1. 读取现有数据
      let existingData = {};
      try {
        const rawData = await fs.promises.readFile(model.jsonPath, 'utf-8');
        existingData = JSON.parse(rawData);
        log.debug(`[IPC saveModel] 成功读取现有模型数据: ${model.jsonPath}`);
      } catch (readError) {
        // 如果文件不存在或无法读取/解析，则从空对象开始合并
        // 但记录一个警告，因为通常文件应该存在
        if (readError.code !== 'ENOENT') {
            log.warn(`[IPC saveModel] 读取现有模型JSON失败 (${model.jsonPath}): ${readError.message}. 将创建新文件或覆盖。`);
        } else {
             log.info(`[IPC saveModel] 现有模型JSON不存在 (${model.jsonPath}). 将创建新文件。`);
        }
        existingData = {}; // 确保从空对象开始
      }

      // 2. 合并数据:
      //    - Start with the existing data from the file.
      //    - Spread the incoming 'model' object from the frontend over it.
      //    - This ensures all fields sent by the frontend (standard and extra)
      //      are included at the top level, overwriting existing values if keys match.
      // 3. 使用 modelParser 准备要写入的数据（合并和清理）
      const finalDataToSave = prepareModelDataForSaving(existingData, model);
      log.debug(`[IPC saveModel] 调用 prepareModelDataForSaving 后准备保存的数据键: ${Object.keys(finalDataToSave)}`);

      // 4. 序列化准备好的数据
      const dataToWrite = JSON.stringify(finalDataToSave, null, 2); // Pretty-print JSON
      log.debug(`[IPC saveModel] 准备写入序列化后的数据到: ${model.jsonPath}`); // Log the exact data being written (removed dataToWrite for brevity)

      // 查找对应的 sourceConfig
      const sourceConfig = (config.modelSources || []).find(s => s.id === model.sourceId);
      if (!sourceConfig) {
          log.error(`[IPC saveModel] 未找到源配置 ID: ${model.sourceId}`);
          throw new Error(`Configuration for source ID ${model.sourceId} not found.`);
      }

      // 使用接口函数写入，传入 sourceConfig
      await dataSourceInterface.writeModelJson(sourceConfig, model, dataToWrite);
      log.info('[IPC saveModel] 模型保存成功', { sourceId: model.sourceId, jsonPath: model.jsonPath });
      return { success: true }; // Indicate success back to the renderer
    } catch (error) {
      log.error('[IPC] 保存模型失败:', error.message, error.stack, { model });
      throw error;
    }
  });

  // --- Model Listing ---
  ipcMain.handle('listModels', async (event, { sourceId, directory }) => { 
    // Change log level to info to ensure visibility
    // 从 config 中获取 supportedExts
    const supportedExts = config.supportedExtensions || []; // 从 config 获取，提供默认空数组
    log.info(`[IPC listModels] Received request. sourceId: ${sourceId}, directory: ${directory}. Using supportedExts from config: ${supportedExts}`);
    const sourceConfig = (config.modelSources || []).find(s => s.id === sourceId);
    log.debug(`[IPC listModels] Found sourceConfig: ${sourceConfig ? JSON.stringify(sourceConfig) : 'Not Found'}`); // Keep this debug for now
    if (!sourceConfig) {
        log.warn(`[IPC listModels] 未找到数据源配置: ${sourceId}`);
        return [];
    }
    try {
      // 调用接口函数，传递从 config 获取的 supportedExts
      return await dataSourceInterface.listModels(sourceConfig, directory, supportedExts);
    } catch (error) {
      log.error(`[IPC listModels] Error listing models for source ${sourceId} in directory ${directory} with exts ${supportedExts}:`, error.message, error.stack); // 在错误日志中添加 exts
      throw error; // 将错误传递给渲染进程
    }
  });

  // --- Subdirectory Listing ---
  ipcMain.handle('listSubdirectories', async (event, { sourceId }) => {
    const sourceConfig = (config.modelSources || []).find(s => s.id === sourceId);
     if (!sourceConfig) {
        log.warn(`[IPC listSubdirectories] 未找到数据源配置: ${sourceId}`);
        return [];
    }
    try {
       // 调用接口函数
      return await dataSourceInterface.listSubdirectories(sourceConfig);
    } catch (error) {
      log.error(`[IPC listSubdirectories] Error listing subdirectories for source ${sourceId}:`, error.message, error.stack);
      throw error; // 将错误传递给渲染进程
    }
  });

  // --- Model Detail Fetching ---
  ipcMain.handle('getModelDetail', async (event, { sourceId, jsonPath }) => {
    const sourceConfig = (config.modelSources || []).find(s => s.id === sourceId);
    if (!sourceConfig) {
        log.warn(`[IPC getModelDetail] 未找到数据源配置: ${sourceId}`);
        return {}; // Return empty object as before
    }
    try {
      // 调用接口函数
      // The interface function now handles the try/catch and returns {} on error internally
      return await dataSourceInterface.readModelDetail(sourceConfig, jsonPath);
    } catch (error) {
      // Interface function handles logging, but we re-throw to renderer as per original logic
      log.error(`[IPC getModelDetail] Error calling dataSourceInterface.readModelDetail for source ${sourceId}, path ${jsonPath}:`, error.message, error.stack);
      throw error;
    }
  });

  // --- Model Image Fetching ---
  ipcMain.handle('getModelImage', async (event, { sourceId, imagePath }) => {
    const sourceConfig = (config.modelSources || []).find(s => s.id === sourceId);
    if (!sourceConfig) {
      log.error(`[ImageLoader] 未找到数据源配置: ${sourceId}`);
      return null;
    }

    try {
      // 统一缓存key生成方式：本地用绝对路径，WebDAV用原始网络路径
      // Use posix path for WebDAV consistency
      const hashKey = sourceConfig.type === 'local'
        ? path.resolve(imagePath) // Keep local paths absolute
        : imagePath.replace(/\\/g, '/').toLowerCase(); // Normalize WebDAV paths

      log.debug(`[ImageLoader] Generated hash key for ${sourceConfig.type} source: ${hashKey}`);

      // 计算缓存路径
      const cacheDir = path.join(process.cwd(), 'cache', 'images');
      const cacheFilename = crypto.createHash('md5').update(hashKey).digest('hex') +
                            (imageCache.config.compressFormat === 'webp' ? '.webp' : '.jpg');
      const cachePath = path.join(cacheDir, cacheFilename);

      // 1. 检查缓存
      log.debug('[ImageLoader] Checking cache at:', cachePath);
      try {
        if (fs.existsSync(cachePath)) {
          log.debug('[ImageLoader] Cache hit, reading...');
          const data = await fs.promises.readFile(cachePath);
          log.debug('[ImageLoader] Successfully read cache file');
          return {
            path: cachePath,
            data,
            mimeType: imageCache.config.compressFormat === 'webp' ? 'image/webp' : 'image/jpeg'
          };
        } else {
          log.debug('[ImageLoader] Cache miss');
        }
      } catch (e) {
        log.error('[ImageLoader] Cache check/read error:', e.message, e.stack);
        // Proceed to fetch if cache read fails
      }

      // 2. 通过接口获取图片数据/路径
      log.debug(`[ImageLoader] Calling dataSourceInterface.getImageData for source ${sourceId}, path: ${imagePath}`);
      const imageDataResult = await dataSourceInterface.getImageData(sourceConfig, imagePath);

      if (!imageDataResult) {
        log.warn(`[ImageLoader] dataSourceInterface.getImageData returned null for ${imagePath}`);
        return null; // Image not found or error in interface
      }

      let sourceImagePathForCache; // Path to the file to be compressed
      let originalMimeType = imageDataResult.mimeType || 'image/png'; // Default mime type
      let tempFilePath = null; // Path for temporary WebDAV file

      if (sourceConfig.type === 'local') {
        // Interface confirmed local path exists
        sourceImagePathForCache = imageDataResult.path;
        log.debug(`[ImageLoader] Using local image path for caching: ${sourceImagePathForCache}`);
      } else if (sourceConfig.type === 'webdav') {
        // Interface returned downloaded data for WebDAV
        if (!imageDataResult.data) {
             log.error(`[ImageLoader] WebDAV image data missing from interface result for: ${imagePath}`);
             return null;
        }
        // Save WebDAV data to a temporary file for imageCache
        const tempDir = path.join(process.cwd(), 'cache', 'temp_images');
        if (!fs.existsSync(tempDir)) await fs.promises.mkdir(tempDir, { recursive: true });
        // Use a more descriptive temp name if possible, or random
        const tempFilename = crypto.createHash('md5').update(imagePath).digest('hex') + path.extname(imagePath || '.png');
        tempFilePath = path.join(tempDir, tempFilename);
        log.debug(`[ImageLoader] Writing WebDAV image data to temporary file: ${tempFilePath}`);
        await fs.promises.writeFile(tempFilePath, imageDataResult.data);
        sourceImagePathForCache = tempFilePath;
        originalMimeType = imageDataResult.mimeType || 'image/png'; // Use mimeType from WebDAV result
      } else {
         log.error(`[ImageLoader] Unsupported source type after interface call: ${sourceConfig.type}`);
         return null;
      }


      // 3. 压缩并缓存图片
      log.debug(`[ImageLoader] Calling imageCache.getCompressedImage with source path: ${sourceImagePathForCache}, hashKey: ${hashKey}`);
      let compressedPath;
      try {
        // Pass the determined source path (local original or webdav temp) to the cache function
        compressedPath = await imageCache.getCompressedImage(sourceImagePathForCache, hashKey);
        log.debug(`[ImageLoader] Compressed image path returned: ${compressedPath}`);
        // Verify the compressed path is the expected cache path
        if (path.resolve(compressedPath) !== path.resolve(cachePath)) {
             log.warn(`[ImageLoader] Compressed path (${compressedPath}) differs from expected cache path (${cachePath}). Using returned path.`);
             // This might happen if caching failed and it returned the original/temp path
        }
      } catch (e) {
        log.error(`[ImageLoader] Image compression/caching failed for ${sourceImagePathForCache}:`, e.message, e.stack);
        // If compression fails, should we return the original? The original logic returned null.
        // Let's stick to returning null on compression failure for now.
         if (tempFilePath) { // Clean up temp file if compression failed
            fs.promises.unlink(tempFilePath).catch(e => log.error(`[ImageLoader] Temp file cleanup failed after compression error: ${tempFilePath}`, e.message));
         }
        return null;
      }

       // 4. 读取压缩后的数据返回给渲染器
       log.debug(`[ImageLoader] Reading final compressed data from: ${compressedPath}`);
       const finalData = await fs.promises.readFile(compressedPath);

      // 5. 清理WebDAV临时文件 (if created and different from compressed path)
      if (tempFilePath && path.resolve(tempFilePath) !== path.resolve(compressedPath)) {
        log.debug(`[ImageLoader] Cleaning up temporary WebDAV file: ${tempFilePath}`);
        fs.promises.unlink(tempFilePath).catch(e =>
          log.error(`[ImageLoader] Temporary file cleanup failed: ${tempFilePath}`, e.message, e.stack));
      }

      // 6. 返回结果
      return {
        path: compressedPath, // Return the path to the cached/compressed file
        data: finalData,
        mimeType: compressedPath.endsWith('.webp') ? 'image/webp' :
                  compressedPath.endsWith('.jpg') ? 'image/jpeg' : originalMimeType // Fallback to original mime
      };
    } catch (e) {
      // Catch errors from the overall process (e.g., finding sourceConfig, interface call itself)
      log.error(`[ImageLoader] Overall image processing failed for source ${sourceId}, path ${imagePath}:`, e.message, e.stack);
      return null;
    }
  });

  log.info('[IPC] Model Library IPC Handlers Initialized.');
}

module.exports = {
  initializeModelLibraryIPC,
};