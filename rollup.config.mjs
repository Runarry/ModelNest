// rollup.config.mjs
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import babel from '@rollup/plugin-babel';
import terser from '@rollup/plugin-terser';
import path from 'path'; // Node.js path module

// 检查是否为生产环境构建
const isProduction = process.env.NODE_ENV === 'production';

export default {
  // 输入配置
  input: 'src/renderer/main.js', // 渲染进程的入口 JS 文件

  // 输出配置
  output: {
    file: 'dist/renderer/bundle.js', // 打包后的输出文件路径
    format: 'iife', // 输出格式：立即执行函数表达式，适合 <script> 标签直接引入
    sourcemap: !isProduction, // 开发环境下生成 sourcemap 以方便调试
    name: 'ModelNestRenderer' // 可选：为 IIFE 包指定一个全局变量名 (主要用于调试)
  },

  // 插件配置
  plugins: [
    // 解析 node_modules 中的模块
    resolve({
      browser: true // 优先使用 package.json 中的 'browser' 字段
    }),

    // 将 CommonJS 模块转换为 ES6
    commonjs(),

    // 使用 Babel 进行代码转译
    babel({
      babelHelpers: 'bundled', // 将 Babel 的辅助函数打包进最终文件，避免额外依赖
      exclude: 'node_modules/**' // 排除 node_modules 目录，通常第三方库已转译
    }),

    // 仅在生产环境启用代码压缩
    isProduction && terser()
  ]

  // 外部依赖 (External Dependencies)
  // 如果渲染进程代码明确依赖了通过 preload 脚本暴露的 Electron 或 Node.js 模块，
  // 需要在这里将它们标记为 external，以防止 Rollup 尝试打包它们。
  // 例如: external: ['electron']
  // 根据之前的分析，渲染进程主要通过 window.api 与主进程交互，
  // 似乎没有直接导入 electron 或 node 模块，所以暂时留空。
  // external: []
};