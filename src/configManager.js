// src/configManager.js

let currentConfig = {}; // 初始化为空对象，或根据需要设为 null

/**
 * 设置全局配置对象。
 * @param {object} newConfig - 新的配置对象。
 */
function setConfig(newConfig) {
  currentConfig = newConfig;
  //console.log('Config updated in configManager:', currentConfig); // 添加日志以便调试
}

/**
 * 获取当前的全局配置对象。
 * @returns {object} 当前的配置对象。
 */
function getConfig() {
  // console.log('Config requested from configManager:', currentConfig); // 可选：添加日志以便调试
  return currentConfig;
}

module.exports = {
  setConfig,
  getConfig,
};