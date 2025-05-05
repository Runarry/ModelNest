const ConfigService = require('./configService');
const DataSourceService = require('./dataSourceService');
const ModelService = require('./modelService');
const ImageService = require('./imageService');
const UpdateService = require('./updateService');
const ModelCrawlerService = require('./modelCrawlerService'); // Import the new service

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

  // 3. Initialize ModelService, injecting DataSourceService
  const modelService = new ModelService(dataSourceService);

  // 4. Initialize ImageService, injecting DataSourceService
  const imageService = new ImageService(dataSourceService);

  // 5. Initialize UpdateService
  const updateService = new UpdateService();
  updateService.initialize(); // Does not need to be awaited currently

  // 6. Initialize ModelCrawlerService, injecting DataSourceService
  const modelCrawlerService = new ModelCrawlerService(dataSourceService);

  // Return all service instances
  return {
    configService,
    dataSourceService,
    modelService,
    imageService,
    updateService,
    modelCrawlerService, // Add the new service instance
  };
}

module.exports = {
  initializeServices,
};
