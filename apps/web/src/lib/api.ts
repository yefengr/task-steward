import * as c from '@pi-steward/contract';
import type { z } from 'zod';
import type { Messages } from './i18n';

export const SESSION_EXPIRED = 'steward-session-expired';
export class WebError extends Error {
  constructor(readonly code: c.ErrorCode | 'network' | 'invalidResponse') { super(code); }
}

export function describeError(error: unknown, t: Messages) {
  return t.errors[error instanceof WebError ? error.code : 'internal_error'];
}

async function request<T>(path: string, output: z.ZodType<T>, options: RequestInit = {}) {
  let response: Response;
  try { response = await fetch(`/api/v1/web${path}`, { credentials: 'same-origin', ...options }); }
  catch (error) {
    if (options.signal?.aborted) throw error;
    throw new WebError('network');
  }
  if (!options.signal?.aborted && response.status === 401 && path !== '/auth/login') {
    window.dispatchEvent(new Event(SESSION_EXPIRED));
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = c.errorResponseSchema.safeParse(body);
    if (!parsed.success) throw new WebError('invalidResponse');
    throw new WebError(parsed.data.error.code);
  }
  const parsed = output.safeParse(body);
  if (!parsed.success) throw new WebError('invalidResponse');
  return parsed.data;
}

function write<T>(method: 'POST' | 'PATCH', path: string, input: z.ZodType, value: unknown, output: z.ZodType<T>) {
  const parsed = input.safeParse(value);
  if (!parsed.success) throw new WebError('invalid_request');
  return request(path, output, {
    method, body: JSON.stringify(parsed.data), headers: { 'Content-Type': 'application/json' },
  });
}

export type TaskAction = 'schedule' | 'unschedule' | 'reschedule' | 'cancel';
const taskApi = (id: string) => `/tasks/${encodeURIComponent(id)}`;

export const api = {
  me: (signal?: AbortSignal) => request('/auth/me', c.webMeResponseSchema, { signal }),
  login: (password: string) => write('POST', '/auth/login', c.webLoginRequestSchema, { password }, c.webLoginResponseSchema),
  logout: () => write('POST', '/auth/logout', c.webLogoutRequestSchema, {}, c.webLogoutResponseSchema),
  projects: (signal?: AbortSignal) => request('/projects', c.webProjectsResponseSchema, { signal }),
  projectTasks: (id: string, signal?: AbortSignal) => request(`/projects/${encodeURIComponent(id)}/tasks`, c.webProjectTasksResponseSchema, { signal }),
  task: (id: string, signal?: AbortSignal) => request(taskApi(id), c.webTaskDetailResponseSchema, { signal }),
  machines: (signal?: AbortSignal) => request('/machines', c.webMachinesResponseSchema, { signal }),
  inspectPairing: (code: string) => write('POST', '/pairing/inspect', c.webPairingRequestSchema, { code }, c.webPairingResponseSchema),
  approvePairing: (code: string) => write('POST', '/pairing/approve', c.webPairingRequestSchema, { code }, c.webApprovePairingResponseSchema),
  create: (input: c.WebCreateTaskRequest) => write('POST', '/tasks', c.webCreateTaskRequestSchema, input, c.webTaskMutationResponseSchema),
  edit: (id: string, input: c.WebUpdateTaskRequest) => write('PATCH', taskApi(id), c.webUpdateTaskRequestSchema, input, c.webTaskMutationResponseSchema),
  action: (id: string, action: TaskAction) => write('POST', `${taskApi(id)}/${action}`, c.webTaskActionRequestSchema, {}, c.webTaskMutationResponseSchema),
  accept: (id: string, deliveryId: string) => write('POST', `${taskApi(id)}/accept`, c.webAcceptRequestSchema, { deliveryId }, c.webTaskMutationResponseSchema),
  rework: (id: string, deliveryId: string, feedback: string) => write('POST', `${taskApi(id)}/rework`, c.webReworkRequestSchema, { deliveryId, feedback }, c.webTaskMutationResponseSchema),
  endDiscussion: (id: string, attemptId: string) => write('POST', `${taskApi(id)}/end-discussion`, c.webEndDiscussionRequestSchema, { attemptId }, c.webTaskMutationResponseSchema),
};
