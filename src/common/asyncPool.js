// src/common/asyncPool.js
const log = require('electron-log');

/**
 * 异步并发池，用于控制并发执行异步任务。
 * @param {number} poolLimit 并发上限。
 * @param {Array<any>} array 要处理的数组。
 * @param {Function} iteratorFn 迭代函数，接收数组中的一个元素，返回一个 Promise。
 * @param {string} taskName 可选的任务名称，用于日志记录。
 * @returns {Promise<Array<{status: 'fulfilled' | 'rejected', value?: any, reason?: any}>>} 返回 Promise.allSettled 的结果数组。
 */
async function asyncPool(poolLimit, array, iteratorFn, taskName = 'Unnamed Task') {
  const ret = []; // 存储所有 Promise 的结果
  const executing = []; // 存储正在执行的 Promise

  // 确保 poolLimit 是一个有效的正数
  const limit = Math.max(1, parseInt(poolLimit, 10) || 1);

  log.debug(`[AsyncPool][${taskName}] Starting with limit ${limit} for ${array.length} items.`);

  for (const item of array) {
    // 为每个任务创建一个 Promise
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p); // 将 Promise 本身推入结果数组，后续用 allSettled 处理

    // 如果并发数达到上限，则等待一个任务完成
    // 只有当数组长度大于并发限制时，并发控制才有意义
    if (limit <= array.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e); // 将包装后的 Promise 推入执行队列
      if (executing.length >= limit) {
        log.debug(`[AsyncPool][${taskName}] Reached pool limit (${limit}). Waiting for a task to finish.`);
        await Promise.race(executing); // 等待执行队列中任意一个 Promise 完成
        log.debug(`[AsyncPool][${taskName}] A task finished. Continuing to add tasks.`);
      }
    }
  }
  log.debug(`[AsyncPool][${taskName}] All tasks added to pool. Waiting for all to settle.`);
  return Promise.allSettled(ret); // 等待所有任务完成并返回结果
}

module.exports = { asyncPool };