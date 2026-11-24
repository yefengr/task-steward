import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 仅隔离测试：临时数据库、Git 仓库、Pi 配置和独立 tmux socket；不加载用户扩展或调用远端模型。
const pi = process.argv[2];
if (!pi?.startsWith('/') || !existsSync(pi)) throw new Error('用法：node scripts/smoke-session-locator.mjs <Pi 可执行文件绝对路径>');
execFileSync('tmux', ['-V'], { stdio: 'ignore' });
const root = fileURLToPath(new URL('../', import.meta.url));
const platformRequire = createRequire(new URL('../apps/platform/package.json', import.meta.url));
const sdkRoot = realpathSync(join(root, 'packages/pi-extension/node_modules/@earendil-works/pi-coding-agent'));
const { SessionManager } = await import(pathToFileURL(join(sdkRoot, 'dist/index.js')).href);
const aiEntry = pathToFileURL(join(dirname(sdkRoot), 'pi-ai/dist/index.js')).href;
const { serve } = platformRequire('@hono/node-server');
const { createApp } = await import('../apps/platform/dist/app.js');
const { openStore } = await import('../apps/platform/dist/store.js');
const { addMachine, hashPassword, newMachineToken } = await import('../apps/platform/dist/auth.js');
const { Launcher } = await import('../apps/launcher/dist/launcher.js');
const { platformClient } = await import('../apps/launcher/dist/platform.js');
const { tmuxClient } = await import('../apps/launcher/dist/tmux.js');
const folder = mkdtempSync(join(realpathSync('/tmp'), 'steward-locator-'));
const socket = join(folder, 'tmux.sock');
const registered = join(folder, 'registered');
const linked = join(folder, 'linked');
const migration = join(folder, 'migration.json');
const observations = join(folder, 'observations.jsonl');
const fixtureExtension = join(folder, 'fixture.mjs');
const configPath = join(folder, 'config.json');
const env = { PATH: process.env.PATH, LC_ALL: 'C' };
const tmux = (...args) => execFileSync('tmux', ['-S', socket, ...args], { env, encoding: 'utf8', timeout: 3_000 });
let server;
let store;
try {
  mkdirSync(registered);
  const git = (...args) => execFileSync('git', ['-C', registered, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('-c', 'user.name=Steward', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture');
  git('worktree', 'add', '-b', 'feature/fixture', linked);
  // 原生 switchSession 完成迁移；测试扩展只提供命令、确定性模型和现场观察。
  writeFileSync(fixtureExtension, `
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream } from ${JSON.stringify(aiEntry)};
export default function(pi) {
  pi.on('project_trust', () => ({ trusted: 'yes' }));
  pi.on('session_start', (_event, ctx) => appendFileSync(${JSON.stringify(observations)}, JSON.stringify({
    attemptId: process.env.STEWARD_ATTEMPT_ID, cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile()
  }) + '\\n'));
  pi.registerCommand('smoke-migrate', { handler: async (_args, ctx) => {
    const { sessionFile } = JSON.parse(readFileSync(${JSON.stringify(migration)}, 'utf8'));
    await ctx.switchSession(sessionFile, { withSession: async (next) => {
      await next.sendUserMessage('记录迁移后现场。先调用 steward_task');
    } });
  } });
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  pi.registerProvider('locator-smoke', { baseUrl: 'http://127.0.0.1', apiKey: 'local-fixture', api: 'locator-smoke-api',
    models: [{ id: 'local', name: 'Local locator smoke', reasoning: false, input: ['text'], cost, contextWindow: 32768, maxTokens: 2048 }],
    streamSimple(model, { messages }) {
      const last = messages.findLast((m) => !['system', 'assistant'].includes(m.role));
      const name = last?.role === 'toolResult' ? last.toolName === 'steward_task' ? 'steward_record_workspace' : undefined : 'steward_task';
      const block = name ? { type: 'toolCall', id: randomUUID(), name, arguments: {} } : { type: 'text', text: '现场已记录，等待测试。' };
      const result = { role: 'assistant', content: [block], api: model.api, provider: model.provider, model: model.id,
        usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } }, stopReason: name ? 'toolUse' : 'stop', timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: result });
      if (name) {
        stream.push({ type: 'toolcall_start', contentIndex: 0, partial: result });
        stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: block, partial: result });
      } else {
        stream.push({ type: 'text_start', contentIndex: 0, partial: result });
        stream.push({ type: 'text_end', contentIndex: 0, content: block.text, partial: result });
      }
      stream.push({ type: 'done', reason: result.stopReason, message: result }); stream.end(); return stream;
    }
  });
}
`);
  const machineToken = newMachineToken();
  store = openStore(join(folder, 'platform.sqlite'));
  addMachine(store, 'Locator fixture', machineToken, Date.now());
  const password = randomBytes(24).toString('hex');
  let app;
  server = serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => app.fetch(request) });
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  app = createApp({ store, publicOrigin: origin, accessPasswordHash: await hashPassword(password), allowLocalHttp: true });
  const config = { platformUrl: origin, allowHttpLoopback: true, machineToken, slots: 1,
    projects: [{ id: 'locator-fixture', name: 'Locator fixture', path: registered }],
    path: [...new Set([dirname(process.execPath), ...(env.PATH ?? '').split(':').filter((p) => p.startsWith('/'))])],
    pi: { command: pi, extraArgs: ['--offline', '--no-approve', '--no-extensions', '--no-context-files', '--no-skills',
      '--no-builtin-tools', '--provider', 'locator-smoke', '--model', 'local', '-e', fixtureExtension] } };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const client = tmuxClient(config, { configPath, extensionPath: join(root, 'packages/pi-extension/dist/index.js'), socket,
    env: { HOME: folder, PI_CODING_AGENT_DIR: join(folder, 'pi'), TERM: 'xterm-256color' } });
  const state = { version: 1, executions: [], outbox: [] };
  const launcher = new Launcher({ config, version: 'locator-smoke', state, save: () => {}, platform: platformClient(config), tmux: client });
  let cookie;
  async function request(namespace, path, body, attemptId) {
    const response = await fetch(`${origin}/api/v1/${namespace}${path}`, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(4_000),
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
        ...(namespace !== 'web' ? { Authorization: `Bearer ${machineToken}` } : {}),
        ...(attemptId ? { 'X-Steward-Attempt-Id': attemptId } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (path === '/auth/login') cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    const result = await response.json();
    assert.ok(response.ok, `${namespace}${path}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  }
  const web = (path, body) => request('web', path, body);
  const lastObservation = (id) => existsSync(observations) && readFileSync(observations, 'utf8').trim().split('\n').map(JSON.parse).findLast((x) => x.attemptId === id);
  // 有界测试反馈环，不访问生产，也不启动守护进程。
  async function until(label, read) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await launcher.tick();
      const value = await read();
      if (value) return value;
      await delay(100);
    }
    throw new Error(`冒烟超时：${label}`);
  }
  await web('/auth/login', { password });
  await launcher.tick();
  const { task } = await web('/tasks', { projectId: 'locator-fixture', title: '工作树 locator smoke' });
  const taskPath = `/tasks/${task.id}`;
  const detail = () => web(taskPath);
  await web(`${taskPath}/schedule`, {});
  const source = await until('首次启动并记录登记目录', async () => {
    const attempt = (await detail()).attempts[0];
    return attempt && store.get('SELECT confirmed_workspace_path path FROM attempts WHERE id=?', attempt.id)?.path === registered && attempt;
  });
  assert.equal(lastObservation(source.id).cwd, registered);
  const originalFile = lastObservation(source.id).sessionFile;
  const fork = SessionManager.forkFrom(originalFile, linked, join(folder, 'fork-sessions'));
  const locator = { path: linked, sessionId: fork.getSessionId(), sessionFile: fork.getSessionFile() };
  writeFileSync(migration, JSON.stringify(locator));
  // 等模型回合真正停稳，避免把 slash command 发入尚未完成的 agent turn。
  await until('首次回合停稳', () => tmux('capture-pane', '-p', '-S', '-100', '-t', source.tmuxSession).includes('现场已记录，等待测试。'));
  tmux('send-keys', '-l', '-t', source.tmuxSession, '--', '/smoke-migrate');
  tmux('send-keys', '-t', source.tmuxSession, 'Enter');
  await until('迁移到独立工作树并记录', () => store.get('SELECT confirmed_workspace_path path FROM attempts WHERE id=?', source.id)?.path === linked);
  assert.equal(lastObservation(source.id).cwd, linked);
  assert.ok(existsSync(originalFile), '旧目录会话仍保留');
  const userCount = () => readFileSync(locator.sessionFile, 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.type === 'message' && e.message.role === 'user').length;
  const restart = async (id, mode) => {
    const requestId = randomUUID();
    await web(`${taskPath}/session-operation`, { requestId, attemptId: id, mode });
    const next = await until(`${mode} 加载正确会话`, async () => {
      const data = await detail();
      return data.sessionOperation?.id === requestId && data.sessionOperation.status === 'succeeded' && data.attempts.at(-1);
    });
    assert.deepEqual(lastObservation(next.id), { attemptId: next.id, cwd: linked, sessionId: locator.sessionId, sessionFile: locator.sessionFile });
    assert.equal(next.sessionId, locator.sessionId);
    const management = await request('task-management', `/tasks/${task.id}`);
    assert.equal(management.attempts.at(-1).sessionId, locator.sessionId);
    return next;
  };
  const count = userCount();
  let current = await restart(source.id, 'restart');
  assert.equal(userCount(), count, '普通重启不添加开工消息');
  console.log('通过：登记目录旧会话保留；迁移后 restart 回到工作树及新会话，两种详情接口 ID 一致。');
  for (const [kind, path, failure] of [['会话文件', locator.sessionFile, 'session_record_missing'], ['工作树', linked, 'session_workspace_unavailable']]) {
    const moved = `${path}.unavailable`;
    renameSync(path, moved);
    try {
      const requestId = randomUUID();
      await web(`${taskPath}/session-operation`, { requestId, attemptId: current.id, mode: 'restart' });
      await until(`${kind}缺失明确失败`, async () => (await detail()).sessionOperation?.failure === failure);
      assert.equal(await client.inspect(current.tmuxSession), 'present', '预检失败不触碰运行中源会话');
    } finally { renameSync(moved, path); }
  }
  console.log('通过：会话文件缺失、工作树缺失均明确失败，不新建会话、不回退登记目录。');
  await client.cancel(current.tmuxSession);
  await until('自然中断被平台观察', async () => (await detail()).task.status === 'interrupted');
  current = await restart(current.id, 'restore');
  assert.equal(userCount(), count, '普通恢复不添加开工消息');
  const { deliveryId } = await request('agent', '/deliveries', { requestId: randomUUID(), summary: 'fixture', done: [], notCovered: [], verification: [], howTo: [], issues: [] }, current.id);
  await client.cancel(current.tmuxSession);
  await until('交付进程退出', async () => (await detail()).attempts.at(-1).endedAt !== null);
  await web(`${taskPath}/rework`, { deliveryId, feedback: 'fixture rework' });
  const rework = await until('返修直接加载工作树会话并记录', async () => {
    const attempt = (await detail()).attempts.at(-1);
    return attempt.kind === 'rework' && store.get('SELECT confirmed_workspace_path path FROM attempts WHERE id=?', attempt.id)?.path === linked && lastObservation(attempt.id) && attempt;
  });
  assert.deepEqual(lastObservation(rework.id), { attemptId: rework.id, cwd: linked, sessionId: locator.sessionId, sessionFile: locator.sessionFile });
  await until('返修提示真正执行', () => {
    const entries = readFileSync(locator.sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
    return userCount() === count + 1 && entries.some((entry) => entry.type === 'message' &&
      entry.message.role === 'toolResult' && entry.message.toolName === 'steward_task' &&
      entry.message.details?.attempt?.id === rework.id) && entries.some((entry) => entry.type === 'message' &&
      entry.message.role === 'user' && JSON.stringify(entry.message.content).includes('返修本任务。先调用 steward_task'));
  });
  assert.equal(rework.sessionId, locator.sessionId);
  console.log('通过：restore 不重放指令；从 resume 交付发起返修时，自动加载同一工作树与 JSONL 并执行返修提示。');
} finally {
  // 只清理本脚本创建的隔离 socket、进程、临时数据库与临时 Git 仓库。
  try { tmux('kill-server'); } catch { /* 自建服务已退出。 */ }
  if (server) await new Promise((resolve) => server.close(resolve));
  store?.connection.close();
  rmSync(folder, { recursive: true, force: true });
}
