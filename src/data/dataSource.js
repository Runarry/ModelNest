const { parseLocalModels } = require('./modelParser');
const fs = require('fs');
const path = require('path');

// 数据源抽象与实现

class DataSource {
  constructor(config) {
    this.config = config;
  }
  async listModels() {
    throw new Error('listModels 未实现');
  }
  async readModelDetail(jsonPath) {
    throw new Error('readModelDetail 未实现');
  }
}

// 本地数据源实现
class LocalDataSource extends DataSource {
  constructor(config) {
    super(config);
  }
  async listModels() {
    // 支持多级目录，递归扫描所有模型目录
    const root = this.config.path;
    const supportedExtensions = this.config.supportedExtensions || [];
    if (!fs.existsSync(root)) return [];
    let allModels = [];
    const walk = (dir) => {
      const files = fs.readdirSync(dir, { withFileTypes: true });
      // 只处理文件夹和模型文件
      const modelObjs = parseLocalModels(dir, supportedExtensions);
      allModels = allModels.concat(modelObjs);
      files.forEach(f => {
        if (f.isDirectory()) {
          walk(path.join(dir, f.name));
        }
      });
    };
    walk(root);
    return allModels;
  }
  async readModelDetail(jsonPath) {
    if (!jsonPath || !fs.existsSync(jsonPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    } catch (e) {
      return {};
    }
  }
}

module.exports = {
  DataSource,
  LocalDataSource
};