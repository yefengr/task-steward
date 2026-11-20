import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { DEFAULT_LOCAL_CONFIG, LEGACY_LOCAL_CONFIG, errorResponseSchema, localConfigSchema } from '@pi-steward/contract';
import { platformFetch, PlatformTransportError } from '@pi-steward/platform-http';

const REQUEST_TIMEOUT_MS = 4_000;

export class AgentError extends Error {
  constructor(readonly code: string) { super(code); }
}

type Validator<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };

function loadConfig(env: NodeJS.ProcessEnv) {
  const home = homedir();
  const current = resolve(home, DEFAULT_LOCAL_CONFIG);
  const legacy = resolve(home, LEGACY_LOCAL_CONFIG);
  const path = env.STEWARD_CONFIG !== undefined ? resolve(env.STEWARD_CONFIG) :
    !existsSync(current) && existsSync(legacy) ? legacy : current;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error();
      const config = localConfigSchema.safeParse(JSON.parse(readFileSync(fd, 'utf8')));
      if (!config.success) throw new Error();
      return config.data;
    } finally { closeSync(fd); }
  } catch { throw new AgentError('invalid_config'); }
}

export function agentClient(attemptId: string, options: { env: NodeJS.ProcessEnv; fetcher?: typeof fetch }) {
  return async function request<T>(method: 'GET' | 'POST' | 'PATCH', route: string, schema: Validator<T>, body?: object, signal?: AbortSignal) {
    const config = loadConfig(options.env);
    const origin = new URL(config.platformUrl).origin;
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      const url = `${origin}/api/v1/agent/${route}`;
      const init: RequestInit = {
        method, redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        headers: { Authorization: `Bearer ${config.machineToken}`, 'X-Steward-Attempt-Id': attemptId,
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      };
      res = await (options.fetcher ? options.fetcher(url, init) : platformFetch(url, init, config.proxy));
    } catch (error) {
      if (signal?.aborted) throw new AgentError('cancelled');
      throw new AgentError(error instanceof PlatformTransportError ? error.code : 'network_error');
    }
    let data: unknown;
    try { data = await res.json(); } catch { throw new AgentError('invalid_response'); }
    if (!res.ok) {
      const parsed = errorResponseSchema.safeParse(data);
      throw new AgentError(parsed.success ? parsed.data.error.code : 'invalid_response');
    }
    const result = schema.safeParse(data);
    if (!result.success) throw new AgentError('invalid_response');
    return result.data;
  };
}

export function validatedBody<T>(schema: Validator<T>, body: unknown) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AgentError('invalid_request');
  return parsed.data;
}
