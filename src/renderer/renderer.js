document.addEventListener('DOMContentLoaded', async () => {
  const { loadLocale, t, getCurrentLocale, getSupportedLocales } = window.i18n;
  // 初始化主题切换
  const { initThemeSwitcher } = await import('./ui.js');
  initThemeSwitcher();

  // ===== Get DOM Element References =====
  const languageSelect = document.getElementById('languageSelect');
  const sourceSelect = document.getElementById('sourceSelect');
  const filterSelect = document.getElementById('filterSelect');
  const modelList = document.getElementById('modelList');
  const detailModal = document.getElementById('detailModal');
  const detailName = document.getElementById('detailName');
  const detailImage = document.getElementById('detailImage');
  const detailDescription = document.getElementById('detailDescription');
  const loadingDiv = document.getElementById('loading');
  // Settings Modal Elements
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsModal = document.getElementById('settingsModal');
  const settingsCloseBtn = document.getElementById('settingsClose');
  const settingsSaveBtn = document.getElementById('settingsSaveBtn');
  const settingsCancelBtn = document.getElementById('settingsCancelBtn');
  const settingsForm = document.querySelector('#settingsModal .settings-form');
  // Source Edit Modal Elements
  const sourceEditModal = document.getElementById('sourceEditModal');
  const sourceEditForm = document.getElementById('sourceEditForm');
  const sourceEditTitle = document.getElementById('sourceEditTitle');
  const sourceEditIdInput = document.getElementById('sourceEditId');
  const sourceEditNameInput = document.getElementById('sourceEditName');
  const sourceEditTypeSelect = document.getElementById('sourceEditType');
  const sourceEditLocalFields = document.getElementById('sourceEditLocalFields');
  const sourceEditPathInput = document.getElementById('sourceEditPath');
  const sourceEditBrowseBtn = document.getElementById('sourceEditBrowseBtn');
  const sourceEditWebdavFields = document.getElementById('sourceEditWebdavFields');
  const sourceEditUrlInput = document.getElementById('sourceEditUrl');
  const sourceEditUsernameInput = document.getElementById('sourceEditUsername');
  const sourceEditPasswordInput = document.getElementById('sourceEditPassword');
  const sourceEditCloseBtn = document.getElementById('sourceEditClose');
  const sourceEditCancelBtn = document.getElementById('sourceEditCancelBtn');
  const sourceEditSaveBtn = document.getElementById('sourceEditSaveBtn');

  // ===== Internationalization (i18n) =====
  // Render language dropdown
  function renderLanguageOptions() {
    const locales = getSupportedLocales();
    languageSelect.innerHTML = '';
    locales.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = l.name;
      languageSelect.appendChild(opt);
    });
    languageSelect.value = getCurrentLocale();
  }

  // 渲染主界面所有静态文本
  function setI18nTexts() {
    // Main UI
    document.getElementById('appTitle').textContent = t('appTitle');
    document.getElementById('cardViewBtn').title = t('viewCard');
    document.getElementById('listViewBtn').title = t('viewList');
    document.getElementById('loadingModels').textContent = t('loadingModels');
    document.getElementById('detailImage').alt = t('appTitle'); // Detail modal image alt

    // Settings Button Title
    settingsBtn.title = t('settings.title');

    // Settings Modal Static Texts
    settingsTitle.textContent = t('settings.title');
    settingsCancelBtn.textContent = t('settings.cancel');
    settingsSaveBtn.textContent = t('settings.save');

    // Source Edit Modal Static Texts
    // Title is set dynamically in openSourceEditModal
    document.getElementById('labelSourceEditName').textContent = t('settings.modelSources.nameLabel');
    document.getElementById('labelSourceEditType').textContent = t('settings.modelSources.typeLabel');
    document.getElementById('optionSourceEditTypeLocal').textContent = t('settings.modelSources.typeLocal');
    document.getElementById('optionSourceEditTypeWebdav').textContent = t('settings.modelSources.typeWebdav');
    document.getElementById('labelSourceEditPath').textContent = t('settings.modelSources.pathLabel');
    sourceEditBrowseBtn.textContent = t('settings.modelSources.browse');
    document.getElementById('labelSourceEditUrl').textContent = t('settings.modelSources.urlLabel');
    document.getElementById('labelSourceEditUsername').textContent = t('settings.modelSources.usernameLabel');
    document.getElementById('labelSourceEditPassword').textContent = t('settings.modelSources.passwordLabel');
    sourceEditCancelBtn.textContent = t('settings.cancel'); // Re-use cancel key
  }

  // 监听语言切换
  languageSelect.addEventListener('change', async () => {
    await loadLocale(languageSelect.value);
    setI18nTexts();
    renderFilterTypes();
    renderModels();
    // 其他需要刷新文本的地方可在此补充
  });

  // 加载当前语言
  await loadLocale(getCurrentLocale());
  renderLanguageOptions();
  setI18nTexts();

  // 图片懒加载观察器
  const imageObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        loadImage(img);
        imageObserver.unobserve(img);
      }
    });
  }, { threshold: 0.1 });

  async function loadImage(imgElement) {
    try {
      const imageData = await window.api.getModelImage({
        sourceId: imgElement.dataset.sourceId,
        imagePath: imgElement.dataset.imagePath
      });
      if (imageData) {
        const blob = new Blob([imageData.data], {type: imageData.mimeType});
        imgElement.src = URL.createObjectURL(blob);
        imgElement.onload = () => {}; // 保留空回调或根据需要移除onload
      }
    } catch (e) {
      console.error('加载图片失败:', e);
    }
  }

  // ===== App State =====
  let sources = [];
  let models = [];
  let filterType = '';
  let displayMode = 'card'; // 'card' or 'list'
  let currentDirectory = null; // 当前选中的目录
  let subdirectories = []; // 子目录列表

  let tempModelSources = []; // Temporary state for editing sources in settings

  function setLoading(isLoading) {
    if (isLoading) {
      loadingDiv.style.display = 'flex';
      document.getElementById('mainSection').style.opacity = '0.5';
    } else {
      loadingDiv.style.display = 'none';
      document.getElementById('mainSection').style.opacity = '1';
    }
  }

  function clearChildren(element) {
    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }
  }

  // ===== UI Feedback Helper =====
  let feedbackTimeout = null;
  function showFeedback(feedbackElement, message, type = 'info', duration = 4000) {
      if (!feedbackElement) return;

      // Clear previous timeout if any
      if (feedbackTimeout) {
          clearTimeout(feedbackTimeout);
      }

      feedbackElement.textContent = message;
      feedbackElement.className = `modal-feedback feedback-${type}`; // Set class based on type

      // Auto-hide after duration (if duration is positive)
      if (duration > 0) {
          feedbackTimeout = setTimeout(() => {
              feedbackElement.textContent = '';
              feedbackElement.className = 'modal-feedback'; // Reset class
              feedbackTimeout = null;
          }, duration);
      }
  }

  function clearFeedback(feedbackElement) {
       if (!feedbackElement) return;
       if (feedbackTimeout) {
          clearTimeout(feedbackTimeout);
          feedbackTimeout = null;
       }
       feedbackElement.textContent = '';
       feedbackElement.className = 'modal-feedback';
  }


  // ===== Core Rendering Functions =====
  function renderSources() {
    clearChildren(sourceSelect);
    sources.forEach(src => {
      const option = document.createElement('option');
      option.value = src.id;
      option.textContent = src.name;
      // 根据源类型添加 CSS 类，假设存在 src.type 字段
      if (src.type === 'local') {
        option.classList.add('source-option-local');
      } else if (src.type === 'webdav') {
        option.classList.add('source-option-webdav');
      } else {
        // 可以为未知类型添加默认类或不加类
      }
      sourceSelect.appendChild(option);
    });
  }

  function renderFilterTypes() {
    clearChildren(filterSelect);
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = '全部';
    filterSelect.appendChild(allOption);

    const types = Array.from(new Set(models.map(m => m.type).filter(Boolean)));
    types.forEach(type => {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = type;
      filterSelect.appendChild(option);
    });
  }

  function renderModels() {
    clearChildren(modelList);
    const filteredModels = filterType ? models.filter(m => m.type === filterType) : models;
    const MAX_VISIBLE_TAGS = 6; // Maximum tags to show initially
    // 根据显示模式设置容器类
    const mainSection = document.getElementById('mainSection');
    if (displayMode === 'list') {
      mainSection.classList.add('list-view');
      mainSection.classList.remove('card-view'); // 确保移除 card-view
      // modelList 本身不需要 list-view 类，因为样式会基于 mainSection
      modelList.classList.remove('list-view'); // 移除可能存在的旧类
    } else { // displayMode === 'card'
      mainSection.classList.add('card-view');
      mainSection.classList.remove('list-view'); // 确保移除 list-view
      // modelList 本身不需要 card-view 类
      modelList.classList.remove('list-view'); // 确保移除 list-view
    }
    
    filteredModels.forEach(model => {
      const card = document.createElement('li');
      card.className = 'model-card';

      let imageElement;
      if (model.image) {
        imageElement = document.createElement('img');
        imageElement.src = '';
        imageElement.setAttribute('data-image-path', model.image);
        imageElement.setAttribute('data-source-id', sourceSelect.value);
        imageElement.alt = t('appTitle');
        imageElement.className = 'model-image';
        imageElement.loading = 'lazy';
        // 观察图片懒加载
        imageObserver.observe(imageElement);
      } else {
        // Create a placeholder div that still uses model-image styles for layout
        imageElement = document.createElement('div');
        imageElement.className = 'model-image model-image-placeholder'; // Add both classes
        // Optional: Add an icon or text inside the placeholder
        imageElement.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="placeholder-icon"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`;
      }

      card.appendChild(imageElement);

      const contentDiv = document.createElement('div');
      contentDiv.className = 'model-content';

      const nameH3 = document.createElement('h3');
      nameH3.className = 'model-name';
      nameH3.textContent = model.name;

      const typeSpan = document.createElement('span');
      typeSpan.className = 'model-type';
      typeSpan.textContent = model.type || t('uncategorized');

      contentDiv.appendChild(nameH3);
      contentDiv.appendChild(typeSpan);

      // 添加tags显示
      let tagsContainer = null;
      if (model.tags && model.tags.length > 0) {
        tagsContainer = document.createElement('div');
        tagsContainer.className = 'tags-container';

        model.tags.forEach((tag, index) => {
          const tagElement = document.createElement('span');
          tagElement.className = 'tag';
          tagElement.textContent = tag;
          if (index >= MAX_VISIBLE_TAGS) {
            tagElement.classList.add('tag-hidden'); // Hide tags beyond the limit
          }
          tagsContainer.appendChild(tagElement);
        });

        // Add "more" button if tags exceed the limit
        if (model.tags.length > MAX_VISIBLE_TAGS) {
          const moreBtn = document.createElement('button');
          moreBtn.className = 'tag-more-btn';
          moreBtn.textContent = t('showMore'); // Use translation key
          moreBtn.onclick = (event) => {
            event.stopPropagation(); // Prevent card click event
            const container = event.target.closest('.tags-container');
            const isExpanded = container.classList.toggle('expanded');
            event.target.textContent = isExpanded ? t('showLess') : t('showMore'); // Update button text
          };
          tagsContainer.appendChild(moreBtn);
        }
      }

      card.appendChild(contentDiv);
      if (tagsContainer) {
        card.appendChild(tagsContainer); // Append container after contentDiv
      }

      card.addEventListener('click', async () => {
        await showDetail(model);
      });

      modelList.appendChild(card);
    });
  }


  async function showDetail(model) {
    detailName.textContent = model.name || '';
    if (model.image) {
      // 使用getModelImage获取图片数据
      try {
        const imageData = await window.api.getModelImage({
          sourceId: sourceSelect.value,
          imagePath: model.image
        });
        if (imageData) {
          try {
            const blob = new Blob([imageData.data], {type: imageData.mimeType});
            const objectUrl = URL.createObjectURL(blob);
            detailImage.src = objectUrl;
          } catch (e) {
            console.error('创建Blob失败:', e);
          }
          detailImage.style.display = 'block';
        } else {
          detailImage.style.display = 'none';
        }
      } catch (e) {
        console.error('加载图片失败:', e);
        detailImage.style.display = 'none';
      }
    } else {
      detailImage.style.display = 'none';
    }
    // 结构化展示模型详情，允许编辑
    const extraEntries = Object.entries(model.extra || {});
    // 过滤掉必要信息字段
    const filteredExtraEntries = extraEntries.filter(([key]) => !['modelType', 'description', 'triggerWord', 'image', 'file', 'jsonPath', 'tags'].includes(key));

    // 递归渲染额外信息
    function renderExtra(key, value) {
      if (typeof value === 'object' && value !== null) {
        const nestedEntries = Object.entries(value);
        return `
          <div class="extra-item">
            <label>${key}:</label>
            <div class="extra-content">
              ${nestedEntries.map(([k, v]) => renderExtra(k, v)).join('')}
            </div>
          </div>
        `;
      } else {
        return `
          <div class="extra-row">
            <label>${key}:</label>
            <input type="text" value="${value}" class="extra-input">
          </div>
        `;
      }
    }

    const extraHtml = filteredExtraEntries.length > 0
      ? filteredExtraEntries.map(([key, value]) => renderExtra(key, value)).join('')
      : `<p>${t('detail.noExtraInfo')}</p>`;

    detailDescription.innerHTML = `
      <div class="detail-modal-content">
        <div class="detail-tabs">
          <button class="tab-btn active" data-tab="basic">${t('detail.tabs.basic')}</button>
          <button class="tab-btn" data-tab="description">${t('detail.tabs.description')}</button>
          <button class="tab-btn" data-tab="extra">${t('detail.tabs.extra')}</button>
        </div>

        <div class="tab-content active" id="basic-tab">
          <div class="detail-info">
            <div class="detail-row"><label>${t('detail.type')}</label><input type="text" value="${model.type || ''}"></div>
            <div class="detail-row"><label>${t('detail.filePath')}</label><span class="readonly-text">${model.file || ''}</span></div>
            <div class="detail-row"><label>${t('detail.jsonPath')}</label><span class="readonly-text">${model.jsonPath || ''}</span></div>
            <div class="detail-row"><label>${t('detail.triggerWord')}</label><input type="text" value="${model.triggerWord || ''}"></div>
            ${model.tags && model.tags.length > 0 ? `
              <div class="detail-row"><label>${t('detail.tags')}</label><input type="text" value="${model.tags.join(', ')}"></div>
            ` : ''}
          </div>
        </div>

        <div class="tab-content" id="description-tab">
          <div class="detail-info">
            <textarea rows="8" class="description-textarea">${model.description || ''}</textarea>
          </div>
        </div>

        <div class="tab-content" id="extra-tab">
          <div class="detail-info">
            <div class="extra-info-group">
              ${extraHtml}
            </div>
          </div>
        </div>

        <button id="saveDetailBtn" class="btn-save">${t('detail.save')}</button>
      </div>
    `;

    // 绑定tab切换事件
    setTimeout(() => {
      const tabButtons = document.querySelectorAll('.tab-btn');
      tabButtons.forEach(button => {
        button.addEventListener('click', () => {
          // 移除所有active类
          document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
          document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
          
          // 添加active类到当前tab
          button.classList.add('active');
          const tabId = button.getAttribute('data-tab');
          document.getElementById(`${tabId}-tab`).classList.add('active');
        });
      });

      // 绑定保存按钮事件
      const saveBtn = document.getElementById('saveDetailBtn');
      if (saveBtn) {
        saveBtn.onclick = async () => {
          // 更新model对象
          const inputs = detailDescription.querySelectorAll('input[type="text"]');
          const textarea = detailDescription.querySelector('textarea');
          model.type = inputs[0].value;
          model.description = textarea.value;
          model.triggerWord = inputs[1].value;


          // 递归获取额外信息输入框的值
          function getExtraData(container) {
            const data = {};
            const items = container.querySelectorAll('.extra-item');
            items.forEach(item => {
              const label = item.querySelector('label').textContent.replace(/:$/, '');
              const nestedContent = item.querySelector('.nested-content');
              if (nestedContent) {
                data[label] = getExtraData(nestedContent);
              } else {
                const input = item.querySelector('input[type="text"]');
                data[label] = input ? input.value : '';
              }
            });
            return data;
          }
      
          const newExtra = getExtraData(detailDescription);
          // 合并原有extra和新extra，优先使用新extra的值
          function mergeExtra(oldExtra, newExtra) {
            const result = { ...oldExtra };
            for (const key in newExtra) {
              if (typeof newExtra[key] === 'object' && newExtra[key] !== null && typeof oldExtra[key] === 'object' && oldExtra[key] !== null) {
                result[key] = mergeExtra(oldExtra[key], newExtra[key]);
              } else {
                result[key] = newExtra[key];
              }
            }
            return result;
          }
          model.extra = mergeExtra(model.extra || {}, newExtra);

          try {
            await window.api.saveModel(model);
            alert(t('detail.saveSuccess'));
          } catch (e) {
            alert(t('detail.saveFail') + e.message);
          }
        };
      } else {
        console.error('未找到保存按钮saveDetailBtn');
      }
    }, 0);

    detailModal.classList.add('active');
  }

  function hideDetail() {
    detailModal.classList.remove('active');
  }

  async function loadModels(sourceId, directory = null) {
    setLoading(true);
    try {
      models = await window.api.listModels(sourceId, directory);
      // 如果是根目录，获取子目录列表
      if (directory === null) {
        subdirectories = await window.api.listSubdirectories(sourceId);
        renderDirectoryTabs();
      }
      renderFilterTypes();
      renderModels();
    } catch (e) {
      console.error('加载模型失败:', e);
    }
    setLoading(false);
  }


  // 渲染目录Tab栏
  function renderDirectoryTabs() {
    const tabList = document.querySelector('.directory-tabs .tab-list');
    if (!tabList) return;
    
    clearChildren(tabList);
    
    // 添加"全部"Tab
    const allTab = document.createElement('div');
    allTab.className = `tab-item ${currentDirectory === null ? 'active' : ''}`;
    allTab.textContent = '全部';
    allTab.onclick = () => {
      // 移除所有active类
      document.querySelectorAll('.tab-item').forEach(item => {
        item.classList.remove('active');
      });
      // 添加active类到当前tab
      allTab.classList.add('active');
      currentDirectory = null;
      loadModels(sourceSelect.value);
    };
    tabList.appendChild(allTab);
    
    // 添加子目录Tab
    subdirectories.forEach(dir => {
      const tab = document.createElement('div');
      tab.className = `tab-item ${currentDirectory === dir ? 'active' : ''}`;
      tab.textContent = dir;
      tab.onclick = () => {
        // 移除所有active类
        document.querySelectorAll('.tab-item').forEach(item => {
          item.classList.remove('active');
        });
        // 添加active类到当前tab
        tab.classList.add('active');
        currentDirectory = dir;
        loadModels(sourceSelect.value, dir);
      };
      tabList.appendChild(tab);
    });
  }

  async function init() {
    setLoading(true);
    try {
      const config = await window.api.getConfig();
      sources = config.modelSources || [];
      renderSources();
      if (sources.length > 0) {
        sourceSelect.value = sources[0].id;
        await loadModels(sources[0].id);
        renderDirectoryTabs();
      }
      document.getElementById('mainSection').style.display = 'grid';
      document.getElementById('loading').style.display = 'none';
    } catch (e) {
      console.error('加载配置失败:', e);
    }
    setLoading(false);
  }

  sourceSelect.addEventListener('change', async () => {
    currentDirectory = null; // 切换仓库时重置目录选择
    await loadModels(sourceSelect.value);
    renderDirectoryTabs();
  });

  filterSelect.addEventListener('change', () => {
    if (filterType !== filterSelect.value) {
      filterType = filterSelect.value;
      setLoading(true);
      setTimeout(() => {
        renderModels();
        setLoading(false);
      }, 100);
    }
  });

  // 视图切换按钮事件
  document.getElementById('cardViewBtn').addEventListener('click', () => {
    if (displayMode !== 'card') {
      displayMode = 'card';
      document.getElementById('cardViewBtn').classList.add('active');
      document.getElementById('listViewBtn').classList.remove('active');
      renderModels();
    }
  });

  document.getElementById('listViewBtn').addEventListener('click', () => {
    if (displayMode !== 'list') {
      displayMode = 'list';
      document.getElementById('listViewBtn').classList.add('active');
      document.getElementById('cardViewBtn').classList.remove('active');
      renderModels();
    }
  });

  document.getElementById('detailClose').addEventListener('click', hideDetail);

  // ===== Settings Modal Logic =====
  // Function to render the list of model sources within the settings modal
  function renderSourceListForSettings() {
    const sourcesSection = settingsForm.querySelector('.settings-section:first-child'); // Assuming sources are the first section
    if (!sourcesSection) return; // Should not happen if loadConfigForSettings ran correctly

    let sourcesList = sourcesSection.querySelector('.source-list');
    if (!sourcesList) {
        sourcesList = document.createElement('ul');
        sourcesList.className = 'source-list';
        // Insert the list before the "Add" button if it exists, otherwise append
        const addBtn = sourcesSection.querySelector('.add-source-btn');
        if (addBtn) {
            sourcesSection.insertBefore(sourcesList, addBtn);
        } else {
            sourcesSection.appendChild(sourcesList);
        }
    }

    clearChildren(sourcesList); // Clear existing list items

    tempModelSources.forEach(source => {
      const item = document.createElement('li');
      item.className = 'source-item';
      item.dataset.sourceId = source.id; // Store ID for edit/delete
      item.innerHTML = `
        <div class="source-item-details">
          <span class="source-item-name">${source.name} (${source.type === 'local' ? t('settings.modelSources.typeLocal') : t('settings.modelSources.typeWebdav')})</span> <!-- Type already uses t() -->
          <span class="source-item-path">${source.type === 'local' ? source.path : source.url}</span>
        </div>
        <div class="source-item-actions">
          <button class="edit-btn" title="${t('settings.modelSources.edit')}">✏️</button> <!-- Title already uses t() -->
          <button class="delete-btn" title="${t('settings.modelSources.delete')}">🗑️</button> <!-- Title already uses t() -->
        </div>
      `;
      // Add event listeners for edit/delete buttons
      item.querySelector('.edit-btn').addEventListener('click', () => openSourceEditModal(source));
      item.querySelector('.delete-btn').addEventListener('click', () => handleDeleteSource(source.id));
      sourcesList.appendChild(item);
    });
  }

  // Load config and populate the main settings form
  async function loadConfigForSettings() {
    try {
      const currentConfig = await window.api.getConfig();
      console.log("Loaded config for settings:", currentConfig);
      // Deep clone sources into temporary state for editing
      tempModelSources = JSON.parse(JSON.stringify(currentConfig.modelSources || []));

      settingsForm.innerHTML = ''; // Clear previous form content

      // --- Render Model Sources Section ---
      const sourcesSection = document.createElement('div');
      sourcesSection.className = 'settings-section';
      sourcesSection.innerHTML = `<h3>${t('settings.modelSources.title')}</h3>`; // Already uses t()
      settingsForm.appendChild(sourcesSection); // Append section first

      renderSourceListForSettings(); // Render the list using temp state

      const addSourceBtn = document.createElement('button');
      addSourceBtn.textContent = t('settings.modelSources.add'); // Already uses t()
      addSourceBtn.className = 'btn btn-secondary add-source-btn';
      addSourceBtn.type = 'button'; // Prevent form submission if inside a form
      addSourceBtn.addEventListener('click', () => openSourceEditModal()); // Open modal for adding
      sourcesSection.appendChild(addSourceBtn); // Append button after the list container

      // --- Render Supported Extensions ---
      const extensionsSection = document.createElement('div');
      extensionsSection.className = 'settings-section';
      extensionsSection.innerHTML = `
        <h3>${t('settings.extensions.title')}</h3> <!-- Already uses t() -->
        <div class="form-group">
          <label for="supportedExtensions">${t('settings.extensions.label')}</label> <!-- Already uses t() -->
          <textarea id="supportedExtensions" rows="3">${(currentConfig.supportedExtensions || []).join(', ')}</textarea>
          <small>${t('settings.extensions.hint')}</small> <!-- Already uses t() -->
        </div>
      `;
      settingsForm.appendChild(extensionsSection);

      // --- Render Image Cache Settings ---
      const cacheSection = document.createElement('div');
      cacheSection.className = 'settings-section';
      const cacheConfig = currentConfig.imageCache || {};
      cacheSection.innerHTML = `
        <h3>${t('settings.imageCache.title')}</h3> <!-- Already uses t() -->
        <div class="form-group">
          <label>
            <input type="checkbox" id="imageCacheDebug" ${cacheConfig.debug ? 'checked' : ''}>
            ${t('settings.imageCache.debug')} <!-- Already uses t() -->
          </label>
        </div>
        <div class="form-group">
          <label for="imageCacheQuality">${t('settings.imageCache.quality')} (0-100)</label> <!-- Already uses t() -->
          <input type="number" id="imageCacheQuality" min="0" max="100" value="${cacheConfig.compressQuality || 80}">
        </div>
        <div class="form-group">
          <label for="imageCacheFormat">${t('settings.imageCache.format')}</label> <!-- Already uses t() -->
          <select id="imageCacheFormat">
            <option value="jpeg" ${cacheConfig.compressFormat === 'jpeg' ? 'selected' : ''}>JPEG</option>
            <option value="webp" ${cacheConfig.compressFormat === 'webp' ? 'selected' : ''}>WebP</option>
            <option value="png" ${cacheConfig.compressFormat === 'png' ? 'selected' : ''}>PNG</option>
          </select>
        </div>
        <div class="form-group">
          <label for="imageCacheSize">${t('settings.imageCache.maxSize')} (MB)</label> <!-- Already uses t() -->
          <input type="number" id="imageCacheSize" min="0" value="${cacheConfig.maxCacheSizeMB || 500}">
        </div>
      `;
      settingsForm.appendChild(cacheSection);

    } catch (error) {
      console.error("Failed to load config for settings:", error);
      settingsForm.innerHTML = `<p style="color: red;">${t('settings.loadError', { message: error.message })}</p>`; // Already uses t()
    }
  }

  function openSettingsModal() {
    console.log("Opening settings modal...");
    clearFeedback(document.getElementById('settingsFeedback')); // Clear feedback on open
    settingsModal.classList.add('active');
    loadConfigForSettings(); // Load config when opening
  }

  function closeSettingsModal() {
    settingsModal.classList.remove('active');
  }

  settingsBtn.addEventListener('click', openSettingsModal);
  settingsCloseBtn.addEventListener('click', closeSettingsModal);
  settingsCancelBtn.addEventListener('click', closeSettingsModal);

  // Close modal if clicking on the backdrop
  settingsModal.addEventListener('click', (event) => {
    if (event.target === settingsModal) {
      closeSettingsModal();
    }
  });

  // --- Source Edit Modal Logic ---

  function handleSourceTypeChange() {
      const selectedType = sourceEditTypeSelect.value;
      if (selectedType === 'local') {
          sourceEditLocalFields.style.display = 'block';
          sourceEditWebdavFields.style.display = 'none';
          sourceEditPathInput.required = true;
          sourceEditUrlInput.required = false;
      } else if (selectedType === 'webdav') {
          sourceEditLocalFields.style.display = 'none';
          sourceEditWebdavFields.style.display = 'block';
          sourceEditPathInput.required = false;
          sourceEditUrlInput.required = true;
          // Username/Password are optional for WebDAV usually
      }
  }

  async function handleBrowseFolder() {
      const browseBtn = sourceEditBrowseBtn; // Use the correct variable
      browseBtn.disabled = true; // Disable button
      const feedbackEl = document.getElementById('sourceEditFeedback');
      clearFeedback(feedbackEl);

      try {
          const selectedPath = await window.api.openFolderDialog();
          if (selectedPath) {
              sourceEditPathInput.value = selectedPath;
          }
      } catch (error) {
          console.error("Failed to open folder dialog:", error);
          showFeedback(feedbackEl, t('settings.folderDialogError', { message: error.message }), 'error');
      } finally {
          browseBtn.disabled = false; // Re-enable button
      }
  }

  function openSourceEditModal(sourceToEdit = null) {
      clearFeedback(document.getElementById('sourceEditFeedback')); // Clear feedback on open
      sourceEditForm.reset(); // Clear form fields
      handleSourceTypeChange(); // Ensure correct fields are shown initially

      if (sourceToEdit) {
          // Editing existing source
          sourceEditTitle.textContent = t('settings.modelSources.editTitle'); // Already uses t()
          sourceEditIdInput.value = sourceToEdit.id;
          sourceEditNameInput.value = sourceToEdit.name;
          sourceEditTypeSelect.value = sourceToEdit.type;
          if (sourceToEdit.type === 'local') {
              sourceEditPathInput.value = sourceToEdit.path || '';
          } else if (sourceToEdit.type === 'webdav') {
              sourceEditUrlInput.value = sourceToEdit.url || '';
              sourceEditUsernameInput.value = sourceToEdit.username || '';
              sourceEditPasswordInput.value = sourceToEdit.password || ''; // Be cautious with passwords
          }
          handleSourceTypeChange(); // Update visible fields based on loaded type
      } else {
          // Adding new source
          sourceEditTitle.textContent = t('settings.modelSources.addTitle'); // Already uses t()
          sourceEditIdInput.value = ''; // Ensure ID is empty for new source
      }
      sourceEditModal.classList.add('active');
  }

  function closeSourceEditModal() {
      sourceEditModal.classList.remove('active');
  }

  function handleSourceEditFormSubmit(event) {
      event.preventDefault(); // Prevent default HTML form submission
      console.log("Source edit form submitted");

      const sourceId = sourceEditIdInput.value;
      const sourceType = sourceEditTypeSelect.value;

      const newSourceData = {
          id: sourceId || Date.now().toString(), // Generate new ID if adding
          name: sourceEditNameInput.value.trim(),
          type: sourceType,
      };

      const feedbackEl = document.getElementById('sourceEditFeedback');
      clearFeedback(feedbackEl);
  
      // Basic validation
      if (!newSourceData.name) {
          showFeedback(feedbackEl, t('settings.validation.sourceNameRequired'), 'error');
          return;
      }

      if (sourceType === 'local') {
          const pathValue = sourceEditPathInput.value.trim();
          if (!pathValue) {
              showFeedback(feedbackEl, t('settings.validation.pathRequired'), 'error');
              return;
          }
          newSourceData.path = pathValue;
      } else if (sourceType === 'webdav') {
          const urlValue = sourceEditUrlInput.value.trim();
          if (!urlValue) {
              showFeedback(feedbackEl, t('settings.validation.urlRequired'), 'error');
              return;
          }
          newSourceData.url = urlValue;
          newSourceData.username = sourceEditUsernameInput.value.trim();
          newSourceData.password = sourceEditPasswordInput.value; // Get password value
      }

      if (sourceId) {
          // Editing: Find index and replace
          const index = tempModelSources.findIndex(s => s.id === sourceId);
          if (index !== -1) {
              tempModelSources[index] = newSourceData;
              console.log("Updated source:", newSourceData);
          } else {
              console.error("Source ID not found for editing:", sourceId);
              // Handle error? Maybe add as new?
          }
      } else {
          // Adding: Push new source
          tempModelSources.push(newSourceData);
          console.log("Added new source:", newSourceData);
      }

      renderSourceListForSettings(); // Re-render the list in the main settings modal
      closeSourceEditModal(); // Close the edit modal
  }

   function handleDeleteSource(sourceId) {
       // TODO: Replace confirm with a custom confirmation UI later
       if (!confirm(t('settings.modelSources.deleteConfirm'))) { // Keep confirm for now
           return;
      }
      const index = tempModelSources.findIndex(s => s.id === sourceId);
      if (index !== -1) {
          tempModelSources.splice(index, 1);
          console.log("Deleted source with ID:", sourceId);
          renderSourceListForSettings(); // Re-render the list
      } else {
          console.error("Source ID not found for deletion:", sourceId);
      }
  }

  // Attach event listeners for the source edit modal
  sourceEditTypeSelect.addEventListener('change', handleSourceTypeChange);
  sourceEditBrowseBtn.addEventListener('click', handleBrowseFolder);
  sourceEditForm.addEventListener('submit', handleSourceEditFormSubmit);
  sourceEditCloseBtn.addEventListener('click', closeSourceEditModal);
  sourceEditCancelBtn.addEventListener('click', closeSourceEditModal);
   sourceEditModal.addEventListener('click', (event) => {
    if (event.target === sourceEditModal) {
      closeSourceEditModal();
    }
  });


  // --- End Source Edit Modal Logic ---


  // Save action for the main settings modal
  settingsSaveBtn.addEventListener('click', async () => {
    console.log("Save settings clicked...");
    const saveBtn = settingsSaveBtn; // Reference the button
    const feedbackEl = document.getElementById('settingsFeedback');
    clearFeedback(feedbackEl);
    saveBtn.disabled = true; // Disable button

    try {
      // 1. Construct the new config object using tempModelSources
      const newConfig = {
        modelSources: tempModelSources, // Use the edited list
        supportedExtensions: [],
        imageCache: {}
      };

      // 2. Collect data from form elements
      // Supported Extensions
      const extensionsText = document.getElementById('supportedExtensions')?.value || '';
      newConfig.supportedExtensions = extensionsText.split(',')
                                          .map(ext => ext.trim())
                                          .filter(ext => ext.length > 0);

      // Image Cache
      newConfig.imageCache.debug = document.getElementById('imageCacheDebug')?.checked || false;
      newConfig.imageCache.compressQuality = parseInt(document.getElementById('imageCacheQuality')?.value || '80', 10);
      newConfig.imageCache.compressFormat = document.getElementById('imageCacheFormat')?.value || 'jpeg';
      newConfig.imageCache.maxCacheSizeMB = parseInt(document.getElementById('imageCacheSize')?.value || '500', 10);

      // Basic validation (can be expanded)
      if (isNaN(newConfig.imageCache.compressQuality) || newConfig.imageCache.compressQuality < 0 || newConfig.imageCache.compressQuality > 100) {
         showFeedback(feedbackEl, t('settings.validation.qualityError'), 'error');
         saveBtn.disabled = false; // Re-enable button on validation error
         return;
      }
       if (isNaN(newConfig.imageCache.maxCacheSizeMB) || newConfig.imageCache.maxCacheSizeMB < 0) {
         showFeedback(feedbackEl, t('settings.validation.sizeError'), 'error');
         saveBtn.disabled = false; // Re-enable button on validation error
         return;
      }


      console.log("Saving new config:", newConfig);

      // 3. Send to main process
      const result = await window.api.saveConfig(newConfig);

      // 4. Handle response
      if (result.success) {
        // Show success feedback briefly before closing
        showFeedback(feedbackEl, t('settings.saveSuccess'), 'success', 2000);
        setTimeout(closeSettingsModal, 2100); // Close after feedback is shown
        // Reloading will be handled by the 'config-updated' listener
      } else {
         // This part might not be reached if saveConfig throws error on failure
         showFeedback(feedbackEl, t('settings.saveErrorUnknown'), 'error');
      }

    } catch (error) {
      console.error("Failed to save settings:", error);
      alert(t('settings.saveError', { message: error.message })); // Already uses t()
    }
  });

  // ==============================

  init();

  // Listen for configuration updates from the main process
  window.api.onConfigUpdated(() => {
      console.log('[Renderer] Received config-updated event. Reloading sources and models.');
      // Re-initialize the application state based on the new config
      // This will re-fetch sources and load models for the first source
      init();
      // Optionally, show a less intrusive notification instead of alert in save handler
  });


  // 自动加载可见卡片图片
  function loadVisibleImages() {
    const images = document.querySelectorAll('.model-image:not([src])');
    images.forEach(img => {
      const rect = img.getBoundingClientRect();
      if (rect.top < window.innerHeight && rect.bottom > 0) {
        window.api.getModelImage({
          sourceId: img.dataset.sourceId,
          imagePath: img.dataset.imagePath
        }).then(imageData => {
          if (imageData) {
            const blob = new Blob([imageData.data], {type: imageData.mimeType});
            img.src = URL.createObjectURL(blob);
          }
        }).catch(e => {
          console.error('加载卡片图片失败:', e);
        });
      }
    });
  }

  // 初始加载可见图片
  setTimeout(loadVisibleImages, 500);

  // 滚动时加载可见图片
  window.addEventListener('scroll', loadVisibleImages);

  // 点击加载图片（备用）
  document.addEventListener('click', async (e) => {
    if (e.target.classList.contains('model-image') && !e.target.src) {
      const img = e.target;
      try {
        const imageData = await window.api.getModelImage({
          sourceId: img.dataset.sourceId,
          imagePath: img.dataset.imagePath
        });
        if (imageData) {
          const blob = new Blob([imageData.data], {type: imageData.mimeType});
          img.src = URL.createObjectURL(blob);
        }
      } catch (e) {
        console.error('加载卡片图片失败:', e);
      }
    }
  });
});