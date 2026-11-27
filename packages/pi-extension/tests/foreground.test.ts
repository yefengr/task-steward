import { execFileSync } from 'node:child_process';
import * as runtime from '@pi-steward/execution-runtime';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';
import { registerForeground } from '../src/foreground.js';
import { claimInstance } from '../src/instance-guard.js';
import { registerSteward } from '../src/index.js';
import { acquireExecutionLock } from '@pi-steward/execution-runtime';

const dirs: string[] = [];
const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const stop of cleanup.splice(0)) stop(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'foreground-')); dirs.push(root);
  const session = SessionManager.create(root, join(root, 'sessions'));
  session.appendMessage({ role: 'user', content: 'fixture', timestamp: 1 });
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ platformUrl: 'https://test.invalid', machineToken: `stm_${randomBytes(32).toString('base64url')}`,
    slots: 1, projects: [{ id: 'test', name: '测试', path: root }], path: ['/usr/bin'], pi: { command: 'pi', extraArgs: [] } }), { mode: 0o600 });
  const handlers = new Map<string, ((e: never, c: ExtensionContext) => unknown)[]>();
  const pi = { appendEntry: (t: string, d: unknown) => session.appendCustomEntry(t, d),
    on: (t: string, fn: (e: never, c: ExtensionContext) => unknown) => {
      handlers.set(t, [...handlers.get(t) ?? [], fn]); return () => {};
    }, registerTool: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
  const ctx = { cwd: root, sessionManager: session, isIdle: () => false, shutdown: vi.fn() } as unknown as ExtensionContext;
  const fire = async (type: string, e = {}) => {
    const results = [];
    for (const fn of handlers.get(type) ?? []) results.push(await fn({ type, ...e } as never, ctx));
    return results;
  };
  cleanup.push(() => { for (const fn of handlers.get('session_shutdown') ?? []) fn({ type: 'session_shutdown', reason: 'reload' } as never, ctx); });
  return { root, session, config, pi, ctx, fire };
}
const input = { title: '目标', goal: '完成目标', acceptance: '', notes: '', type: 'implementation' as const, transition: 'continue' as const };

it('普通问答不创建目标，明确 start 取得绑定；同目标多轮、finish 后新目标不关闭 Pi', async () => {
  const f = fixture();
  const bodies: Record<string, unknown>[] = [];
  const bindings = new Map<unknown, object>();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method === 'GET') return Response.json({ binding: bindings.values().next().value ?? null });
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    if (String(url).endsWith('/start')) {
      if (!bindings.has(body.goalId)) bindings.set(body.goalId, { goalId: body.goalId, pid: process.pid, attemptId: randomUUID(), taskId: randomUUID() });
      return Response.json({ binding: bindings.get(body.goalId) });
    }
    return Response.json({ ok: true });
  });
  const active = vi.fn(); const stopped = vi.fn();
  const state = registerForeground(f.pi, { env: { STEWARD_CONFIG: f.config }, fetcher }, active, stopped);
  await f.fire('session_start', { reason: 'startup' });
  await f.fire('input', { text: '你好' }); expect(fetcher).not.toHaveBeenCalled();
  const first = await state.begin(input, f.ctx);
  expect(await state.begin(input, f.ctx)).toEqual(first);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(bodies[0]!.requestId).toBe(bodies[1]!.requestId);
  await expect(state.begin({ ...input, transition: 'new' }, f.ctx)).rejects.toThrow('goal_interrupt_required');
  await state.close('settle');
  expect(new Headers(fetcher.mock.calls.at(-1)![1]?.headers).get('X-Steward-Owner-Id')).toBe(state.ownerId);
  expect(f.ctx.shutdown).not.toHaveBeenCalled();
  const next = await state.begin({ ...input, transition: 'new' }, f.ctx);
  expect(next.binding.goalId).not.toBe(first.binding.goalId);
  expect(active).toHaveBeenCalledTimes(2);
});

