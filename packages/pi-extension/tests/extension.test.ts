import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SessionManager } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { uuidSchema } from '@pi-steward/contract';
import type { AgentContextResponse } from '@pi-steward/contract';
import { afterEach, expect, it, vi } from 'vitest';
import { registerSteward } from '../src/index.js';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

const executionTools = ['steward_task', 'steward_record_workspace', 'steward_progress', 'steward_ask', 'steward_question_update',
  'steward_decision', 'steward_deliver', 'steward_finish'];
const managementTools = ['steward_list_projects', 'steward_list_tasks', 'steward_get_task', 'steward_create_task', 'steward_update_task'];
const directories: string[] = [];
function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'steward-extension-'));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const delivery = { summary: '结果', done: ['完成'], notCovered: [], verification: ['通过'], howTo: [], issues: [] };
function mockTools(fetcher: typeof fetch, options: { attemptId?: string; config?: string; resumed?: boolean } = {}) {
  const registerTool = vi.fn<ExtensionAPI['registerTool']>();
  const on = vi.fn<ExtensionAPI['on']>();
  const shutdown = vi.fn();
  const sendMessage = vi.fn();
  let session: SessionManager | undefined;
  registerSteward({ registerTool, on, sendMessage,
    appendEntry: (type: string, data: unknown) => session?.appendCustomEntry(type, data) } as unknown as ExtensionAPI, {
    env: { STEWARD_ATTEMPT_ID: options.attemptId, STEWARD_CONFIG: options.config, STEWARD_RESUME: options.resumed ? '1' : undefined }, fetcher,
  });
  const sessionId = randomUUID();
  const context = () => ({ cwd: session?.getCwd(), shutdown, sessionManager: session ?? { getSessionId: () => sessionId },
    isIdle: () => false }) as unknown as ExtensionToolContext;
  return { registerTool, shutdown, sendMessage, sessionId, useSession: (value: SessionManager) => { session = value; },
    async fire(name: string, event = {}) {
      for (const [type, handler] of on.mock.calls) if (type === name) await handler({ type: name, ...event } as never, context());
    }, call: (name: string, args = {}, signal?: AbortSignal) => {
      const tool = registerTool.mock.calls.map(([entry]) => entry).find((entry) => entry.name === name);
      if (!tool) throw new Error('工具未注册');
      return tool.execute('test-call', args, signal, undefined, context());
    },
  };
}
function configFile(file = join(workspace(), 'config.json'), platformUrl = 'https://steward.example') {
  mkdirSync(dirname(file), { recursive: true });
  const token = `stm_${randomBytes(32).toString('base64url')}`;
  writeFileSync(file, JSON.stringify({ platformUrl, machineToken: token,
    slots: 1, projects: [], path: ['/usr/bin'], pi: { command: 'pi', extraArgs: [] } }), { mode: 0o600 });
  return file;
}

it('扩展优先读取新默认配置，升级前的配置仍能使用', async () => {
  const directory = workspace();
  configFile(join(directory, '.config', 'pi-steward', 'config.json'), 'https://legacy.example');
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ok: true }));
  const agent = mockTools(fetcher, { attemptId: randomUUID() });
  vi.mocked(homedir).mockReturnValueOnce(directory);
  await agent.call('steward_progress', { text: '旧配置' });
  configFile(join(directory, 'pi-steward', 'config.json'), 'https://current.example');
  vi.mocked(homedir).mockReturnValueOnce(directory);
  await agent.call('steward_progress', { text: '新配置' });
  expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).origin)).toEqual(['https://legacy.example', 'https://current.example']);
});

it('没有有效执行编号时只注册任务管理工具', () => {
  for (const attemptId of [undefined, 'bogus']) {
    expect(mockTools(vi.fn(), { attemptId }).registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(managementTools);
  }
});

it.each([false, true])('Pi 资源加载器从 settings.json 加载扩展，自动执行=%s', async (automatic) => {
  const directory = workspace();
  vi.stubEnv('STEWARD_ATTEMPT_ID', automatic ? randomUUID() : undefined);
  const extension = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({ extensions: [extension] }));
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory,
    additionalExtensionPaths: automatic ? [extension] : [],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const { extensions, errors } = loader.getExtensions();
  expect(errors).toHaveLength(0);
  expect(extensions.filter((entry) => entry.path === extension)).toHaveLength(1);
  expect([...extensions.find((entry) => entry.path === extension)!.tools.keys()])
    .toEqual(automatic ? [...managementTools, ...executionTools] : managementTools);
}, 10_000);

