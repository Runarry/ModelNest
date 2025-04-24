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
  if (!SUPPORTED_LOCALES.some(l => l.code === locale)) locale = 'zh-CN';
  const res = await fetch(`./locales/${locale}.json`);
  messages = await res.json();
  currentLocale = locale;
  localStorage.setItem(LOCALE_KEY, locale);
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