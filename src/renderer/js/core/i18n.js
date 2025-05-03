// 移除 LOCALE_KEY 常量

import { logMessage, getConfig, saveConfig } from '../apiBridge.js'; // 导入 API 桥接和配置函数

const SUPPORTED_LOCALES = [
  { code: 'zh-CN', name: '简体中文' },
  { code: 'en-US', name: 'English' }
];

let currentLocale = null; // 初始化为 null，将在 initializeI18n 中设置
let messages = {};

function getDefaultLocale() {
  // 优先取浏览器语言
  const lang = navigator.language || navigator.userLanguage;
  // 检查是否是支持的完整区域代码 (e.g., 'en-US')
  if (SUPPORTED_LOCALES.some(l => l.code === lang)) return lang;
  // 检查是否是支持的语言代码部分 (e.g., 'en' from 'en-GB')
  const langPart = lang.split('-')[0];
  const supportedLang = SUPPORTED_LOCALES.find(l => l.code.startsWith(langPart + '-'));
  if (supportedLang) return supportedLang.code;
  // 默认回退
  return 'zh-CN';
}

/**
 * 初始化 i18n 服务，加载初始语言设置
 */
export async function initializeI18n() {
  logMessage('info', '[i18n] Initializing...');
  let initialLocale = getDefaultLocale(); // 先获取默认语言
  try {
    const config = await getConfig();
    if (config && config.locale && SUPPORTED_LOCALES.some(l => l.code === config.locale)) {
      initialLocale = config.locale; // 优先使用配置中保存的语言
      logMessage('info', `[i18n] Found saved locale in config: ${initialLocale}`);
    } else {
      logMessage('info', `[i18n] No valid saved locale found in config, using default: ${initialLocale}`);
    }
  } catch (error) {
    logMessage('error', '[i18n] Failed to get config for initial locale, using default.', error.message, error.stack);
  }

  try {
    await loadLocale(initialLocale, false); // 初始加载时不保存配置，因为它已经是配置或默认值
    logMessage('info', `[i18n] Initialization complete with locale: ${currentLocale}`);
  } catch (error) {
    logMessage('error', `[i18n] Failed to load initial locale '${initialLocale}'. Trying fallback 'zh-CN'.`, error.message, error.stack);
    try {
        // 如果初始加载失败，尝试加载中文作为最终回退
        await loadLocale('zh-CN', false);
        logMessage('info', `[i18n] Fallback locale 'zh-CN' loaded successfully.`);
    } catch (fallbackError) {
        logMessage('error', `[i18n] Failed to load fallback locale 'zh-CN'. i18n may not function correctly.`, fallbackError.message, fallbackError.stack);
        // 此时 i18n 可能无法正常工作，messages 可能为空
        messages = {};
        currentLocale = 'zh-CN'; // 至少设置一个 currentLocale
    }
  }
}


/**
 * 加载指定的区域设置文件，并可选择是否保存偏好。
 * @param {string} locale - 要加载的区域设置代码 (e.g., 'en-US').
 * @param {boolean} [savePreference=true] - 是否将此区域设置保存为用户偏好。
 */
export async function loadLocale(locale, savePreference = true) {
  const originalLocale = locale;
  if (!SUPPORTED_LOCALES.some(l => l.code === locale)) {
      logMessage('warn', `[i18n] Unsupported locale "${locale}", falling back to 'zh-CN'.`);
      locale = 'zh-CN';
  }
  logMessage('info', `[i18n] Attempting to load locale file: ${locale}.json (Save preference: ${savePreference})`);
  try {
      const res = await fetch(`./locales/${locale}.json`);
      if (!res.ok) {
          logMessage('error', `[i18n] Failed to fetch locale file: ${locale}.json, Status: ${res.status} ${res.statusText}`);
          throw new Error(`HTTP error ${res.status}`);
      }
      messages = await res.json();
      const previousLocale = currentLocale; // Store previous locale for comparison
      currentLocale = locale; // Update current locale *after* successful load
      logMessage('info', `[i18n] Locale file loaded successfully: ${locale}.json`);

      // 只有在语言实际发生变化且需要保存偏好时才保存配置
      if (savePreference && previousLocale !== currentLocale) {
          try {
              logMessage('info', `[i18n] Saving locale preference: ${locale}`);
              const currentConfig = await getConfig();
              // 创建一个新的配置对象，以避免直接修改缓存的配置
              const newConfig = { ...currentConfig, locale: currentLocale };
              await saveConfig(newConfig);
              logMessage('debug', `[i18n] Locale preference saved via configService: ${locale}`);
          } catch (saveError) {
              logMessage('error', `[i18n] Failed to save locale preference via configService: ${locale}`, saveError.message, saveError.stack);
              // 保存失败不应阻止语言切换，但需要记录错误
          }
      } else if (savePreference && previousLocale === currentLocale) {
          logMessage('debug', `[i18n] Locale preference (${locale}) already matches current locale. Skipping save.`);
      }

  } catch (error) {
      logMessage('error', `[i18n] Error loading or parsing locale file: ${locale}.json (Requested: ${originalLocale})`, error.message, error.stack);
      // 不清除 messages 或更改 currentLocale，除非是初始化失败
      throw error; // Re-throw so the caller knows loading failed
  }
}