it('明确中断后在原会话继续仍用同一目标，重新取得执行尝试而非新建任务', async () => {
  const f = fixture(); let binding: { goalId: string; pid: number; taskId: string; attemptId: string } | undefined;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method === 'GET') return Response.json({ binding });
    if (String(url).endsWith('/start')) {
      const body = JSON.parse(String(init?.body));
      binding = { goalId: body.goalId, pid: process.pid, taskId: binding?.taskId ?? randomUUID(), attemptId: randomUUID() };
      return Response.json({ binding });
    }
    return Response.json({ ok: true });
  });
  const state = registerForeground(f.pi, { env: { STEWARD_CONFIG: f.config }, fetcher }, vi.fn(), vi.fn());
  await f.fire('session_start', { reason: 'startup' });
  const first = await state.begin(input, f.ctx);
  await state.close('interrupt');
  const next = await state.begin(input, f.ctx);
  expect(next.binding.goalId).toBe(first.binding.goalId); expect(next.binding.taskId).toBe(first.binding.taskId);
  expect(next.binding.attemptId).not.toBe(first.binding.attemptId);
});

it('离线 pending 重试保持 goalId/requestId/正文，reload 历史不自动授权；fork 不继承', async () => {
  const f = fixture();
  const bodies: Record<string, unknown>[] = [];
  let offline = true;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'GET') return Response.json({ binding: null });
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    if (offline) throw new Error('offline');
    return Response.json({ binding: { goalId: body.goalId, pid: process.pid, attemptId: randomUUID(), taskId: randomUUID() } });
  });
  const active = vi.fn();
  const state = registerForeground(f.pi, { env: { STEWARD_CONFIG: f.config }, fetcher }, active, vi.fn());
  await f.fire('session_start', { reason: 'startup' });
  await expect(state.begin(input, f.ctx)).rejects.toThrow('network_error');
  offline = false;
  await state.begin({ ...input, title: '不覆盖' }, f.ctx);
  expect(bodies[0]).toEqual(bodies[1]);
  await f.fire('session_shutdown', { reason: 'reload' });
  await f.fire('session_start', { reason: 'reload' });
  expect(state.binding).toBeUndefined();
  expect(state.managedHistory).toBe(true);
  await state.begin(input, f.ctx);
  expect(active).toHaveBeenCalledTimes(2);
  await f.fire('session_shutdown', { reason: 'fork' });
  await f.fire('session_start', { reason: 'fork' });
  await expect(state.begin(input, f.ctx)).rejects.toThrow('foreground_fork_requires_handover');
  const beforeDetach = fetcher.mock.calls.length;
  expect(await state.close('interrupt')).toMatchObject({ ok: true, localOnly: true });
  expect(fetcher.mock.calls).toHaveLength(beforeDetach);
  expect((await state.begin({ ...input, transition: 'new' }, f.ctx)).binding.goalId).not.toBe(bodies[0]!.goalId);
});

it('本机锁竞争阻止 start，历史旧 PID 活着时不请求平台', async () => {
  const f = fixture(); const goalId = randomUUID();
  f.session.appendCustomEntry('steward-foreground-goal', { goalId, requestId: randomUUID(), start: input, sessionId: f.session.getSessionId() });
  const release = acquireExecutionLock(f.config, goalId); cleanup.push(release);
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ binding: null }));
  const state = registerForeground(f.pi, { env: { STEWARD_CONFIG: f.config }, fetcher }, vi.fn(), vi.fn());
  await f.fire('session_start', { reason: 'startup' });
  await expect(state.begin(input, f.ctx)).rejects.toThrow('session_ownership_unavailable');
  release();
  f.session.appendCustomEntry('steward-foreground-goal', { goalId, requestId: randomUUID(), start: input, sessionId: f.session.getSessionId(),
    binding: { goalId, pid: process.ppid, attemptId: randomUUID(), taskId: randomUUID() } });
  await f.fire('session_start', { reason: 'resume' });
  await expect(state.begin(input, f.ctx)).rejects.toThrow('session_source_alive');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![1]?.method).toBe('GET');
});

it('同真实入口去重、不同安装入口清楚报错，reload 清理可重载', () => {
  const emitter = new EventEmitter(); const shutdown: (() => void)[] = [];
  const pi = { events: { emit: (t: string, d: unknown) => emitter.emit(t, d), on: (t: string, fn: (...a: unknown[]) => void) => {
    emitter.on(t, fn); return () => emitter.off(t, fn);
  } }, on: (_t: string, fn: () => void) => { shutdown.push(fn); } } as unknown as ExtensionAPI;
  const url = new URL('../src/index.ts', import.meta.url).href;
  expect(claimInstance(pi, url)).toBe(true); expect(claimInstance(pi, url)).toBe(false);
  expect(() => claimInstance(pi, import.meta.url)).toThrow('安装冲突');
  shutdown.forEach((fn) => fn()); expect(claimInstance(pi, url)).toBe(true); shutdown.at(-1)!();
});

