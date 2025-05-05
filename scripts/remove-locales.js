const fs = require('fs');
const path = require('path');

// 删除除了中文和英文外的pak来减少包体大小，暂时不支持这些语言。
module.exports = async ({ appOutDir }) => {
    const localesDir = path.join(appOutDir, 'locales');
    const keepLocales = ['en-US.pak', 'zh-CN.pak']; // 保留的语言
    fs.readdirSync(localesDir).forEach(file => {
        if (!keepLocales.includes(file)) {
            fs.unlinkSync(path.join(localesDir, file));
        }
    });
};