const { parseLocalModels } = require('./modelParser');
const fs = require('fs');
const path = require('path');

// 数据源抽象与实现

class DataSource {
  constructor(config) {
    this.config = config;
  }
  async listModels(directory = null) { // 添加 directory 参数
    throw new Error('listModels 未实现');
  }
  async readModelDetail(jsonPath) {
    throw new Error('readModelDetail 未实现');
  }
  async listSubdirectories() { // 添加 listSubdirectories 接口
    throw new Error('listSubdirectories 未实现');
  }
}

// 本地数据源实现
class LocalDataSource extends DataSource {
  constructor(config) {
    super(config);
  }
  async listSubdirectories() {
    const root = this.config.path;
    if (!fs.existsSync(root)) return [];
    try {
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch (error) {
      console.error(`[LocalDataSource] Error reading subdirectories in ${root}:`, error);
      return [];
    }
  }

  async listModels(directory = null) { // 添加 directory 参数
    const root = this.config.path;
    const startPath = directory ? path.join(root, directory) : root; // 确定起始路径
    const supportedExtensions = this.config.supportedExtensions || [];

    if (!fs.existsSync(startPath)) { // 检查起始路径是否存在
      console.warn(`[LocalDataSource] Directory not found: ${startPath}`);
      return [];
    }

    let allModels = [];
    const walk = (dir) => {
      try { // 添加 try-catch 块以处理可能的权限错误等
        const files = fs.readdirSync(dir, { withFileTypes: true });
        // 只处理文件夹和模型文件
        const modelObjs = parseLocalModels(dir, supportedExtensions);
        allModels = allModels.concat(modelObjs);
        files.forEach(f => {
          if (f.isDirectory()) {
            walk(path.join(dir, f.name));
          }
        });
      } catch (error) {
        console.error(`[LocalDataSource] Error walking directory ${dir}:`, error);
        // 可以选择继续或抛出错误，这里选择记录错误并继续
      }
    };

    walk(startPath); // 从 startPath 开始扫描
    return allModels;
  }
  async readModelDetail(jsonPath) {
    if (!jsonPath || !fs.existsSync(jsonPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    } catch (e) {
      console.error(`[LocalDataSource] Error reading model detail ${jsonPath}:`, e); // 添加错误日志
      return {};
    }
  }
}

module.exports = {
  DataSource,
  LocalDataSource
};