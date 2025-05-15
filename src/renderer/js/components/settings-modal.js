import { showFeedback, clearFeedback, clearChildren, showConfirmationDialog, setLoading } from '../utils/ui-utils.js';
import { t, loadLocale, getCurrentLocale, getSupportedLocales, updateUIWithTranslations } from '../core/i18n.js';
import {
    logMessage,
    openFolderDialog,
    getConfig,
    saveConfig,
    onUpdateStatus,
    checkForUpdate,
    quitAndInstall,
    downloadUpdate, // <-- 添加下载更新函数
    getAppVersion, // <-- 添加获取应用版本
    clearImageCache, // <-- 添加清除图片缓存 (假设存在)
    getPackageInfo, // <-- 添加 getPackageInfo 导入
    getImageCacheSize
    // getProcessVersions is no longer needed here
} from '../apiBridge.js';

// ===== Helper Functions =====

/**
 * Formats bytes into a human-readable string (KB, MB, GB).
 * @param {number} bytes - The number of bytes.
 * @param {number} [decimals=2] - The number of decimal places.
 * @returns {string} Formatted string.
 */
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    if (isNaN(parseInt(bytes))) return 'N/A'; // Handle non-numeric input

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    // Ensure index is within bounds
    const unitIndex = i < sizes.length ? i : sizes.length - 1;

    return parseFloat((bytes / Math.pow(k, unitIndex)).toFixed(dm)) + ' ' + sizes[unitIndex];
}
// ===== DOM Element References =====
let settingsModal;
let settingsBtn; // The button that opens the settings Model
let settingsCloseBtn;
let settingsNav; // Left navigation container
let settingsContent; // Right content container
let dataSourceListEl; // UL element for data sources
let addDataSourceBtn; // Button to add a new data source
let addDataSourceFormContainer; // Container for the add form
// References to individual panes (optional, can query when needed)
// let settingsDataSourcesPane;
// let settingsGeneralPane; ... etc.
let updateStatusEl; // Span to display update status messages (within its pane)
let checkUpdatesBtn; // Button to check for updates (within its pane) - Renamed from checkUpdateButton
let updateStatusInfoEl; // Element to display update status messages (within its pane) - Renamed from updateStatusEl
let clearImageCacheBtn; // Button to clear image cache
let clearCacheStatusEl; // Span to show cache clearing status

// ===== Module State =====
let tempModelSources = []; // Temporary state for editing sources
let unsubscribeUpdateStatus = null; // Function to unsubscribe from update status events
let currentConfigData = null; // Store loaded config temporarily

// ===== Initialization =====

/**
 * Initializes the settings Model module for the new two-column layout.
 * @param {object} config - Configuration object containing element IDs.
 * @param {string} config.ModelId
 * @param {string} config.openBtnId - ID of the button that opens this Model.
 * @param {string} config.closeBtnId
 */
export function initsettingsModal(config) { // 移除 sourceEditModelConfig
    settingsModal = document.getElementById(config.ModelId);
    settingsBtn = document.getElementById(config.openBtnId);
    settingsCloseBtn = document.getElementById(config.closeBtnId);

    if (!settingsModal || !settingsBtn || !settingsCloseBtn) {
        logMessage('error', "[settingsModal] 初始化失败：弹窗、打开或关闭按钮未找到。请检查配置中的 ID:", config);
        return;
    }

    // Get references to the new layout elements within the Model
    settingsNav = settingsModal.querySelector('.settings-nav ul');
    settingsContent = settingsModal.querySelector('.settings-content');
    dataSourceListEl = settingsModal.querySelector('#dataSourceList'); // 数据源列表 UL
    addDataSourceBtn = settingsModal.querySelector('#addDataSourceBtn'); // 添加按钮
    addDataSourceFormContainer = settingsModal.querySelector('#addDataSourceFormContainer'); // 添加表单的容器

    if (!settingsNav || !settingsContent || !dataSourceListEl || !addDataSourceBtn || !addDataSourceFormContainer) {
        logMessage('error', "[settingsModal] 初始化失败：导航、内容区域、数据源列表、添加按钮或添加表单容器未找到。请检查 index.html 结构。");
        return;
    }

    // 移除 initSourceEditModel 调用

    // --- Attach Event Listeners ---

    // Open Model Button
    settingsBtn.addEventListener('click', () => {
        logMessage('info', '[UI] 点击了设置按钮');
        opensettingsModal();
    });

    // Close Model Button
    settingsCloseBtn.addEventListener('click', () => {
        logMessage('info', '[UI] 点击了设置弹窗的关闭按钮');
        closesettingsModal();
    });

    // Close Model on backdrop click
    settingsModal.addEventListener('click', (event) => {
        if (event.target === settingsModal) {
            logMessage('info', '[UI] 点击了设置弹窗的背景遮罩');
            closesettingsModal();
        }
    });

    // Navigation Item Clicks (Event Delegation)
    settingsNav.addEventListener('click', (event) => {
        const navLink = event.target.closest('a.nav-item');
        if (navLink && !navLink.classList.contains('active')) {
            event.preventDefault();
            const category = navLink.dataset.category;
            logMessage('info', `[UI] 点击了设置导航项: ${category}`);
            switchSettingsTab(category);
        }
    });

    // Add Data Source Button Click
    addDataSourceBtn.addEventListener('click', () => {
        logMessage('info', '[UI] 点击了添加数据源按钮');
        // 不再打开子弹窗，改为显示行内添加表单
        showAddDataSourceForm();
    });

    // Data Source List Actions (Event Delegation for Edit/Delete/Inline Save/Cancel/Browse)
    dataSourceListEl.addEventListener('click', (event) => {
        const target = event.target;
        const listItem = target.closest('.data-source-item');
        if (!listItem) return;
        const sourceId = listItem.dataset.id;

        if (target.classList.contains('edit-btn')) {
            logMessage('info', `[UI] 点击了数据源编辑按钮 (行内): ${sourceId}`);
            handleEditSourceInline(listItem);
        } else if (target.classList.contains('delete-btn')) {
            logMessage('info', `[UI] 点击了数据源删除按钮: ${sourceId}`);
            handleDeleteSource(sourceId);
        } else if (target.classList.contains('save-inline-btn')) {
             logMessage('info', `[UI] 点击了数据源行内保存按钮: ${sourceId}`);
             handleSaveSourceInline(listItem);
        } else if (target.classList.contains('cancel-inline-btn')) {
             logMessage('info', `[UI] 点击了数据源行内取消按钮: ${sourceId}`);
             handleCancelSourceInline(listItem);
        } else if (target.classList.contains('browse-inline-btn')) {
            logMessage('info', `[UI] 点击了数据源行内浏览按钮: ${sourceId}`);
            handleBrowseInline(listItem);
        }
   });

    // Section Save Buttons (Event Delegation on Content Area)
    settingsContent.addEventListener('click', (event) => {
        if (event.target.classList.contains('settings-save-section')) {
            const pane = event.target.closest('.settings-pane');
            const category = pane?.dataset.category;
            if (category) {
                logMessage('info', `[UI] 点击了保存按钮，分区: ${category}`);
                handleSaveSection(category, pane);
            }
        }
    });

     // Clear Image Cache Button Click (Specific to Image Cache Pane)
     // Listener attached dynamically in populateImageCachePane

     // Check Updates Button Click (Specific to Update Pane)
     // Listener attached dynamically in setupUpdateSection

    logMessage('info', "[settingsModal] 新设置界面初始化完成");
}

// ===== Core Functions =====

/** Opens the settings Model and loads the current configuration. */
async function opensettingsModal() {
    if (!settingsModal) {
        logMessage('error', "[settingsModal] opensettingsModal 失败：弹窗元素未初始化");
        return;
    }
    logMessage('info', "[settingsModal] 开始打开设置弹窗");
    // Clear any previous feedback? (No global feedback area anymore)
    document.body.classList.add('modal-open'); // Prevent body scroll
    settingsModal.classList.add('active');

    document.title = t('settings.title'); // Set page title
    // Set default tab and load data
    switchSettingsTab('data-sources'); // Default to data sources
    await loadAndDisplaySettings();

    logMessage('info', "[settingsModal] 设置弹窗已打开并加载数据");
}

/** Closes the settings Model. */
function closesettingsModal() {
    logMessage('info', "[settingsModal] 开始关闭设置弹窗");
    if (settingsModal) {
        settingsModal.classList.remove('active');
        document.body.classList.remove('modal-open'); // Restore body scroll
        // Clear temporary state
        tempModelSources = [];
        currentConfigData = null;
        // Clean up IPC listener
        if (unsubscribeUpdateStatus) {
            logMessage('info', "[settingsModal] 取消订阅更新状态事件");
            unsubscribeUpdateStatus();
            unsubscribeUpdateStatus = null;
        }
        // Reset UI state (e.g., close any open inline forms)
        dataSourceListEl.querySelectorAll('.edit-form').forEach(form => form.style.display = 'none');
        dataSourceListEl.querySelectorAll('.data-source-item > *:not(.edit-form)').forEach(el => el.style.display = ''); // Show original content

        logMessage('info', "[settingsModal] 设置弹窗已关闭");
        document.title = t('appTitle'); // Restore original page title on close
    } else {
        logMessage('warn', "[settingsModal] closesettingsModal 调用时弹窗元素未初始化");
    }
}

// ===== Internal Logic =====

