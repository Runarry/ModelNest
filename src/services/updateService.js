const log = require('electron-log');
const { autoUpdater } = require('electron-updater');

/**
 * @class UpdateService
 * @description 封装 electron-updater 的交互逻辑，提供统一的应用更新服务接口。
 */
class UpdateService {
  constructor() {
    this.webContents = null; // 用于向渲染进程发送消息
    log.transports.file.level = 'info'; // 配置日志级别
    autoUpdater.logger = log; // 将 electron-updater 的日志定向到 electron-log
    autoUpdater.autoDownload = false; // 禁用自动下载，让用户控制
    autoUpdater.disableWebInstaller = true; // 推荐禁用 web installer
  }

  /**
   * @description 设置用于发送消息的 webContents 实例。
   * @param {Electron.WebContents} webContents - 渲染进程的 WebContents。
   */
  setWebContents(webContents) {
    this.webContents = webContents;
    log.info('[UpdateService] WebContents set.');
  }

  /**
   * @description 向渲染进程发送状态更新。
   * @param {object} statusUpdate - 包含状态和可选信息的对象。
   * @param {string} statusUpdate.status - 更新状态 ('checking', 'available', 'not-available', 'downloading', 'downloaded', 'error')。
   * @param {any} [statusUpdate.info] - 附加信息 (例如，版本信息、进度、错误对象)。
   */
  sendStatusToRenderer(statusUpdate) {
    if (this.webContents && !this.webContents.isDestroyed()) {
      try {
        this.webContents.send('updater.onUpdateStatus', statusUpdate);
        log.info(`[UpdateService] Sent status to renderer: ${statusUpdate.status}`, statusUpdate.info || '');
      } catch (error) {
        log.error('[UpdateService] Failed to send status to renderer:', error);
      }
    } else {
      log.warn(`[UpdateService] Cannot send status to renderer, webContents is not available or destroyed. Status: ${statusUpdate.status}`);
    }
  }

  /**
   * @description 初始化 UpdateService，设置 autoUpdater 事件监听。
   */
  initialize() {
    log.info('[UpdateService] Initializing...');

    autoUpdater.on('checking-for-update', () => {
      log.info('[UpdateService] Event: checking-for-update');
      log.info('[UpdateService] Checking for update...');
      this.sendStatusToRenderer({ status: 'checking' });
    });

    autoUpdater.on('update-available', (info) => {
      log.info('[UpdateService] Update available:', info);
      this.sendStatusToRenderer({ status: 'available', info });
      // 通常在这里提示用户是否下载
    });

    autoUpdater.on('update-not-available', (info) => {
      log.info('[UpdateService] Update not available:', info);
      this.sendStatusToRenderer({ status: 'not-available', info });
    });

    autoUpdater.on('download-progress', (progressObj) => {
      const logMessage = `Download speed: ${progressObj.bytesPerSecond} - Downloaded ${progressObj.percent}% (${progressObj.transferred}/${progressObj.total})`;
      log.info(`[UpdateService] ${logMessage}`);
      this.sendStatusToRenderer({ status: 'downloading', info: progressObj });
    });

    autoUpdater.on('update-downloaded', (info) => {
      log.info('[UpdateService] Update downloaded:', info);
      this.sendStatusToRenderer({ status: 'downloaded', info });
      // 通常在这里提示用户是否立即安装
    });

    autoUpdater.on('error', (err) => {
      log.error('[UpdateService] Error in auto-updater:', err);
      this.sendStatusToRenderer({ status: 'error', info: err.message || err });
    });

    log.info('[UpdateService] Initialization complete. Event listeners attached.');
  }

  /**
   * @description 检查是否有可用更新。
   */
  checkForUpdates() {
    log.info('[UpdateService] >>> Starting checkForUpdates method.');
    log.info('[UpdateService] Executing checkForUpdates...');
    try {
      // 注意：如果 webContents 未设置，检查更新仍然会进行，但状态无法发送到 UI
      if (!this.webContents) {
        log.warn('[UpdateService] checkForUpdates called, but webContents is not set. Status updates might not reach the UI.');
      }
      autoUpdater.checkForUpdates();
      log.info('[UpdateService] >>> Calling autoUpdater.checkForUpdates()...');
    } catch (error) {
      log.error('[UpdateService] Error calling checkForUpdates:', error);
      this.sendStatusToRenderer({ status: 'error', info: `Failed to check for updates: ${error.message}` });
    }
  }

/**
   * @description 开始下载可用更新。
   */
  downloadUpdate() {
    log.info('[UpdateService] >>> Starting downloadUpdate method.');
    log.info('[UpdateService] Executing downloadUpdate...');
    try {
      // 注意：如果 webContents 未设置，下载仍然会进行，但进度状态无法发送到 UI
      if (!this.webContents) {
        log.warn('[UpdateService] downloadUpdate called, but webContents is not set. Progress updates might not reach the UI.');
      }
      this.autoUpdater.downloadUpdate(); // 调用 electron-updater 的下载方法
      log.info('[UpdateService] >>> Calling autoUpdater.downloadUpdate()...');
      // 可以选择性地发送一个“开始下载”的状态，尽管 'download-progress' 事件会很快跟上
      // this.sendStatusToRenderer({ status: 'downloading-started' });
    } catch (error) {
      log.error('[UpdateService] Error calling downloadUpdate:', error);
      this.sendStatusToRenderer({ status: 'error', info: `Failed to start download: ${error.message}` });
    }
  }
  /**
   * @description 退出应用并安装已下载的更新。
   */
  quitAndInstall() {
    log.info('[UpdateService] Executing quitAndInstall...');
    try {
      autoUpdater.quitAndInstall();
    } catch (error) {
      log.error('[UpdateService] Error calling quitAndInstall:', error);
      // 此时可能无法向渲染进程发送消息，因为应用即将退出
    }
  }
}


// 这里导出类，由服务注册中心管理实例
module.exports = UpdateService;