function taskContext(path: string): AgentContextResponse {
  return { task: { id: randomUUID(), projectId: 'test', title: '实现', type: 'implementation', goal: '', acceptance: '', notes: '' },
    attempt: { id: randomUUID(), kind: 'new' }, workspace: { path, requirements: [] }, decisions: [], deliveries: [], questions: [] };
}

function savedSession(path: string, storage: string) {
  const session = SessionManager.create(path, storage);
  session.appendMessage({ role: 'user', content: 'fixture', timestamp: 1 });
  return session;
}

it('仅任务启动会话注入执行规则，原生迁移与手动恢复保留来源但不继承执行权限', async () => {
  const directory = workspace();
  const storage = join(directory, 'sessions');
  const original = savedSession(directory, storage);
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ type: 'implementation', discussionEndRequested: false,
    deliverySaved: false, waitId: null }));
  const agent = mockTools(fetcher, { attemptId: randomUUID(), config: configFile() });
  async function guidelines(target: typeof agent) {
    const promptGuidelines: string[] = [];
    await target.fire('before_agent_start', { systemPromptOptions: { promptGuidelines } });
    return promptGuidelines.join('\n');
  }
  const manual = mockTools(vi.fn());
  manual.useSession(original);
  expect(await guidelines(manual)).toBe('');
  agent.useSession(original);
  await agent.fire('session_start', { reason: 'startup' });
  const first = await guidelines(agent);
  expect(first).toMatch(/任务台后台启动.*先调用 steward_task/u);
  expect(first).toMatch(/只读任务不创建工作树.*明确确认后才可在主分支实施/u);
  expect(first).not.toContain('worktree_create');
  expect(await guidelines(agent)).toEqual(first); // 接回仍在运行的进程，不替换任务绑定。
  await agent.fire('session_shutdown');
  const target = SessionManager.forkFrom(original.getSessionFile()!, workspace(), storage);
  agent.useSession(target);
  await agent.fire('session_start', { reason: 'resume' });
  expect(await guidelines(agent)).toEqual(first);
  await agent.fire('session_shutdown');
  manual.useSession(SessionManager.open(target.getSessionFile()!));
  const historical = await guidelines(manual);
  expect(historical).toContain('会话历史来源');
  expect(historical).not.toContain('先调用 steward_task');
  expect(manual.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(managementTools);
});

it('接续启动只确认已加载的原文件与执行编号，不发送用户消息', async () => {
  const directory = realpathSync(workspace());
  const storage = join(directory, 'sessions');
  const source = savedSession(directory, storage);
  const reopened = SessionManager.open(source.getSessionFile()!);
  const attemptId = randomUUID();
  const fetcher = vi.fn<typeof fetch>(async (url) => Response.json(String(url).endsWith('/session') ? { ok: true } :
    { type: 'discussion', discussionEndRequested: false, deliverySaved: false, waitId: null }));
  const agent = mockTools(fetcher, { attemptId, config: configFile(), resumed: true });
  agent.useSession(reopened);
  await agent.fire('session_start', { reason: 'startup' });
  try {
    await vi.waitFor(() => {
      const call = fetcher.mock.calls.find(([url]) => String(url).endsWith('/agent/session'));
      expect(call).toBeDefined();
      expect(new Headers(call?.[1]?.headers).get('X-Steward-Attempt-Id')).toBe(attemptId);
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ requestId: expect.any(String),
        locator: { path: directory, sessionId: source.getSessionId(), sessionFile: source.getSessionFile() } });
    });
    expect(agent.sendMessage).not.toHaveBeenCalled();
    expect(reopened.getEntries().filter(({ type }) => type === 'message')).toHaveLength(1);
  } finally { await agent.fire('session_shutdown'); }
});

