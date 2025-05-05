// babel.config.js
module.exports = {
  presets: [
    [
      '@babel/preset-env',
      {
        targets: {
          // 目标环境设置为项目当前使用的 Electron 主要版本 (36)
          electron: '36'
        },
        useBuiltIns: 'usage', // 按需引入 polyfill
        corejs: 3 // 指定 core-js 版本 (已安装)
      }
    ]
  ]
};