/** Switches the active tab and content pane in the settings Model. */
function switchSettingsTab(category) {
    if (!settingsNav || !settingsContent) return;
    logMessage('debug', `[settingsModal] 切换到设置标签页: ${category}`);

    // Update navigation active state
    settingsNav.querySelectorAll('a.nav-item').forEach(link => {
        link.classList.toggle('active', link.dataset.category === category);
    });

    // Show/Hide content panes
    settingsContent.querySelectorAll('.settings-pane').forEach(pane => {
        pane.style.display = pane.dataset.category === category ? '' : 'none';
    });

    // Special handling for sections needing dynamic setup (like Updates)
    // Populate the specific pane when switching (or ensure it's populated on load)
    // We already populate everything on load, but could optimize later if needed.
    switch (category) {
        case 'updates':
            setupUpdateSection(); // Ensure listeners are attached when pane becomes visible
            break;
        case 'image-cache':
            // Ensure the clear cache button listener is attached if not already
            setupImageCacheSection();
            break;
        // Add other cases if specific setup is needed on tab switch
    }
}

/** Loads config and populates all setting panes. */
async function loadAndDisplaySettings() {
    logMessage('info', "[settingsModal] 开始加载并显示所有设置");
    setLoading(true); // Consider a loading indicator for the content area
    const startTime = Date.now();

    try {
        currentConfigData = await getConfig();
        logMessage('info', "[settingsModal] 从主进程获取的配置:", currentConfigData);

        // Deep clone sources into temporary state for editing
        tempModelSources = currentConfigData.modelSources ? JSON.parse(JSON.stringify(currentConfigData.modelSources)) : [];

        // --- Populate Panes ---
        populateDataSourcesPane();
        populateGeneralPane();
        populateFileRecognitionPane();
        populateImageCachePane();
        populateUpdatesPane(); // This might just set initial text
        populateAboutPane();
        // populateLanguageSetting(); // Language dropdown is part of populateGeneralPane now

        const duration = Date.now() - startTime;
        logMessage('info', `[settingsModal] 所有设置面板填充完成, 耗时: ${duration}ms`);

    } catch (error) {
        const duration = Date.now() - startTime;
        logMessage('error', `[settingsModal] 加载或显示设置失败, 耗时: ${duration}ms`, error.message, error.stack, error);
        // Display error in a relevant pane or a general error message area if added
        const dataSourcesPane = settingsContent.querySelector('#settingsDataSources');
        if (dataSourcesPane) {
            dataSourcesPane.innerHTML = `<p class="error-message">${t('settings.loadError', { message: error.message })}</p>`;
        }
    } finally {
        setLoading(false);
    }
}

// --- Pane Population Functions ---

function populateDataSourcesPane() {
    logMessage('debug', "[settingsModal] 填充数据源面板");
    renderSourceListForSettings(); // Render the list using temp state
}

function populateGeneralPane() {
    logMessage('debug', "[settingsModal] 填充常规设置面板");
    const pane = settingsContent.querySelector('#settingsGeneral');
    if (!pane || !currentConfigData) return;
    const langSelect = pane.querySelector('#languageSelector');
    if (langSelect) {
        // Populate options first (if not already done)
        if (langSelect.options.length === 0) {
            const locales = getSupportedLocales();
            locales.forEach(l => {
                const opt = document.createElement('option');
                opt.value = l.code;
                opt.textContent = l.name;
                langSelect.appendChild(opt);
            });
        }
        // Set value and listener
        langSelect.value = currentConfigData.language || getCurrentLocale(); // Use current locale as fallback
        langSelect.removeEventListener('change', handleLanguageChange); // Ensure no duplicate listeners
        langSelect.addEventListener('change', handleLanguageChange);
    } else {
        logMessage('warn', "[settingsModal] 未找到常规设置面板中的 #languageSelector");
    }
}

function populateFileRecognitionPane() {
    logMessage('debug', "[settingsModal] 填充文件识别面板");
    const pane = settingsContent.querySelector('#settingsFileRecognition');
    if (!pane || !currentConfigData) return;
    const textarea = pane.querySelector('#supportedFileExtensions'); // Corrected ID from HTML
    if (textarea) {
        // Use default from configService if available, otherwise a hardcoded default
        const defaultExtensions = currentConfigData.defaults?.supportedExtensions || [".checkpoint", ".ckpt", ".safetensors", ".pt", ".pth", ".bin"];
        const currentExtensions = currentConfigData.supportedExtensions || defaultExtensions;
        textarea.value = currentExtensions.join(', ');
    } else {
         logMessage('warn', "[settingsModal] 未找到文件识别面板中的 #supportedFileExtensions 文本区域");
    }
}

function populateImageCachePane() {
    logMessage('debug', "[settingsModal] 填充图片缓存面板");
    const pane = settingsContent.querySelector('#settingsImageCache');
    if (!pane || !currentConfigData) return;
    const cacheConfig = currentConfigData.imageCache || currentConfigData.defaults?.imageCache || {}; // Use defaults if available

    // --- Cache Size Limit ---
    const sizeInput = pane.querySelector('#imageCacheSizeLimit');
    if (sizeInput) {
        sizeInput.value = cacheConfig.maxCacheSizeMB ?? 500; // Default to 500MB if not set
    } else {
        logMessage('warn', "[settingsModal] 未找到图片缓存面板中的 #imageCacheSizeLimit 输入框");
    }

    // --- Compression Quality ---
    const qualityInput = pane.querySelector('#imageCacheCompressQuality');
    const qualityValueDisplay = pane.querySelector('#imageCacheCompressQualityValue');
    if (qualityInput && qualityValueDisplay) {
        const quality = cacheConfig.compressQuality ?? 80; // Default to 80 if not set
        qualityInput.value = quality;
        qualityValueDisplay.textContent = quality; // Display initial value
        // Add listener to update display when slider changes
        qualityInput.removeEventListener('input', handleQualitySliderChange); // Prevent duplicates
        qualityInput.addEventListener('input', handleQualitySliderChange);
    } else {
        logMessage('warn', "[settingsModal] 未找到图片缓存面板中的 #imageCacheCompressQuality 或 #imageCacheCompressQualityValue");
    }

    // --- Current Cache Size Display ---
    const cacheSizeDisplay = pane.querySelector('#currentCacheSizeDisplay');
    if (cacheSizeDisplay) {
        cacheSizeDisplay.textContent = t('settings.imageCache.calculatingSize'); // Initial text
        cacheSizeDisplay.classList.remove('error'); // Reset error state
        getImageCacheSize() // This now returns bytes
            .then(sizeBytes => {
                // Check if the returned value is a valid number
                if (typeof sizeBytes === 'number' && !isNaN(sizeBytes)) {
                    cacheSizeDisplay.textContent = formatBytes(sizeBytes); // Use formatBytes
                    cacheSizeDisplay.classList.remove('error');
                } else {
                    // Handle cases where the API might return non-numeric or error states (though it should return 0 on error now)
                    logMessage('warn', `[settingsModal] getImageCacheSize 返回了无效值: ${sizeBytes}`);
                    cacheSizeDisplay.textContent = t('settings.imageCache.sizeError');
                    cacheSizeDisplay.classList.add('error');
                }
            })
            .catch(error => {
                logMessage('error', "[settingsModal] 获取缓存大小失败:", error);
                cacheSizeDisplay.textContent = t('settings.imageCache.sizeError');
                cacheSizeDisplay.classList.add('error');
            });
    } else {
        logMessage('warn', "[settingsModal] 未找到图片缓存面板中的 #currentCacheSizeDisplay 元素");
    }

    // --- Preferred Cache Format --- (Keep this section as is)
    const formatSelect = pane.querySelector('#imageCacheFormatSelect');
    if (formatSelect) {
        // Populate options if needed (should be done in HTML ideally)
        if (formatSelect.options.length < 4) { // Basic check
             clearChildren(formatSelect); // Clear existing options if any
             const formats = ['Original', 'JPEG', 'PNG', 'WebP'];
             formats.forEach(format => {
                 const option = document.createElement('option');
                 option.value = format;
                 // Use specific keys if available, otherwise just the format name
                 option.textContent = t(`settings.imageCache.format${format}`, {}, format); // Fallback to format name
                 formatSelect.appendChild(option);
             });
        }
        // Set current value
        formatSelect.value = cacheConfig.preferredFormat || 'Original'; // Default to Original
    } else {
        logMessage('warn', "[settingsModal] 未找到图片缓存面板中的 #imageCacheFormatSelect 下拉菜单");
    }

    // --- Clear Cache Button & Status ---
    clearImageCacheBtn = pane.querySelector('#clearImageCacheBtn'); // Assign to module variable
    clearCacheStatusEl = pane.querySelector('#clearCacheStatus'); // Assign to module variable
    if (clearCacheStatusEl) {
        clearCacheStatusEl.textContent = '';
        clearCacheStatusEl.className = 'status-message'; // Reset class
    }

    // Attach listeners (including the new format select listener)
    setupImageCacheSection();
}

/** Sets up event listeners for the Image Cache pane. */
function setupImageCacheSection() {
    const pane = settingsContent?.querySelector('#settingsImageCache');
    if (!pane) {
         logMessage('warn', "[settingsModal] 无法设置图片缓存部分：面板未找到");
         return;
    }

    // --- Clear Cache Button ---
    clearImageCacheBtn = pane.querySelector('#clearImageCacheBtn');
    if (clearImageCacheBtn) {
        clearImageCacheBtn.removeEventListener('click', handleClearImageCache); // Prevent duplicates
        clearImageCacheBtn.addEventListener('click', handleClearImageCache);
        logMessage('debug', "[settingsModal] 已附加清除缓存按钮的事件监听器");
    } else {
        logMessage('warn', "[settingsModal] 无法设置图片缓存部分：清除按钮未找到");
    }

    // --- Format Select Dropdown ---
    const formatSelect = pane.querySelector('#imageCacheFormatSelect');
    const formatFeedbackArea = pane.querySelector('#imageCacheFormatFeedback'); // Specific feedback area for format
    if (formatSelect) {
        formatSelect.removeEventListener('change', handleFormatChange); // Prevent duplicates
        formatSelect.addEventListener('change', handleFormatChange);
        logMessage('debug', "[settingsModal] 已附加缓存格式选择下拉菜单的事件监听器");
    } else {
         logMessage('warn', "[settingsModal] 无法设置图片缓存部分：格式选择下拉菜单未找到");
    }

    // Ensure status element reference is updated
    clearCacheStatusEl = pane.querySelector('#clearCacheStatus');
}

