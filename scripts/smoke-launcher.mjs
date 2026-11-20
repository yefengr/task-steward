import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const env = { PATH: process.env.PATH, LC_ALL: 'C' };
const root = fileURLToPath(new URL('../', import.meta.url));

async function smoke() {
  try { execFileSync('tmux', ['-V'], { env, stdio: 'ignore', timeout: 3_000 }); } catch (error) {
    if (error.code === 'ENOENT') { console.log('跳过启动器冒烟：本机没有 tmux。'); return; }
    throw new Error('tmux 版本检查失败');
  }
  const { createApp } = await import('../apps/platform/dist/app.js');
  const { openStore } = await import('../apps/platform/dist/store.js');
  const { addMachine, hashPassword, newMachineToken } = await import('../apps/platform/dist/auth.js');
  const { readConfig } = await import('../apps/launcher/dist/config.js');
  const { Launcher } = await import('../apps/launcher/dist/launcher.js');
  const { platformClient } = await import('../apps/launcher/dist/platform.js');
  const { loadState, saveState } = await import('../apps/launcher/dist/state.js');
  const { tmuxClient } = await import('../apps/launcher/dist/tmux.js');
  const platformRequire = createRequire(new URL('../apps/platform/package.json', import.meta.url));
  const { serve } = platformRequire('@hono/node-server');
  const folder = mkdtempSync(join(realpathSync('/tmp'), 'ps-smoke-'));
  const socket = join(folder, 'tmux.sock');
  let server;
  let store;
  try {
    const workspace = join(folder, '中文 project #{pane_id};');
    const configPath = join(folder, '配置 config;');
    const statePath = join(folder, 'launcher-state.json');
    mkdirSync(workspace);
    const password = randomBytes(24).toString('hex');
    const machineToken = newMachineToken();
    store = openStore(join(folder, 'platform.sqlite'));
    addMachine(store, 'Smoke Mac', machineToken, Date.now());
    let app;
    server = serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => app.fetch(request) });
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    app = createApp({ store, publicOrigin: origin, accessPasswordHash: await hashPassword(password), allowLocalHttp: true });
    const config = {
      platformUrl: origin, allowHttpLoopback: true, machineToken, slots: 1,
      projects: [{ id: 'smoke', name: '假 Agent 项目', path: workspace }],
      path: [...new Set([dirname(process.execPath), ...(env.PATH ?? '').split(':').filter((item) => item.startsWith('/'))])],
      pi: { command: process.execPath, extraArgs: [join(root, 'scripts/fake-agent.mjs')] },
    };
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    const extensionPath = join(root, 'packages/pi-extension/dist/index.js');
    const local = readConfig(configPath);
    const tmux = tmuxClient(local, { configPath, extensionPath, socket, env: { HOME: folder } });
    const launcher = () => new Launcher({ config: local, version: 'smoke', state: loadState(statePath),
      save: (state) => saveState(statePath, state), platform: platformClient(local), tmux });
    let cookie;
    async function web(path, body) {
      const response = await fetch(`${origin}/api/v1/web${path}`, { method: body ? 'POST' : 'GET',
        headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(4_000),
      });
      if (path === '/auth/login') cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
      if (!response.ok) throw new Error(`网页 API 请求失败（${response.status}）`);
      return response.json();
    }
    await web('/auth/login', { password });
    assert.ok(Boolean(cookie));
    await launcher().tick();
    const { task } = await web('/tasks', { projectId: 'smoke', title: '-@中文\n标题; #{pane_id}', goal: `@完整正文\n${'测试正文'.repeat(10_000)};` });
    await web(`/tasks/${task.id}/schedule`, {});
    const detail = () => web(`/tasks/${task.id}`);
    async function waitForExit(version) {
      const deadline = Date.now() + 7_000;
      while (Date.now() < deadline) {
        // 每轮从磁盘恢复，端到端覆盖守护进程重启后的核对与报告。
        await launcher().tick();
        const data = await detail();
        const attempt = data.attempts.find(({ kind }) => kind === (version === 1 ? 'new' : 'rework'));
        if (attempt?.endedAt != null) {
          if (attempt.result !== 'delivered') throw new Error(`第 ${version} 轮假 Agent 未完成交付`);
          assert.ok(attempt.startedAt != null);
          assert.equal(data.task.status, 'review');
          assert.ok(data.progress.some(({ attemptId }) => attemptId === attempt.id));
          assert.deepEqual(loadState(statePath).outbox, []);
          return data.deliveries.find((item) => item.version === version);
        }
        await sleep(75);
      }
      throw new Error(`第 ${version} 轮等待尝试退出超时`);
    }
    const v1 = await waitForExit(1);
    await web(`/tasks/${task.id}/rework`, { deliveryId: v1.id, feedback: '请验证返修' });
    const v2 = await waitForExit(2);
    await web(`/tasks/${task.id}/accept`, { deliveryId: v2.id });
    assert.equal((await detail()).task.status, 'done');
    console.log('启动器冒烟通过：在隔离 tmux 中领取、回报、交付、退出，复用原会话返修并通过验收。');
  } finally {
    try { execFileSync('tmux', ['-S', socket, 'kill-server'], { env, stdio: 'ignore', timeout: 3_000 }); } catch { /* 已无 server。 */ }
    if (server) await new Promise((resolve) => server.close(resolve));
    store?.connection.close();
    rmSync(folder, { recursive: true, force: true });
  }
}

smoke().catch((error) => {
  if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error.code)) console.error('冒烟依赖未构建，请先构建 contract、platform、launcher 和 pi-extension。');
  else if (/^第 [12] 轮|^网页 API 请求失败|^tmux 版本检查失败/u.test(error.message)) console.error(error.message);
  else console.error('启动器冒烟失败。');
  process.exitCode = 1;
});
