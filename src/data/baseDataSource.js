class DataSource {
  constructor(config) {
    this.config = config;
  }

  /**
   * 列出指定目录下的模型对象。
   * @param {string|null} directory - 要列出模型的子目录（相对于源根目录），如果为 null 则列出根目录。
   * @param {string[]} supportedExts - 支持的模型文件扩展名数组 (e.g., ['.safetensors', '.ckpt']).
   * @returns {Promise<Array<object>>} 模型对象数组。
   * @throws {Error} 如果子类未实现此方法。
   */
  async listModels(directory = null, supportedExts = []) {
    throw new Error(`'listModels' method must be implemented by subclass. Received directory: ${directory}, supportedExts: ${supportedExts}`);
  }

  /**
   * 读取并解析指定路径的模型详情 JSON 文件。
   * @param {string} jsonPath - 模型 JSON 文件的完整路径。
   * @returns {Promise<object>} 模型详情对象。
   * @throws {Error} 如果子类未实现此方法。
   */
  async readModelDetail(jsonPath) {
    throw new Error(`'readModelDetail' method must be implemented by subclass. Received jsonPath: ${jsonPath}`);
  }

  /**
   * 列出数据源根目录下的子目录名称。
   * @returns {Promise<Array<string>>} 子目录名称数组。
   * @throws {Error} 如果子类未实现此方法。
   */
  async listSubdirectories() {
    throw new Error("'listSubdirectories' method must be implemented by subclass.");
  }

  /**
   * 获取指定路径的图片数据。
   * @param {string} imagePath - 图片文件的完整路径。
   * @returns {Promise<object|null>} 包含 { path, data, mimeType } 的对象，如果找不到或出错则返回 null。
   * @throws {Error} 如果子类未实现此方法。
   */
  async getImageData(imagePath) {
    throw new Error(`'getImageData' method must be implemented by subclass. Received imagePath: ${imagePath}`);
  }

  /**
   * 将 JSON 字符串写入指定的文件路径。
   * @param {string} filePath - 要写入的文件的完整路径。
   * @param {string} dataToWrite - 要写入的 JSON 字符串数据。
   * @returns {Promise<void>} 操作完成时解析的 Promise。
   * @throws {Error} 如果子类未实现此方法或写入失败。
   */
  async writeModelJson(filePath, dataToWrite) {
    throw new Error(`'writeModelJson' method must be implemented by subclass. Received filePath: ${filePath}, dataToWrite length: ${dataToWrite?.length}`);
  }
}

module.exports = DataSource;