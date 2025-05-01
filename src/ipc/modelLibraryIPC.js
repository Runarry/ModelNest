const { ipcMain } = require('electron');
const log = require('electron-log');

/**
 * 初始化模型库相关的 IPC Handlers
 * @param {object} services - 包含所有服务的对象
 */
function initializeModelLibraryIPC(services) { // 接收 services 对象
  log.info('[IPC] 初始化 Model Library IPC Handlers...');

  // --- Model Saving ---
  ipcMain.handle('saveModel', async (event, model) => {
    log.info('[IPC] saveModel 请求', { sourceId: model?.sourceId, jsonPath: model?.jsonPath });
    try {
      // 验证输入
      if (!model || !model.jsonPath || !model.sourceId) {
        throw new Error('无效的模型数据或缺少 sourceId/jsonPath');
      }
      // 直接调用 ModelService 保存模型
      return await services.modelService.saveModel(model);
    } catch (error) {
      log.error('[IPC] 调用 modelService.saveModel 失败:', error.message, error.stack, { model });
      // 将错误传递给渲染进程
      throw error;
    }
  });

  // --- Model Listing ---
  ipcMain.handle('listModels', async (event, { sourceId, directory }) => {
    log.info('[IPC] listModels 请求', { sourceId, directory });
    try {
      // 验证输入
      if (!sourceId) throw new Error('缺少 sourceId');
      // 直接调用 ModelService 列出模型
      return await services.modelService.listModels(sourceId, directory);
    } catch (error) {
      log.error('[IPC] 调用 modelService.listModels 失败:', error.message, error.stack, { sourceId, directory });
      // 将错误传递给渲染进程
      throw error;
    }
  });

  // --- Subdirectory Listing ---
  ipcMain.handle('listSubdirectories', async (event, { sourceId }) => {
    log.info('[IPC] listSubdirectories 请求', { sourceId });
    try {
      // 验证输入
      if (!sourceId) throw new Error('缺少 sourceId');
      // 直接调用 ModelService 列出子目录
      return await services.modelService.listSubdirectories(sourceId);
    } catch (error) {
      log.error('[IPC] 调用 modelService.listSubdirectories 失败:', error.message, error.stack, { sourceId });
      // 将错误传递给渲染进程
      throw error;
    }
  });

  // --- Model Detail Fetching ---
  ipcMain.handle('getModelDetail', async (event, { sourceId, jsonPath }) => {
    log.info('[IPC] getModelDetail 请求', { sourceId, jsonPath });
    try {
      // 验证输入
      if (!sourceId || !jsonPath) throw new Error('缺少 sourceId 或 jsonPath');
      // 直接调用 ModelService 获取模型详情
      return await services.modelService.getModelDetail(sourceId, jsonPath);
    } catch (error) {
      log.error('[IPC] 调用 modelService.getModelDetail 失败:', error.message, error.stack, { sourceId, jsonPath });
      // 将错误传递给渲染进程
      throw error;
    }
  });

  // --- Model Image Fetching ---
  ipcMain.handle('getModelImage', async (event, { sourceId, imagePath }) => {
    log.info('[IPC] getModelImage 请求', { sourceId, imagePath });
    try {
      // 验证输入
      if (!sourceId || !imagePath) throw new Error('缺少 sourceId 或 imagePath');
      // 直接调用 ImageService 获取模型图片
      // ImageService 内部会处理缓存、数据源获取、压缩等逻辑
      return await services.imageService.getImage(sourceId, imagePath);
    } catch (error) {
      log.error('[IPC] 调用 imageService.getModelImage 失败:', error.message, error.stack, { sourceId, imagePath });
      // 将错误传递给渲染进程
      throw error;
    }
  });

  log.info('[IPC] Model Library IPC Handlers 初始化完成');
}

module.exports = {
  initializeModelLibraryIPC,
};