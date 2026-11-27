import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// 独立本机平台、SQLite、临时 HOME、tmux socket 和确定性 provider；不连接正式平台或远端模型。
const pi = process.argv[2];
if (!pi?.startsWith('/') || !existsSync(pi)) throw new Error('用法：node scripts/smoke-lifecycle.mjs <Pi绝对路径>');
execFileSync('tmux', ['-V'], { stdio: 'ignore' });
const root = fileURLToPath(new URL('../', import.meta.url));
const requirePlatform = createRequire(new URL('../apps/platform/package.json', import.meta.url));
const { serve } = requirePlatform('@hono/node-server');
const { openStore } = await import('../apps/platform/dist/store.js');
const { createApp } = await import('../apps/platform/dist/app.js');
const { addMachine, hashPassword, newMachineToken } = await import('../apps/platform/dist/auth.js');
const { Launcher } = await import('../apps/launcher/dist/launcher.js');
const { platformClient } = await import('../apps/launcher/dist/platform.js');
const { tmuxClient } = await import('../apps/launcher/dist/tmux.js');
const folder = mkdtempSync(join(realpathSync('/tmp'), 'steward-lifecycle-'));
const socket = join(folder, 'isolated.sock');
const workspace = join(folder, 'project');
const configFile = join(folder, 'config.json');
const proof = join(workspace, 'resumed.txt');
const env = { PATH: process.env.PATH, LC_ALL: 'C' };
const tmux = (...args) => execFileSync('tmux', ['-S', socket, '-f', '/dev/null', ...args], { env, encoding: 'utf8', timeout: 3000 });
let server, store;
async function until(label, run) {
  const deadline = Date.now() + 24000;
  while (Date.now() < deadline) {
    const result = await run();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`隔离生命周期冒烟超时：${label}`);
}
try {
  mkdirSync(workspace);
  const token = newMachineToken();
  store = openStore(join(folder, 'fixture.sqlite'));
  addMachine(store, 'Lifecycle smoke Mac', token, Date.now());
  const password = randomBytes(24).toString('hex');
  let app;
  server = serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => app.fetch(request) });
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  app = createApp({ store, publicOrigin: origin, accessPasswordHash: await hashPassword(password), allowLocalHttp: true });
  const config = { platformUrl: origin, allowHttpLoopback: true, machineToken: token, slots: 1,
    projects: [{ id: 'lifecycle-smoke', name: 'Lifecycle smoke', path: workspace }],
    path: [...new Set([dirname(process.execPath), ...(env.PATH ?? '').split(':').filter((p) => p.startsWith('/'))])],
    pi: { command: pi, extraArgs: ['--offline', '--no-approve', '--no-extensions', '--no-context-files', '--no-skills',
      '--provider', 'lifecycle-smoke', '--model', 'local', '-e', join(root, 'scripts/lifecycle-smoke-provider.mjs')] } };
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const state = { version: 1, executions: [], outbox: [] };
  const launcher = new Launcher({ config, configFile, version: 'lifecycle-smoke', state, save: () => {},
    platform: platformClient(config), tmux: tmuxClient(config, { configPath: configFile,
      extensionPath: join(root, 'packages/pi-extension/dist/index.js'), socket,
      env: { HOME: folder, PI_CODING_AGENT_DIR: join(folder, 'pi'), TERM: 'xterm-256color', STEWARD_SMOKE_PROOF: proof } }),
    warn: (message) => console.error(`隔离启动器：${message}`) });
  let cookie;
  async function web(path, body, expected = 200) {
    const response = await fetch(`${origin}/api/v1/web${path}`, { method: body ? 'POST' : 'GET',
      signal: AbortSignal.timeout(4000), headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (path === '/auth/login') cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    assert.equal(response.status, expected, `${path}: ${response.status}`);
    return response.json();
  }
  await web('/auth/login', { password });
  await launcher.tick();
  const { task } = await web('/tasks', { projectId: 'lifecycle-smoke', title: 'Native lifecycle smoke', type: 'implementation' }, 201);
  const path = `/tasks/${task.id}`;
  await web(`${path}/schedule`, {});
  const first = await until('交付结算后保留同一 Pi', async () => {
    await launcher.tick();
    const detail = await web(path);
    const attempt = detail.attempts[0];
    return detail.task.lifecycle?.phase === 'settled' && attempt?.settledAt !== null && detail.deliveries.length === 1 ? detail : false;
  });
  const original = first.attempts[0];
  assert.equal(original.endedAt, null);
  const target = original.tmuxSession;
  const pane = tmux('list-panes', '-t', `=${target}`, '-F', '#{pane_id}').trim();
  assert.match(pane, /^%\d+$/);
  const send = (message, p = pane) => { tmux('send-keys', '-l', '-t', p, '--', message); tmux('send-keys', '-t', p, 'Enter'); };
  assert.equal((await web('/machines')).machines[0].occupiedSlots, 0);
  const source = store.get('SELECT session_locator FROM attempts WHERE id=?', original.id);
  const locator = JSON.parse(source.session_locator);
  send('仅补记录，不修改代码或重做操作');
  await until('专用补记录生成第二版且不恢复实施权限', async () => {
    await launcher.tick();
    const detail = await web(path);
    return detail.deliveries.length === 2 && detail.task.lifecycle.phase === 'settled';
  });
  const revised = await web(path);
  assert.equal(revised.deliveries[1].kind, 'record');
  assert.equal(revised.deliveries[1].sourceDeliveryId, revised.deliveries[0].id);
  assert.equal(revised.attempts[0].workRevision, 0);
  assert.equal(revised.attempts[0].endedAt, null);
  await web(`${path}/accept`, { deliveryId: revised.deliveries[0].id }, 409);

  // 单槽位仍允许原 Pi 显式前台续做；另一个后台讨论保持运行，占据唯一后台名额。
  const { task: other } = await web('/tasks', { projectId: 'lifecycle-smoke', title: 'Unrelated background discussion', type: 'discussion' }, 201);
  await web(`/tasks/${other.id}/schedule`, {});
  const second = await until('结算名额可启动另一项后台工作', async () => {
    await launcher.tick();
    const detail = await web(`/tasks/${other.id}`);
    return detail.attempts[0]?.startedAt ? detail.attempts[0] : false;
  });
  assert.equal((await web('/machines')).machines[0].occupiedSlots, 1);
  send('明确授权续做后等待暂停');
  await until('原 Pi 不受后台额度限制取得新工作段', async () => {
    await launcher.tick();
    const detail = await web(path);
    return detail.task.status === 'running' && detail.attempts[0].workRevision === 1 &&
      detail.progress.some((row) => row.text.includes('等待主动暂停'));
  });
  const continued = await web(path);
  assert.equal(continued.attempts.length, 1);
  assert.equal(continued.task.executionMode, 'foreground');
  assert.equal((await web('/machines')).machines[0].occupiedSlots, 1);
  const stale = await fetch(`${origin}/api/v1/agent/progress`, { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'X-Steward-Attempt-Id': original.id, 'X-Steward-Work-Revision': '0', 'Content-Type': 'application/json',
  }, body: JSON.stringify({ requestId: randomUUID(), text: 'stale write must not land' }) });
  assert.equal(stale.status, 409);
  assert.ok(!store.get('SELECT 1 FROM progress WHERE text=?', 'stale write must not land'));

  await web(`${path}/session-operation`, { requestId: randomUUID(), attemptId: original.id, mode: 'pause' });
  await until('执行端确认暂停，保留原生对话', async () => {
    await launcher.tick();
    const detail = await web(path);
    return detail.task.lifecycle?.phase === 'paused' && detail.attempts.at(-1).endedAt !== null;
  });
  assert.ok(existsSync(locator.sessionFile));
  const unaffected = (await web(`/tasks/${other.id}`)).attempts[0];
  assert.equal(unaffected.id, second.id);
  assert.equal(unaffected.endedAt, null);
  await web(`${path}/session-operation`, { requestId: randomUUID(), attemptId: original.id, mode: 'continue' }, 409);
  await web(`/tasks/${other.id}/cancel`, {});
  await until('只停止本脚本的另一项后台讨论', async () => { await launcher.tick(); return (await web(`/tasks/${other.id}`)).attempts[0].endedAt !== null; });
  await web(`${path}/session-operation`, { requestId: randomUUID(), attemptId: original.id, mode: 'continue' });
  const resumed = await until('同一原生对话核对后自动接续并重新交付结算', async () => {
    await launcher.tick();
    const detail = await web(path);
    return existsSync(proof) && detail.attempts.length === 2 && detail.attempts.at(-1).settledAt !== null &&
      detail.task.lifecycle?.phase === 'settled' ? detail : false;
  });
  assert.equal(resumed.attempts[1].sessionId, original.sessionId);
  assert.equal(readFileSync(proof, 'utf8'), 'same conversation resumed safely\n');
  assert.equal(resumed.deliveries.length, 3);
  const accepted = resumed.deliveries.at(-1);
  await web(`${path}/accept`, { deliveryId: accepted.id });
  const complete = await until('人工验收后确认 Pi 退出并完成无Git清理', async () => {
    await launcher.tick();
    const detail = await web(path);
    return detail.task.status === 'done' && detail.attempts.at(-1).endedAt !== null ? detail : false;
  });
  assert.ok(complete.task.lifecycle.acceptedAt !== null);
  assert.equal(complete.task.lifecycle.phase, 'complete');
  assert.ok(existsSync(locator.sessionFile));
  assert.equal(store.get('SELECT COUNT(*) n FROM tasks').n, 2);
  console.log('真实 Pi 生命周期隔离冒烟通过：交付结算后进程保留并释放后台名额；独立补记录与旧版本拒绝；后台满额原 Pi 显式前台续做及迟到写隔离；暂停确认、限额拒绝、原生对话自动接续；验收后退出清理，历史保留。');
} catch (error) {
  try {
    for (const target of tmux('list-sessions', '-F', '#{session_name}').trim().split('\n')) {
      console.error(tmux('capture-pane', '-p', '-S', '-80', '-t', `=${target}`));
    }
  } catch { /* 隔离进程可能已停止。 */ }
  throw error;
} finally {
  try { tmux('kill-server'); } catch { /* 仅停止本脚本创建的临时 socket。 */ }
  if (server) await new Promise((resolve) => server.close(resolve));
  store?.connection.close();
  rmSync(folder, { recursive: true, force: true });
}