it('普通任务可登记预期会话文件，但接续启动不确认空白会话', async () => {
  const directory = realpathSync(workspace());
  const session = SessionManager.create(directory, join(directory, 'sessions'));
  const fetcher = vi.fn<typeof fetch>(async (url) => Response.json(String(url).endsWith('/session') ? { ok: true } :
    { type: 'implementation', discussionEndRequested: false, deliverySaved: false, waitId: null }));
  const config = configFile();
  const fresh = mockTools(fetcher, { attemptId: randomUUID(), config });
  const resumed = mockTools(fetcher, { attemptId: randomUUID(), config, resumed: true });
  const sessionCalls = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/agent/session'));
  fresh.useSession(session);
  resumed.useSession(session);
  try {
    await fresh.fire('session_start', { reason: 'startup' });
    await vi.waitFor(() => expect(sessionCalls()).toHaveLength(1));
    expect(JSON.parse(String(sessionCalls()[0]?.[1]?.body))).toMatchObject({ locator: { sessionFile: session.getSessionFile() } });
    await resumed.fire('session_start', { reason: 'startup' });
    await expect(import('../src/workspace.js').then(({ currentSessionLocator }) =>
      currentSessionLocator({ cwd: directory, sessionManager: session }, true))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(sessionCalls()).toHaveLength(1);
  } finally { await fresh.fire('session_shutdown'); await resumed.fire('session_shutdown'); }
});

it('返修核对真实工作树、Git 分支与 Pi 会话，在目标会话保存当前现场', async () => {
  const directory = realpathSync(workspace());
  const root = join(directory, 'repo');
  const linked = join(directory, 'linked');
  mkdirSync(root);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  git(root, 'init', '-b', 'main');
  git(root, '-c', 'user.name=Steward', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '-m', 'fixture');
  git(root, 'worktree', 'add', '-b', 'feature/old', linked);
  const storage = join(directory, 'sessions');
  const original = savedSession(root, storage);
  const target = SessionManager.forkFrom(original.getSessionFile()!, linked, storage);
  const context = taskContext(root);
  const fetcher = vi.fn<typeof fetch>(async (url) => Response.json(String(url).endsWith('/context') ? context : { ok: true }));
  const agent = mockTools(fetcher, { attemptId: context.attempt.id, config: configFile() });
  agent.useSession(original);
  expect((await agent.call('steward_record_workspace')).details).toEqual({ code: 'task_context_required' });
  await agent.call('steward_task');
  agent.useSession(target);
  const workspaceInfo = { path: linked, gitKind: 'linked' as const, gitBranch: 'feature/old',
    sessionId: target.getSessionId(), sessionFile: target.getSessionFile()! };
  expect((await agent.call('steward_record_workspace')).details).toEqual({ ok: true, workspace: workspaceInfo });
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual({ requestId: expect.any(String), workspace: workspaceInfo });
  expect(workspaceInfo.sessionId).not.toBe(original.getSessionId());

  context.attempt.kind = 'rework';
  const prior = { attemptId: randomUUID(), machineId: randomUUID(), sameMachine: true, workspace: workspaceInfo };
  context.workspace.previous = prior;
  agent.useSession(original);
  const status = async () => (await agent.call('steward_task')).details;
  expect(await status()).toMatchObject({ reworkWorkspace: 'switch_required' });
  agent.useSession(savedSession(linked, storage));
  expect(await status()).toMatchObject({ reworkWorkspace: 'switch_required' });
  agent.useSession(SessionManager.open(workspaceInfo.sessionFile));
  expect(await status()).toMatchObject({ reworkWorkspace: 'confirmed' });
  git(root, 'worktree', 'move', linked, join(directory, 'moved'));
  expect(await status()).toMatchObject({ reworkWorkspace: 'unavailable' });
  git(root, 'worktree', 'move', join(directory, 'moved'), linked);
  git(linked, 'switch', '-c', 'unexpected');
  expect(await status()).toMatchObject({ reworkWorkspace: 'mismatch' });
  git(linked, 'switch', 'feature/old');
  rmSync(workspaceInfo.sessionFile);
  expect(await status()).toMatchObject({ reworkWorkspace: 'unavailable' });
  context.workspace.previous = { ...prior, sameMachine: false, workspace: null };
  expect(await status()).toMatchObject({ reworkWorkspace: 'different_machine' });
  context.workspace.previous = null;
  expect(await status()).toMatchObject({ reworkWorkspace: 'not_recorded' });
});

it('普通 Pi 使用配对令牌查、建、改任务，写入附带当前会话 ID', async () => {
  const task = { id: randomUUID(), projectId: 'steward', title: '待办', goal: '', acceptance: '', notes: '', agent: 'pi',
    machineId: null, status: 'unscheduled', reworkPending: false, position: 1, createdBy: 'agent', version: 1,
    createdAt: 1, updatedAt: 1, waiting: null, needsVerification: false, needsResponse: false,
    type: 'discussion', discussionEndRequested: false };
  const detail = { task, decisions: [], progress: [], questions: [], deliveries: [], attempts: [], events: [] };
  const updated = { ...task, version: 2, acceptance: '可验证' };
  const responses = [{ projects: [] }, { tasks: [task] }, detail, { task }, { task: updated }];
  const fetcher = vi.fn<typeof fetch>();
  for (const data of responses) fetcher.mockResolvedValueOnce(Response.json(data));
  const agent = mockTools(fetcher, { config: configFile() });
  const create = { projectId: task.projectId, title: task.title, type: task.type };
  const update = { taskId: task.id, version: 1, acceptance: updated.acceptance };
  const calls = [['steward_list_projects', {}], ['steward_list_tasks', { projectId: task.projectId }],
    ['steward_get_task', { taskId: task.id }], ['steward_create_task', create], ['steward_update_task', update]] as const;
  for (const [index, [name, args]] of calls.entries()) expect((await agent.call(name, args)).details).toEqual(responses[index]);
  expect(fetcher.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, init?.method])).toEqual([
    ['/api/v1/task-management/projects', 'GET'], ['/api/v1/task-management/projects/steward/tasks', 'GET'],
    [`/api/v1/task-management/tasks/${task.id}`, 'GET'], ['/api/v1/task-management/tasks', 'POST'],
    [`/api/v1/task-management/tasks/${task.id}`, 'PATCH'],
  ]);
  for (const [, init] of fetcher.mock.calls) {
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toMatch(/^Bearer stm_/);
    expect(headers.has('X-Steward-Attempt-Id')).toBe(false);
  }
  const bodies = fetcher.mock.calls.slice(3).map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies).toEqual([
    { ...create, sessionId: agent.sessionId, requestId: expect.any(String) },
    { version: 1, acceptance: updated.acceptance, sessionId: agent.sessionId, requestId: expect.any(String) },
  ]);
  expect(bodies.every(({ requestId }) => uuidSchema.safeParse(requestId).success)).toBe(true);
  expect((await agent.call('steward_get_task', { taskId: '../projects' })).details).toEqual({ code: 'invalid_request' });
  expect((await agent.call('steward_update_task', { ...update, status: 'done' })).details).toEqual({ code: 'invalid_request' });
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it('创建请求取消后使用原参数重试时复用请求 ID', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
    controller.abort();
    throw new Error('请求可能已提交');
  }).mockResolvedValueOnce(Response.json({ error: { code: 'not_found', message: '' } }, { status: 404 }));
  const agent = mockTools(fetcher, { config: configFile() });
  const args = { projectId: 'steward', title: '任务' };
  expect((await agent.call('steward_create_task', args, controller.signal)).details).toEqual({ code: 'cancelled' });
  expect((await agent.call('steward_create_task', args)).details).toEqual({ code: 'not_found' });
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
});

