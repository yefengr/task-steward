import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import type { AgentContextResponse } from '@pi-steward/contract';
import { acquireExecutionLock } from '@pi-steward/execution-runtime';
import { afterEach, expect, it, vi } from 'vitest';
import { registerSteward } from '../src/index.js';
import { lifecycleBlocked } from '../src/lifecycle.js';
import { proveWorkspace } from '../src/git-lifecycle.js';
import { retryableWrites } from '../src/retry-writes.js';

vi.mock('../src/git-lifecycle.js', () => ({ proveWorkspace: vi.fn(), prepareGit: vi.fn() }));
const cleanup: (() => void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.clearAllMocks(); });
const report = { summary: '记录', done: [], notCovered: [], verification: [], howTo: [], issues: [] };
function fixture(manual = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'steward-life-')));
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ platformUrl: 'https://test.invalid', machineToken: `stm_${randomBytes(32).toString('base64url')}`,
    slots: 1, projects: [{ id: 'p', name: 'p', path: root }], path: ['/usr/bin'], pi: { command: 'pi', extraArgs: [] } }), { mode: 0o600 });
  const session = SessionManager.create(root, join(root, 'sessions'));
  session.appendMessage({ role: 'user', content: 'fixture', timestamp: 1 });
  const attemptId = randomUUID(); const taskId = randomUUID(); const sourceId = randomUUID();
  const data: AgentContextResponse = { task: { id: taskId, projectId: 'p', title: '任务', type: 'implementation', goal: '', acceptance: '', notes: '' },
    attempt: { id: attemptId, kind: 'new', executionMode: manual ? 'foreground' : 'background' }, workspace: { path: root, requirements: [] },
    decisions: [], questions: [], deliveries: [{ ...report, id: sourceId, taskId, attemptId, version: 1, review: null,
      feedback: null, reviewedAt: null, createdAt: 1, commit: 'a'.repeat(40), baseCommit: 'b'.repeat(40) }],
    workRevision: 0, settled: false, implementationAllowed: false, recordAllowed: true, phase: 'delivered', latestDeliveryId: sourceId };
  let goalId = randomUUID();
  let pending: ((response: Response) => void) | undefined;
  let holdProgress = false;
  let offline = false;
  let loseContinue = false;
  const continued = new Map<string, number>();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const route = String(url).split('/').at(-1);
    if (offline) return Response.json({ error: { code: 'internal_error', message: '' } }, { status: 500 });
    if (route === 'context') return Response.json(data);
    if (route === 'control') return Response.json({ type: data.task.type, deliverySaved: data.phase !== 'working', waitId: null,
      discussionEndRequested: false, workRevision: data.workRevision, settled: data.settled, phase: data.phase,
      implementationAllowed: data.implementationAllowed, recordAllowed: data.recordAllowed });
    if (route === 'start') {
      goalId = JSON.parse(String(init?.body)).goalId;
      return Response.json({ binding: { goalId, pid: process.pid, attemptId, taskId } });
    }
    if (route === goalId) return Response.json({ binding: { goalId, pid: process.pid, attemptId, taskId } });
    if (route === 'settle') { data.settled = true; data.phase = 'settled'; return Response.json({ ok: true }); }
    if (route === 'continue') {
      const nonce = JSON.parse(String(init?.body)).requestId;
      if (continued.has(nonce)) return Response.json({ workRevision: continued.get(nonce) });
      data.workRevision = (data.workRevision ?? 0) + 1; data.settled = false;
      data.implementationAllowed = true; data.recordAllowed = false; data.phase = 'working';
      continued.set(nonce, data.workRevision);
      if (loseContinue) { loseContinue = false; throw new Error('response lost'); }
      return Response.json({ workRevision: data.workRevision });
    }
    if (route === 'progress' && holdProgress) return new Promise<Response>((resolve) => { pending = resolve; });
    if (route === 'deliveries' || route === 'delivery-revisions') return Response.json({ deliveryId: randomUUID(), version: 2 });
    return Response.json({ ok: true });
  });
  const handlers = vi.fn<ExtensionAPI['on']>(); const registerTool = vi.fn<ExtensionAPI['registerTool']>(); const shutdown = vi.fn();
  const ctx = { cwd: root, sessionManager: session, shutdown, isIdle: () => false } as unknown as ExtensionToolContext;
  registerSteward({ on: handlers, registerTool, sendMessage: vi.fn(), appendEntry: (t: string, d: unknown) => session.appendCustomEntry(t, d) } as unknown as ExtensionAPI,
    { env: { STEWARD_CONFIG: config, STEWARD_ATTEMPT_ID: manual ? undefined : attemptId }, fetcher });
  const fire = async (name: string, event = {}) => {
    const results = [];
    for (const [type, fn] of handlers.mock.calls) if (type === name) results.push(await fn({ type: name, ...event } as never, ctx));
    return results;
  };
  const call = (name: string, args = {}) => registerTool.mock.calls.find(([tool]) => tool.name === name)![0].execute('id', args, undefined, undefined, ctx);
  cleanup.push(() => { void fire('session_shutdown'); rmSync(root, { force: true, recursive: true }); });
  return { data, call, fire, fetcher, shutdown, config, session, attemptId, sourceId, get goalId() { return goalId; },
    offline(value: boolean) { offline = value; }, loseContinue() { loseContinue = true; },
    hold() { holdProgress = true; }, release() { holdProgress = false; pending!(Response.json({ ok: true })); } };
}

