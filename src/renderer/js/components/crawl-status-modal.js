// src/renderer/js/components/crawl-status-modal.js
import { t } from '../core/i18n.js';
import { logMessage } from '../apiBridge.js';

export class CrawlStatusModal {
    constructor() {
        this.modalElement = null;
        this.statusTextElement = null;
        this.startButton = null;
        this.pauseResumeButton = null;
        this.cancelButton = null;
        this.closeButton = null;
        this.currentSourceId = null; // 新增：存储当前数据源 ID
        this.currentDirectory = null; // 新增：存储当前目录

        this.boundUpdateStatus = this.updateStatus.bind(this); // 预绑定 updateStatus

        this._createModalDOM();
        this._attachEventListeners();
    }

    _createModalDOM() {
        // 检查是否已存在
        this.modalElement = document.getElementById('crawlStatusModal');
        if (this.modalElement) {
            logMessage('warn', '[CrawlStatusModal] Modal element already exists in DOM.');
            // 获取现有元素的引用
            this.statusTextElement = document.getElementById('crawl-status-text');
            this.startButton = document.getElementById('crawl-start-button');
            this.pauseResumeButton = document.getElementById('crawl-pause-resume-button');
            this.cancelButton = document.getElementById('crawl-cancel-button');
            this.closeButton = this.modalElement.querySelector('.close-button');
            return;
        }

        // 创建 Modal 容器
        this.modalElement = document.createElement('div');
        this.modalElement.id = 'crawlStatusModal';
        this.modalElement.className = 'modal'; // 需要 CSS 定义 .modal
        this.modalElement.style.display = 'none'; // 初始隐藏

        // 创建 Modal 内容区域
        const modalContent = document.createElement('div');
        modalContent.className = 'modal-content'; // 需要 CSS 定义 .modal-content

        // 关闭按钮 (右上角)
        this.closeButton = document.createElement('span');
        this.closeButton.className = 'close-button';
        this.closeButton.innerHTML = '&times;'; // '×' 字符
        this.closeButton.title = t('crawlModal.closeTitle'); // 添加 title

        // 标题
        const title = document.createElement('h2');
        title.dataset.i18nKey = 'crawlModal.title';
        title.textContent = t('crawlModal.title'); // 设置初始文本

        // 状态文本
        this.statusTextElement = document.createElement('p');
        this.statusTextElement.id = 'crawl-status-text';
        this.statusTextElement.dataset.i18nKey = 'crawlModal.status.idle';
        this.statusTextElement.textContent = t('crawlModal.status.idle'); // 初始状态

        // 按钮容器
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'modal-buttons'; // 需要 CSS 定义 .modal-buttons

        // 开始按钮
        this.startButton = document.createElement('button');
        this.startButton.id = 'crawl-start-button';
        this.startButton.dataset.i18nKey = 'crawlModal.button.start';
        this.startButton.textContent = t('crawlModal.button.start');

        // 暂停/恢复按钮 (初始隐藏)
        this.pauseResumeButton = document.createElement('button');
        this.pauseResumeButton.id = 'crawl-pause-resume-button';
        this.pauseResumeButton.style.display = 'none';
        this.pauseResumeButton.dataset.i18nKey = 'crawlModal.button.pause'; // 初始为暂停
        this.pauseResumeButton.textContent = t('crawlModal.button.pause');

        // 取消按钮 (初始禁用)
        this.cancelButton = document.createElement('button');
        this.cancelButton.id = 'crawl-cancel-button';
        this.cancelButton.dataset.i18nKey = 'crawlModal.button.cancel';
        this.cancelButton.textContent = t('crawlModal.button.cancel');
        this.cancelButton.disabled = true;

        // 组装按钮
        buttonContainer.appendChild(this.startButton);
        buttonContainer.appendChild(this.pauseResumeButton);
        buttonContainer.appendChild(this.cancelButton);

        // 组装 Modal 内容
        modalContent.appendChild(this.closeButton);
        modalContent.appendChild(title);
        modalContent.appendChild(this.statusTextElement);
        modalContent.appendChild(buttonContainer);

        // 添加到 Modal 容器
        this.modalElement.appendChild(modalContent);

        // 添加到 body
        document.body.appendChild(this.modalElement);
        logMessage('info', '[CrawlStatusModal] Modal DOM created and appended to body.');
    }

    _attachEventListeners() {
        if (!this.modalElement) return;

        this.startButton.addEventListener('click', this._handleStartClick.bind(this));
        this.pauseResumeButton.addEventListener('click', this._handlePauseResumeClick.bind(this));
        this.cancelButton.addEventListener('click', this._handleCancelClick.bind(this));
        this.closeButton.addEventListener('click', this._handleCancelClick.bind(this)); // 右上角关闭也触发取消

        // 点击模态背景关闭 (可选)
        this.modalElement.addEventListener('click', (event) => {
            if (event.target === this.modalElement) {
                // 只有在非运行状态下点击背景才关闭
                if (this.cancelButton.disabled) { // 取消按钮禁用表示非运行状态
                    this.hide();
                } else {
                    logMessage('debug', '[CrawlStatusModal] Clicked background while running, ignored.');
                }
            }
        });
    }