/** Handles the input event for the compression quality slider. */
function handleQualitySliderChange(event) {
    const qualityValueDisplay = event.target.parentElement.querySelector('#imageCacheCompressQualityValue');
    if (qualityValueDisplay) {
        qualityValueDisplay.textContent = event.target.value;
    }
}


/** Handles the change event for the image cache format select dropdown. */
async function handleFormatChange(event) {
    const newFormat = event.target.value;
    const selectElement = event.target;
    const feedbackArea = selectElement.closest('.form-group').querySelector('.feedback-area'); // Find feedback area near the select

    logMessage('info', `[UI] 图片缓存格式更改为: ${newFormat}`);

    if (!currentConfigData) {
        logMessage('error', "[settingsModal] 无法保存格式更改：当前配置数据不可用");
        if (feedbackArea) showFeedback(feedbackArea, t('settings.saveError', { message: '配置数据丢失' }), 'error');
        return;
    }

    // Disable select while saving
    selectElement.disabled = true;
    if (feedbackArea) clearFeedback(feedbackArea);

    try {
        // Create the update object, merging with existing imageCache settings
        const updatedImageCacheConfig = {
            ...(currentConfigData.imageCache || {}), // Keep existing settings like maxCacheSizeMB
            preferredFormat: newFormat
        };

        // Merge into the full config object
        const fullConfigToSend = {
            ...currentConfigData,
            imageCache: updatedImageCacheConfig
        };

        logMessage('info', `[settingsModal] 调用 API 保存图片缓存格式: ${newFormat}`, fullConfigToSend);
        await saveConfig(fullConfigToSend);

        // Update local config state
        currentConfigData = fullConfigToSend;
        logMessage('info', `[settingsModal] 图片缓存格式保存成功: ${newFormat}`);
        if (feedbackArea) showFeedback(feedbackArea, t('settings.imageCache.formatSaveSuccess'), 'success', 1500);

    } catch (error) {
        logMessage('error', `[settingsModal] 保存图片缓存格式失败: ${newFormat}`, error.message, error.stack);
        if (feedbackArea) showFeedback(feedbackArea, t('settings.saveError', { message: error.message }), 'error');
        // Revert dropdown selection on error?
        selectElement.value = currentConfigData.imageCache?.preferredFormat || 'Original';
    } finally {
        selectElement.disabled = false;
    }
}


function populateUpdatesPane() {
    logMessage('debug', "[settingsModal] 填充更新面板");
    const pane = settingsContent.querySelector('#settingsUpdates');
    if (!pane) return;
    const versionDisplay = pane.querySelector('#appVersionDisplay');
    if (versionDisplay) {
        getAppVersion().then(version => {
            versionDisplay.textContent = version || t('settings.updates.versionUnknown');
        }).catch(err => {
            logMessage('error', "[settingsModal] 获取应用版本失败 (更新面板):", err);
            versionDisplay.textContent = t('settings.updates.versionError');
        });
    } else {
        logMessage('warn', "[settingsModal] 未找到更新面板中的 #appVersionDisplay 元素");
    }
    // Button listener and status element are handled by setupUpdateSection
}

async function populateAboutPane() { // Make function async
    logMessage('debug', "[settingsModal] 填充关于面板");
    const pane = settingsContent.querySelector('#settingsAbout');
    if (!pane) return;

    // --- 获取元素引用 ---
    const nameEl = pane.querySelector('#package-name');
    const versionEl = pane.querySelector('#package-version');
    const descEl = pane.querySelector('#package-description');
    const authorEl = pane.querySelector('#package-author');
    const licenseEl = pane.querySelector('#package-license');
    const projectAddressEl = pane.querySelector('#project-address');
    const feedbackEmailEl = pane.querySelector('#feedback-email');
    // Remove tech stack element references
    // const electronVersionEl = pane.querySelector('#electron-version');
    // const nodeVersionEl = pane.querySelector('#node-version');
    // const chromeVersionEl = pane.querySelector('#chrome-version');
    // const v8VersionEl = pane.querySelector('#v8-version');
    const appVersionDisplay = pane.querySelector('#appVersionDisplay');
    const checkUpdatesBtn = pane.querySelector('#checkUpdatesBtn');

    // --- 设置初始加载状态 (可选) ---
    const setLoadingText = (el) => { if (el) el.textContent = t('settings.updates.loading'); };
    setLoadingText(nameEl);
    setLoadingText(versionEl);
    setLoadingText(descEl);
    setLoadingText(authorEl);
    setLoadingText(licenseEl);
    setLoadingText(projectAddressEl);
    setLoadingText(feedbackEmailEl);
    // Remove tech stack loading text
    // setLoadingText(electronVersionEl);
    // setLoadingText(nodeVersionEl);
    // setLoadingText(chromeVersionEl);
    // setLoadingText(v8VersionEl);
    setLoadingText(appVersionDisplay);

    try {
        // --- 并行获取信息 (移除 processVersions) ---
        const [packageInfo, appVersion] = await Promise.all([
            getPackageInfo(),
            // getProcessVersions(), // Removed
            getAppVersion()
        ]);
        logMessage('info', "[settingsModal] 获取到的 packageInfo:", packageInfo);
        // logMessage('info', "[settingsModal] 获取到的 processVersions:", processVersions); // Removed
        logMessage('info', "[settingsModal] 获取到的 appVersion:", appVersion);

        // --- 填充 Package Info ---
        if (packageInfo) {
            if (nameEl) nameEl.textContent = packageInfo.name || t('settings.about.valueMissing');
            if (versionEl) versionEl.textContent = packageInfo.version || t('settings.about.valueMissing');
            if (descEl) descEl.textContent = packageInfo.description || t('settings.about.valueMissing');
            if (authorEl) authorEl.textContent = packageInfo.author || t('settings.about.valueMissing');
            if (licenseEl) licenseEl.textContent = packageInfo.license || t('settings.about.valueMissing');

            // 填充项目地址和反馈邮箱
            if (projectAddressEl) {
                let repoUrl = packageInfo.repository?.url || '';
                // 清理 URL: 移除 .git 后缀, 替换 git+ 前缀
                repoUrl = repoUrl.replace(/\.git$/, '').replace(/^git\+/, '');
                if (repoUrl) {
                    projectAddressEl.textContent = repoUrl;
                    projectAddressEl.href = repoUrl;
                } else {
                    projectAddressEl.textContent = t('settings.about.valueMissing');
                    projectAddressEl.removeAttribute('href');
                }
            }
            if (feedbackEmailEl) {
                const email = packageInfo.bugs?.email || '';
                if (email) {
                    feedbackEmailEl.textContent = email;
                    feedbackEmailEl.href = `mailto:${email}`;
                } else {
                    feedbackEmailEl.textContent = t('settings.about.valueMissing');
                    feedbackEmailEl.removeAttribute('href');
                }
            }
            logMessage('info', "[settingsModal] package.json 信息已成功显示 (包括链接)");
        } else {
            logMessage('warn', "[settingsModal] getPackageInfo 返回了 null 或 undefined");
            // Set error text for package info fields
            const setErrorText = (el) => { if (el) el.textContent = t('settings.about.loadError'); };
            setErrorText(nameEl);
            setErrorText(versionEl);
            // ... set error for other package fields ...
            setErrorText(projectAddressEl);
            setErrorText(feedbackEmailEl);
        }

        // --- 填充 App Version ---
        if (appVersionDisplay) {
            appVersionDisplay.textContent = appVersion || t('settings.updates.versionUnknown');
            logMessage('info', `[settingsModal] 应用版本已更新为: ${appVersionDisplay.textContent}`);
        }

    } catch (error) {
        logMessage('error', "[settingsModal] 填充关于面板时获取信息失败:", error);
        // Set error text for all fields if any promise fails
        const setErrorText = (el) => { if (el) el.textContent = t('settings.about.loadError'); };
        setErrorText(nameEl);
        setErrorText(versionEl);
        setErrorText(descEl);
        setErrorText(authorEl);
        setErrorText(licenseEl);
        setErrorText(projectAddressEl);
        setErrorText(feedbackEmailEl);
        // Remove tech stack error text
        // setErrorText(electronVersionEl);
        // setErrorText(nodeVersionEl);
        // setErrorText(chromeVersionEl);
        // setErrorText(v8VersionEl);
        setErrorText(appVersionDisplay);
    }

    // --- 设置更新按钮和状态监听 (保持不变) ---
    if (checkUpdatesBtn) {
        checkUpdatesBtn.removeEventListener('click', handleUpdateButtonClick);
        checkUpdatesBtn.addEventListener('click', handleUpdateButtonClick);
    }
    if (unsubscribeUpdateStatus) {
        unsubscribeUpdateStatus();
    }
    unsubscribeUpdateStatus = onUpdateStatus(handleUpdateStatus);
}

// Removed populateLanguageSetting function as its logic is merged into populateGeneralPane
// --- Data Source Specific Functions ---

