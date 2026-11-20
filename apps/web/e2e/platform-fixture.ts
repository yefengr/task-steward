import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, test as base } from '@playwright/test';
import * as c from '@pi-steward/contract';

const admin = fileURLToPath(new URL('../../platform/dist/admin.js', import.meta.url));
const index = fileURLToPath(new URL('../../platform/dist/index.js', import.meta.url));
const webDir = fileURLToPath(new URL('../dist', import.meta.url));
export const artifact = (name: string) => fileURLToPath(new URL(`../../../.pi/tmp/steward-web-e2e/${name}`, import.meta.url));

async function freeLocalPort() {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error || !address || typeof address === 'string') reject(error ?? new Error('No loopback port'));
        else resolve(address.port);
      });
    });
  });
}

function adminInput(args: string[], input: string, env: NodeJS.ProcessEnv) {
  try { return execFileSync(process.execPath, [admin, ...args], { input, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error(`Could not prepare platform test data (${args[0]})`); }
}

async function waitForPlatform(origin: string, stopped: () => boolean) {
  for (let attempt = 0; attempt < 30 && !stopped(); attempt += 1) {
    const status = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(250) }).then((response) => response.status).catch(() => 0);
    if (status === 200) return;
    await setTimeout(100);
  }
  throw new Error('The test platform did not start. Build the contract, platform and web packages first.');
}

export const projectId = 'steward-demo';
export const projectName = 'Task Steward 任务控制台';
const machineName = '测试 Mac';

function platformApi(origin: string, token: string) {
  async function post(path: string, data: object, attemptId?: string) {
    const response = await fetch(`${origin}/api/v1${path}`, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(attemptId ? { 'X-Steward-Attempt-Id': attemptId } : {}),
    }, body: JSON.stringify(data) });
    expect(response.status, path).toBe(200);
    return response.json() as Promise<unknown>;
  }
  return {
    register: async (path: string) => c.launcherHeartbeatResponseSchema.parse(await post('/launcher/heartbeat',
      c.launcherHeartbeatRequestSchema.parse({ requestId: randomUUID(), launcherVersion: 'smoke', slots: 2,
        projects: [{ id: projectId, name: projectName, path }], attempts: [] }))),
    claim: async () => c.launcherClaimResponseSchema.parse(await post('/launcher/claim', { requestId: randomUUID() })).attempt,
    started: async (id: string) => c.launcherStartedResponseSchema.parse(await post(`/launcher/attempts/${id}/started`,
      { requestId: randomUUID(), tmuxSession: `steward-${id}`, startedAt: Date.now() })),
    progress: async (id: string, text: string) => c.agentProgressResponseSchema.parse(await post('/agent/progress', { requestId: randomUUID(), text }, id)),
    deliver: async (id: string, summary: string) => c.agentDeliveryResponseSchema.parse(await post('/agent/deliveries', {
      requestId: randomUUID(), summary, done: ['已保存任务详情'], notCovered: [], verification: ['运行检查通过'], howTo: [], issues: [],
    }, id)),
    exited: async (id: string) => c.launcherExitedResponseSchema.parse(await post(`/launcher/attempts/${id}/exited`,
      { requestId: randomUUID(), exitCode: 0, endedAt: Date.now() })),
  };
}

interface Fixture { origin: string; password: string; api: ReturnType<typeof platformApi> }
export const test = base.extend<{ platform: Fixture }>({
  platform: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'steward-web-e2e-'));
    try {
      const port = await freeLocalPort();
      const origin = `http://127.0.0.1:${port}`;
      const password = randomBytes(24).toString('base64url');
      const token = `stm_${randomBytes(32).toString('base64url')}`;
      const env = { ...process.env, STEWARD_DATA_DIR: directory, STEWARD_PUBLIC_ORIGIN: origin, STEWARD_ALLOW_LOCAL_HTTP: '1',
        STEWARD_WEB_DIR: webDir, PORT: String(port) };
      adminInput(['machine:add', machineName], token, env);
      const hash = adminInput(['hash-password'], password, env);
      const child = spawn(process.execPath, [index], { env: { ...env, STEWARD_ACCESS_PASSWORD_HASH: hash }, stdio: 'ignore' });
      let stopped = false;
      const closed = new Promise<void>((resolve) => child.once('close', () => { stopped = true; resolve(); }));
      child.once('error', () => { stopped = true; });
      try {
        await waitForPlatform(origin, () => stopped);
        const api = platformApi(origin, token);
        await api.register(directory);
        await use({ origin, password, api });
      } finally {
        if (!stopped) child.kill();
        await closed;
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  },
});
export { expect };
