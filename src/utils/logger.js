const fs = require('fs');
const path = require('path');
const log = require('electron-log');
const { app } = require('electron');

/**
 * Initializes the logger.
 * @param {object} configService - The configuration service instance.
 */
async function initializeLogger(configService) {
  // 日志文件路径配置
  const logsDir = path.join(app.getPath('userData'), 'logs');
  const logFile = path.join(logsDir, 'main.log');
  try {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
      log.info(`[Log] 日志目录已创建: ${logsDir}`);
    }
  } catch (e) {
    // 若目录创建失败，降级为默认路径
    log.error('日志目录创建失败:', e.message, e.stack);
  }
  log.transports.file.resolvePath = () => logFile;
  log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] {text}';
  log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB

  // 配置 electron-log 捕获未处理的异常和拒绝
  log.errorHandler.startCatching({
    showDialog: process.env.NODE_ENV !== 'production' // 只在非生产环境显示对话框
  });
  log.info('[Log] 配置 electron-log 捕获未处理错误');

  // --- 日志级别设置 ---
  const appConfig = await configService.getConfig();
  let finalLogLevel = 'warn'; // 默认级别

  // 1. 优先从 configService 获取有效的 logLevel
  //    检查是否为非空字符串
  if (appConfig && typeof appConfig.logLevel === 'string' && appConfig.logLevel.trim() !== '') {
      finalLogLevel = appConfig.logLevel.trim();
      // 使用 info 级别记录来源，这条日志本身也会受最终级别限制
      log.info(`[Log] 使用来自 configService 的日志级别: ${finalLogLevel}`);
  }
  // 2. 如果 configService 没有提供有效级别，则检查环境变量 LOG_LEVEL
  else if (process.env.LOG_LEVEL && process.env.LOG_LEVEL.trim() !== '') {
      finalLogLevel = process.env.LOG_LEVEL.trim();
      // 使用 warn 级别记录回退，因为这通常表示配置缺失
      log.warn(`[Log] configService 未提供有效日志级别，回退到环境变量 LOG_LEVEL: ${finalLogLevel}`);
  }
  // 3. 如果都没有提供有效级别，则使用默认值
  else {
      // 使用 warn 级别记录回退
      log.warn(`[Log] configService 和环境变量均未提供有效日志级别，使用默认级别: ${finalLogLevel}`);
  }

  // 应用日志级别
  // 设置主级别
  log.level = finalLogLevel;
  // 显式设置 transports 的级别以确保生效
  // (根据 electron-log 的行为，有时单独设置 transport 级别更可靠)
  if (log.transports.console) {
    log.transports.console.level = finalLogLevel;
  }
  // 确保文件 transport 也遵循级别设置
  // 注意：文件 transport 的其他配置（如路径、格式）在前面已设置
  if (log.transports.file) {
    log.transports.file.level = finalLogLevel;
  }

  // 这条日志现在会根据 finalLogLevel 是否 >= info 来决定是否输出
  log.info(`[Log] 最终日志级别已设置为: ${finalLogLevel}`);
}

module.exports = { initializeLogger };