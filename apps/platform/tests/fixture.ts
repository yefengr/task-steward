import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect } from 'vitest';
import * as c from '@pi-steward/contract';
import { createApp } from '../src/app.js';
import { addMachine, hashPassword, newMachineToken } from '../src/auth.js';
import { openStore } from '../src/store.js';

export const origin = 'http://127.0.0.1:3000';
export const project = { id: 'steward', name: 'Steward', path: '/work/中文 project' };
export const delivery = { summary: '交付', done: ['已完成'], notCovered: [], verification: ['测试'], howTo: [], issues: [],
  baseCommit: 'base', commit: 'result', reportRef: 'report.md' };
export const request = (body: object = {}) => ({ requestId: randomUUID(), ...body });

export function useFixture() {
  const password = randomBytes(20).toString('hex');
  let hash: string;
  beforeAll(async () => { hash = await hashPassword(password); });
  const stores: ReturnType<typeof openStore>[] = [];
  afterAll(() => { for (const store of stores) store.connection.close(); });
  return async function setup(options: { secure?: boolean; login?: boolean; trustProxy?: boolean } = {}) {
    let now = 1_800_000_000_000;
    const store = openStore(':memory:');
    stores.push(store);
    const token = newMachineToken();
    const machineId = addMachine(store, 'Mac', token, now);
    const otherToken = newMachineToken();
    const otherId = addMachine(store, 'Other Mac', otherToken, now);
    const publicOrigin = options.secure ? 'https://steward.example' : origin;
    const app = createApp({ store, accessPasswordHash: hash, publicOrigin, allowLocalHttp: !options.secure,
      now: () => now, trustProxyClientIp: options.trustProxy });
    let cookie: string | undefined;
    async function send(path: string, body?: object, auth: { machine?: string; attempt?: string; web?: boolean;
      headers?: Record<string, string>; method?: string } = {}) {
      const headers = new Headers(auth.headers);
      if (body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      if (auth.web) {
        if (cookie) headers.set('Cookie', cookie);
        if (!headers.has('Origin')) headers.set('Origin', publicOrigin);
      }
      if (auth.machine) headers.set('Authorization', `Bearer ${auth.machine}`);
      if (auth.attempt) headers.set('X-Steward-Attempt-Id', auth.attempt);
      return app.request(`/api/v1${path}`, { headers, method: auth.method ?? (body ? 'POST' : 'GET'),
        body: body ? JSON.stringify(body) : undefined });
    }
    const login = (value = password, headers?: Record<string, string>) => send('/web/auth/login', { password: value }, { web: true, headers });
    if (options.login !== false) {
      const response = await login();
      expect(response.status).toBe(200);
      cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
      expect(Boolean(cookie)).toBe(true);
    }
    const web = (path: string, body?: object, method?: string) => send(`/web${path}`, body, { web: true, method });
    const launcher = (path: string, body: object, machine = token) => send(`/launcher${path}`, body, { machine });
    const agent = (id: string, path: string, body?: object, method?: string) => send(`/agent${path}`, body, { machine: token, attempt: id, method });
    const heartbeat = (slots = 1, projects = [project], attempts: c.LauncherHeartbeatRequest['attempts'] = [], machine = token) =>
      launcher('/heartbeat', request({ launcherVersion: 'test', slots, projects, attempts }), machine);
    async function create(title = '标题', fields: Partial<c.WebCreateTaskRequest> = {}) {
      const response = await web('/tasks', { projectId: project.id, title, ...fields });
      expect(response.status).toBe(201);
      return c.webTaskMutationResponseSchema.parse(await response.json()).task;
    }
    const action = (id: string, name: string, body = {}) => web(`/tasks/${id}/${name}`, body);
    const detail = async (id: string) => c.webTaskDetailResponseSchema.parse(await (await web(`/tasks/${id}`)).json());
    const claim = (body = request(), machine = token) => launcher('/claim', body, machine);
    async function claimed() {
      const response = await claim();
      const { attempt } = c.launcherClaimResponseSchema.parse(await response.json());
      if (!attempt) throw new Error('Expected a claimed attempt');
      return attempt;
    }
    const exit = (id: string, body = request({ exitCode: null, endedAt: now })) => launcher(`/attempts/${id}/exited`, body);
    return { app, store, send, web, agent, launcher, heartbeat, login, create, action, detail, claim, claimed, exit, machineId,
      otherId, token, otherToken, advance: (ms: number) => { now += ms; }, now: () => now };
  };
}

export async function errorCode(response: Response, status: number, code: c.ErrorCode) {
  expect(response.status).toBe(status);
  expect(c.errorResponseSchema.parse(await response.json()).error.code).toBe(code);
}
