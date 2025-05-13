const log = require('electron-log');
const path = require('path');
const { getCivitaiModelInfoWithTagsAndVersions, calcFileHash } = require('../utils/civitai-model-info-crawler');
const { downloadAndSaveImage } = require('../utils/imageDownloader');
const { LocalDataSource } = require('../data/localDataSource'); // Import LocalDataSource for type checking
const { CRAWL_STATUS } = require('../common/constants'); // Assuming constants for status



class ModelCrawlerService {
  constructor(dataSourceService) {
    this.dataSourceService = dataSourceService;
    this.status = CRAWL_STATUS.IDLE;
    this.progress = {
      total: 0,
      completed: 0,
      currentModelName: null,
      errorMessage: null,
    };
    this.taskQueue = [];
    this.currentTask = null; // Holds { sourceId, directory, dataSource, isPaused, isCanceled }
    this.isProcessing = false; // Flag to prevent concurrent _processQueue runs
    this.rateLimitDelay = 1000; // ms delay between Civitai API calls
    this.supportedImageExts = ['.png', '.jpg', '.jpeg', '.webp']; // Common image extensions
    log.info('[Service:ModelCrawler] ModelCrawlerService initialized');
    this.mainWindow = null; // Reference to the main browser window
  }

  /**
   * Sets the main window instance for IPC communication.
   * @param {import('electron').BrowserWindow} mainWindow The main window instance.
   */
  setMainWindow(mainWindow) {
    this.mainWindow = mainWindow;
    log.info('[Service:ModelCrawler] Main window instance set.');
  }

  _updateStatus(newStatus, errorMessage = null) {
    this.status = newStatus;
    this.progress.errorMessage = errorMessage;
    log.info(`[Service:ModelCrawler] Status updated: ${this.status}`, this.progress);
    // TODO: Implement IPC emission here in the next step
    // this._emitStatusUpdate();
  }

