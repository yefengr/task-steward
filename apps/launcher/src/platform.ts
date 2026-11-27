import { randomUUID } from 'node:crypto';
import * as c from '@pi-steward/contract';
import { platformFetch, PlatformTransportError } from '@pi-steward/platform-http';
import type { z } from 'zod';
import type { Event } from './state.js';

const REQUEST_TIMEOUT_MS = 4_000;
const legacyHeartbeatResponse = c.launcherHeartbeatResponseSchema.omit({ sessionOperations: true, gitOperations: true }).strip();

export class PlatformError extends Error {
  constructor(readonly code: c.ErrorCode | PlatformTransportError['code'] | 'network_error', readonly startedAlreadySaved = false) {
    super(`平台请求失败（${code}）。`);
  }
}

export function platformClient(config: c.LocalConfig, fetcher?: typeof fetch, getMachineToken = () => config.machineToken) {
  const origin = new URL(config.platformUrl).origin;
  async function post<T>(path: string, body: object, schema: z.ZodType<T>, startedReport = false): Promise<T> {
    let machineToken: string;
    try { machineToken = getMachineToken(); } catch { throw new PlatformError('unauthorized'); }
    let res: Response;
    let data: unknown;
    try {
      const url = `${origin}/api/v1/launcher/${path}`;
      const init: RequestInit = {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${machineToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      };
      res = await (fetcher ? fetcher(url, init) : platformFetch(url, init, config.proxy));
      data = await res.json();
    } catch (error) {
      throw new PlatformError(error instanceof PlatformTransportError ? error.code : 'network_error');
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
    heartbeat: async (body: c.LauncherHeartbeatRequest) => {
      if (!body.sessionControl) return post('heartbeat', body, legacyHeartbeatResponse);
      try {
        return await post('heartbeat', body, c.launcherHeartbeatResponseSchema);
      } catch (error) {
        if (!(error instanceof PlatformError) || error.code !== 'invalid_request') throw error;
        return post('heartbeat', { ...body, sessionControl: undefined, gitLifecycle: undefined, requestId: randomUUID() }, legacyHeartbeatResponse);
      }
    },
    reportGit: (id: string, body: c.LauncherGitReport) => post(`git-operations/${id}/report`, body, c.okResponseSchema),
    reportSession: (id: string, body: c.LauncherSessionReport) => post(`session-operations/${id}/report`, body, c.okResponseSchema),
    report: (e: Event) => post(`attempts/${e.id}/${e.kind}`, e.body,
      e.kind === 'started' ? c.launcherStartedResponseSchema : c.launcherExitedResponseSchema, e.kind === 'started'),
  };
}

export type Platform = ReturnType<typeof platformClient>;