/** Renders the list of model sources based on the `tempModelSources` state into #dataSourceList. */
function renderSourceListForSettings() {
    try {
        if (!dataSourceListEl) {
            logMessage('error', "[settingsModal] renderSourceListForSettings 失败：数据源列表元素 (#dataSourceList) 未初始化");
            // 尝试在 settingsContent 区域显示错误提示，避免页面全白
            if (settingsContent) {
                settingsContent.innerHTML = `<div class="feedback error" style="display:block;">${t('settings.modelSources.renderError', { message: '数据源列表元素未初始化' })}</div>`;
            }
            return;
        }
        logMessage('debug', "[settingsModal] 开始渲染数据源列表");

        clearChildren(dataSourceListEl); // Clear existing list items

        if (tempModelSources.length === 0) {
            dataSourceListEl.innerHTML = `<li class="no-sources-message">${t('settings.modelSources.none')}</li>`;
            return;
        }

        tempModelSources.forEach(source => {
            const item = document.createElement('li');
            item.className = 'data-source-item';
            item.dataset.id = source.id; // Store ID for actions

            const typeText = source.type === 'local' ? t('settings.dataSources.typeLocal') : t('settings.dataSources.typeWebdav'); // Use correct key path
            const pathOrUrl = source.type === 'local' ? source.path : source.url;

            // Main content of the list item
            const mainContent = document.createElement('div');
            mainContent.className = 'source-details-actions'; // Wrapper for easier show/hide
            mainContent.innerHTML = `
                <span class="source-name" title="${source.name}">${source.name}</span> <!-- Added title for potential overflow -->
                <span class="source-type">(${typeText})</span>
                <span class="source-path" title="${pathOrUrl}">${pathOrUrl}</span>
                <div class="actions">
                    <button type="button" class="edit-btn btn btn-sm btn-secondary" title="${t('settings.dataSources.edit')}">${t('settings.dataSources.edit')}</button> <!-- Use correct key path -->
                    <button type="button" class="delete-btn btn btn-sm btn-danger" title="${t('settings.dataSources.delete')}">${t('settings.dataSources.delete')}</button> <!-- Use correct key path -->
                </div>
            `;

            // Inline edit form (initially hidden)
            const editForm = document.createElement('div');
            editForm.className = 'edit-form';
            editForm.style.display = 'none';
            // Populate with form fields based on source type - FRAMEWORK ONLY
            editForm.innerHTML = `
                <p><strong>${t('settings.dataSources.editing')}: ${source.name}</strong></p>
                <!-- Actual form fields - Use dataSources path for consistency -->
                <div class="form-group">
                    <label>${t('settings.dataSources.nameLabel')}:</label> <input type="text" class="edit-name" value="${source.name}">
                </div>
                 ${source.type === 'local' ? `
                 <div class="form-group">
                     <label>${t('settings.dataSources.pathLabel')}:</label>
                     <div class="input-group"> <!-- Added input-group wrapper -->
                         <input type="text" class="edit-path" value="${source.path}">
                         <button type="button" class="browse-inline-btn btn btn-secondary" title="${t('settings.dataSources.browse')}">${t('settings.dataSources.browseShort', '...')}</button> <!-- Use btn-secondary like add form -->
                     </div>
                 </div>
                 ` : `
                 <div class="form-group">
                     <label>${t('settings.dataSources.urlLabel')}:</label> <input type="text" class="edit-url" value="${source.url}">
                 </div>
                 <div class="form-group">
                     <label>${t('settings.dataSources.usernameLabel')}:</label> <input type="text" class="edit-username" value="${source.username || ''}">
                 </div>
                  <div class="form-group">
                     <label>${t('settings.dataSources.passwordLabel')}:</label> <input type="password" class="edit-password" placeholder="${t('settings.dataSources.passwordPlaceholder', 'Enter new password to change')}">
                 </div>
                 <div class="form-group">
                     <label>${t('settings.modelSources.webdav.subdirectoryLabel', 'Subdirectory (Optional)')}:</label>
                     <input type="text" class="edit-subdirectory" value="${source.subDirectory || ''}" placeholder="/optional/path/on/server">
                     <small>${t('settings.modelSources.webdav.subdirectoryHint', 'Specify a subdirectory on the server as root, must start with /')}</small>
                 </div>
                 `}
                <div class="form-group form-check">
                    <input type="checkbox" class="form-check-input edit-readOnly" ${source.readOnly ? 'checked' : ''}>
                    <label class="form-check-label" data-i18n-key="settings.modelSources.readOnlyLabel"></label>
                </div>
                <div class="inline-actions">
                    <button type="button" class="save-inline-btn btn btn-sm btn-primary" title="${t('settings.save')}">${t('settings.save')}</button>
                    <button type="button" class="cancel-inline-btn btn btn-sm btn-secondary" title="${t('settings.cancel')}">${t('settings.cancel')}</button>
                </div>
            `;

            item.appendChild(mainContent);
            item.appendChild(editForm);
            dataSourceListEl.appendChild(item);
        });
        logMessage('debug', "[settingsModal] 数据源列表渲染完成");
    } catch (err) {
        logMessage('error', "[settingsModal] 渲染数据源列表时发生异常：", err);
        if (settingsContent) {
            settingsContent.innerHTML = `<div class="feedback error" style="display:block;">${t('settings.modelSources.renderError', { message: err.message })}</div>`;
        }
    }
}

/** Handles showing the inline edit form for a data source. */
function handleEditSourceInline(listItem) {
     if (!listItem) return;
     logMessage('debug', `[settingsModal] 显示行内编辑表单: ${listItem.dataset.id}`);
     // Hide main content, show edit form
     const mainContent = listItem.querySelector('.source-details-actions');
     const editForm = listItem.querySelector('.edit-form');
     if (mainContent) mainContent.style.display = 'none';
     if (editForm) {
         editForm.style.display = 'block';
         // 修复：显示编辑表单后，立即刷新 i18n，确保只读标签等内容正常显示
         if (typeof updateUIWithTranslations === 'function') {
             updateUIWithTranslations(editForm);
         }
     }
     // TODO: Potentially fetch fresh data or ensure form fields are correct
}

/** Handles saving changes from the inline edit form. */
function handleSaveSourceInline(listItem) {
    if (!listItem) return;
    const sourceId = listItem.dataset.id;
    logMessage('info', `[settingsModal] 尝试保存行内编辑: ${sourceId}`);
    const editForm = listItem.querySelector('.edit-form');
    if (!editForm) return;

    const sourceIndex = tempModelSources.findIndex(s => s.id === sourceId);
    if (sourceIndex === -1) {
        logMessage('error', `[settingsModal] 行内保存失败：未找到源 ID ${sourceId}`);
        return;
    }

    const originalSource = tempModelSources[sourceIndex];
    const updatedSource = { ...originalSource }; // Clone to modify

    // --- Collect data from inline form ---
    const nameInput = editForm.querySelector('.edit-name');
    if (nameInput) updatedSource.name = nameInput.value.trim();

    if (updatedSource.type === 'local') {
        const pathInput = editForm.querySelector('.edit-path');
        if (pathInput) updatedSource.path = pathInput.value.trim();
        // TODO: Add validation if needed
    } else if (updatedSource.type === 'webdav') {
        const urlInput = editForm.querySelector('.edit-url');
        const usernameInput = editForm.querySelector('.edit-username');
        const passwordInput = editForm.querySelector('.edit-password'); // Note: Password might be empty if not changed
        if (urlInput) updatedSource.url = urlInput.value.trim();
        if (usernameInput) updatedSource.username = usernameInput.value.trim();
        if (passwordInput && passwordInput.value) { // Only update password if field is not empty
            updatedSource.password = passwordInput.value;
        } else {
             // If password field is empty, keep the original password (or lack thereof)
             // delete updatedSource.password; // Or ensure it remains undefined/null if that's the convention
             updatedSource.password = originalSource.password; // Explicitly keep original
        }
        const subdirectoryInput = editForm.querySelector('.edit-subdirectory');
        if (subdirectoryInput) {
            const subDirectoryValue = subdirectoryInput.value.trim();
            if (subDirectoryValue && !subDirectoryValue.startsWith('/')) {
                // TODO: Show validation error within the inline form
                logMessage('error', `[settingsModal] 行内保存验证失败 (WebDAV): 子目录必须以 / 开头 - ${subDirectoryValue}`);
                alert(t('settings.validation.subdirectoryInvalidFormat')); // Simple alert for now
                subdirectoryInput.focus();
                return; // Stop saving
            }
            if (subDirectoryValue) {
                updatedSource.subDirectory = subDirectoryValue;
            } else {
                delete updatedSource.subDirectory; // Remove if empty
            }
        }
        // TODO: Add other WebDAV validation if needed (e.g., URL format)
    }

    // Read readOnly state from checkbox
    const readOnlyCheckbox = editForm.querySelector('.edit-readOnly');
    if (readOnlyCheckbox) updatedSource.readOnly = readOnlyCheckbox.checked;

    // --- Update temporary state and re-render ---
    logMessage('debug', `[settingsModal] 更新后的行内数据:`, updatedSource);
    tempModelSources[sourceIndex] = updatedSource;
    renderSourceListForSettings(); // Re-render the entire list to reflect changes

    // Note: The list re-render will automatically hide the edit form.
    // If a more targeted update is needed later, adjust this.
    // 修复：将保存成功提示显示在当前编辑表单内部，避免全局布局异常
    showFeedback(listItem.querySelector('.edit-form'), t('settings.modelSources.inlineSaveSuccess'), 'success', 1500);
}

/** Handles canceling the inline edit form. */
function handleCancelSourceInline(listItem) {
     if (!listItem) return;
     logMessage('debug', `[settingsModal] 取消行内编辑: ${listItem.dataset.id}`);
     // Hide edit form, show main content
     const mainContent = listItem.querySelector('.source-details-actions');
     const editForm = listItem.querySelector('.edit-form');
     if (editForm) editForm.style.display = 'none';
     if (mainContent) mainContent.style.display = ''; // Reset display
     // No data changes needed, just UI reset
}