  _emitStatusUpdate() {
    const statusPayload = this.getCrawlingStatus(); // Use the getter for consistent data
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.webContents.send('crawl-status-update', statusPayload);
        log.debug('[Service:ModelCrawler] Emitted crawl-status-update via IPC:', statusPayload);
      } catch (error) {
        log.error('[Service:ModelCrawler] Failed to send crawl-status-update via IPC:', error);
      }
    } else {
      log.warn('[Service:ModelCrawler] Cannot emit status update: mainWindow is not available or destroyed.');
      // Optional: Log the status locally if IPC fails
      // log.debug('[Service:ModelCrawler] Current status (not emitted):', statusPayload);
    }
  }

  async startCrawling(sourceId, directory) {
    // --- 添加日志：打印传入参数 ---
    log.info(`[Service:ModelCrawler] startCrawling method entered. SourceID: "${sourceId}", Directory: "${directory}"`);
    // --- 结束日志 ---

    if (this.isProcessing || [CRAWL_STATUS.SCANNING, CRAWL_STATUS.RUNNING, CRAWL_STATUS.PAUSED].includes(this.status)) {
      log.warn(`[Service:ModelCrawler] Crawling task already in progress or starting. Status: ${this.status}`);
      return false;
    }

    // Reset state
    this.taskQueue = [];
    this.progress = { total: 0, completed: 0, currentModelName: null, errorMessage: null };
    this.currentTask = {
      sourceId,
      directory,
      dataSource: null,
      isPaused: false,
      isCanceled: false,
    };

    this._updateStatus(CRAWL_STATUS.SCANNING);
    this._emitStatusUpdate(); // Emit scanning status

    try {
      const sourceConfig = await this.dataSourceService.getSourceConfig(sourceId); // 注意：getSourceConfig 是异步的，需要 await
      // --- 添加日志：打印获取到的 sourceConfig ---
      log.debug(`[Service:ModelCrawler] Result from getSourceConfig for ID "${sourceId}": ${JSON.stringify(sourceConfig, null, 2)}`);
      // --- 结束日志 ---
      if (!sourceConfig) {
        // 保持原有错误处理，但日志已在 dataSourceService 中记录
        throw new Error(`Data source config not found for ID: ${sourceId}`);
      }
      // 移除这里的冗余错误日志，因为它会在 sourceConfig 存在时错误地打印 "not found"
      // log.error(`[Service:ModelCrawler] Source config not found for ID: ${sourceId} Config: ${JSON.stringify(sourceConfig)}`);
    

      // Convert type to uppercase for case-insensitive comparison
      if (sourceConfig.type?.toUpperCase() !== 'LOCAL') {
        throw new Error(`Model crawling is only supported for LOCAL data sources. Type was: ${sourceConfig.type}`);
      }
      if (sourceConfig.readOnly) {
         throw new Error(`Cannot crawl a read-only data source.`);
      }

      // Get DataSource instance using the interface/factory (assuming it exists)
      // We need the actual instance to call fileExists, writeFile etc.
      // Let's assume dataSourceService can provide the instance or we use the interface directly
      // For now, directly instantiate LocalDataSource for simplicity, but ideally use the factory
      this.currentTask.dataSource = new LocalDataSource(sourceConfig); // TODO: Replace with factory/interface call if available

      if (!(this.currentTask.dataSource instanceof LocalDataSource)) {
         throw new Error(`Crawling requires a LocalDataSource instance.`); // Should not happen with type check above
      }


      log.info(`[Service:ModelCrawler] Scanning directory: ${this.currentTask.dataSource.config.path} / ${directory || ''}`);
      const supportedModelExts = await this.dataSourceService.getSupportedExtensions(); // <-- 添加 await
      log.debug(`[Service:ModelCrawler] Supported extensions loaded: ${JSON.stringify(supportedModelExts)}`); // 添加日志确认
      const models = await this.currentTask.dataSource.listModels(directory, supportedModelExts);
      log.info(`[Service:ModelCrawler] Found ${models.length} potential models.`);

      for (const model of models) {
         if (this.currentTask.isCanceled) break; // Check for cancellation during scan

         const modelPath = model.file; // Corrected: Use 'file' property instead of 'filePath'
         const modelName = model.name; // Assuming model object has name

         // Add a check for modelPath before using it
         if (!modelPath || typeof modelPath !== 'string') {
             log.error(`[Service:ModelCrawler] Skipping model due to invalid path: ${modelPath} for model object:`, model);
             continue; // Skip this iteration if path is invalid
         }

         const dirName = path.dirname(modelPath);
         const baseName = path.basename(modelPath, path.extname(modelPath));
         const jsonPath = path.join(dirName, `${baseName}.json`);

         let jsonExists = false;
         let imageExists = false;

         try {
            jsonExists = await this.currentTask.dataSource.fileExists(jsonPath);

            for (const ext of this.supportedImageExts) {
                const imagePath = path.join(dirName, `${baseName}${ext}`);
                if (await this.currentTask.dataSource.fileExists(imagePath)) {
                    imageExists = true;
                    break; // Found one image, no need to check others
                }
            }
         } catch (checkError) {
             log.error(`[Service:ModelCrawler] Error checking files for model ${modelName}:`, checkError);
             // Decide if we should skip this model or try anyway
             // Let's skip if checking fails critically
             continue;
         }


         if (!jsonExists || !imageExists) {
           log.debug(`[Service:ModelCrawler] Queuing model: ${modelName} (JSON: ${jsonExists}, Image: ${imageExists})`);
           this.taskQueue.push({ modelPath, modelName, baseName, dirName, needsJson: !jsonExists, needsImage: !imageExists });
         }
      }

      if (this.currentTask.isCanceled) {
         log.info('[Service:ModelCrawler] Scan canceled.');
         this._updateStatus(CRAWL_STATUS.CANCELED);
         this._emitStatusUpdate();
         return false;
      }

      this.progress.total = this.taskQueue.length;
      log.info(`[Service:ModelCrawler] Scan complete. ${this.progress.total} models queued for processing.`);

      if (this.progress.total === 0) {
        this._updateStatus(CRAWL_STATUS.FINISHED);
        log.info('[Service:ModelCrawler] No models need processing. Task finished.');
      } else {
        this._updateStatus(CRAWL_STATUS.RUNNING);
        this.isProcessing = true;
        this._processQueue(); // Start processing
      }
      this._emitStatusUpdate(); // Emit final scan/initial run status
      return true;

    } catch (error) {
      log.error('[Service:ModelCrawler] Error during scanning phase:', error);
      this._updateStatus(CRAWL_STATUS.ERROR, error.message);
      this._emitStatusUpdate();
      this.currentTask = null; // Clear task info on error
      return false;
    }
  }

  pauseCrawling() {
    if (this.currentTask && this.status === CRAWL_STATUS.RUNNING) {
      this.currentTask.isPaused = true;
      this._updateStatus(CRAWL_STATUS.PAUSED);
      this._emitStatusUpdate();
      log.info('[Service:ModelCrawler] Crawling paused.');
    } else {
      log.warn(`[Service:ModelCrawler] Cannot pause. Status: ${this.status}`);
    }
  }

  resumeCrawling() {
    if (this.currentTask && this.status === CRAWL_STATUS.PAUSED) {
      this.currentTask.isPaused = false;
      this._updateStatus(CRAWL_STATUS.RUNNING);
      this._emitStatusUpdate();
      log.info('[Service:ModelCrawler] Crawling resumed.');
      // If _processQueue stopped due to pause, restart it
      if (this.isProcessing) { // Check if it was processing before pause
          this._processQueue();
      }
    } else {
      log.warn(`[Service:ModelCrawler] Cannot resume. Status: ${this.status}`);
    }
  }

  cancelCrawling() {
    if (this.currentTask && ![CRAWL_STATUS.FINISHED, CRAWL_STATUS.ERROR, CRAWL_STATUS.CANCELED].includes(this.status)) {
      this.currentTask.isCanceled = true;
      this.taskQueue = []; // Clear remaining queue
      // The _processQueue loop will detect isCanceled and stop
      this._updateStatus(CRAWL_STATUS.CANCELED);
      this._emitStatusUpdate();
      log.info('[Service:ModelCrawler] Crawling canceled.');
    } else {
      log.warn(`[Service:ModelCrawler] Cannot cancel. Status: ${this.status}`);
    }
     // Reset processing flag if canceled
     this.isProcessing = false;
     this.currentTask = null;
  }

  getCrawlingStatus() {
    return { status: this.status, progress: this.progress };
  }

  async _processQueue() {
    if (!this.currentTask || !this.isProcessing) {
        log.warn('[Service:ModelCrawler] _processQueue called but no active task or not processing.');
        this.isProcessing = false; // Ensure flag is reset
        return;
    }

    while (this.taskQueue.length > 0) {
      if (this.currentTask.isCanceled) {
        log.info('[Service:ModelCrawler] Processing loop detected cancellation.');
        this._updateStatus(CRAWL_STATUS.CANCELED);
        this.isProcessing = false;
        this.currentTask = null;
        this._emitStatusUpdate();
        return;
      }

      if (this.currentTask.isPaused) {
        log.info('[Service:ModelCrawler] Processing loop paused.');
        // Don't set isProcessing = false here, just wait
        // Use a promise-based delay to avoid busy-waiting
        await new Promise(resolve => setTimeout(resolve, 500)); // Check pause status every 500ms
        continue; // Re-check pause/cancel status in the next loop iteration
      }

      const taskItem = this.taskQueue.shift(); // Get next item
      this.progress.currentModelName = taskItem.modelName;
      log.info(`[Service:ModelCrawler] Processing model (${this.progress.completed + 1}/${this.progress.total}): ${taskItem.modelName}`);
      this._emitStatusUpdate(); // Update UI with current model name

      let modelInfo = null;
      try {
        // --- Calculate Hash (Optional but recommended for efficiency) ---
        let modelHash = null;
        try {
            modelHash = await calcFileHash(taskItem.modelPath);
            log.debug(`[Service:ModelCrawler] Calculated hash for ${taskItem.modelName}: ${modelHash}`);
        } catch (hashError) {
            log.error(`[Service:ModelCrawler] Failed to calculate hash for ${taskItem.modelName} at path ${taskItem.modelPath}:`, hashError);
            // Continue without pre-calculated hash, let the crawler handle it internally if needed
        }

        // --- Call Civitai Crawler (passing optional hash) ---
        log.debug(`[Service:ModelCrawler] Calling Civitai crawler for path: ${taskItem.modelPath} with hash: ${modelHash || 'N/A'}`);
        // Pass path and optional pre-calculated hash
        modelInfo = await getCivitaiModelInfoWithTagsAndVersions(taskItem.modelPath, modelHash);

        if (modelInfo) {
          log.info(`[Service:ModelCrawler] Civitai info found for: ${taskItem.modelName} (Hash: ${modelHash || 'calculated internally'})`);

          // --- Save JSON if needed ---
          if (taskItem.needsJson) {
            const jsonPath = path.join(taskItem.dirName, `${taskItem.baseName}.json`);
            try {
              // IMPORTANT: Save the RAW modelInfo object as JSON string
              await this.currentTask.dataSource.writeModelJson(jsonPath, JSON.stringify(modelInfo, null, 2));
              log.info(`[Service:ModelCrawler] Saved JSON for: ${taskItem.modelName} to ${jsonPath}`);
            } catch (writeError) {
              log.error(`[Service:ModelCrawler] Failed to write JSON for ${taskItem.modelName}:`, writeError);
              // Continue to image download even if JSON fails? Yes, according to design.
            }
          } else {
             log.debug(`[Service:ModelCrawler] JSON already exists for: ${taskItem.modelName}`);
          }

          // --- Download and Save Image if needed ---
          if (taskItem.needsImage && modelInfo.images && modelInfo.images.length > 0) {
             // Try downloading the first image
             // TODO: Potentially allow choosing which image or finding the best one
             const imageUrl = modelInfo.images[0].url; // Assuming structure based on typical Civitai responses
             const targetPathWithoutExtension = path.join(taskItem.dirName, taskItem.baseName);
             log.debug(`[Service:ModelCrawler] Attempting image download for ${taskItem.modelName} from ${imageUrl}`);
             try {
                const savedImagePath = await downloadAndSaveImage(imageUrl, targetPathWithoutExtension, this.currentTask.dataSource);
                if (savedImagePath) {
                    log.info(`[Service:ModelCrawler] Saved image for: ${taskItem.modelName} to ${savedImagePath}`);
                } else {
                    log.warn(`[Service:ModelCrawler] Failed to download or save image for ${taskItem.modelName} from ${imageUrl}`);
                }
             } catch (downloadError) {
                 log.error(`[Service:ModelCrawler] Error during image download/save for ${taskItem.modelName}:`, downloadError);
             }
          } else if (taskItem.needsImage) {
             log.warn(`[Service:ModelCrawler] Image needed for ${taskItem.modelName}, but no image URL found in Civitai info.`);
          } else {
             log.debug(`[Service:ModelCrawler] Image already exists for: ${taskItem.modelName}`);
          }

        } else {
          log.warn(`[Service:ModelCrawler] Civitai info not found for: ${taskItem.modelName} (Path: ${taskItem.modelPath})`);
        }

      } catch (crawlError) {
        log.error(`[Service:ModelCrawler] Error crawling Civitai for ${taskItem.modelName}:`, crawlError);
        // Don't stop the queue, just log and continue
      }

      this.progress.completed++;
      this.progress.currentModelName = null; // Clear current model after processing
      this._emitStatusUpdate(); // Update progress

      // --- Rate Limiting Delay ---
      if (this.taskQueue.length > 0) { // Only delay if there are more items
          log.debug(`[Service:ModelCrawler] Applying rate limit delay: ${this.rateLimitDelay}ms`);
          await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay));
      }
    } // End while loop

    // Queue is empty
    if (!this.currentTask.isCanceled) {
        this._updateStatus(CRAWL_STATUS.FINISHED);
        log.info('[Service:ModelCrawler] Task queue processed successfully.');
    } else {
        // If canceled during the last item processing, status might still be RUNNING
        this._updateStatus(CRAWL_STATUS.CANCELED);
        log.info('[Service:ModelCrawler] Task queue processing stopped due to cancellation.');
    }

    this.isProcessing = false;
    this.currentTask = null; // Clear task info when finished/canceled
    this._emitStatusUpdate(); // Emit final status
  }
}

module.exports = ModelCrawlerService;