it('前台真实工具交付并 finish 后可再开始，不 shutdown；讨论未确认不得交付', async () => {
  const f = fixture();
  let type = 'implementation';
  let revoked = false;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const route = String(url).split('/').at(-1);
    if (route === 'start') {
      const body = JSON.parse(String(init?.body));
      return Response.json({ binding: { goalId: body.goalId, pid: process.pid, attemptId: randomUUID(), taskId: randomUUID() } });
    }
    if (route === 'progress' && revoked) return Response.json({ error: { code: 'conflict', message: 'reviewed' } }, { status: 409 });
    if (route === 'context') return Response.json({ task: { id: randomUUID(), projectId: 'test', title: '目标', type, goal: '', acceptance: '', notes: '' },
      attempt: { id: randomUUID(), kind: 'new', executionMode: 'foreground' }, workspace: { path: f.root, requirements: [] }, decisions: [], deliveries: [], questions: [] });
    if (route === 'control') return Response.json({ type, discussionEndRequested: false, deliverySaved: false, waitId: null });
    if (route === 'deliveries') return Response.json({ deliveryId: randomUUID(), version: 1 });
    return Response.json({ ok: true });
  });
  registerSteward(f.pi, { env: { STEWARD_CONFIG: f.config }, fetcher });
  await f.fire('session_start', { reason: 'startup' });
  async function call(name: string, args = {}) {
    const tool = vi.mocked(f.pi.registerTool).mock.calls.find(([t]) => t.name === name)![0];
    return tool.execute('test', args, undefined, undefined, f.ctx as never);
  }
  expect((await call('steward_begin_task', input)).details).toHaveProperty('binding');
  const delivery = { summary: '完成', done: [], notCovered: [], verification: [], howTo: [], issues: [] };
  expect((await call('steward_deliver', delivery)).details).toHaveProperty('deliveryId');
  revoked = true;
  expect((await call('steward_progress', { text: '已先验收或返修' })).details).toEqual({ code: 'conflict' });
  expect((await f.fire('tool_call', { toolName: 'steward_finish' })).some((v) => (v as { block?: boolean })?.block)).toBe(false);
  expect((await call('steward_finish')).details).toEqual({ ok: true });
  expect(f.ctx.shutdown).not.toHaveBeenCalled();
  expect((await call('steward_finish')).details).toEqual({ code: 'binding_required' });
  expect(f.ctx.shutdown).not.toHaveBeenCalled();
  type = 'discussion';
  expect((await call('steward_begin_task', { ...input, type, transition: 'new' })).details).toHaveProperty('binding');
  expect((await call('steward_deliver', delivery)).details).toEqual({ code: 'discussion_end_required' });
});

it('后台接续带前台真实 metadata 时不恢复前台、不阻断写入', async () => {
  const f = fixture();
  f.session.appendCustomEntry('steward-foreground-goal', { goalId: randomUUID(), requestId: randomUUID(), start: input,
    sessionId: f.session.getSessionId(), binding: { goalId: randomUUID(), pid: process.pid, taskId: randomUUID(), attemptId: randomUUID() } });
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ type: 'implementation', discussionEndRequested: false, deliverySaved: false, waitId: null }));
  registerSteward(f.pi, { env: { STEWARD_CONFIG: f.config, STEWARD_ATTEMPT_ID: randomUUID() }, fetcher });
  await f.fire('session_start', { reason: 'resume' });
  expect((await f.fire('tool_call', { toolName: 'write' })).some((v: unknown) => (v as { block?: boolean })?.block)).toBe(false);
  const promptGuidelines: string[] = [];
  await f.fire('before_agent_start', { systemPromptOptions: { promptGuidelines } });
  expect(promptGuidelines.join('')).not.toContain('明确工作目标先自动');
  expect(promptGuidelines.join('')).toContain('任务台后台启动');
});

