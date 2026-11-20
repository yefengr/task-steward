import * as c from '@pi-steward/contract';
import type { z } from 'zod';
import type { Event } from './state.js';

const REQUEST_TIMEOUT_MS = 4_000;

export class PlatformError extends Error {
  constructor(readonly code: c.ErrorCode | 'network_error' | 'invalid_response', readonly startedAlreadySaved = false) {
    super(`平台请求失败（${code}）。`);
  }
}

export function platformClient(config: c.LocalConfig, fetcher = fetch, getMachineToken = () => config.machineToken) {
  const origin = new URL(config.platformUrl).origin;
  async function post<T>(path: string, body: object, schema: z.ZodType<T>, startedReport = false): Promise<T> {
    let machineToken: string;
    try { machineToken = getMachineToken(); } catch { throw new PlatformError('unauthorized'); }
    let res: Response;
    let data: unknown;
    try {
      res = await fetcher(`${origin}/api/v1/launcher/${path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${machineToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      data = await res.json();
    } catch {
      throw new PlatformError('network_error');
    }
    if (!res.ok) {
      const parsed = c.errorResponseSchema.safeParse(data);
      if (!parsed.success) throw new PlatformError('invalid_response');
      const { code, message } = parsed.data.error;
      // M1 同时用 conflict 表示请求 ID 绑定冲突和已有开始记录，只认后者的固定响应。
      const alreadySaved = startedReport && res.status === 409 && code === 'conflict' && message === 'Attempt already has a start report';
      throw new PlatformError(code, alreadySaved);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new PlatformError('invalid_response');
    return parsed.data;
  }
  return {
    claim: (requestId: string) => post('claim', { requestId }, c.launcherClaimResponseSchema),
    heartbeat: (body: c.LauncherHeartbeatRequest) => post('heartbeat', body, c.launcherHeartbeatResponseSchema),
    report: (e: Event) => post(`attempts/${e.id}/${e.kind}`, e.body,
      e.kind === 'started' ? c.launcherStartedResponseSchema : c.launcherExitedResponseSchema, e.kind === 'started'),
  };
}

export type Platform = ReturnType<typeof platformClient>;
