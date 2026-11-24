import { piSessionLocatorSchema } from '@pi-steward/contract';
import type { PiSessionLocator } from '@pi-steward/contract';
import type { AttemptRow } from './views.js';

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

export function sameLocator(a: PiSessionLocator | undefined, b: PiSessionLocator) {
  return a?.path === b.path && a.sessionId === b.sessionId && a.sessionFile === b.sessionFile;
}