it('响应丢失、旧进程死亡后 lookup 仅给定位；新 owner 正文分配新 requestId 并 CAS 恢复', async () => {
  const f = fixture(); const goalId = randomUUID(); const oldRequest = randomUUID(); const oldAttempt = randomUUID();
  f.session.appendCustomEntry('steward-foreground-goal', { goalId, requestId: oldRequest, start: { title: input.title, goal: input.goal, acceptance: '', notes: '', type: input.type }, sent: true,
    pending: true, ownerTag: 'previous-process', sessionId: f.session.getSessionId() });
  vi.spyOn(runtime, 'processStatus').mockReturnValue('dead');
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'GET' ?
    Response.json({ binding: { goalId, pid: 98765, attemptId: oldAttempt, taskId: randomUUID() } }) :
    Response.json({ binding: { goalId, pid: process.pid, attemptId: randomUUID(), taskId: randomUUID() } }));
  const active = vi.fn();
  const state = registerForeground(f.pi, { env: { STEWARD_CONFIG: f.config }, fetcher }, active, vi.fn());
  await f.fire('session_start', { reason: 'resume' });
  expect(active).not.toHaveBeenCalled();
  await state.begin(input, f.ctx);
  const body = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
  expect(body.requestId).not.toBe(oldRequest);
  expect(body.previousAttemptId).toBe(oldAttempt);
  expect(body.previousOwnerPid).toBe(98765);
  expect(JSON.stringify(f.session.getEntries().filter((e) => e.type === 'custom'))).not.toContain(state.ownerId);
});

it('确定未发送目标可显式放弃；未知 start 必须先查询再取得所有权并 interrupt', async () => {
  const f = fixture(); const env = { STEWARD_CONFIG: join(f.root, 'missing') };
  let binding: object | null = null; let loseResponse = true;
  const routes: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    routes.push(String(url).split('/').at(-1)!);
    if (init?.method === 'GET') return Response.json({ binding });
    if (String(url).endsWith('/start')) {
      const body = JSON.parse(String(init?.body));
      binding ??= { goalId: body.goalId, pid: process.pid, attemptId: randomUUID(), taskId: randomUUID() };
      if (loseResponse) { loseResponse = false; throw new Error('lost'); }
      return Response.json({ binding });
    }
    return Response.json({ ok: true });
  });
  const state = registerForeground(f.pi, { env, fetcher }, vi.fn(), vi.fn());
  await f.fire('session_start', { reason: 'startup' });
  await expect(state.begin(input, f.ctx)).rejects.toThrow('invalid_config');
  expect(await state.close('interrupt')).toEqual({ ok: true });
  env.STEWARD_CONFIG = f.config;
  await expect(state.begin({ ...input, transition: 'new' }, f.ctx)).rejects.toThrow('network_error');
  // 当前进程刚发起的新目标，即使登记响应未知也可按本地授权工作；锁与PID阻止后台接管。
  expect((await f.fire('tool_call', { toolName: 'write' })).some((v) => (v as { block?: boolean })?.block)).toBe(false);
  await state.close('interrupt');
  expect(routes.at(-1)).toBe('interrupt');
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'GET')).toBe(true);
});

it('worktree 新 ctx 同 goal 同 task 同步真实 locator，改变 payload 使用新 requestId', async () => {
  const f = fixture();
  const git = (...args: string[]) => execFileSync('git', ['-C', f.root, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  const linked = join(f.root, 'linked'); git('worktree', 'add', '-qb', 'feature/test', linked);
  const moved = SessionManager.create(linked, join(f.root, 'other-sessions'));
  moved.appendMessage({ role: 'user', content: '迁移', timestamp: 1 });
  let binding: object | null = null;
  const bodies: Record<string, unknown>[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'GET') return Response.json({ binding });
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    binding = { goalId: body.goalId, pid: process.pid, attemptId: randomUUID(), taskId: (binding as { taskId?: string } | null)?.taskId ?? randomUUID() };
    return Response.json({ binding });
  });
  const active = vi.fn();
  const state = registerForeground(f.pi, { env: { STEWARD_CONFIG: f.config }, fetcher }, active, vi.fn());
  await f.fire('session_start', { reason: 'startup' });
  const first = await state.begin(input, f.ctx);
  const next = await state.begin(input, { ...f.ctx, cwd: linked, sessionManager: moved } as unknown as ExtensionContext);
  expect(next.binding.goalId).toBe(first.binding.goalId);
  expect(next.binding.taskId).toBe(first.binding.taskId);
  expect(next.binding.attemptId).not.toBe(first.binding.attemptId);
  expect(bodies[1]!.locator).toMatchObject({ path: realpathSync(linked), sessionId: moved.getSessionId() });
  expect(bodies[1]!.requestId).not.toBe(bodies[0]!.requestId);
  expect(active).toHaveBeenCalledTimes(2);
});

