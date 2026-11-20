import { useSyncExternalStore } from 'react';
import { getLocale, subscribeLanguage, toggleLanguage } from './locale';
import { en } from './messages/en';
import { zh } from './messages/zh';

export type { Messages } from './messages/en';
export { toggleLanguage };

const dictionaries = { en, 'zh-CN': zh };
const dateOptions = { dateStyle: 'medium', timeStyle: 'short' } as const;
const formatters = { en: new Intl.DateTimeFormat('en', dateOptions), 'zh-CN': new Intl.DateTimeFormat('zh-CN', dateOptions) };

export function useI18n() {
  const locale = useSyncExternalStore(subscribeLanguage, getLocale);
  return { t: dictionaries[locale], locale, dateTime: formatters[locale].format };
}