it('交付未开始、失败和请求未完成时拦截 finish，确认成功后才 shutdown', async () => {
  let unblock: (response: Response) => void = () => { throw new Error('交付请求没有发出'); };
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ error: { code: 'internal_error', message: '不可回显的诊断内容' } }, { status: 500 }))
    .mockImplementationOnce(() => new Promise((resolve) => { unblock = resolve; }));
  const agent = mockTools(fetcher, { attemptId: randomUUID(), config: configFile() });
  expect((await agent.call('steward_finish')).details).toEqual({ code: 'delivery_required' });
  const failure = await agent.call('steward_deliver', delivery);
  expect(failure.details).toEqual({ code: 'internal_error' });
  expect(JSON.stringify(failure)).not.toContain('不可回显的诊断内容');
  expect((await agent.call('steward_finish')).details).toEqual({ code: 'delivery_required' });
  const pending = agent.call('steward_deliver', delivery);
  expect((await agent.call('steward_finish')).details).toEqual({ code: 'delivery_required' });
  expect(agent.shutdown).not.toHaveBeenCalled();
  const saved = { deliveryId: randomUUID(), version: 1 };
  unblock(Response.json(saved));
  expect((await pending).details).toEqual(saved);
  expect((await agent.call('steward_finish')).details).toEqual({ ok: true });
  expect(agent.shutdown).toHaveBeenCalledTimes(1);
});

