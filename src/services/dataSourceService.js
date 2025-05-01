const log = require('electron-log'); // 引入 log 模块，根据文档要求

/**
 * @typedef {import('../types').SourceConfig} SourceConfig
 * @typedef {import('./configService')} ConfigService
 */

/**
 * 服务：管理数据源配置信息。
 * 提供统一的接口来访问和管理模型数据源的配置。
 */
class DataSourceService {
  /** @type {ConfigService} */
  #configService;

  /**
   * 创建 DataSourceService 实例。
   * @param {object} dependencies - 依赖项。
   * @param {ConfigService} dependencies.configService - ConfigService 实例。
   */
  constructor({ configService }) {
    if (!configService) {
      throw new Error('DataSourceService requires a ConfigService instance.');
    }
    this.#configService = configService;
    log.info('DataSourceService initialized.');
  }

  /**
   * 根据 sourceId 获取单个数据源配置。
   * @param {string} sourceId - 数据源的唯一标识符。
   * @returns {Promise<SourceConfig | null>} 返回找到的数据源配置对象，如果未找到则返回 null。
   */
  async getSourceConfig(sourceId) {
    try {
      const config = await this.#configService.getConfig();
      const sourceConfig = config.modelSources?.find(source => source.id === sourceId);
      if (!sourceConfig) {
        log.warn(`DataSourceService: Source config with id "${sourceId}" not found.`);
        return null;
      }
      return sourceConfig;
    } catch (error) {
      log.error(`DataSourceService: Error getting source config for id "${sourceId}":`, error);
      return null; // 或者抛出错误，取决于错误处理策略
    }
  }

  /**
   * 获取所有数据源的配置。
   * @returns {Promise<SourceConfig[]>} 返回包含所有数据源配置对象的数组。如果配置不存在或为空，则返回空数组。
   */
  async getAllSourceConfigs() {
    try {
      const config = await this.#configService.getConfig();
      return config.modelSources || [];
    } catch (error) {
      log.error('DataSourceService: Error getting all source configs:', error);
      return []; // 返回空数组表示没有可用的配置或发生错误
    }
  }

  /**
   * 获取支持的模型文件扩展名列表。
   * @returns {Promise<string[]>} 返回支持的文件扩展名数组。如果配置不存在或为空，则返回空数组。
   */
  async getSupportedExtensions() {
    try {
      const config = await this.#configService.getConfig();
      return config.supportedExtensions || [];
    } catch (error) {
      log.error('DataSourceService: Error getting supported extensions:', error);
      return []; // 返回空数组表示没有可用的配置或发生错误
    }
  }
}

module.exports = DataSourceService;