it('新目标令牌失效明确尚未纳管，但不阻断本地授权工作', async () => {
  const f = fixture();
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: { code: 'unauthorized', message: 'invalid token' } }, { status: 401 }));
  registerSteward(f.pi, { env: { STEWARD_CONFIG: f.config }, fetcher });
  await f.fire('session_start', { reason: 'startup' });
  const tool = vi.mocked(f.pi.registerTool).mock.calls.find(([t]) => t.name === 'steward_begin_task')![0];
  const reply = await tool.execute('test', input, undefined, undefined, f.ctx as never);
  expect(reply.details).toMatchObject({ code: 'unauthorized', managed: false });
  expect(JSON.stringify(reply.details)).toContain('尚未纳管');
  expect((await f.fire('tool_call', { toolName: 'write' })).some((v) => (v as { block?: boolean })?.block)).toBe(false);
});

it('新 attempt 绑定后重建心跳，不继续给旧 attempt 续租', async () => {
  const f = fixture(); vi.useFakeTimers(); cleanup.push(() => vi.useRealTimers());
  const old = { goalId: randomUUID(), pid: process.pid, attemptId: randomUUID(), taskId: randomUUID() };
  const next = { ...old, attemptId: randomUUID() };
  let starts = 0;
  const heartbeats: (string | null)[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method === 'GET') return Response.json({ binding: old });
    if (String(url).endsWith('/start')) return Response.json({ binding: starts++ === 0 ? old : next });
    if (String(url).endsWith('/heartbeat')) heartbeats.push(new Headers(init?.headers).get('X-Steward-Attempt-Id'));
    return Response.json({ ok: true });
  });
  const state = registerForeground(f.pi, { env: { STEWARD_CONFIG: f.config }, fetcher }, vi.fn(), vi.fn());
  await f.fire('session_start', { reason: 'startup' });
  await state.begin(input, f.ctx); await vi.advanceTimersByTimeAsync(15_000);
  await state.begin(input, f.ctx); await vi.advanceTimersByTimeAsync(15_000);
  expect(heartbeats).toEqual([old.attemptId, next.attemptId]);
});

it('迟到关闭响应不会把恢复后的新目标标成已结束', async () => {
  const f = fixture(); let resolveClose: ((response: Response) => void) | undefined;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/interrupt')) return new Promise<Response>((resolve) => { resolveClose = resolve; });
    const body = JSON.parse(String(init?.body));
    return Response.json({ binding: { goalId: body.goalId, pid: process.pid, taskId: randomUUID(), attemptId: randomUUID() } });
  });
  const state = registerForeground(f.pi, { env: { STEWARD_CONFIG: f.config }, fetcher }, vi.fn(), vi.fn());
  await f.fire('session_start', { reason: 'startup' }); await state.begin(input, f.ctx);
  const closing = state.close('interrupt'); await Promise.resolve();
  await f.fire('session_shutdown', { reason: 'new' });
  f.session.appendCustomEntry('steward-foreground-goal', { goalId: randomUUID(), requestId: randomUUID(),
    start: { title: input.title, goal: input.goal, acceptance: '', notes: '', type: input.type }, sessionId: f.session.getSessionId() });
  await f.fire('session_start', { reason: 'new' });
  const fresh = await state.begin(input, f.ctx);
  resolveClose!(Response.json({ ok: true }));
  await expect(closing).rejects.toThrow('binding_changed');
  expect(state.binding).toEqual(fresh.binding);
});

