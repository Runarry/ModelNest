// src/ipc/modelCrawlerIPC.js
const { ipcMain } = require('electron');
// const logger = require('../common/logger'); // 假设你有一个日志模块, 暂时注释掉避免未找到模块错误

/**
 * 初始化模型爬取相关的 IPC 通信。
 * @param {import('electron').IpcMain} ipcMain - Electron 的 ipcMain 模块。
 * @param {object} services - 包含所有服务的对象。
 * @param {import('electron').BrowserWindow} mainWindow - 主窗口实例。
 */
function initializeModelCrawlerIPC(ipcMain, services, mainWindow) {
  if (!services || !services.modelCrawlerService) {
    console.error('[ModelCrawlerIPC] ModelCrawlerService 未初始化。');
    // logger.error('[ModelCrawlerIPC] ModelCrawlerService 未初始化。');
    return;
  }

  // 将 mainWindow 实例传递给 modelCrawlerService
  // 假设 modelCrawlerService 有一个 setMainWindow 方法
  if (typeof services.modelCrawlerService.setMainWindow === 'function') {
    services.modelCrawlerService.setMainWindow(mainWindow);
    console.info('[ModelCrawlerIPC] mainWindow 已设置到 ModelCrawlerService。');
    // logger.info('[ModelCrawlerIPC] mainWindow 已设置到 ModelCrawlerService。');
  } else {
    console.warn('[ModelCrawlerIPC] ModelCrawlerService 没有 setMainWindow 方法。状态更新可能无法发送到渲染进程。');
    // logger.warn('[ModelCrawlerIPC] ModelCrawlerService 没有 setMainWindow 方法。状态更新可能无法发送到渲染进程。');
  }

  ipcMain.handle('start-crawl', async (_event, sourceId, directory) => {
    console.info(`[ModelCrawlerIPC] 收到 start-crawl 请求: sourceId=${sourceId}, directory=${directory}`);
    // logger.info(`[ModelCrawlerIPC] 收到 start-crawl 请求: sourceId=${sourceId}, directory=${directory}`);
    try {
      const result = await services.modelCrawlerService.startCrawling(sourceId, directory);
      console.info(`[ModelCrawlerIPC] start-crawl 处理完成: ${JSON.stringify(result)}`);
      // logger.info(`[ModelCrawlerIPC] start-crawl 处理完成: ${JSON.stringify(result)}`);
      return { success: true, data: result };
    } catch (error) {
      console.error(`[ModelCrawlerIPC] start-crawl 处理失败: ${error.message}`, error);
      // logger.error(`[ModelCrawlerIPC] start-crawl 处理失败: ${error.message}`, error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('pause-crawl', async () => {
    console.info('[ModelCrawlerIPC] 收到 pause-crawl 请求');
    // logger.info('[ModelCrawlerIPC] 收到 pause-crawl 请求');
    try {
      await services.modelCrawlerService.pauseCrawling();
      console.info('[ModelCrawlerIPC] pause-crawl 处理完成');
      // logger.info('[ModelCrawlerIPC] pause-crawl 处理完成');
      return { success: true };
    } catch (error) {
      console.error(`[ModelCrawlerIPC] pause-crawl 处理失败: ${error.message}`, error);
      // logger.error(`[ModelCrawlerIPC] pause-crawl 处理失败: ${error.message}`, error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resume-crawl', async () => {
    console.info('[ModelCrawlerIPC] 收到 resume-crawl 请求');
    // logger.info('[ModelCrawlerIPC] 收到 resume-crawl 请求');
    try {
      await services.modelCrawlerService.resumeCrawling();
      console.info('[ModelCrawlerIPC] resume-crawl 处理完成');
      // logger.info('[ModelCrawlerIPC] resume-crawl 处理完成');
      return { success: true };
    } catch (error) {
      console.error(`[ModelCrawlerIPC] resume-crawl 处理失败: ${error.message}`, error);
      // logger.error(`[ModelCrawlerIPC] resume-crawl 处理失败: ${error.message}`, error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('cancel-crawl', async () => {
    console.info('[ModelCrawlerIPC] 收到 cancel-crawl 请求');
    // logger.info('[ModelCrawlerIPC] 收到 cancel-crawl 请求');
    try {
      await services.modelCrawlerService.cancelCrawling();
      console.info('[ModelCrawlerIPC] cancel-crawl 处理完成');
      // logger.info('[ModelCrawlerIPC] cancel-crawl 处理完成');
      return { success: true };
    } catch (error) {
      console.error(`[ModelCrawlerIPC] cancel-crawl 处理失败: ${error.message}`, error);
      // logger.error(`[ModelCrawlerIPC] cancel-crawl 处理失败: ${error.message}`, error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-crawl-status', async () => {
    // console.debug('[ModelCrawlerIPC] 收到 get-crawl-status 请求'); // 使用 debug 级别，因为这个请求可能很频繁
    // logger.debug('[ModelCrawlerIPC] 收到 get-crawl-status 请求'); // 使用 debug 级别，因为这个请求可能很频繁
    try {
      const status = services.modelCrawlerService.getCrawlingStatus();
      // console.debug(`[ModelCrawlerIPC] get-crawl-status 返回: ${JSON.stringify(status)}`);
      // logger.debug(`[ModelCrawlerIPC] get-crawl-status 返回: ${JSON.stringify(status)}`);
      return { success: true, data: status };
    } catch (error) {
      console.error(`[ModelCrawlerIPC] get-crawl-status 处理失败: ${error.message}`, error);
      // logger.error(`[ModelCrawlerIPC] get-crawl-status 处理失败: ${error.message}`, error);
      return { success: false, error: error.message };
    }
  });

  console.info('[ModelCrawlerIPC] 模型爬取 IPC 通信已初始化。');
  // logger.info('[ModelCrawlerIPC] 模型爬取 IPC 通信已初始化。');
}

module.exports = { initializeModelCrawlerIPC };