/** Handles the deletion of a model source from the temporary list. */
function handleDeleteSource(sourceId) {
    logMessage('info', `[settingsModal] 尝试删除临时列表中的数据源: ${sourceId}`);
    const sourceToDelete = tempModelSources.find(s => s.id === sourceId);
    const sourceName = sourceToDelete?.name || sourceId;

    showConfirmationDialog(
        t('settings.modelSources.deleteConfirm', { name: sourceName }),
        () => { // onConfirm callback
            logMessage('info', `[settingsModal] 用户确认删除数据源: ${sourceId} (${sourceName})`);
            const index = tempModelSources.findIndex(s => s.id === sourceId);
            if (index !== -1) {
                tempModelSources.splice(index, 1);
                logMessage('info', `[settingsModal] 已从临时列表中删除数据源: ${sourceId}`);
                renderSourceListForSettings(); // Re-render the list
            } else {
                logMessage('error', `[settingsModal] 删除失败：在临时列表中未找到数据源 ID: ${sourceId} (确认后)`);
            }
        },
        () => { // onCancel callback
            logMessage('info', `[settingsModal] 用户取消删除数据源: ${sourceId} (${sourceName})`);
        } // Closing brace for onCancel callback
    ); // Closing parenthesis for showConfirmationDialog
} // Closing brace for handleDeleteSource function

// --- Add Data Source Form Functions ---

/** Shows the form to add a new data source below the list. */
function showAddDataSourceForm() {
    if (!addDataSourceFormContainer) {
        logMessage('error', "[settingsModal] 无法显示添加表单：容器元素未找到");
        return;
    }
    logMessage('debug', "[settingsModal] 显示添加数据源表单");

    // Clear previous content and create the form
    clearChildren(addDataSourceFormContainer);
    addDataSourceFormContainer.style.display = 'block';

    const form = document.createElement('form');
    form.id = 'addSourceForm'; // Give it an ID for potential styling/selection
    form.innerHTML = `
        <h4 data-i18n-key="settings.modelSources.addTitle"></h4>
        <div class="form-group">
            <label for="addSourceName" data-i18n-key="settings.modelSources.nameLabel"></label>
            <input type="text" id="addSourceName" required>
        </div>
        <div class="form-group">
            <label for="addSourceType" data-i18n-key="settings.modelSources.typeLabel"></label>
            <select id="addSourceType" required>
                <option value="local" data-i18n-key="settings.modelSources.typeLocal"></option>
                <option value="webdav" data-i18n-key="settings.modelSources.typeWebdav"></option>
            </select>
        </div>

        <!-- Fields for Local Type -->
        <div id="addSourceLocalFields" class="form-group source-type-fields">
            <label for="addSourcePath" data-i18n-key="settings.modelSources.pathLabel"></label>
            <div class="input-group">
                <input type="text" id="addSourcePath" required>
                <button type="button" id="addSourceBrowseBtn" class="btn btn-secondary" data-i18n-key="settings.modelSources.browse"></button>
            </div>
        </div>

        <!-- Fields for WebDAV Type -->
        <div id="addSourceWebdavFields" class="form-group source-type-fields" style="display: none;">
            <div class="form-group">
                <label for="addSourceUrl" data-i18n-key="settings.modelSources.urlLabel"></label>
                <input type="url" id="addSourceUrl" required data-i18n-key="[placeholder]settings.modelSources.urlPlaceholder" placeholder="https://example.com/webdav/">
            </div>
            <div class="form-group">
                <label for="addSourceUsername" data-i18n-key="settings.modelSources.usernameLabel"></label>
                <input type="text" id="addSourceUsername">
            </div>
            <div class="form-group">
                <label for="addSourcePassword" data-i18n-key="settings.modelSources.passwordLabel"></label>
                <input type="password" id="addSourcePassword">
            </div>
            <div class="form-group">
                <label for="addSourceSubdirectory" data-i18n-key="settings.modelSources.webdav.subdirectoryLabel">Subdirectory (Optional):</label>
                <input type="text" id="addSourceSubdirectory" placeholder="/optional/path/on/server">
                <small data-i18n-key="settings.modelSources.webdav.subdirectoryHint">Specify a subdirectory on the server as root, must start with /</small>
            </div>
        </div>

        <div class="form-group form-check">
            <input type="checkbox" class="form-check-input" id="addSourceReadOnly">
            <label class="form-check-label" for="addSourceReadOnly" data-i18n-key="settings.modelSources.readOnlyLabel"></label>
        </div>

        <div class="form-actions">
             <div id="addSourceFeedback" class="feedback" style="margin-bottom: 10px;"></div> <!-- Feedback Area -->
            <button type="submit" class="btn btn-primary" data-i18n-key="settings.modelSources.addSource"></button>
            <button type="button" id="addSourceCancelBtn" class="btn btn-secondary" data-i18n-key="settings.cancel"></button>
        </div>
    `;

    addDataSourceFormContainer.appendChild(form);
    updateUIWithTranslations(form); // Apply translations to the new form

    // --- Add Event Listeners for the new form ---

    // Type selector change
    const typeSelect = form.querySelector('#addSourceType');
    const localFields = form.querySelector('#addSourceLocalFields');
    const webdavFields = form.querySelector('#addSourceWebdavFields');
    const pathInput = form.querySelector('#addSourcePath');
    const urlInput = form.querySelector('#addSourceUrl');
    const subdirectoryField = webdavFields.querySelector('#addSourceSubdirectory').closest('.form-group'); // Find the subdirectory form group

    typeSelect.addEventListener('change', (event) => {
        const isLocal = event.target.value === 'local';
        localFields.style.display = isLocal ? '' : 'none';
        webdavFields.style.display = isLocal ? 'none' : '';
        // Toggle required attribute based on visibility
        pathInput.required = isLocal;
        urlInput.required = !isLocal;
        // Subdirectory field is never required, just shown/hidden
        if (subdirectoryField) {
            subdirectoryField.style.display = isLocal ? 'none' : ''; // Show only for WebDAV
        }
        logMessage('debug', `[settingsModal] 添加表单类型切换为: ${event.target.value}`);
    });
    // Initial setup based on default selection
    const initialIsLocal = typeSelect.value === 'local';
    localFields.style.display = initialIsLocal ? '' : 'none';
    webdavFields.style.display = initialIsLocal ? 'none' : '';
    pathInput.required = initialIsLocal;
    urlInput.required = !initialIsLocal;
    if (subdirectoryField) {
        subdirectoryField.style.display = initialIsLocal ? 'none' : ''; // Hide initially if local is default
    }


    // Browse button click
    const browseBtn = form.querySelector('#addSourceBrowseBtn');
    browseBtn.addEventListener('click', handleAddBrowse);

    // Form submission
    form.addEventListener('submit', handleAddDataSourceSubmit);

    // Cancel button click
    const cancelBtn = form.querySelector('#addSourceCancelBtn');
    cancelBtn.addEventListener('click', handleAddDataSourceCancel);

    // Hide the main "Add Data Source" button while the form is shown
    if (addDataSourceBtn) addDataSourceBtn.style.display = 'none';
}

/** Hides the add data source form and shows the main add button again. */
function hideAddDataSourceForm() {
    if (addDataSourceFormContainer) {
        clearChildren(addDataSourceFormContainer);
        addDataSourceFormContainer.style.display = 'none';
    }
     if (addDataSourceBtn) addDataSourceBtn.style.display = ''; // Show the main button again
     logMessage('debug', "[settingsModal] 隐藏添加数据源表单");
}

/** Handles the submission of the add data source form. */
function handleAddDataSourceSubmit(event) {
    event.preventDefault(); // Prevent default form submission
    logMessage('info', "[settingsModal] 尝试提交添加数据源表单");
    const form = event.target;
    const feedbackArea = form.querySelector('#addSourceFeedback');
    clearFeedback(feedbackArea);

    const name = form.querySelector('#addSourceName').value.trim();
    const type = form.querySelector('#addSourceType').value;

    if (!name) {
        showFeedback(feedbackArea, t('settings.validation.nameRequired'), 'error');
        form.querySelector('#addSourceName').focus();
        return;
    }

    const readOnly = form.querySelector('#addSourceReadOnly').checked;

    const newSource = {
        id: crypto.randomUUID(), // Generate a unique ID
        name: name,
        type: type,
        readOnly: readOnly, // 添加 readOnly 属性
    };

    if (type === 'local') {
        const path = form.querySelector('#addSourcePath').value.trim();
        if (!path) {
            showFeedback(feedbackArea, t('settings.validation.pathRequired'), 'error');
            form.querySelector('#addSourcePath').focus();
            return;
        }
        newSource.path = path;
    } else if (type === 'webdav') {
        const url = form.querySelector('#addSourceUrl').value.trim();
        const username = form.querySelector('#addSourceUsername').value.trim();
        const password = form.querySelector('#addSourcePassword').value; // Don't trim password

        if (!url) {
             showFeedback(feedbackArea, t('settings.validation.urlRequired'), 'error');
             form.querySelector('#addSourceUrl').focus();
             return;
        }
         // Basic URL validation (can be improved)
        try {
            new URL(url); // Check if it's a valid URL structure
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                 throw new Error(t('settings.validation.urlSchemeInvalid')); // Use translation key
            }
        } catch (e) {
            logMessage('warn', `[settingsModal] WebDAV URL 验证失败: ${url}`, e.message);
            showFeedback(feedbackArea, t('settings.validation.urlInvalid', { message: e.message }), 'error');
            form.querySelector('#addSourceUrl').focus();
            return;
        }

        newSource.url = url;
        if (username) newSource.username = username;
        if (password) newSource.password = password; // Only add password if provided

        const subdirectoryInput = form.querySelector('#addSourceSubdirectory');
        const subDirectoryValue = subdirectoryInput.value.trim();
        if (subDirectoryValue && !subDirectoryValue.startsWith('/')) {
            showFeedback(feedbackArea, t('settings.validation.subdirectoryInvalidFormat'), 'error');
            subdirectoryInput.focus();
            return;
        }
        if (subDirectoryValue) {
            newSource.subDirectory = subDirectoryValue;
        }
        // No need to delete if empty, as it wasn't added in the first place
    }

    logMessage('info', "[settingsModal] 创建新的数据源对象:", newSource);

    // Add to temporary list and re-render
    tempModelSources.push(newSource);
    renderSourceListForSettings();

    // Hide the form and show success feedback (maybe on the main pane?)
    hideAddDataSourceForm();
    // Show feedback in the dedicated area within the data sources pane
    const paneFeedbackArea = settingsContent.querySelector('#settingsDataSources #dataSourceFeedbackArea');
    if (paneFeedbackArea) {
        showFeedback(paneFeedbackArea, t('settings.modelSources.addSuccess', { name: newSource.name }), 'success', 2000);
    } else {
        logMessage('warn', '[settingsModal] 未找到数据源面板的反馈区域 (#dataSourceFeedbackArea)，无法显示添加成功消息。');
        // Fallback: maybe use alert or log? For now, just log.
    }
}

