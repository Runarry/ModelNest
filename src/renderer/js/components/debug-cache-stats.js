/**
 * 图片缓存统计调试面板
 * 显示缓存命中率、节省空间等统计信息
 */

import { getCacheStats, logMessage } from '../apiBridge.js';

class DebugCacheStats {
  constructor() {
    this.container = null;
    this.isVisible = false;
    this.updateInterval = null;
    this.lastUpdateTime = 0;
  }

  /**
   * 创建缓存统计面板
   * @returns {HTMLElement} 面板容器
   */
  createPanel() {
    const panel = document.createElement('div');
    panel.className = 'debug-cache-stats';
    panel.style.cssText = `
      position: fixed;
      bottom: 10px;
      right: 10px;
      width: 300px;
      max-height: 400px;
      background-color: rgba(0, 0, 0, 0.8);
      color: #fff;
      border-radius: 5px;
      padding: 10px;
      font-family: monospace;
      font-size: 12px;
      z-index: 9999;
      overflow-y: auto;
      display: none;
      box-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
    `;

    // 标题和关闭按钮
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      border-bottom: 1px solid #555;
      padding-bottom: 5px;
    `;
    
    const title = document.createElement('h3');
    title.textContent = '图片缓存统计';
    title.style.margin = '0';
    
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = `
      background: none;
      border: none;
      color: #fff;
      font-size: 16px;
      cursor: pointer;
      padding: 0 5px;
    `;
    closeBtn.onclick = () => this.hide();
    
    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // 统计数据容器
    const statsContainer = document.createElement('div');
    statsContainer.id = 'cacheStatsContent';
    panel.appendChild(statsContainer);

    // 底部操作按钮
    const footer = document.createElement('div');
    footer.style.cssText = `
      display: flex;
      justify-content: space-between;
      margin-top: 10px;
      border-top: 1px solid #555;
      padding-top: 5px;
    `;
    
    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = '刷新';
    refreshBtn.style.cssText = `
      background: #444;
      border: none;
      color: #fff;
      padding: 5px 10px;
      border-radius: 3px;
      cursor: pointer;
    `;
    refreshBtn.onclick = () => this.updateStats();
    
    const clearCacheBtn = document.createElement('button');
    clearCacheBtn.textContent = '清除缓存';
    clearCacheBtn.style.cssText = `
      background: #833;
      border: none;
      color: #fff;
      padding: 5px 10px;
      border-radius: 3px;
      cursor: pointer;
    `;
    clearCacheBtn.onclick = () => this.clearCache();
    
    footer.appendChild(refreshBtn);
    footer.appendChild(clearCacheBtn);
    panel.appendChild(footer);

    document.body.appendChild(panel);
    this.container = panel;
    return panel;
  }

  /**
   * 显示缓存统计面板
   */
  show() {
    if (!this.container) {
      this.createPanel();
    }
    
    this.container.style.display = 'block';
    this.isVisible = true;
    this.updateStats();
    
    // 设置每30秒自动更新一次
    this.updateInterval = setInterval(() => {
      this.updateStats();
    }, 30000);
  }

  /**
   * 隐藏缓存统计面板
   */
  hide() {
    if (this.container) {
      this.container.style.display = 'none';
    }
    
    this.isVisible = false;
    
    // 清除自动更新
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * 切换面板显示状态
   */
  toggle() {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * 更新缓存统计信息
   */
  async updateStats() {
    if (!this.isVisible) return;
    
    const statsContainer = document.getElementById('cacheStatsContent');
    if (!statsContainer) return;
    
    try {
      // 显示加载中
      statsContainer.innerHTML = '<p>正在加载统计信息...</p>';
      
      // 获取统计数据
      const stats = await getCacheStats();
      this.lastUpdateTime = Date.now();
      
      // 未获取到统计数据
      if (!stats) {
        statsContainer.innerHTML = '<p class="error">无法获取缓存统计</p>';
        return;
      }
      
      // 格式化缓存大小
      const formatSize = (bytes) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
      };
      
      // 构建HTML
      let html = `
        <div class="stat-grid">
          <div class="stat-item">
            <div class="stat-label">请求总数</div>
            <div class="stat-value">${stats.totalRequests || 0}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">缓存命中</div>
            <div class="stat-value">${stats.cacheHits || 0}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">命中率</div>
            <div class="stat-value">${stats.cacheHitRate || '0%'}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">当前缓存大小</div>
            <div class="stat-value">${formatSize(stats.currentCacheSize || 0)}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">原始大小</div>
            <div class="stat-value">${formatSize(stats.originalSize || 0)}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">压缩后大小</div>
            <div class="stat-value">${formatSize(stats.compressedSize || 0)}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">节省空间</div>
            <div class="stat-value">${stats.spaceSaved || '0%'}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">最后清理时间</div>
            <div class="stat-value">${stats.lastCleanTime ? new Date(stats.lastCleanTime).toLocaleString() : '无'}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">缓存限制</div>
            <div class="stat-value">${stats.maxCacheSizeMB ? stats.maxCacheSizeMB + ' MB' : '未知'}</div>
          </div>
        </div>
        <div class="stat-update-time">
          更新时间: ${new Date().toLocaleTimeString()}
        </div>
      `;
      
      // 添加样式
      html += `
        <style>
          .stat-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            grid-gap: 8px;
          }
          .stat-item {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 3px;
            padding: 8px;
          }
          .stat-label {
            opacity: 0.7;
            font-size: 10px;
            margin-bottom: 3px;
          }
          .stat-value {
            font-weight: bold;
            font-size: 14px;
          }
          .stat-update-time {
            text-align: right;
            font-size: 10px;
            opacity: 0.5;
            margin-top: 10px;
          }
          .error {
            color: #ff6b6b;
          }
        </style>
      `;
      
      statsContainer.innerHTML = html;
    } catch (error) {
      logMessage('error', '获取缓存统计失败:', error);
      statsContainer.innerHTML = `<p class="error">更新统计信息失败: ${error.message}</p>`;
    }
  }

  /**
   * 清除缓存
   */
  async clearCache() {
    if (!confirm('确定要清空图片缓存吗？此操作不可撤销。')) {
      return;
    }
    
    try {
      // 调用API清除缓存
      const statsContainer = document.getElementById('cacheStatsContent');
      statsContainer.innerHTML = '<p>正在清除缓存...</p>';
      
      await window.electronAPI.clearImageCache();
      logMessage('info', '图片缓存已清除');
      
      // 刷新统计信息
      setTimeout(() => this.updateStats(), 500);
    } catch (error) {
      logMessage('error', '清除缓存失败:', error);
      alert(`清除缓存失败: ${error.message}`);
    }
  }
}

// 创建单例实例
const debugCacheStats = new DebugCacheStats();

// 添加快捷键: Ctrl+Shift+C
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'C') {
    debugCacheStats.toggle();
  }
});

export default debugCacheStats; 