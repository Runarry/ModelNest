// 项目常量定义

/**
 * 模型爬取任务的状态常量
 */
const CRAWL_STATUS = Object.freeze({
  IDLE: 'idle',           // 空闲/未开始
  SCANNING: 'scanning',   // 扫描本地文件中
  RUNNING: 'running',     // 正在处理队列，爬取信息/下载图片
  PAUSED: 'paused',       // 任务已暂停
  CANCELED: 'canceled',   // 任务已被用户取消
  FINISHED: 'finished',   // 任务正常完成
  ERROR: 'error',         // 任务因错误终止
});

module.exports = {
  CRAWL_STATUS,
};