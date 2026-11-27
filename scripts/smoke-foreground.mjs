import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// 隔离真 Pi + tmux 验证，不连接正式服务，不安装扩展或改用户配置，不调用远端模型。
const pi = process.argv[2];
if (!pi?.startsWith('/') || !existsSync(pi)) throw new Error('用法：node scripts/smoke-foreground.mjs <Pi绝对路径>');
execFileSync('tmux', ['-V'], { stdio: 'ignore' });
const root = fileURLToPath(new URL('../', import.meta.url));
const extension = process.argv[3] ?? join(root, 'packages/pi-extension/dist/index.js');
const requirePlatform = createRequire(new URL('../apps/platform/package.json', import.meta.url));
const { serve } = requirePlatform('@hono/node-server');
const { openStore } = await import('../apps/platform/dist/store.js');
const { createApp } = await import('../apps/platform/dist/app.js');
const { addMachine, hashPassword, newMachineToken } = await import('../apps/platform/dist/auth.js');
const { Launcher } = await import('../apps/launcher/dist/launcher.js');
const { platformClient } = await import('../apps/launcher/dist/platform.js');
const { tmuxClient } = await import('../apps/launcher/dist/tmux.js');
const folder = mkdtempSync(join(realpathSync('/tmp'), 'steward-foreground-'));
const socket = join(folder, 'isolated.sock');
const workspace = join(folder, 'project');
const configFile = join(folder, 'config.json');
const proof = join(workspace, 'continued.txt');
const env = { PATH: process.env.PATH, LC_ALL: 'C' };
const tmux = (...args) => execFileSync('tmux', ['-S', socket, '-f', '/dev/null', ...args], { env, encoding: 'utf8', timeout: 3000 });
let server, store;
async function until(label, run) {
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) { const value = await run(); if (value) return value; await delay(100); }
  throw new Error(`隔离前台冒烟超时：${label}`);
}
try {
  mkdirSync(workspace);
  const token = newMachineToken();
  store = openStore(join(folder, 'fixture.sqlite'));
  addMachine(store, 'Foreground smoke Mac', token, Date.now());
  const password = randomBytes(24).toString('hex');
  let app;
  server = serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => app.fetch(request) });
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  app = createApp({ store, publicOrigin: origin, accessPasswordHash: await hashPassword(password), allowLocalHttp: true });
  const packageRegistration = Boolean(process.argv[3] && statSync(extension).isDirectory());
  if (packageRegistration) {
    mkdirSync(join(folder, 'pi'));
    writeFileSync(join(folder, 'pi', 'settings.json'), JSON.stringify({ packages: [extension] }));
  }
  const extraArgs = ['--offline', '--no-approve', ...(packageRegistration ? [] : ['--no-extensions']), '--no-context-files', '--no-skills',
    '--provider', 'foreground-smoke', '--model', 'local', '-e', join(root, 'scripts/foreground-smoke-provider.mjs')];
  const config = { platformUrl: origin, allowHttpLoopback: true, machineToken: token, slots: 1,
    projects: [{ id: 'foreground-smoke', name: 'Foreground smoke', path: workspace }],
    path: [...new Set([dirname(process.execPath), ...(env.PATH ?? '').split(':').filter((p) => p.startsWith('/'))])],
    pi: { command: pi, extraArgs } };
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const privateEnv = { HOME: folder, PI_CODING_AGENT_DIR: join(folder, 'pi'), TERM: 'xterm-256color', STEWARD_SMOKE_WRITE: proof };
  const sourceTarget = 'ordinary-foreground';
  const sourcePane = tmux('new-session', '-d', '-s', sourceTarget, '-c', workspace, '-P', '-F', '#{pane_id}',
    ...Object.entries({ ...privateEnv, STEWARD_CONFIG: configFile, PATH: config.path.join(':') }).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    '--', pi, ...extraArgs, '-e', extension, '--', '开始前台目标').trim();
  assert.match(sourcePane, /^%\d+$/);
  const front = await until('普通 Pi 登记明确目标', () => store.get("SELECT a.* FROM attempts a WHERE execution_mode='foreground' AND ended_at IS NULL"));
  assert.equal(store.get('SELECT status FROM tasks WHERE id=?', front.task_id).status, 'running');
  assert.ok(front.session_locator);
  const original = JSON.parse(front.session_locator);
  let cookie;
  async function web(path, body) {
    const response = await fetch(`${origin}/api/v1/web${path}`, { method: body ? 'POST' : 'GET',
      signal: AbortSignal.timeout(4000), headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (path === '/auth/login') cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    if (!response.ok) throw new Error(`隔离网页请求失败：${response.status}`);
    return response.json();
  }
  await web('/auth/login', { password });
  const state = { version: 1, executions: [], outbox: [] };
  const launcher = new Launcher({ config, configFile, version: 'foreground-smoke', state, save: () => {},
    platform: platformClient(config), tmux: tmuxClient(config, { configPath: configFile, extensionPath: extension, socket, env: privateEnv }) });
  await launcher.tick();
  const aliveRequest = { requestId: randomUUID(), attemptId: front.id, mode: 'background' };
  await web(`/tasks/${front.task_id}/session-operation`, aliveRequest);
  // 暂不 tick 启动器，让真实原 Pi 在 stop 窗口收到可重试错误，而不是跳过竞态窗口。
  tmux('send-keys', '-t', sourcePane, '核对期间原 Pi 回报', 'Enter');
  await until('真实 Pi 已收到交接待确认而非解绑错误', () => {
    const lines = readFileSync(original.sessionFile, 'utf8').split('\n').slice(0, -1);
    const result = lines.map((line) => JSON.parse(line)).findLast((entry) => entry.type === 'message' &&
      entry.message.role === 'toolResult' && entry.message.toolName === 'steward_progress');
    if (!result) return false;
    // 生命周期门禁可在工具发送前拒绝；仍须明确交接原因，不能误报原绑定已丢失。
    assert.ok(result.message.details?.code === 'session_handover_pending' ||
      (result.message.isError === true && result.message.content.some((part) => part.text?.includes('session_handover_pending'))), JSON.stringify(result.message));
    return true;
  });
  assert.equal(store.get('SELECT COUNT(*) n FROM progress').n, 0);
  await launcher.tick();
  assert.equal(store.get('SELECT failure FROM session_operations WHERE id=?', aliveRequest.requestId).failure, 'session_source_alive');
  tmux('send-keys', '-t', sourcePane, '拒绝接管后原 Pi 回报', 'Enter');
  await until('alive 拒绝后原 Pi 未重新登记即可回报', () => store.get(
    'SELECT 1 FROM progress WHERE attempt_id=? AND text=?', front.id, '原 Pi 保持绑定，无需重新登记即可回报。'));
  assert.equal(store.get('SELECT COUNT(*) n FROM attempts').n, 1);
  // 只退出本脚本创建的隔离前台会话，不能操作正式 steward socket。
  tmux('kill-session', '-t', `=${sourceTarget}`);
  await until('原 Pi 进程退出', () => {
    try { process.kill(front.owner_pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  });
  await web(`/tasks/${front.task_id}/session-operation`, { requestId: randomUUID(), attemptId: front.id, mode: 'background' });
  await until('后台加载原对话并继续', async () => { await launcher.tick(); return existsSync(proof); });
  assert.equal(readFileSync(proof, 'utf8'), 'same native conversation continued\n');
  await until('接续后的平台进展回报已确认', async () => {
    await launcher.tick();
    return store.get('SELECT 1 FROM progress WHERE task_id=? AND text=?', front.task_id, '原对话安全接续，已核对中断结果。');
  });
  const detail = await web(`/tasks/${front.task_id}`);
  assert.equal(detail.task.origin, 'foreground');
  assert.equal(detail.task.executionMode, 'background');
  assert.equal(detail.attempts.length, 2);
  assert.equal(detail.attempts[1].sessionId, original.sessionId);
  await until('平台确认原会话已加载且进程已启动', async () => {
    await launcher.tick();
    const operation = store.get('SELECT step,failure FROM session_operations ORDER BY rowid DESC LIMIT 1');
    if (operation?.step === 'failed') throw new Error(`后台接续确认失败：${operation.failure}`);
    return operation?.step === 'succeeded';
  });
  const conversation = readFileSync(original.sessionFile, 'utf8');
  const userMessages = conversation.trim().split('\n').map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'message' && entry.message.role === 'user')
    .map((entry) => typeof entry.message.content === 'string' ? entry.message.content :
      entry.message.content.map((part) => part.text ?? '').join(''));
  assert.equal(userMessages.filter((message) => message === '开始前台目标').length, 1);
  const continuationMessages = conversation.trim().split('\n').map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'custom_message' && entry.customType === 'steward-background-continue');
  assert.equal(continuationMessages.length, 1);
  assert.ok(continuationMessages[0].content.includes('用户已授权在原会话接续本任务'));
  assert.equal(store.get('SELECT COUNT(*) n FROM tasks').n, 1);
  console.log('真实 Pi 前台冒烟通过：普通会话纳管；stop 期间收到可重试错误，活进程拒绝接管后原 Pi 无需重绑可回报；退出后同任务/同原生对话后台接续并实际写入；未重放初始指令。');
} finally {
  try { tmux('kill-server'); } catch { /* 仅本脚本的临时 socket。 */ }
  if (server) await new Promise((resolve) => server.close(resolve));
  store?.connection.close();
  rmSync(folder, { recursive: true, force: true });
}
