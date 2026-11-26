import { useSyncExternalStore } from 'react';
import { readSystemBodySize, supportsSystemTextSize, textSizeForSystemBody } from '@yefengr/pwa-foundation';
import type { PwaTextSizePreference } from '@yefengr/pwa-foundation';

const STORAGE_KEY = 'pi-steward-text-size';
const listeners = new Set<() => void>();
let preference: PwaTextSizePreference = 'system';

function valid(value: unknown): value is PwaTextSizePreference {
  return value === 'system' || value === 'standard' || value === 'large' || value === 'xlarge';
}

function apply() {
  const size = preference === 'system' ? textSizeForSystemBody(readSystemBodySize()) : preference;
  if (size === 'standard') document.documentElement.removeAttribute('data-pwa-text-size');
  else document.documentElement.setAttribute('data-pwa-text-size', size);
  listeners.forEach((listener) => listener());
}

export function setTextSizePreference(value: PwaTextSizePreference) {
  preference = value;
  try { localStorage.setItem(STORAGE_KEY, value); } catch { /* 存储不可用时保留本次会话偏好。 */ }
  apply();
}

export function installTextSizePreference() {
  const restore = () => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      preference = valid(stored) ? stored : 'system';
    } catch { /* 保留内存偏好。 */ }
    apply();
  };
  const visibility = () => { if (document.visibilityState === 'visible') restore(); };
  const storage = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) restore(); };
  restore();
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('storage', storage);
  return () => {
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('storage', storage);
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useTextSizePreference() {
  const value = useSyncExternalStore(subscribe, () => preference, () => 'system' as const);
  const supportsSystem = supportsSystemTextSize();
  return { preference: value === 'system' && !supportsSystem ? 'standard' : value, supportsSystem };
}
