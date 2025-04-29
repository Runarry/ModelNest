const LOCALE_KEY = 'app_locale';

const SUPPORTED_LOCALES = [
  { code: 'zh-CN', name: '简体中文' },
  { code: 'en-US', name: 'English' }
];

let currentLocale = localStorage.getItem(LOCALE_KEY) || getDefaultLocale();
let messages = {};

function getDefaultLocale() {
  // 优先取浏览器语言
  const lang = navigator.language || navigator.userLanguage;
  if (SUPPORTED_LOCALES.some(l => l.code === lang)) return lang;
  return 'zh-CN';
}

async function loadLocale(locale) {
  const originalLocale = locale;
  if (!SUPPORTED_LOCALES.some(l => l.code === locale)) {
      console.warn(`[i18n] 不支持的区域设置 "${locale}"，回退到默认值 'zh-CN'`);
      locale = 'zh-CN';
  }
  console.log(`[i18n] 开始加载区域设置文件: ${locale}.json`);
  try {
      const res = await fetch(`./locales/${locale}.json`);
      if (!res.ok) {
          // Task 1: Error Logging (Fetch failed)
          console.error(`[i18n] 获取区域设置文件失败: ${locale}.json, 状态: ${res.status} ${res.statusText}`);
          throw new Error(`HTTP error ${res.status}`);
      }
      messages = await res.json();
      currentLocale = locale;
      try {
          localStorage.setItem(LOCALE_KEY, locale);
          console.debug(`[i18n] 区域设置偏好已保存到 localStorage: ${locale}`);
      } catch (storageError) {
           // Task 1: Error Logging (LocalStorage failed)
           console.error(`[i18n] 保存区域设置偏好到 localStorage 失败: ${locale}`, storageError.message, storageError.stack);
      }
      console.log(`[i18n] 区域设置文件加载成功: ${locale}.json`);
  } catch (error) {
       // Task 1: Error Logging (Fetch or JSON parse failed)
      console.error(`[i18n] 加载或解析区域设置文件时出错: ${locale}.json (请求的: ${originalLocale})`, error.message, error.stack, error);
      // Optionally load a fallback locale or clear messages
      // messages = {}; // Clear messages on error?
      throw error; // Re-throw so the caller knows loading failed
  }
}

function t(key) {
  // 支持嵌套 key，如 detail.save
  const keys = key.split('.');
  let value = messages;
  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k];
    } else {
      return key; // 未找到时返回 key
    }
  }
  return value;
}

function getCurrentLocale() {
  return currentLocale;
}

function getSupportedLocales() {
  return SUPPORTED_LOCALES;
}

// 挂载到全局，便于通过 script 标签引入后全局访问
window.i18n = {
  loadLocale,
  t,
  getCurrentLocale,
  getSupportedLocales
};