/** Handles the cancellation of the add data source form. */
function handleAddDataSourceCancel() {
    logMessage('info', "[settingsModal] 取消添加数据源表单");
    hideAddDataSourceForm();
}

/** Handles the 'Browse...' button click for the add form. */
async function handleAddBrowse() {
    logMessage('debug', "[settingsModal] 点击添加表单的浏览按钮");
    const pathInput = addDataSourceFormContainer.querySelector('#addSourcePath');
    if (!pathInput) return;

    try {
        const selectedPath = await openFolderDialog({ // Correct API function call
            properties: ['openDirectory']
        });
        // Check if a non-empty string path was returned
        if (typeof selectedPath === 'string' && selectedPath.trim() !== '') {
            logMessage('info', `[settingsModal] 用户选择的目录 (添加表单): ${selectedPath}`);
            pathInput.value = selectedPath;
        } else {
             logMessage('debug', "[settingsModal] 用户取消了目录选择或未返回有效路径 (添加表单)");
        }
    } catch (error) {
        logMessage('error', "[settingsModal] 浏览目录时出错 (添加表单):", error);
        // Show error feedback in the add form's feedback area
        const feedbackArea = addDataSourceFormContainer.querySelector('#addSourceFeedback');
        if(feedbackArea) {
            showFeedback(feedbackArea, t('settings.browseError', { message: error.message }), 'error');
        }
    }
}

// --- Inline Edit Browse Function ---
/** Handles the 'Browse...' button click for the inline edit form. */
async function handleBrowseInline(listItem) {
     if (!listItem) return;
     const sourceId = listItem.dataset.id;
     logMessage('debug', `[settingsModal] 点击行内编辑的浏览按钮: ${sourceId}`);
     const pathInput = listItem.querySelector('.edit-form .edit-path');
     if (!pathInput) {
         logMessage('warn', `[settingsModal] 未找到 ID ${sourceId} 的行内编辑路径输入框`);
         return;
     }
 
     try {
         const selectedPath = await openFolderDialog({ // Correct API function call
             properties: ['openDirectory'],
             defaultPath: pathInput.value || undefined // Start browsing from current path if set
         });
         // Check if a non-empty string path was returned
         if (typeof selectedPath === 'string' && selectedPath.trim() !== '') {
            logMessage('info', `[settingsModal] 用户选择的目录 (行内编辑 ${sourceId}): ${selectedPath}`);
            pathInput.value = selectedPath;
        } else {
             logMessage('debug', `[settingsModal] 用户取消了目录选择或未返回有效路径 (行内编辑 ${sourceId})`);
        }
    } catch (error) {
        logMessage('error', `[settingsModal] 浏览目录时出错 (行内编辑 ${sourceId}):`, error);
        // Show error feedback within the inline form? Needs a dedicated area or use alert.
        // For now, log it. Consider adding a small feedback span in the inline form later.
        alert(t('settings.browseError', { message: error.message })); // Simple alert for now
    }
}

// 移除 handleSourceSaved 函数


/** Handles saving the settings for a specific section/pane. */
async function handleSaveSection(category, paneElement) {
    if (!paneElement || !currentConfigData) {
        logMessage('error', `[settingsModal] 保存失败：缺少必要参数 paneElement=${!!paneElement}, currentConfigData=${!!currentConfigData}`);
        return;
    }
    logMessage('info', `[settingsModal] 开始保存分区: ${category}`);
    const saveButton = paneElement.querySelector('.settings-save-section');
    // Find the dedicated feedback area within the pane using specific IDs where possible
    let feedbackArea;
    if (category === 'data-sources') {
        feedbackArea = paneElement.querySelector('#dataSourceFeedbackArea');
    } else if (category === 'general') {
        feedbackArea = paneElement.querySelector('#generalFeedbackArea');
    } else if (category === 'file-recognition') { // Be explicit for known panes
        feedbackArea = paneElement.querySelector('#fileRecognitionFeedbackArea');
    } else if (category === 'image-cache') { // Explicitly target the correct ID
        feedbackArea = paneElement.querySelector('#imageCacheFeedbackArea'); // <-- Use the specific ID
    } else {
        // Fallback for truly unknown sections, though unlikely
        feedbackArea = paneElement.querySelector('.feedback-area');
        if (!feedbackArea) { // Add a specific log if fallback fails
             logMessage('warn', `[settingsModal] 未能为未知分区 ${category} 找到通用的 .feedback-area`);
        }
    }
    const startTime = Date.now();

    // Check if feedback area exists (now more robust and with specific error message)
    if (!feedbackArea) {
        // Construct a more specific error message based on the category
        const expectedId = category === 'data-sources' ? '#dataSourceFeedbackArea' :
                           category === 'general' ? '#generalFeedbackArea' :
                           category === 'file-recognition' ? '#fileRecognitionFeedbackArea' :
                           category === 'image-cache' ? '#imageCacheFeedbackArea' :
                           '.feedback-area (fallback)'; // Default message part
        logMessage('error', `[settingsModal] 保存分区 ${category} 失败：未找到预期的反馈元素 (${expectedId})。`);
        // Optionally show an alert or log, but don't proceed with saving if feedback area is crucial
        // For now, just log and return to prevent further errors using a null feedbackArea
        return;
    }

    if (saveButton) {
        saveButton.disabled = true;
        saveButton.textContent = t('settings.saving');
    }
    clearFeedback(feedbackArea); // Clear previous feedback in this pane

    try {
        // Create a partial config object to send
        const configUpdate = {};
        let validationFailed = false;

        switch (category) {
            case 'data-sources':
                // Use the temporary list directly
                configUpdate.modelSources = tempModelSources;
                logMessage('debug', `[settingsModal] 保存数据源:`, configUpdate.modelSources);
                break;
            case 'general':
                const langSelect = paneElement.querySelector('#languageSelector');
                if (langSelect) {
                    configUpdate.locale = langSelect.value;
                    logMessage('debug', `[settingsModal] 保存常规设置 - 语言: ${configUpdate.language}`);
                } else {
                    logMessage('warn', `[settingsModal] 保存常规设置失败：未找到 #languageSelector`);
                    // Decide if this should be a validation failure
                }
                // Add logic here if other general settings are added in the future
                break;
            case 'file-recognition':
                const extensionsText = paneElement.querySelector('#supportedFileExtensions')?.value || ''; // Corrected ID
                const extensionsArray = extensionsText.split(',')
                    .map(ext => ext.trim().toLowerCase()) // Normalize to lowercase
                    .filter(ext => ext.length > 0 && ext.startsWith('.')); // Basic validation: non-empty and starts with '.'
                // Further validation could be added here (e.g., regex for valid chars)
                configUpdate.supportedExtensions = extensionsArray;
                logMessage('debug', `[settingsModal] 保存文件识别扩展名:`, configUpdate.supportedExtensions);
                break;
            case 'image-cache':
                configUpdate.imageCache = { ...(currentConfigData.imageCache || {}) }; // Start with existing cache settings
                const sizeInput = paneElement.querySelector('#imageCacheSizeLimit');
                const qualityInput = paneElement.querySelector('#imageCacheCompressQuality');

                const size = parseInt(sizeInput?.value || '500', 10);
                const quality = parseInt(qualityInput?.value || '80', 10);

                // Validate Size
                if (isNaN(size) || size < 0) {
                    const errorMsg = t('settings.validation.sizeError');
                    logMessage('error', `[settingsModal] 保存图片缓存失败：大小验证错误 - ${errorMsg}`);
                    showFeedback(feedbackArea, errorMsg, 'error');
                    sizeInput?.focus();
                    validationFailed = true;
                }

                // Validate Quality
                if (isNaN(quality) || quality < 0 || quality > 100) {
                    const errorMsg = t('settings.validation.qualityError'); // Need to add this key to locales
                    logMessage('error', `[settingsModal] 保存图片缓存失败：质量验证错误 - ${errorMsg}`);
                    // Show feedback only if size validation passed or focus quality input
                    if (!validationFailed) {
                        showFeedback(feedbackArea, errorMsg, 'error');
                        qualityInput?.focus();
                    }
                    validationFailed = true;
                }

                if (!validationFailed) {
                    configUpdate.imageCache.maxCacheSizeMB = size;
                    configUpdate.imageCache.compressQuality = quality;
                    // preferredFormat is saved separately via handleFormatChange
                }
                logMessage('debug', `[settingsModal] 保存图片缓存设置 (大小和质量):`, configUpdate.imageCache);
                break;
            // Updates and About typically don't have save buttons
            default:
                logMessage('warn', `[settingsModal] 未知的保存分区: ${category}`);
                return; // Don't proceed if category is unknown
        } // End of switch(category)

        // --- Perform validation check AFTER collecting data from the switch ---
        if (validationFailed) {
             logMessage('error', `[settingsModal] 保存分区 ${category} 因验证失败而中止`);
             throw new Error(t('settings.validation.failed')); // Throw error to be caught by outer catch block
        }

        // --- If validation passed, proceed to merge and save ---

        // Merge partial update with existing config before saving
        // Note: saveConfig expects the *full* config object.
        // We need to merge our changes into the last known full config.
        const fullConfigToSend = { ...currentConfigData, ...configUpdate };

        // Special case for modelSources: ensure it uses the temp list
        if (category === 'data-sources') {
            fullConfigToSend.modelSources = tempModelSources;
        }
         // Special case for imageCache: ensure it merges correctly
         if (category === 'image-cache' && configUpdate.imageCache) {
             fullConfigToSend.imageCache = { ...(currentConfigData.imageCache || {}), ...configUpdate.imageCache };
         }


        logMessage('info', `[settingsModal] 调用 API 保存配置 (分区: ${category})`, fullConfigToSend);
        const apiStartTime = Date.now();
        await saveConfig(fullConfigToSend); // Send the merged full config
        const apiDuration = Date.now() - apiStartTime;
        logMessage('info', `[settingsModal] API 保存配置成功 (分区: ${category}), 耗时: ${apiDuration}ms`);

        // Update our local copy of the config
        currentConfigData = fullConfigToSend;

        // If we're saving data sources, we need to refresh the main UI
        if (category === 'data-sources') {
            // If the UI will be automatically refreshed via onConfigUpdated event in main.js
            // we can ensure that it selects a valid source ID, especially if none was selected before
            // We can use a custom event for this specific situation
            try {
                const sourceSelect = document.getElementById('sourceSelect');
                const hasModelLibraries = tempModelSources && tempModelSources.length > 0;
                const wasSourceSelected = sourceSelect && sourceSelect.value;
                
                if (hasModelLibraries && !wasSourceSelected) {
                    // Dispatch a custom event to notify that we need to load the first source
                    window.dispatchEvent(new CustomEvent('load-first-source', {
                        detail: { firstSourceId: tempModelSources[0].id }
                    }));
                    logMessage('info', `[settingsModal] 触发加载第一个模型库: ${tempModelSources[0].id}`);
                }
            } catch (refreshError) {
                logMessage('error', '[settingsModal] 保存后刷新主界面失败:', refreshError.message, refreshError.stack);
                // This is non-fatal, the config was already saved
            }
        }

        const duration = Date.now() - startTime;
        logMessage('info', `[settingsModal] 分区 ${category} 保存成功, 总耗时: ${duration}ms`);
        showFeedback(feedbackArea, t('settings.saveSectionSuccess'), 'success', 2000); // Use the found feedbackArea
        // Optionally close Model after saving a section? Or just show feedback.

    } catch (error) {
        const duration = Date.now() - startTime;
        logMessage('error', `[settingsModal] 保存分区 ${category} 失败, 总耗时: ${duration}ms`, error.message, error.stack, error);
        // Show feedback only if validation didn't already (check the specific feedbackArea)
        if (!feedbackArea.classList.contains('feedback-error')) { // Check class on the feedbackArea itself
             showFeedback(feedbackArea, t('settings.saveError', { message: error.message }), 'error'); // Use the found feedbackArea
        }
    } finally {
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.textContent = t('settings.save'); // Or specific text like "Save Data Sources"
        }
    }
}