it('重载扩展后交付重试保留每次尝试固定的请求 ID 和载荷', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('网络错误详情'))
    .mockImplementation(async () => Response.json({ deliveryId: randomUUID(), version: 1 }));
  const config = configFile();
  const attemptId = randomUUID();
  const first = await mockTools(fetcher, { attemptId, config }).call('steward_deliver', delivery);
  expect(first.details).toEqual({ code: 'network_error' });
  const second = mockTools(fetcher, { attemptId, config });
  expect(second.shutdown).not.toHaveBeenCalled();
  await second.call('steward_deliver', delivery);
  await mockTools(fetcher, { attemptId: randomUUID(), config }).call('steward_deliver', delivery);
  const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies[0]).toEqual(bodies[1]);
  expect(uuidSchema.safeParse(bodies[0].requestId).success).toBe(true);
  expect(bodies[0].requestId).not.toBe(bodies[2].requestId);
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('X-Steward-Attempt-Id')).toBe(attemptId);
  expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
  expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
});

it('配置文件权限不安全时不发送请求，问题编号不会被拼成任意路由', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const config = configFile();
  const agent = mockTools(fetcher, { attemptId: randomUUID(), config });
  expect((await agent.call('steward_question_update', { questionId: '../../context', status: 'resolved' })).details)
    .toEqual({ code: 'invalid_request' });
  chmodSync(config, 0o644);
  expect((await agent.call('steward_task')).details).toEqual({ code: 'invalid_config' });
  expect(fetcher.mock.calls).toHaveLength(0);
});

it.each([
  ['steward_progress', { text: '进展' }, { ok: true }],
  ['steward_ask', { text: '问题', context: '上下文' }, { questionId: randomUUID() }],
  ['steward_question_update', { questionId: randomUUID(), status: 'resolved' }, { ok: true }],
  ['steward_decision', { text: '决定', confirmedByUser: true }, { ok: true }],
] as const)('%s 在丢结果时同参重试，成功后的独立写入使用新 ID', async (tool, args, response) => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('模拟丢失响应'))
    .mockResolvedValueOnce(Response.json({ error: { code: 'unauthorized', message: '模拟认证失败' } }, { status: 401 }))
    .mockImplementation(async () => Response.json(response));
  const agent = mockTools(fetcher, { attemptId: randomUUID(), config: configFile() });
  expect((await agent.call(tool, args)).details).toEqual({ code: 'network_error' });
  expect((await agent.call(tool, args)).details).toEqual({ code: 'unauthorized' });
  expect((await agent.call(tool, args)).details).toEqual(response);
  expect((await agent.call(tool, args)).details).toEqual(response);
  const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toEqual(bodies[2]);
  expect(bodies[3].requestId).not.toBe(bodies[0].requestId);
});

it('并发同参写入共享同一请求，同参进展和决定各用独立请求', async () => {
  let unblock: (value: Response) => void = () => { throw new Error('请求没有发出'); };
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise((resolve) => { unblock = resolve; }))
    .mockImplementation(async () => Response.json({ ok: true }));
  const agent = mockTools(fetcher, { attemptId: randomUUID(), config: configFile() });
  const first = agent.call('steward_progress', { text: '同参' });
  const second = agent.call('steward_progress', { text: '同参' });
  await expect(agent.call('steward_decision', { text: '同参', confirmedByUser: false })).resolves.toMatchObject({ details: { ok: true } });
  expect(fetcher.mock.calls).toHaveLength(2);
  unblock(Response.json({ ok: true }));
  expect((await Promise.all([first, second])).map(({ details }) => details)).toEqual([{ ok: true }, { ok: true }]);
  const ids = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).requestId);
  expect(new Set(ids).size).toBe(2);
});

it('待确认写入达到容量时限制新请求，保留已有请求 ID 供重试', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('模拟丢失响应'));
  const agent = mockTools(fetcher, { attemptId: randomUUID(), config: configFile() });
  const calls = await Promise.all(Array.from({ length: 128 }, (_, index) => agent.call('steward_progress', { text: `进展 ${index}` })));
  expect(calls.every(({ details }) => (details as { code: string }).code === 'network_error')).toBe(true);
  expect((await agent.call('steward_progress', { text: '新进展' })).details).toEqual({ code: 'pending_writes_full' });
  const first = fetcher.mock.calls[0]?.[1]?.body;
  expect(fetcher.mock.calls).toHaveLength(128);
  fetcher.mockResolvedValueOnce(Response.json({ ok: true }));
  expect((await agent.call('steward_progress', { text: '进展 0' })).details).toEqual({ ok: true });
  expect(fetcher.mock.lastCall?.[1]?.body).toBe(first);
  fetcher.mockResolvedValueOnce(Response.json({ ok: true }));
  expect((await agent.call('steward_progress', { text: '新进展' })).details).toEqual({ ok: true });
});
