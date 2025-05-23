/**
 * 图片缓存统计调试面板
 * 显示缓存命中率、节省空间等统计信息
 */

import { getCacheStats, logMessage } from '../apiBridge.js';
import { migrateImageCache, migrateModelCache, cleanupUserData } from '../apiBridge.js';
import { BlobUrlCache } from '../core/blobUrlCache.js';

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
    title.textContent = '缓存统计';
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

    // Blob URL 统计数据容器
    const blobStatsContainer = document.createElement('div');
    blobStatsContainer.id = 'blobUrlStatsContent';
    panel.appendChild(blobStatsContainer);

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
    
    // 添加缓存迁移按钮容器
    const migrationContainer = document.createElement('div');
    migrationContainer.style.cssText = `
      width: 100%;
      margin-top: 5px;
      display: flex;
      justify-content: space-between;
    `;
    
    // 图片缓存迁移按钮
    const migrateImgCacheBtn = document.createElement('button');
    migrateImgCacheBtn.textContent = '迁移图片缓存';
    migrateImgCacheBtn.style.cssText = `
      background: #474;
      border: none;
      color: #fff;
      padding: 5px 8px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
    `;
    migrateImgCacheBtn.onclick = () => this.migrateImageCache();
    
    // 模型缓存迁移按钮
    const migrateModelCacheBtn = document.createElement('button');
    migrateModelCacheBtn.textContent = '迁移模型缓存';
    migrateModelCacheBtn.style.cssText = `
      background: #447;
      border: none;
      color: #fff;
      padding: 5px 8px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
    `;
    migrateModelCacheBtn.onclick = () => this.migrateModelCache();
    
    // 添加清理用户数据按钮
    const cleanupContainer = document.createElement('div');
    cleanupContainer.style.cssText = `
      width: 100%;
      margin-top: 5px;
      display: flex;
      justify-content: space-between;
    `;
    
    const cleanupCacheBtn = document.createElement('button');
    cleanupCacheBtn.textContent = '清理缓存目录';
    cleanupCacheBtn.style.cssText = `
      background: #853;
      border: none;
      color: #fff;
      padding: 5px 8px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
    `;
    cleanupCacheBtn.onclick = () => this.cleanupUserDataCache();
    
    const cleanupLogsBtn = document.createElement('button');
    cleanupLogsBtn.textContent = '清理日志目录';
    cleanupLogsBtn.style.cssText = `
      background: #835;
      border: none;
      color: #fff;
      padding: 5px 8px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
    `;
    cleanupLogsBtn.onclick = () => this.cleanupUserDataLogs();
    
    // 添加Blob URL清理按钮
    const clearBlobUrlsBtn = document.createElement('button');
    clearBlobUrlsBtn.textContent = '清理Blob URLs';
    clearBlobUrlsBtn.style.cssText = `
      background: #538;
      border: none;
      color: #fff;
      padding: 5px 8px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
    `;
    clearBlobUrlsBtn.onclick = () => this.clearBlobUrls();
    
    // 添加重置Blob URL统计按钮
    const resetBlobStatsBtn = document.createElement('button');
    resetBlobStatsBtn.textContent = '重置Blob统计';
    resetBlobStatsBtn.style.cssText = `
      background: #358;
      border: none;
      color: #fff;
      padding: 5px 8px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
    `;
    resetBlobStatsBtn.onclick = () => this.resetBlobStats();
    
    // 添加按钮到容器
    migrationContainer.appendChild(migrateImgCacheBtn);
    migrationContainer.appendChild(migrateModelCacheBtn);
    
    cleanupContainer.appendChild(cleanupCacheBtn);
    cleanupContainer.appendChild(cleanupLogsBtn);
    
    // 创建Blob URL按钮容器
    const blobUrlContainer = document.createElement('div');
    blobUrlContainer.style.cssText = `
      width: 100%;
      margin-top: 5px;
      display: flex;
      justify-content: space-between;
    `;
    
    blobUrlContainer.appendChild(clearBlobUrlsBtn);
    blobUrlContainer.appendChild(resetBlobStatsBtn);
    
    footer.appendChild(refreshBtn);
    footer.appendChild(clearCacheBtn);
    panel.appendChild(footer);
    
    // 添加迁移按钮容器
    panel.appendChild(migrationContainer);
    
    // 添加清理按钮容器
    panel.appendChild(cleanupContainer);
    
    // 添加Blob URL按钮容器
    panel.appendChild(blobUrlContainer);

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
    const blobStatsContainer = document.getElementById('blobUrlStatsContent');
    if (!statsContainer || !blobStatsContainer) return;
    
    try {
      // 显示加载中
      statsContainer.innerHTML = '<p>正在加载统计信息...</p>';
      blobStatsContainer.innerHTML = '';
      
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
        <h4 class="stat-section-title">磁盘缓存</h4>
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
      
      // 获取Blob URL缓存统计数据
      const blobStats = BlobUrlCache.getStats();
      
      if (blobStats) {
        const blobHtml = `
          <h4 class="stat-section-title">Blob URL 缓存</h4>
          <div class="stat-grid">
            <div class="stat-item">
              <div class="stat-label">当前活跃Blob</div>
              <div class="stat-value">${blobStats.currentActiveBlobs || 0}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">已创建总数</div>
              <div class="stat-value">${blobStats.totalCreated || 0}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">已释放总数</div>
              <div class="stat-value">${blobStats.totalReleased || 0}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">已撤销总数</div>
              <div class="stat-value">${blobStats.totalRevoked || 0}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">重用次数</div>
              <div class="stat-value">${blobStats.totalReused || 0}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">提前恢复</div>
              <div class="stat-value">${blobStats.totalEarlyReuse || 0}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">当前存储大小</div>
              <div class="stat-value">${formatSize(blobStats.totalBytesStored || 0)}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">节省大小</div>
              <div class="stat-value">${formatSize(blobStats.totalBytesSaved || 0)}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">请求合并次数</div>
              <div class="stat-value">${blobStats.totalPendingDeduped || 0}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">清理事件数</div>
              <div class="stat-value">${blobStats.cleanupEvents || 0}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">清理释放项</div>
              <div class="stat-value">${blobStats.cleanupItemsReleased || 0}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">最后清理时间</div>
              <div class="stat-value">${blobStats.lastCleanupTime ? new Date(blobStats.lastCleanupTime).toLocaleString() : '无'}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">待处理请求</div>
              <div class="stat-value">${blobStats.pendingRequestsCount || 0}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">缓存延迟(ms)</div>
              <div class="stat-value">${blobStats.revocationDelayMs || 0}</div>
            </div>
          </div>
          <div class="stat-update-time">
            统计重置于: ${blobStats.lastStatsResetTime ? new Date(blobStats.lastStatsResetTime).toLocaleString() : '未知'}
          </div>
        `;
        
        blobStatsContainer.innerHTML = blobHtml;
      } else {
        blobStatsContainer.innerHTML = '<p class="error">无法获取Blob URL缓存统计</p>';
      }
      
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
          .stat-section-title {
            margin: 12px 0 8px;
            font-size: 14px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.2);
            padding-bottom: 4px;
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
      blobStatsContainer.innerHTML = '';
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

  /**
   * 迁移图片缓存
   */
  async migrateImageCache() {
    try {
      const statsContainer = document.getElementById('cacheStatsContent');
      statsContainer.innerHTML = '<p>正在迁移图片缓存...</p>';
      
      await migrateImageCache();
      logMessage('info', '图片缓存迁移成功');
      
      // 刷新统计信息
      setTimeout(() => this.updateStats(), 500);
    } catch (error) {
      logMessage('error', '迁移图片缓存失败:', error);
      alert(`迁移图片缓存失败: ${error.message}`);
    }
  }

  /**
   * 迁移模型缓存
   */
  async migrateModelCache() {
    try {
      const statsContainer = document.getElementById('cacheStatsContent');
      statsContainer.innerHTML = '<p>正在迁移模型缓存...</p>';
      
      await migrateModelCache();
      logMessage('info', '模型缓存迁移成功');
      
      // 刷新统计信息
      setTimeout(() => this.updateStats(), 500);
    } catch (error) {
      logMessage('error', '迁移模型缓存失败:', error);
      alert(`迁移模型缓存失败: ${error.message}`);
    }
  }

  /**
   * 清理用户数据的缓存目录
   */
  async cleanupUserDataCache() {
    if (!confirm('确定要清理用户数据中的缓存目录吗？这将删除缓存的图片和模型信息。')) {
      return;
    }
    
    try {
      this.setStatusMessage('正在清理缓存目录...');
      const result = await cleanupUserData({ cleanCache: true, cleanLogs: false });
      
      if (result.success) {
        this.setStatusMessage('缓存目录清理成功！');
      } else {
        this.setStatusMessage(`缓存目录清理失败：${result.errors.join(', ')}`);
      }
      
      // 更新统计
      this.updateStats();
    } catch (error) {
      logMessage('error', '清理缓存目录时出错:', error);
      this.setStatusMessage(`清理缓存目录时出错: ${error.message}`);
    }
  }
  
  /**
   * 清理用户数据的日志目录
   */
  async cleanupUserDataLogs() {
    if (!confirm('确定要清理用户数据中的日志目录吗？这将删除所有应用日志文件。')) {
      return;
    }
    
    try {
      this.setStatusMessage('正在清理日志目录...');
      const result = await cleanupUserData({ cleanCache: false, cleanLogs: true });
      
      if (result.success) {
        this.setStatusMessage('日志目录清理成功！');
      } else {
        this.setStatusMessage(`日志目录清理失败：${result.errors.join(', ')}`);
      }
    } catch (error) {
      logMessage('error', '清理日志目录时出错:', error);
      this.setStatusMessage(`清理日志目录时出错: ${error.message}`);
    }
  }

  /**
   * 设置状态消息
   * @param {string} message 状态消息
   */
  setStatusMessage(message) {
    const statusContainer = document.createElement('div');
    statusContainer.style.cssText = `
      margin-top: 10px;
      padding: 5px;
      background-color: rgba(0, 0, 0, 0.5);
      border-radius: 3px;
      text-align: center;
      color: #fff;
    `;
    statusContainer.textContent = message;
    
    // 移除之前的状态消息
    const oldStatus = this.container.querySelector('.status-message');
    if (oldStatus) {
      oldStatus.remove();
    }
    
    statusContainer.className = 'status-message';
    this.container.appendChild(statusContainer);
    
    // 5秒后自动移除
    setTimeout(() => {
      if (statusContainer && statusContainer.parentNode) {
        statusContainer.remove();
      }
    }, 5000);
  }

  /**
   * 清除所有BlobUrl
   */
  async clearBlobUrls() {
    if (!confirm('确定要清空所有Blob URL缓存吗？这可能会导致当前页面上的一些图片无法显示。')) {
      return;
    }
    
    try {
      this.setStatusMessage('正在清除Blob URL缓存...');
      
      BlobUrlCache.clearAllBlobUrls();
      logMessage('info', 'Blob URL缓存已清除');
      
      // 刷新统计信息
      setTimeout(() => this.updateStats(), 500);
    } catch (error) {
      logMessage('error', '清除Blob URL缓存失败:', error);
      this.setStatusMessage(`清除Blob URL缓存失败: ${error.message}`);
    }
  }
  
  /**
   * 重置Blob URL统计
   */
  resetBlobStats() {
    try {
      // 获取BlobUrlCache统计信息
      const stats = BlobUrlCache.getStats();
      
      // 直接调用BlobUrlCache中的stats对象的resetStats方法
      if (stats && stats.resetStats) {
        stats.resetStats();
        this.setStatusMessage('Blob URL统计已重置');
        logMessage('info', 'Blob URL统计已重置');
      } else {
        // 尝试备用方案
        logMessage('warn', 'BlobUrlCache.getStats().resetStats 不可用，尝试备用方法');
        if (typeof BlobUrlCache.resetStats === 'function') {
          BlobUrlCache.resetStats();
          this.setStatusMessage('Blob URL统计已重置（通过备用方法）');
          logMessage('info', 'Blob URL统计已重置（通过备用方法）');
        } else {
          throw new Error('无法找到重置Blob URL统计的方法');
        }
      }
      
      // 刷新统计信息
      setTimeout(() => this.updateStats(), 500);
    } catch (error) {
      logMessage('error', '重置Blob URL统计失败:', error);
      this.setStatusMessage(`重置Blob URL统计失败: ${error.message}`);
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