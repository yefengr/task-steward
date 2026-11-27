import { piSessionLocatorSchema } from '@pi-steward/contract';
import type { PiSessionLocator } from '@pi-steward/contract';
import type { AttemptRow } from './views.js';
import type { Store } from './store.js';

export function confirmedLocator(attempt: AttemptRow): PiSessionLocator | undefined {
  const result = piSessionLocatorSchema.safeParse({ path: attempt.confirmed_workspace_path,
    sessionId: attempt.confirmed_session_id, sessionFile: attempt.confirmed_session_file });
  return result.success ? result.data : undefined;
}

export function attemptLocator(attempt: AttemptRow): PiSessionLocator | undefined {
  if (!attempt.session_locator) return confirmedLocator(attempt);
  try {
    const result = piSessionLocatorSchema.safeParse(JSON.parse(attempt.session_locator));
    return result.success ? result.data : undefined;
  } catch { return undefined; }
}

// 目标 ID 不是原生对话的互斥边界；不同任务也不能同时占用同一会话。
export function sessionInUse(store: Store, machineId: string, locator: PiSessionLocator, taskId = '') {
  return Boolean(store.get(`SELECT 1 FROM attempts WHERE machine_id=? AND task_id<>? AND ended_at IS NULL AND
    (COALESCE(json_extract(session_locator,'$.sessionFile'),confirmed_session_file)=? OR
     COALESCE(json_extract(session_locator,'$.sessionId'),confirmed_session_id,session_id)=?) LIMIT 1`,
  machineId, taskId, locator.sessionFile, locator.sessionId) || store.get(`SELECT 1 FROM session_operations
    WHERE machine_id=? AND task_id<>? AND step IN ('stop','launch','cleanup') AND
    (json_extract(locator,'$.sessionFile')=? OR json_extract(locator,'$.sessionId')=?) LIMIT 1`,
  machineId, taskId, locator.sessionFile, locator.sessionId));
}

export function sameLocator(a: PiSessionLocator | undefined, b: PiSessionLocator) {
  return a?.path === b.path && a.sessionId === b.sessionId && a.sessionFile === b.sessionFile;
}