    async show(sourceId, directory) { // 接收 sourceId 和 directory
        if (!this.modalElement) return;
        logMessage('info', `[CrawlStatusModal] Showing modal for source: ${sourceId}, directory: ${directory ?? 'root'}`);
        this.currentSourceId = sourceId; // 存储 ID
        this.currentDirectory = directory; // 存储目录
        this.modalElement.style.display = 'block'; // 或者 'flex'，取决于 CSS

        // 重置到初始状态显示 (Idle)
        this.updateStatus({ status: 'idle', processed: 0, total: 0, currentModel: null, error: null }); // 改为小写 'idle'

        // 不再主动获取初始状态，依赖 onCrawlStatusUpdate 推送
        // try {
        //     logMessage('debug', '[CrawlStatusModal] Getting initial crawl status...');
        //     const initialStatus = await window.api.getCrawlStatus();
        //     logMessage('info', '[CrawlStatusModal] Initial status received:', initialStatus);
        //     this.updateStatus(initialStatus); // 更新为实际初始状态
        // } catch (error) {
        //     logMessage('error', '[CrawlStatusModal] Failed to get initial crawl status:', error);
        //     // 显示错误状态
        //     this.updateStatus({ status: 'ERROR', processed: 0, total: 0, currentModel: null, error: t('crawlModal.error.getStatusFailed') });
        // }

        // 注册状态更新监听器
        logMessage('debug', '[CrawlStatusModal] Registering status update listener.');
        window.api.onCrawlStatusUpdate(this.boundUpdateStatus);
    }

    hide() {
        if (!this.modalElement) return;
        logMessage('info', '[CrawlStatusModal] Hiding modal.');
        this.modalElement.style.display = 'none';

        // 移除状态更新监听器
        logMessage('debug', '[CrawlStatusModal] Removing status update listener.');
        // 假设 preload.js 暴露了 remove 方法，或者 IPC 能处理重复注册
        if (window.api.removeCrawlStatusUpdateListener) {
             window.api.removeCrawlStatusUpdateListener(this.boundUpdateStatus);
        } else {
            logMessage('warn', '[CrawlStatusModal] window.api.removeCrawlStatusUpdateListener not available.');
            // 如果没有移除方法，可能需要确保 onCrawlStatusUpdate 能处理重复监听或在 preload 中管理
        }
    }

    updateStatus(status) {
        if (!this.modalElement || !status) return;
        logMessage('debug', '[CrawlStatusModal] Updating status:', status);

        // Correctly access values from the nested progress object
        const { status: state, progress, error } = status;
        const processedCount = progress?.completed ?? 0; // Use 'completed' from backend, provide default
        const totalCount = progress?.total ?? 0; // Use 'total' from backend, provide default
        const currentModel = progress?.currentModelName; // Get current model name

        let statusText = '';
        let pauseResumeTextKey = 'crawlModal.button.pause';
        let pauseResumeAction = 'pause'; // 'pause' or 'resume'

        // 更新状态文本
        switch (state) {
            case 'idle': // 改为小写
                statusText = t('crawlModal.status.idle');
                this.startButton.disabled = false;
                this.pauseResumeButton.style.display = 'none';
                this.cancelButton.disabled = true; // IDLE 状态下取消按钮应禁用，因为没有任务可取消
                break;
            case 'scanning': // 改为小写
                statusText = t('crawlModal.status.scanning'); // 需要添加新的翻译键
                this.startButton.disabled = true; // 扫描时禁用开始
                this.pauseResumeButton.style.display = 'none'; // 扫描时隐藏暂停/恢复
                this.cancelButton.disabled = false; // 扫描时可以取消
                break;
            case 'running': // 改为小写
                statusText = t('crawlModal.status.running', {
                    processed: processedCount, // Use correct variable
                    total: totalCount,       // Use correct variable
                    model: currentModel || '...'
                });
                this.startButton.disabled = true;
                this.pauseResumeButton.style.display = 'inline-block';
                this.pauseResumeButton.disabled = false;
                pauseResumeTextKey = 'crawlModal.button.pause';
                pauseResumeAction = 'pause';
                this.cancelButton.disabled = false;
                break;
            case 'paused': // 改为小写
                statusText = t('crawlModal.status.paused', {
                    processed: processedCount, // Use correct variable
                    total: totalCount        // Use correct variable
                });
                this.startButton.disabled = true;
                this.pauseResumeButton.style.display = 'inline-block';
                this.pauseResumeButton.disabled = false;
                pauseResumeTextKey = 'crawlModal.button.resume';
                pauseResumeAction = 'resume';
                this.cancelButton.disabled = false;
                break;
            case 'finished': // 改为小写
                statusText = t('crawlModal.status.finished', { total: totalCount }); // Use correct variable
                this.startButton.disabled = false; // 完成后可以重新开始
                this.pauseResumeButton.style.display = 'none';
                this.cancelButton.disabled = true; // 完成后不能取消
                // 可以在几秒后自动关闭，或者让用户手动关闭
                // setTimeout(() => this.hide(), 3000);
                break;
            case 'canceled': // 改为小写
                 statusText = t('crawlModal.status.canceled'); // 需要添加新的翻译键
                 this.startButton.disabled = false; // 取消后可以重新开始
                 this.pauseResumeButton.style.display = 'none';
                 this.cancelButton.disabled = true; // 取消后不能再取消
                 break;
            case 'error': // 改为小写
                statusText = t('crawlModal.status.error', { error: error || t('unknownError') });
                this.startButton.disabled = false; // 允许重试
                this.pauseResumeButton.style.display = 'none';
                this.cancelButton.disabled = true; // 出错后不能取消
                break;
            default:
                statusText = t('crawlModal.status.unknown');
                logMessage('warn', '[CrawlStatusModal] Received unknown status state:', state);
                this.startButton.disabled = true;
                this.pauseResumeButton.style.display = 'none';
                this.cancelButton.disabled = true;
        }

        this.statusTextElement.textContent = statusText;
        this.pauseResumeButton.textContent = t(pauseResumeTextKey);
        // 存储当前动作，以便点击时知道是暂停还是恢复
        this.pauseResumeButton.dataset.action = pauseResumeAction;

        // 更新 i18n key 以便语言切换时能正确更新 (如果需要)
        // this.statusTextElement.dataset.i18nKey = ... (根据状态设置不同的 key)
        // this.pauseResumeButton.dataset.i18nKey = pauseResumeTextKey;
    }