/** Handles the change event for the language select dropdown. */
async function handleLanguageChange(event) {
    const newLocale = event.target.value;
    const currentLocale = getCurrentLocale();
    logMessage('info', `[UI] 切换语言设置: 从 ${currentLocale} 到 ${newLocale}`);

    // Store the currently active category *before* potential UI changes
    const activeNav = settingsNav?.querySelector('a.nav-item.active');
    const activeCategoryBeforeChange = activeNav?.dataset.category;
    logMessage('debug', `[settingsModal] Active category before language change: ${activeCategoryBeforeChange}`);

    if (newLocale !== currentLocale) {
        setLoading(true); // Show loading indicator
        const generalPaneBefore = settingsContent?.querySelector('#settingsGeneral');
        logMessage('debug', `[settingsModal] Before loadLocale/updateUI, #settingsGeneral innerHTML: ${generalPaneBefore?.innerHTML?.substring(0, 100)}...`);
        try {
            logMessage('info', `[settingsModal] 调用 loadLocale 加载新语言: ${newLocale}`);
            await loadLocale(newLocale); // Re-enable save on language change (default is true)
            logMessage('info', `[settingsModal] loadLocale 完成，调用 updateUIWithTranslations 更新 UI`);
            updateUIWithTranslations(); // Update the entire UI
            logMessage('info', `[settingsModal] 语言切换和 UI 更新成功: ${newLocale}`);
            const generalPaneAfter = settingsContent?.querySelector('#settingsGeneral');
            logMessage('debug', `[settingsModal] After loadLocale/updateUI, #settingsGeneral innerHTML: ${generalPaneAfter?.innerHTML?.substring(0, 100)}...`);
            // Update the dropdown in settings if it's open
            const langSelect = settingsContent?.querySelector('#settingsLanguageSelect'); // Corrected ID based on HTML
            if (langSelect) {
                 langSelect.value = newLocale;
            }
            // Show feedback in the General pane
            const generalPane = settingsContent?.querySelector('#settingsGeneral');
            const feedbackArea = generalPane?.querySelector('#generalFeedbackArea'); // Find the specific feedback area
            if (feedbackArea) { // Check if feedbackArea exists
                showFeedback(feedbackArea, t('settings.general.changeSuccess', { lang: newLocale }), 'info', 1500); // Pass feedbackArea instead of generalPane
            } else if (generalPane) {
                // Fallback or log error if feedback area is missing
                 logMessage('warn', '[settingsModal] #generalFeedbackArea not found in #settingsGeneral. Cannot display language change feedback.');
            }
        } catch (error) {
            logMessage('error', `[settingsModal] 切换语言失败: ${newLocale}`, error.message, error.stack);
             const generalPane = settingsContent?.querySelector('#settingsGeneral');
             if (generalPane) {
                 showFeedback(generalPane, t('settings.general.changeError', { message: error.message }), 'error');
             }
            // Revert dropdown selection if loading failed?
            event.target.value = currentLocale;
        } finally {
            setLoading(false); // Hide loading indicator

            // --- Re-ensure the correct pane is visible after UI update ---
            if (activeCategoryBeforeChange && settingsContent) {
                const targetPane = settingsContent.querySelector(`.settings-pane[data-category="${activeCategoryBeforeChange}"]`);
                if (targetPane) {
                    // Ensure all panes are hidden first (in case updateUI messed up)
                    settingsContent.querySelectorAll('.settings-pane').forEach(pane => {
                        if (pane !== targetPane) { // Don't hide the target pane yet
                            pane.style.display = 'none';
                        }
                    });
                    // Then ensure the target pane is visible
                    targetPane.style.display = ''; // Reset to default (usually block or flex)
                    logMessage('info', `[settingsModal] 语言切换后，已确保面板 '${activeCategoryBeforeChange}' 可见`);
                } else {
                    logMessage('warn', `[settingsModal] 语言切换后，无法找到目标面板: ${activeCategoryBeforeChange}`);
                    // Fallback: maybe show the default 'data-sources' pane?
                    switchSettingsTab('data-sources');
                }
            } else {
                 logMessage('warn', `[settingsModal] 语言切换后，无法确定先前活动的面板类别`);
                 // Fallback: show default
                 switchSettingsTab('data-sources');
            }
            // --- End of visibility fix ---

            const generalPaneFinal = settingsContent?.querySelector('#settingsGeneral');
            logMessage('debug', `[settingsModal] handleLanguageChange finally #settingsGeneral display: ${generalPaneFinal?.style.display}, innerHTML: ${generalPaneFinal?.innerHTML?.substring(0,100)}...`);
        }
        // This log might be less relevant now as we explicitly set the display style above
        // logMessage('debug', `[settingsModal] handleLanguageChange 结束时 #settingsGeneral display: ${settingsContent?.querySelector('#settingsGeneral')?.style.display}, innerHTML: ${settingsContent?.querySelector('#settingsGeneral')?.innerHTML?.substring(0,100)}...`);
    } else {
        logMessage('debug', '[settingsModal] 选择的语言与当前语言相同，无需操作');
    }
}

// ===== Image Cache Handling Functions =====

/** Handles the click event for the "Clear Image Cache" button. */
async function handleClearImageCache() {
    if (!clearImageCacheBtn || !clearCacheStatusEl) {
        logMessage('error', "[settingsModal] 清除缓存失败：按钮或状态元素未找到");
        return;
    }
    logMessage('info', "[UI] 点击了清除图片缓存按钮");

    clearImageCacheBtn.disabled = true;
    clearCacheStatusEl.textContent = t('settings.imageCache.clearing');
    clearCacheStatusEl.className = 'status-message info'; // Use info class

    try {
        logMessage('info', "[settingsModal] 调用 clearImageCache API...");
        const result = await clearImageCache(); // Call the imported async function
        logMessage('info', "[settingsModal] clearImageCache API 返回结果:", result);

        if (result.success) {
            clearCacheStatusEl.textContent = t('settings.imageCache.clearSuccess');
            clearCacheStatusEl.className = 'status-message success';
            logMessage('info', '[settingsModal] 图片缓存已成功清除。');
            // Optionally update cache size display if available
        } else {
            const errorMessage = result.error || t('settings.imageCache.unknownError'); // Use unknown error key as fallback
            clearCacheStatusEl.textContent = t('settings.imageCache.clearError', { message: errorMessage });
            clearCacheStatusEl.className = 'status-message error';
            logMessage('error', `[settingsModal] 清除图片缓存失败: ${errorMessage}`);
        }
    } catch (error) {
        logMessage('error', "[settingsModal] 调用 clearImageCache 时发生意外错误:", error.message, error.stack);
        clearCacheStatusEl.textContent = t('settings.imageCache.clearError', { message: error.message });
        clearCacheStatusEl.className = 'status-message error';
    } finally {
        clearImageCacheBtn.disabled = false;
        // Optionally clear the success/info message after a delay, keep errors visible longer?
        setTimeout(() => {
            // Only clear non-error messages automatically
            if (clearCacheStatusEl && !clearCacheStatusEl.classList.contains('error')) {
                 clearCacheStatusEl.textContent = '';
                 clearCacheStatusEl.className = 'status-message';
            }
        }, 3000); // Keep error messages until user interacts again or pane is hidden
    }
}


