const getCivitaiModelInfoWithTagsAndVersions = require("../utils/civitai-model-info-crawler")

class ModelCrawlerService{
    #sourceConfig
    

    constructor(sourceConfig){
        if(!sourceConfig){
            throw new Error('ModelCrawlerService required  a SourceConfig.')
        }
        this.#sourceConfig = sourceConfig;
    }


}

module.exports = ModelCrawlerService;