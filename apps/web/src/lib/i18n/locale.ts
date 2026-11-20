const LANGUAGE_STORAGE_KEY = 'pi-steward-language';

type Locale = 'zh-CN' | 'en';

function selectedLocale(): Locale {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === 'zh-CN' || stored === 'en') return stored;
  } catch { /* 存储不可用时按浏览器语言显示。 */ }
  for (const language of navigator.languages ?? [navigator.language]) {
    const primary = language.toLowerCase().split('-')[0];
    if (primary === 'zh') return 'zh-CN';
    if (primary === 'en') return 'en';
  }
  return 'en';
}

let locale = selectedLocale();
document.documentElement.lang = locale;
const listeners = new Set<() => void>();

export function getLocale() {
  return locale;
}

export function toggleLanguage() {
  locale = locale === 'zh-CN' ? 'en' : 'zh-CN';
  document.documentElement.lang = locale;
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, locale); }
  catch { /* 这次访问仍按选择显示。 */ }
  for (const listener of listeners) listener();
}

export function subscribeLanguage(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