export function t(key, params) {
  // 支持嵌套 key，如 detail.save
  const keys = key.split('.');
  let value = messages;
  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k];
    } else {
      logMessage('warn', `[i18n] Missing translation key: ${key} for locale: ${currentLocale}`);
      return key;
    }
  }
  if (typeof value !== 'string') {
      logMessage('warn', `[i18n] Translation for key '${key}' is not a string:`, value);
      return String(value);
  }
  // 简单参数替换：{param}
  if (params && typeof params === 'object') {
    value = value.replace(/\{(\w+)\}/g, (match, p1) => (p1 in params ? params[p1] : match));
  }
  return value;
}

export function getCurrentLocale() {
  return currentLocale;
}

export function getSupportedLocales() {
  return SUPPORTED_LOCALES;
}

/**
 * Updates UI elements with data-i18n attributes based on the current locale.
 * Moved from main.js to be reusable.
 */
export function updateUIWithTranslations() {
  logMessage('debug', '[i18n] Starting UI translation update...');
  const settingsGeneralPane = document.getElementById('settingsGeneral');
  logMessage('debug', `[i18n] Before updateUI loop, #settingsGeneral innerHTML: ${settingsGeneralPane?.innerHTML?.substring(0, 100)}...`); // Log initial content

  // Use a combined selector to fetch all relevant elements at once
  const elements = document.querySelectorAll('[data-i18n-key], [data-i18n-title-key], [data-i18n-placeholder-key]');
  const startTime = performance.now(); // Optional: for performance measurement

  elements.forEach(el => {
    const isGeneralPaneChild = settingsGeneralPane?.contains(el); // Check if element is inside the general pane
    try { // Add try...catch around element processing
        // Check for data-i18n-key and apply translation to textContent or value
        if (el.hasAttribute('data-i18n-key')) {
          const key = el.getAttribute('data-i18n-key');
          if (isGeneralPaneChild) {
              logMessage('debug', `[i18n] Processing general pane child (key: ${key}):`, el.outerHTML.substring(0, 100));
          }
          const translation = t(key); // t() already handles missing keys
          if (translation !== key) { // Apply only if translation exists
            // Prioritize 'value' attribute for inputs/buttons if present
            if (el.hasAttribute('value') && (el.tagName === 'INPUT' || el.tagName === 'BUTTON')) {
                if (isGeneralPaneChild) logMessage('debug', `[i18n] Setting value for ${key} to: ${translation}`);
                el.value = translation;
            // Otherwise, update textContent for most elements
            } else if (el.textContent !== undefined && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') { // Avoid overwriting input/textarea content unless intended
                if (isGeneralPaneChild) logMessage('debug', `[i18n] Setting textContent for ${key} to: ${translation}`);
                el.textContent = translation;
            }
          }
        }

        // Check for data-i18n-title-key and apply translation to title
        if (el.hasAttribute('data-i18n-title-key')) {
          const key = el.getAttribute('data-i18n-title-key');
          const translation = t(key);
          if (translation !== key) {
            if (isGeneralPaneChild) logMessage('debug', `[i18n] Setting title for ${key} to: ${translation}`);
            el.title = translation;
          }
        }

        // Check for data-i18n-placeholder-key and apply translation to placeholder
        if (el.hasAttribute('data-i18n-placeholder-key')) {
          const key = el.getAttribute('data-i18n-placeholder-key');
          const translation = t(key);
          if (translation !== key) {
            if (isGeneralPaneChild) logMessage('debug', `[i18n] Setting placeholder for ${key} to: ${translation}`);
            el.placeholder = translation;
          }
        }
    } catch (error) {
        logMessage('error', `[i18n] Error processing element during UI update:`, el.outerHTML.substring(0, 200), error.message, error.stack);
        // Optionally continue to the next element instead of stopping the whole update
        // continue;
    }
  });

  const endTime = performance.now(); // Optional
  logMessage('debug', `[i18n] UI translation update complete, took: ${(endTime - startTime).toFixed(2)}ms, processed ${elements.length} elements`);
  logMessage('debug', `[i18n] After updateUI loop, #settingsGeneral innerHTML: ${settingsGeneralPane?.innerHTML?.substring(0, 100)}...`); // Log final content
}