    _handleStartClick() {
        logMessage('info', `[CrawlStatusModal] Start button clicked for source: ${this.currentSourceId}, directory: ${this.currentDirectory ?? 'root'}`);
        // 检查 sourceId 是否有效
        if (!this.currentSourceId) {
            logMessage('error', '[CrawlStatusModal] Cannot start crawl: sourceId is missing.');
            this.updateStatus({ status: 'ERROR', error: t('crawlModal.error.missingSourceId') }); // 需要添加新的翻译键
            return;
        }
        // 可以在调用 API 前禁用按钮，防止重复点击
        this.startButton.disabled = true;
        this.cancelButton.disabled = false; // 开始后可以取消

        // 添加日志，确认传递的参数
        logMessage('debug', `[CrawlStatusModal] Calling window.api.startCrawl with sourceId: ${this.currentSourceId}, directory: ${this.currentDirectory}`);

        window.api.startCrawl(this.currentSourceId, this.currentDirectory).catch(err => {
            logMessage('error', '[CrawlStatusModal] Failed to start crawl:', err);
            // API 调用失败，恢复按钮状态并显示错误
            this.updateStatus({ status: 'ERROR', error: t('crawlModal.error.startFailed') });
            // 允许用户重试
            this.startButton.disabled = false;
            this.cancelButton.disabled = true;
        });
        // 状态将通过 onCrawlStatusUpdate 更新
    }

    _handlePauseResumeClick() {
        const action = this.pauseResumeButton.dataset.action;
        logMessage('info', `[CrawlStatusModal] Pause/Resume button clicked (action: ${action}).`);
        this.pauseResumeButton.disabled = true; // 禁用按钮直到状态更新

        if (action === 'pause') {
            window.api.pauseCrawl().catch(err => {
                logMessage('error', '[CrawlStatusModal] Failed to pause crawl:', err);
                this.updateStatus({ status: 'ERROR', error: t('crawlModal.error.pauseFailed') });
                this.pauseResumeButton.disabled = false; // 恢复按钮
            });
        } else if (action === 'resume') {
            window.api.resumeCrawl().catch(err => {
                logMessage('error', '[CrawlStatusModal] Failed to resume crawl:', err);
                 this.updateStatus({ status: 'ERROR', error: t('crawlModal.error.resumeFailed') });
                 this.pauseResumeButton.disabled = false; // 恢复按钮
            });
        }
        // 状态将通过 onCrawlStatusUpdate 更新
    }

    _handleCancelClick() {
        logMessage('info', '[CrawlStatusModal] Cancel/Close button clicked.');
        // 禁用所有操作按钮
        this.startButton.disabled = true;
        this.pauseResumeButton.disabled = true;
        this.cancelButton.disabled = true;

        window.api.cancelCrawl()
            .then(() => {
                logMessage('info', '[CrawlStatusModal] Crawl cancelled successfully via API.');
            })
            .catch(err => {
                logMessage('error', '[CrawlStatusModal] Failed to cancel crawl via API:', err);
                // 即使取消失败，也尝试关闭弹窗
            })
            .finally(() => {
                // 无论 API 调用成功与否，都关闭弹窗
                this.hide();
                // 可以在 hide() 之后稍微延迟重置状态，或者在 show() 时重置
                // this.updateStatus({ status: 'IDLE' }); // 立即重置或依赖 show()
            });
    }
}