// ===== Update Handling Functions =====

/** Sets up event listeners and subscribes to updates for the Update pane. */
function setupUpdateSection() {
    const pane = settingsContent.querySelector('#settingsUpdates');
    if (!pane) {
        logMessage('warn', "[settingsModal] 无法设置更新部分：面板未找到");
        return;
    }

    updateStatusInfoEl = pane.querySelector('#updateStatusInfo'); // Corrected ID
    checkUpdatesBtn = pane.querySelector('#checkUpdatesBtn'); // Corrected ID

    if (!updateStatusInfoEl || !checkUpdatesBtn) {
        logMessage('error', "[settingsModal] 初始化更新 UI 失败：状态 (#updateStatusInfo) 或按钮 (#checkUpdatesBtn) 元素在更新面板中未找到");
        return;
    }

    // Remove previous listener before adding a new one
    checkUpdatesBtn.removeEventListener('click', handleUpdateButtonClick);
    checkUpdatesBtn.addEventListener('click', handleUpdateButtonClick);

    // Register listener for update status changes from main process
    // Ensure previous listener is removed if Model is reopened/pane reshown
    if (unsubscribeUpdateStatus) {
        unsubscribeUpdateStatus();
        unsubscribeUpdateStatus = null; // Reset before re-subscribing
    }
    unsubscribeUpdateStatus = onUpdateStatus(handleUpdateStatus);
    logMessage('info', "[settingsModal] 已订阅更新状态事件 (更新面板激活)");

    // Optionally, trigger a status check or display current known status here?
    // For now, it relies on the main process sending status updates.
     updateStatusInfoEl.textContent = t('settings.updates.statusIdle'); // Reset text on show (use correct key)
     checkUpdatesBtn.textContent = t('settings.updates.checkButton'); // Use correct key
     checkUpdatesBtn.disabled = false;
}


/**
 * Handles clicks on the "Check for Updates" / "Restart & Install" button.
 */
function handleUpdateButtonClick() {
    // Query for elements *inside* the handler to ensure fresh references
    const aboutPane = settingsContent?.querySelector('#settingsAbout');
    const currentCheckUpdatesBtn = aboutPane?.querySelector('#checkUpdatesBtn');
    const currentUpdateStatusInfoEl = aboutPane?.querySelector('#updateStatusInfo');

    if (!currentCheckUpdatesBtn || !currentUpdateStatusInfoEl) {
        logMessage('error', "[settingsModal] handleUpdateButtonClick 失败：无法在 #settingsAbout 面板中找到更新按钮 (#checkUpdatesBtn) 或状态元素 (#updateStatusInfo)。");
        return;
    }

    const action = currentCheckUpdatesBtn.dataset.action || 'check'; // Default to 'check' if attribute is missing
    logMessage('info', `[UI] 点击了更新按钮，执行操作: ${action}`);

    switch (action) {
        case 'check':
            checkForUpdate().catch(err => {
                logMessage('error', "[settingsModal] 调用 checkForUpdate 失败:", err);
                currentUpdateStatusInfoEl.textContent = t('settings.updates.checkError', { message: err.message });
            });
            break;
        case 'download':
            // Provide immediate feedback
            currentCheckUpdatesBtn.disabled = true;
            currentCheckUpdatesBtn.textContent = t('settings.updates.downloadingButton'); // Use correct key
            currentCheckUpdatesBtn.dataset.action = 'checking'; // Prevent multiple clicks while downloading starts
            currentUpdateStatusInfoEl.textContent = t('settings.updates.statusDownloading'); // Use correct key

            downloadUpdate().catch(err => {
                logMessage('error', "[settingsModal] 调用 downloadUpdate 失败:", err);
                currentUpdateStatusInfoEl.textContent = t('settings.updates.statusError', { message: err.message }); // Need downloadError key
                // Re-enable button or revert state? Maybe revert to 'available' state?
                handleUpdateStatus({ status: 'available', info: {} }); // Revert to available state on download error
            });
            break;
        case 'install':
            quitAndInstall().catch(err => {
                logMessage('error', "[settingsModal] 调用 quitAndInstall 失败:", err);
                currentUpdateStatusInfoEl.textContent = t('settings.updates.installError', { message: err.message });
            });
            break;
        default:
            logMessage('warn', `[settingsModal] 未知的更新按钮操作: ${action}`);
            // Optionally default to check for updates
            checkForUpdate().catch(err => {
                logMessage('error', "[settingsModal] 调用 checkForUpdate (默认) 失败:", err);
                currentUpdateStatusInfoEl.textContent = t('settings.updates.checkError', { message: err.message });
            });
            break;
    }
}

/**
 * Callback function to handle update status updates from the main process.
 * Updates the UI elements (status text and button) in the Update pane.
 * @param {string} status - The update status code.
 * @param {...any} args - Additional arguments.
 */
function handleUpdateStatus(status, ...args) {
     // Ensure elements are available using the correct IDs
    const currentUpdateStatusInfoEl = settingsContent?.querySelector('#settingsAbout #updateStatusInfo');
    const currentCheckUpdatesBtn = settingsContent?.querySelector('#settingsAbout #checkUpdatesBtn');

    if (!currentUpdateStatusInfoEl || !currentCheckUpdatesBtn) {
        logMessage('warn', `[settingsModal] 无法处理更新状态 '${status}'：更新面板的 UI 元素 (#updateStatusInfo 或 #checkUpdatesBtn) 不可用`);
        // If the pane isn't visible, we might not want to log an error, just ignore.
        return;
    }
    // Log the entire status object for better debugging
    logMessage('info', `[settingsModal] 收到更新状态对象:`, status, args);

    // Use the current references
    updateStatusInfoEl = currentUpdateStatusInfoEl; // Update module-level reference
    checkUpdatesBtn = currentCheckUpdatesBtn; // Update module-level reference

    // Reset button state initially
    checkUpdatesBtn.disabled = false;
    checkUpdatesBtn.textContent = t('settings.updates.checkButton'); // Default text
    checkUpdatesBtn.dataset.action = 'check'; // Default action

    // Access the status string from the status object
    switch (status.status) {
        case 'checking':
            updateStatusInfoEl.textContent = t('settings.updates.statusChecking');
            checkUpdatesBtn.disabled = true;
            checkUpdatesBtn.textContent = t('settings.updates.checkingButton');
            checkUpdatesBtn.dataset.action = 'checking'; // Indicate checking state
            break;
        case 'available': // Renamed from 'update-available' based on previous code, confirm if needed
            const version = status.info?.version || 'N/A';
            updateStatusInfoEl.textContent = t('settings.updates.statusAvailable', { version: version }); // Include version
            checkUpdatesBtn.disabled = false;
            checkUpdatesBtn.textContent = t('settings.updates.downloadButton'); // New text: "立即更新"
            checkUpdatesBtn.dataset.action = 'download'; // Set action to download
            break;
        case 'not-available':
            updateStatusInfoEl.textContent = t('settings.updates.statusNotAvailable');
            checkUpdatesBtn.disabled = false; // Re-enable check button
            checkUpdatesBtn.textContent = t('settings.updates.checkButton');
            checkUpdatesBtn.dataset.action = 'check';
            break;
        case 'downloading':
            const progress = status.info?.percent; // Assuming progress info is in status.info
            const progressText = typeof progress === 'number' ? `(${progress.toFixed(1)}%)` : '';
            updateStatusInfoEl.textContent = `${t('settings.updates.statusDownloading')} ${progressText}`;
            checkUpdatesBtn.disabled = true;
            checkUpdatesBtn.textContent = t('settings.updates.downloadingButton');
            checkUpdatesBtn.dataset.action = 'checking'; // Treat as checking during download
            break;
        case 'downloaded': // Renamed from 'update-downloaded' based on previous code, confirm if needed
            updateStatusInfoEl.textContent = t('settings.updates.statusDownloaded');
            checkUpdatesBtn.disabled = false;
            checkUpdatesBtn.textContent = t('settings.updates.installButton');
            checkUpdatesBtn.dataset.action = 'install'; // Set action to install
            break;
        case 'error':
            const error = status.info; // Assuming error info is in status.info
            const errorMessage = error instanceof Error ? error.message : String(error || t('settings.updates.unknownError')); // Use correct key path
            logMessage('error', `[settingsModal] 更新过程中发生错误: ${errorMessage}`, error);
            updateStatusInfoEl.textContent = t('settings.updates.statusError', { message: errorMessage });
            checkUpdatesBtn.disabled = false; // Re-enable check button on error
            checkUpdatesBtn.textContent = t('settings.updates.checkButton');
            checkUpdatesBtn.dataset.action = 'check';
            break;
        default:
            // Log the entire status object for better debugging
            logMessage('warn', `[settingsModal] 未处理的更新状态对象:`, status);
            updateStatusInfoEl.textContent = t('settings.updates.statusIdle'); // Reset to idle
            checkUpdatesBtn.disabled = false;
            checkUpdatesBtn.textContent = t('settings.updates.checkButton');
            checkUpdatesBtn.dataset.action = 'check';
            break;
    }
}