it('403 撤销本地执行权并阻断历史写入；迟到旧请求不能改写下一目标', async () => {
  const f = fixture();
  let revoke = false;
  let resolveOld: ((value: Response) => void) | undefined;
  let holdOld = false;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const route = String(url).split('/').at(-1);
    if (route === 'start') {
      const body = JSON.parse(String(init?.body));
      return Response.json({ binding: { goalId: body.goalId, pid: process.pid, attemptId: randomUUID(), taskId: randomUUID() } });
    }
    if (route === 'progress' && holdOld) return new Promise<Response>((resolve) => { resolveOld = resolve; });
    if (route === 'progress' && revoke) return Response.json({ error: { code: 'forbidden', message: 'revoked' } }, { status: 403 });
    if (route === 'control') return Response.json({ type: 'discussion', discussionEndRequested: false, deliverySaved: false, waitId: null });
    return Response.json({ ok: true });
  });
  registerSteward(f.pi, { env: { STEWARD_CONFIG: f.config }, fetcher });
  async function call(name: string, args = {}) {
    return vi.mocked(f.pi.registerTool).mock.calls.find(([t]) => t.name === name)![0].execute('test', args, undefined, undefined, f.ctx as never);
  }
  await f.fire('session_start', { reason: 'startup' });
  await call('steward_begin_task', input);
  holdOld = true;
  const pending = call('steward_progress', { text: '旧回报' });
  await Promise.resolve();
  expect(resolveOld).toBeDefined();
  await call('steward_interrupt_task');
  await call('steward_begin_task', { ...input, transition: 'new' });
  resolveOld!(Response.json({ ok: true }));
  expect((await pending).details).toEqual({ code: 'binding_changed' });
  holdOld = false; revoke = true;
  expect((await call('steward_progress', { text: '撤权' })).details).toEqual({ code: 'forbidden' });
  for (const toolName of ['edit', 'bash', 'subagent', 'worktree_create', 'multi_tool_use.parallel']) {
    expect((await f.fire('tool_call', { toolName })).some((v) => (v as { block?: boolean })?.block)).toBe(true);
  }
  expect((await f.fire('tool_call', { toolName: 'read' })).some((v) => (v as { block?: boolean })?.block)).toBe(false);
  const promptGuidelines: string[] = [];
  await f.fire('before_agent_start', { systemPromptOptions: { promptGuidelines } });
  expect(promptGuidelines.join('')).not.toContain('当前为前台目标');
  expect(await call('steward_interrupt_task')).toMatchObject({ details: { ok: true, localOnly: true } });
  expect((await call('steward_begin_task', { ...input, transition: 'new' })).details).toHaveProperty('binding');
});

it('原对话被其他任务占用时，换目标及离线不能绕过；原生新会话可开始独立目标', async () => {
  const f = fixture(); let offline = false; let permit = false;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (offline) throw new Error('offline');
    if (!permit) return Response.json({ error: { code: 'session_in_use', message: 'another task owns session' } }, { status: 409 });
    const body = JSON.parse(String(init?.body));
    return Response.json({ binding: { goalId: body.goalId, pid: process.pid, taskId: randomUUID(), attemptId: randomUUID() } });
  });
  const state = registerForeground(f.pi, { env: { STEWARD_CONFIG: f.config }, fetcher }, vi.fn(), vi.fn());
  await f.fire('session_start', { reason: 'startup' });
  await expect(state.begin(input, f.ctx)).rejects.toThrow('session_in_use');
  expect((await f.fire('tool_call', { toolName: 'write' })).some((v) => (v as { block?: boolean })?.block)).toBe(true);
  expect(await state.close('interrupt')).toMatchObject({ localOnly: true });
  offline = true;
  await expect(state.begin({ ...input, transition: 'new' }, f.ctx)).rejects.toThrow('network_error');
  expect((await f.fire('tool_call', { toolName: 'write' })).some((v) => (v as { block?: boolean })?.block)).toBe(true);
  const forked = SessionManager.create(f.root, join(f.root, 'fork-sessions'));
  forked.appendMessage({ role: 'user', content: '新会话独立目标', timestamp: 2 });
  // 原生新会话没有旧对话的占用记录；使用真实新 session ID，不伪造旧执行权限。
  offline = false; permit = true;
  const next = registerForeground({ ...f.pi, appendEntry: (type: string, data: unknown) => forked.appendCustomEntry(type, data) } as unknown as ExtensionAPI,
    { env: { STEWARD_CONFIG: f.config }, fetcher }, vi.fn(), vi.fn());
  const moved = { ...f.ctx, sessionManager: forked } as unknown as ExtensionContext;
  expect((await next.begin(input, moved)).binding).toHaveProperty('attemptId');
});

it('历史无绑定不能使用执行工具', async () => {
  const f = fixture(); const fetcher = vi.fn<typeof fetch>();
  registerSteward(f.pi, { env: { STEWARD_CONFIG: f.config }, fetcher });
  const tool = vi.mocked(f.pi.registerTool).mock.calls.find(([t]) => t.name === 'steward_progress')![0];
  expect((await tool.execute('test', { text: '不应发送' }, undefined, undefined, f.ctx as never)).details).toEqual({ code: 'binding_required' });
  expect(fetcher).not.toHaveBeenCalled();
});
