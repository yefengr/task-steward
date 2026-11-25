import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';

type Entry = { value: unknown; warn: boolean };
function createStore() {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  return {
    entries,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    clearPrefix(prefix: string) {
      for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
      listeners.forEach((listener) => listener());
    },
    set(key: string, value: unknown, warn: boolean) {
      entries.set(key, { value, warn });
      listeners.forEach((listener) => listener());
    },
  };
}
const ViewState = createContext<ReturnType<typeof createStore> | null>(null);

// 生命周期限定在已认证的 Workspace；不把任务正文写入浏览器存储。
export function TaskViewStateProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createStore);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (![...store.entries.values()].some((entry) => entry.warn)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); };
  }, [store]);
  return <ViewState.Provider value={store}>{children}</ViewState.Provider>;
}

export function useClearTaskViewState() {
  const store = useContext(ViewState);
  if (!store) throw new Error('Task view state requires Workspace');
  return store.clearPrefix;
}

export function useTaskViewState<T>(key: string, initial: T | (() => T), warn = false): [T, Dispatch<SetStateAction<T>>] {
  const store = useContext(ViewState);
  if (!store) throw new Error('Task view state requires Workspace');
  const [fallback] = useState(initial);
  const value = useSyncExternalStore(store.subscribe, () => store.entries.has(key) ? store.entries.get(key)!.value as T : fallback);
  const setValue: Dispatch<SetStateAction<T>> = (next) => {
    const previous = store.entries.has(key) ? store.entries.get(key)!.value as T : fallback;
    const value = typeof next === 'function' ? (next as (value: T) => T)(previous) : next;
    store.set(key, value, warn && value !== undefined && value !== false);
  };
  return [value, setValue];
}