it('继续在原 attempt 开启新代，先结算；迟到实施响应不污染新段，写请求 ID 隔离', async () => {
  const f = fixture(); f.hold();
  const old = f.call('steward_progress', { text: '旧写' });
  await vi.waitFor(() => expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith('/progress'))).toBe(true));
  expect((await f.call('steward_continue', { deliveryId: f.sourceId, reason: '用户授权续做', authorizedByUser: true })).details).toEqual({ workRevision: 1 });
  const posts = f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts.map(([url]) => String(url).split('/').at(-1))).toEqual(['progress', 'settle', 'continue']);
  f.release(); expect((await old).details).toEqual({ code: 'binding_changed' });
  await f.call('steward_progress', { text: '旧写' });
  const writes = f.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/progress'));
  expect(writes.map(([, init]) => new Headers(init?.headers).get('X-Steward-Work-Revision'))).toEqual(['0', '1']);
  expect(JSON.parse(String(writes[0]![1]?.body)).requestId).not.toBe(JSON.parse(String(writes[1]![1]?.body)).requestId);
  expect(f.shutdown).not.toHaveBeenCalled();
});

it('修订记录稳定幂等、强制保留 SHA/base，不证明现场或开启实施；已验收拒绝', async () => {
  const f = fixture(); f.data.settled = true;
  const args = { ...report, deliveryId: f.sourceId, reason: '仅补说明', authorizedByUser: true, commit: 'c'.repeat(40) };
  await f.call('steward_revise_delivery', args); await f.call('steward_revise_delivery', args);
  await f.call('steward_revise_delivery', Object.fromEntries(Object.entries(args).reverse()));
  const writes = f.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/delivery-revisions'));
  expect(writes).toHaveLength(3);
  expect(new Set(writes.map(([, init]) => init?.body)).size).toBe(1);
  expect(JSON.parse(String(writes[0]![1]?.body))).toMatchObject({ commit: 'a'.repeat(40), baseCommit: 'b'.repeat(40) });
  expect(proveWorkspace).not.toHaveBeenCalled(); expect(f.data.workRevision).toBe(0);
  expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith('/continue'))).toBe(false);
  f.data.recordAllowed = false; f.data.phase = 'complete';
  expect((await f.call('steward_revise_delivery', args)).details).toEqual({ code: 'forbidden' });
  expect((await f.call('steward_continue', args)).details).toEqual({ code: 'forbidden' });
});

it('普通 Pi 解绑仍有同 owner 记录权，继续前重新取得 goal 锁，仍绑定同一 attempt', async () => {
  const f = fixture(true); await f.fire('session_start', { reason: 'startup' });
  await f.call('steward_begin_task', { title: '任务', goal: '目标', type: 'implementation', transition: 'new' });
  await f.call('steward_deliver', report); await f.call('steward_finish');
  expect(f.shutdown).not.toHaveBeenCalled();
  expect((await f.call('steward_revise_delivery', { ...report, deliveryId: f.sourceId, reason: '补说明', authorizedByUser: true })).details)
    .toMatchObject({ version: 2 });
  const unlock = acquireExecutionLock(f.config, f.goalId);
  const args = { deliveryId: f.sourceId, reason: '续做', authorizedByUser: true };
  try { expect((await f.call('steward_continue', args)).details).toEqual({ code: 'session_ownership_unavailable' }); }
  finally { unlock(); }
  expect(f.data.workRevision).toBe(0);
  expect((await f.call('steward_continue', args)).details).toEqual({ workRevision: 1 });
  await f.call('steward_progress', { text: '新段' });
  const post = f.fetcher.mock.calls.findLast(([url]) => String(url).endsWith('/progress'));
  expect(new Headers(post![1]?.headers).get('X-Steward-Attempt-Id')).toBe(f.attemptId);
  expect(new Headers(post![1]?.headers).get('X-Steward-Work-Revision')).toBe('1');
});

