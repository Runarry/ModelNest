const ConfigService = require('./configService');
const DataSourceService = require('./dataSourceService');
const ModelService = require('./modelService');
const ImageService = require('./imageService');
const UpdateService = require('./updateService');
const ModelCrawlerService = require('./modelCrawlerService'); // Import the new service
const { ModelInfoCacheService } = require('./modelInfoCacheService'); // Import the new cache service
const { DataSourceInterface } = require('../data/dataSourceInterface'); // Import DataSourceInterface

/**
 * Initializes all application services and handles dependency injection.
 * @returns {Promise<object>} A promise that resolves to an object containing all initialized service instances.
 */
async function initializeServices() {
  // 1. Initialize ConfigService first as others might depend on it
  const configService = new ConfigService();
  await configService.initialize(); // Wait for config to be loaded

  // 2. Initialize DataSourceService, injecting ConfigService
  const dataSourceService = new DataSourceService({ configService });

  // 3. Initialize ModelInfoCacheService, injecting ConfigService
  const modelInfoCacheService = new ModelInfoCacheService(configService);
  await modelInfoCacheService.initialize(); // Initialize cache service

  // 3.5 Initialize DataSourceInterface with required services
  const dataSourceInterface = new DataSourceInterface(configService, modelInfoCacheService);

  // 4. Initialize ModelService, injecting DataSourceService, ModelInfoCacheService, ConfigService, and DataSourceInterface
  const modelService = new ModelService(dataSourceService, modelInfoCacheService, configService, dataSourceInterface);

  // 5. Initialize ImageService, injecting DataSourceService, ConfigService, and DataSourceInterface
  const imageService = new ImageService(dataSourceService, configService, dataSourceInterface);

  // 6. Initialize UpdateService
  const updateService = new UpdateService();
  updateService.initialize(); // Does not need to be awaited currently

  // 7. Initialize ModelCrawlerService, injecting DataSourceService
  const modelCrawlerService = new ModelCrawlerService(dataSourceService);

  // Return all service instances
  return {
    configService,
    dataSourceService,
    modelService,
    imageService,
    updateService,
    modelCrawlerService, // Add the new service instance
    modelInfoCacheService, // Add the new cache service instance
    dataSourceInterface, // Export dataSourceInterface instance
  };
}

module.exports = {
  initializeServices,
};
