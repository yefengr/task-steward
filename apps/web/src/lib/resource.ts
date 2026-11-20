import { useEffect, useEffectEvent, useState } from 'react';

const POLL_INTERVAL_MS = 10_000;

export function useResource<T>(load: (signal: AbortSignal) => Promise<T>, poll = true) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [revision, setRevision] = useState(0);
  const fetchData = useEffectEvent(load);

  useEffect(() => {
    let current: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function stop() {
      current?.abort();
      clearTimeout(timer);
    }
    async function read() {
      stop();
      if (poll && document.hidden) return;
      const controller = new AbortController();
      current = controller;
      try {
        const value = await fetchData(controller.signal);
        if (controller.signal.aborted) return;
        setData(value);
        setError(undefined);
      } catch (error) {
        if (!controller.signal.aborted) setError(error);
      } finally {
        if (poll && !controller.signal.aborted && !document.hidden) timer = setTimeout(read, POLL_INTERVAL_MS);
      }
    }
    function visibilityChange() {
      if (document.hidden) stop();
      else void read();
    }
    void read();
    if (poll) document.addEventListener('visibilitychange', visibilityChange);
    return () => {
      stop();
      if (poll) document.removeEventListener('visibilitychange', visibilityChange);
    };
  }, [revision, poll]);

  return { data, error, refresh: () => setRevision((value) => value + 1) };
}
