const fs = require('fs-extra'); // 使用fs-extra来获得更好的异步支持和错误处理
const path = require('path');
const log = require('electron-log');
const { app } = require('electron');

/**
 * Initializes the logger.
 * @param {object} configService - The configuration service instance.
 */
async function initializeLogger(configService) {
  // 日志文件路径配置
  const userDataPath = app.getPath('userData');
  const logsDir = path.join(userDataPath, 'logs');
  const logFile = path.join(logsDir, 'main.log');
  
  // 提前配置文件解析函数，确保即使最早的日志也能使用正确的路径
  log.transports.file.resolvePath = () => logFile;
  
  // 确保user data目录和logs目录存在
  try {
    // 显式检查和创建userData目录（可能不需要，但增加容错性）
    if (!fs.existsSync(userDataPath)) {
      await fs.ensureDir(userDataPath);
      console.log(`[Log] 创建用户数据目录: ${userDataPath}`);
    }
    
    // 使用fs-extra的ensureDir确保logs目录存在
    await fs.ensureDir(logsDir);
    console.log(`[Log] 确保日志目录存在: ${logsDir}`);
    log.info(`[Log] 日志目录已准备: ${logsDir}`);
  } catch (e) {
    // 若目录创建失败，尝试打印错误，但不中断程序
    console.error('日志目录创建失败:', e.message, e.stack);
    
    // 尝试回退到临时目录
    try {
      const tempDir = path.join(app.getPath('temp'), 'model-nest-logs');
      await fs.ensureDir(tempDir);
      
      // 更新日志文件路径
      const tempLogFile = path.join(tempDir, 'main.log');
      log.transports.file.resolvePath = () => tempLogFile;
      
      console.log(`[Log] 使用临时日志目录: ${tempDir}`);
      log.warn(`[Log] 使用临时日志目录: ${tempDir}`);
    } catch (tempError) {
      console.error('临时日志目录创建也失败:', tempError.message);
      // 此时只能继续使用控制台日志了
    }
  }

  // 日志格式和大小配置
  log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] {text}';
  log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB

  // 日志清理配置
  const maxTotalLogSize = 100 * 1024 * 1024; // 100MB，日志目录最大总大小
  const maxLogFileAgeDays = 30; // 30天，日志文件最大保留时间

  // 清理旧日志文件函数
  async function cleanOldLogs() {
    try {
      // 检查日志目录是否存在
      const exists = await fs.pathExists(logsDir);
      if (!exists) {
        console.log(`[Log] 日志目录不存在，跳过清理: ${logsDir}`);
        return;
      }
      
      const files = await fs.readdir(logsDir);
      const logFiles = files
        .filter(f => f.endsWith('.log'))
        .map(f => path.join(logsDir, f));

      if (logFiles.length === 0) {
        log.info(`[Log] 没有找到日志文件，跳过清理`);
        return;
      }

      // 获取文件信息
      const fileInfos = await Promise.all(
        logFiles.map(async file => {
          try {
            const stats = await fs.stat(file);
            return { file, size: stats.size, mtime: stats.mtime };
          } catch (err) {
            log.warn(`[Log] 获取文件信息失败: ${file}`, err.message);
            return null;
          }
        })
      );

      // 过滤掉获取信息失败的文件
      const validFileInfos = fileInfos.filter(info => info !== null);

      // 删除超过最大保留时间的日志文件
      const now = Date.now();
      const expiredFiles = validFileInfos.filter(info => {
        const ageDays = (now - info.mtime.getTime()) / (1000 * 60 * 60 * 24);
        return ageDays > maxLogFileAgeDays;
      });
      
      for (const info of expiredFiles) {
        try {
          await fs.unlink(info.file);
          log.info(`[Log] 删除过期日志文件: ${info.file}`);
        } catch (err) {
          log.warn(`[Log] 删除过期日志文件失败: ${info.file}`, err.message);
        }
      }

      // 重新获取文件信息，计算总大小
      const remainingFiles = validFileInfos.filter(info => !expiredFiles.includes(info));
      let totalSize = remainingFiles.reduce((acc, info) => acc + info.size, 0);

      // 按修改时间升序排序，删除最旧文件直到总大小符合限制
      if (totalSize > maxTotalLogSize) {
        log.info(`[Log] 日志总大小 ${totalSize} 字节超过限制 ${maxTotalLogSize} 字节，将删除旧文件`);
        
        remainingFiles.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
        for (const info of remainingFiles) {
          if (totalSize <= maxTotalLogSize) break;
          
          try {
            await fs.unlink(info.file);
            log.info(`[Log] 删除日志文件以控制总大小: ${info.file}`);
            totalSize -= info.size;
          } catch (err) {
            log.warn(`[Log] 删除日志文件失败: ${info.file}`, err.message);
          }
        }
      }
    } catch (err) {
      log.error('[Log] 清理日志文件时出错:', err.message, err.stack);
    }
  }

  // 执行日志清理（忽略可能的错误，不影响主流程）
  try {
    await cleanOldLogs();
  } catch (err) {
    console.error('[Log] 日志清理过程异常:', err.message);
  }

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