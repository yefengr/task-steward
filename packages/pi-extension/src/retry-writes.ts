import { createHash, randomUUID } from 'node:crypto';
import { AgentError } from './client.js';

const MAX_PENDING_WRITES = 128;
const UNCERTAIN_RESULT = new Set(['network_error', 'invalid_response', 'internal_error']);

export function retryableWrites({ cancelledMayHaveSaved = false } = {}) {
  const pending = new Map<string, { requestId: string; uncertain: boolean; inFlight?: Promise<unknown> }>();
  return async function write<T>(method: string, route: string, args: object, send: (id: string) => Promise<T>): Promise<T> {
    const key = createHash('sha256').update(JSON.stringify([method, route, Object.entries(args).sort()])).digest('hex');
    let entry = pending.get(key);
    if (!entry) {
      // 保留未知结果的 ID，达到上限时要求先重试已有请求。
      if (pending.size >= MAX_PENDING_WRITES) throw new AgentError('pending_writes_full');
      entry = { requestId: randomUUID(), uncertain: false };
      pending.set(key, entry);
    }
    if (entry.inFlight) return entry.inFlight as Promise<T>;
    const current = entry;
    const inFlight = Promise.resolve().then(() => send(current.requestId)).then((data) => {
      pending.delete(key);
      return data;
    }, (error: unknown) => {
      if (error instanceof AgentError && (UNCERTAIN_RESULT.has(error.code) || (cancelledMayHaveSaved && error.code === 'cancelled'))) {
        current.uncertain = true;
      }
      // 之后一次明确的拒绝不能证明更早的未知结果没有保存。
      if (!current.uncertain) pending.delete(key);
      throw error;
    }).finally(() => { delete current.inFlight; });
    current.inFlight = inFlight;
    return inFlight;
  };
}