it('工作段门禁使用最新 control，交付/结算/合并拒绝潜在实施工具', async () => {
  const f = fixture();
  for (const phase of ['delivered', 'settled', 'merging', 'complete'] as const) {
    f.data.phase = phase;
    for (const toolName of ['bash', 'write', 'edit', 'subagent', 'worktree_create', 'unknown']) {
      expect(await f.fire('tool_call', { toolName })).toContainEqual(expect.objectContaining({ block: true }));
    }
  }
  expect(lifecycleBlocked('read', { settled: true })).toBe(false);
  expect(lifecycleBlocked('steward_progress', { phase: 'delivered', implementationAllowed: false })).toBe(false);
  expect(lifecycleBlocked('steward_progress', { settled: true })).toBe(true);
  expect(lifecycleBlocked('steward_revise_delivery', { settled: true })).toBe(false);
});

it('continue 响应丢失后即使 control 已采纳新段也原 nonce 重放，不再结算或开启新段', async () => {
  const f = fixture(); f.loseContinue();
  const args = { deliveryId: f.sourceId, reason: '继续验证', authorizedByUser: true };
  expect((await f.call('steward_continue', args)).details).toEqual({ code: 'network_error' });
  await f.fire('tool_call', { toolName: 'edit' });
  expect((await f.call('steward_continue', args)).details).toEqual({ workRevision: 1 });
  expect(f.data.workRevision).toBe(1);
  expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/settle'))).toHaveLength(1);
  const writes = f.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/continue'));
  expect(writes).toHaveLength(2); expect(writes[0]![1]?.body).toBe(writes[1]![1]?.body);
  f.data.phase = 'complete'; f.data.implementationAllowed = false;
  expect((await f.call('steward_continue', args)).details).toEqual({ code: 'forbidden' });
  expect(await f.fire('tool_call', { toolName: 'edit' })).toContainEqual(expect.objectContaining({ block: true }));
});

it('新段到来后 finish 不沿用旧段 deliverySaved；工具刷新也同步控制缓存', async () => {
  const f = fixture();
  await f.fire('tool_call', { toolName: 'edit' });
  f.data.workRevision = 1; f.data.phase = 'working'; f.data.implementationAllowed = true;
  await f.fire('tool_call', { toolName: 'edit' });
  expect((await f.call('steward_finish')).details).toEqual({ code: 'delivery_required' });
  expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith('/settle'))).toBe(false);
});

it('离线不阻断本地纯读，未知工具与 user_bash 明确拒绝而不抛异常', async () => {
  const f = fixture(); f.offline(true);
  for (const toolName of ['read', 'grep', 'find', 'ls']) expect(await f.fire('tool_call', { toolName })).toEqual([undefined, undefined]);
  expect(f.fetcher).not.toHaveBeenCalled();
  for (const toolName of ['edit', 'bash', 'unknown']) expect(await f.fire('tool_call', { toolName }))
    .toContainEqual(expect.objectContaining({ block: true, reason: expect.stringContaining('无法确认') }));
  expect(await f.fire('user_bash')).toContainEqual({ result: expect.objectContaining({ exitCode: 1 }) });
});

it('交接核对暂时拒绝写工具时保留具体错误与原绑定指引', async () => {
  const f = fixture();
  f.fetcher.mockResolvedValueOnce(Response.json({ error: { code: 'session_handover_pending', message: 'handover pending' } }, { status: 409 }));
  expect(await f.fire('tool_call', { toolName: 'steward_progress' })).toContainEqual({ block: true,
    reason: expect.stringContaining('session_handover_pending') });
  expect(await f.fire('tool_call', { toolName: 'steward_progress' })).not.toContainEqual(expect.objectContaining({ block: true }));
});

it('排队写在代数变化后不发送，也不借新 control 提升旧请求', async () => {
  let generation = 0; const send = vi.fn(async () => true);
  const write = retryableWrites({ generation: () => generation });
  const pending = write('POST', 'progress', {}, send); generation++;
  await expect(pending).rejects.toMatchObject({ code: 'binding_changed' }); expect(send).not.toHaveBeenCalled();
});
