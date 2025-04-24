document.addEventListener('DOMContentLoaded', async () => {
  const { loadLocale, t, getCurrentLocale, getSupportedLocales } = window.i18n;
  // 初始化主题切换
  const { initThemeSwitcher } = await import('./ui.js');
  initThemeSwitcher();

  // ===== 国际化初始化 =====
  const languageSelect = document.getElementById('languageSelect');
  // 渲染语言下拉
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
    document.getElementById('appTitle').textContent = t('appTitle');
    // document.getElementById('viewCardText').textContent = t('viewCard');
    // document.getElementById('viewListText').textContent = t('viewList');
    document.getElementById('cardViewBtn').title = t('viewCard');
    document.getElementById('listViewBtn').title = t('viewList');
    document.getElementById('loadingModels').textContent = t('loadingModels');
    // 详情图片alt
    document.getElementById('detailImage').alt = t('appTitle');
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
        console.log('开始加载可见图片:', img.dataset.imagePath);
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
        console.log('获取到图片数据:', imageData.data.length);
        const blob = new Blob([imageData.data], {type: imageData.mimeType});
        imgElement.src = URL.createObjectURL(blob);
        imgElement.onload = () => console.log('图片加载完成');
      }
    } catch (e) {
      console.error('加载图片失败:', e);
    }
  }

  const sourceSelect = document.getElementById('sourceSelect');
  const filterSelect = document.getElementById('filterSelect');
  const modelList = document.getElementById('modelList');
  const detailModal = document.getElementById('detailModal');
  const detailName = document.getElementById('detailName');
  const detailImage = document.getElementById('detailImage');
  const detailDescription = document.getElementById('detailDescription');
  const loadingDiv = document.getElementById('loading');

  let sources = [];
  let models = [];
  let filterType = '';
  let displayMode = 'card'; // 'card' or 'list'

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

  function renderSources() {
    clearChildren(sourceSelect);
    sources.forEach(src => {
      const option = document.createElement('option');
      option.value = src.id;
      option.textContent = src.name;
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
    console.log('[调试] renderModels filteredModels:', filteredModels);
    
    // 根据显示模式设置容器类
    const mainSection = document.getElementById('mainSection');
    if (displayMode === 'list') {
      modelList.classList.add('list-view');
      mainSection.classList.add('list-view');
    } else {
      modelList.classList.remove('list-view');
      mainSection.classList.remove('list-view');
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
        imageElement = document.createElement('div');
        imageElement.className = 'model-image-placeholder';
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
        
        model.tags.forEach(tag => {
          const tagElement = document.createElement('span');
          tagElement.className = 'tag';
          tagElement.textContent = tag;
          tagsContainer.appendChild(tagElement);
        });
      }

      card.appendChild(contentDiv);
      if (tagsContainer) {
        card.appendChild(tagsContainer);
      }

      card.addEventListener('click', async () => {
        await showDetail(model);
      });

      modelList.appendChild(card);
    });
    console.log('[调试] modelList 子元素数量:', modelList.children.length);
  }


  async function showDetail(model) {
    detailName.textContent = model.name || '';
    if (model.image) {
      // 使用getModelImage获取图片数据
      try {
        console.log('开始加载WebDAV图片:', model.image);
        const imageData = await window.api.getModelImage({
          sourceId: sourceSelect.value,
          imagePath: model.image
        });
        console.log('获取到的图片数据:', imageData);
        if (imageData) {
          console.log('图片数据长度:', imageData.data.length);
          try {
            const blob = new Blob([imageData.data], {type: imageData.mimeType});
            const objectUrl = URL.createObjectURL(blob);
            console.log('生成的Blob URL:', objectUrl);
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
          console.log('保存按钮点击事件触发');
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
          console.log('读取的额外信息:', newExtra);
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

  async function loadModels(sourceId) {
    setLoading(true);
    try {
      models = await window.api.listModels(sourceId);
      renderFilterTypes();
      renderModels();
    } catch (e) {
      console.error('加载模型失败:', e);
    }
    setLoading(false);
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
      }
      document.getElementById('mainSection').style.display = 'grid';
      document.getElementById('loading').style.display = 'none';
    } catch (e) {
      console.error('加载配置失败:', e);
    }
    setLoading(false);
  }

  sourceSelect.addEventListener('change', async () => {
    await loadModels(sourceSelect.value);
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

  init();

  // 自动加载可见卡片图片
  function loadVisibleImages() {
    const images = document.querySelectorAll('.model-image:not([src])');
    images.forEach(img => {
      const rect = img.getBoundingClientRect();
      if (rect.top < window.innerHeight && rect.bottom > 0) {
        console.log('开始加载可见图片:', img.dataset.imagePath);
        window.api.getModelImage({
          sourceId: img.dataset.sourceId,
          imagePath: img.dataset.imagePath
        }).then(imageData => {
          if (imageData) {
            console.log('获取到图片数据:', imageData.data.length, 'bytes');
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
        console.log('点击加载图片:', img.dataset.imagePath);
        const imageData = await window.api.getModelImage({
          sourceId: img.dataset.sourceId,
          imagePath: img.dataset.imagePath
        });
        if (imageData) {
          console.log('获取到图片数据:', imageData.data.length, 'bytes');
          const blob = new Blob([imageData.data], {type: imageData.mimeType});
          img.src = URL.createObjectURL(blob);
        }
      } catch (e) {
        console.error('加载卡片图片失败:', e);
      }
    }
  });
});