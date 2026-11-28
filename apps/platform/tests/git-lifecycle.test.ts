import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import * as c from '@pi-steward/contract';
import { delivery, errorCode, project, request, useFixture } from './fixture.js';

const setup = useFixture();
type Fixture = Awaited<ReturnType<typeof setup>>;
const baseCommit = 'a'.repeat(40);
const commit = 'b'.repeat(40);
const workspace: c.AttemptWorkspace = { path: '/work/task/subdir', gitRoot: '/work/task', gitKind: 'linked',
  gitBranch: 'feature/task', sessionId: 'original-session', sessionFile: '/sessions/original.jsonl' };
const preparation = { baseBranch: 'main', baseCommit, taskBranch: 'feature/task', repositoryPath: project.path,
  syncBeforeStart: true, syncResult: 'no_upstream' };
const read = async <T>(schema: { parse(data: unknown): T }, response: Response): Promise<T> => schema.parse(await response.json());
const settings = (x: Fixture, body: object) => x.web(`/projects/${project.id}/git`, body, 'PATCH');
const pollBody = () => request({ launcherVersion: 'test', slots: 3, projects: [project], attempts: [], gitLifecycle: true });
const poll = async (x: Fixture, body: object = pollBody()) => read(c.launcherHeartbeatResponseSchema, await x.launcher('/heartbeat', body));
const report = (x: Fixture, id: string, body: object, machine?: string) => x.launcher(`/git-operations/${id}/report`, body, machine);
const context = (x: Fixture, id: string) => x.agent(id, '/context').then((r) => read(c.agentContextResponseSchema, r));

async function prepared() {
  const x = await setup();
  await x.heartbeat(3);
  expect((await settings(x, { baseBranch: 'main', syncBeforeStart: true, version: 1 })).status).toBe(200);
  const task = await x.create();
  await x.action(task.id, 'schedule');
  const attempt = await x.claimed();
  expect((await x.agent(attempt.id, '/git/prepare', request(preparation))).status).toBe(200);
  return { x, task, attempt };
}
async function accepted() {
  const { x, task, attempt } = await prepared();
  expect((await x.agent(attempt.id, '/workspace', request({ workspace }))).status).toBe(200);
  const submitted = await read(c.agentDeliveryResponseSchema, await x.agent(attempt.id, '/deliveries', request({ ...delivery, baseCommit, commit })));
  expect((await x.action(task.id, 'accept', { deliveryId: submitted.deliveryId })).status).toBe(200);
  return { x, task, attempt, deliveryId: submitted.deliveryId };
}

it('取消释放分支与树占用但保留历史快照，活动任务仍排斥承接', async () => {
  const { x, task, attempt } = await prepared();
  await x.agent(attempt.id, '/workspace', request({ workspace }));
  const next = await x.create(); await x.action(next.id, 'schedule'); const nextAttempt = await x.claimed();
  await errorCode(await x.agent(nextAttempt.id, '/git/prepare', request(preparation)), 409, 'conflict');
  const history = x.store.get('SELECT snapshot FROM task_git WHERE task_id=?', task.id);
  expect((await x.action(task.id, 'cancel')).status).toBe(200);
  expect((await x.agent(nextAttempt.id, '/git/prepare', request(preparation))).status).toBe(200);
  expect((await x.agent(nextAttempt.id, '/workspace', request({ workspace: { ...workspace, sessionId: 'next', sessionFile: '/sessions/next.jsonl' } }))).status).toBe(200);
  expect(x.store.get('SELECT snapshot FROM task_git WHERE task_id=?', task.id)).toEqual(history);
});

it('同树实际分支登记更新快照，不能迁往其他树或抢占活动分支', async () => {
  const { x, attempt } = await prepared();
  await x.agent(attempt.id, '/workspace', request({ workspace }));
  const next = await x.create(); await x.action(next.id, 'schedule'); const nextAttempt = await x.claimed();
  await x.agent(nextAttempt.id, '/git/prepare', request({ ...preparation, taskBranch: 'feature/occupied' }));
  await errorCode(await x.agent(attempt.id, '/workspace', request({ workspace: { ...workspace, gitBranch: 'feature/occupied' } })), 409, 'conflict');
  await errorCode(await x.agent(attempt.id, '/workspace', request({ workspace: { ...workspace, gitRoot: '/different', path: '/different' } })), 409, 'conflict');
  const renamed = request({ workspace: { ...workspace, gitBranch: 'feature/renamed' } });
  expect((await x.agent(attempt.id, '/workspace', renamed)).status).toBe(200);
  expect((await x.agent(attempt.id, '/workspace', renamed)).status).toBe(200);
  expect((await context(x, attempt.id)).git?.taskBranch).toBe('feature/renamed');
  expect(x.store.all('SELECT * FROM progress WHERE attempt_id=?', attempt.id)).toHaveLength(1);
});

it('会话占用拒绝 workspace 时，外层事务回滚已计算的 Git 现场和确认字段', async () => {
  const { x, task, attempt } = await prepared();
  const otherTask = await x.create(); await x.action(otherTask.id, 'schedule'); const other = await x.claimed();
  expect((await x.agent(other.id, '/session', request({ locator: { path: '/work/other', sessionId: workspace.sessionId, sessionFile: workspace.sessionFile } }))).status).toBe(200);
  const beforeGit = x.store.get('SELECT snapshot FROM task_git WHERE task_id=?', task.id);
  const beforeAttempt = x.store.get('SELECT * FROM attempts WHERE id=?', attempt.id);
  const rejected = request({ workspace });
  await errorCode(await x.agent(attempt.id, '/workspace', rejected), 409, 'session_in_use');
  expect(x.store.get('SELECT snapshot FROM task_git WHERE task_id=?', task.id)).toEqual(beforeGit);
  expect(x.store.get('SELECT * FROM attempts WHERE id=?', attempt.id)).toEqual(beforeAttempt);
  expect(x.store.get('SELECT 1 FROM request_log WHERE request_id=?', rejected.requestId)).toBeUndefined();
});

it('前台交付验收绑定源进程身份，旧启动器不能绕过普通 Pi 存活保护', async () => {
  const { x, task, attempt } = await prepared();
  await x.agent(attempt.id, '/workspace', request({ workspace }));
  const submitted = await read(c.agentDeliveryResponseSchema, await x.agent(attempt.id, '/deliveries', request({ ...delivery, baseCommit, commit })));
  const goalId = randomUUID(), ownerId = randomUUID(), pid = 12345;
  x.store.run("UPDATE attempts SET execution_mode='foreground',goal_id=?,owner_id=?,owner_pid=? WHERE id=?", goalId, ownerId, pid, attempt.id);
  expect((await x.action(task.id, 'accept', { deliveryId: submitted.deliveryId })).status).toBe(200);
  expect((await x.send('/agent/foreground/settle', request(), { machine: x.token, attempt: attempt.id,
    headers: { 'X-Steward-Owner-Id': ownerId } })).status).toBe(200);
  expect((await poll(x)).gitOperations).toEqual([]);
  const capable = await poll(x, { ...pollBody(), foregroundControl: true });
  expect(capable.gitOperations?.[0]?.foregroundOwner).toEqual({ goalId, pid });
});
it('项目默认、版本冲突、heartbeat不覆盖设置；任务覆盖仅未启动可改，prepare冻结配置和同步结果', async () => {
  const x = await setup();
  await x.heartbeat(3);
  const projects = await read(c.webProjectsResponseSchema, await x.web('/projects'));
  expect(projects.projects[0]?.gitSettings).toEqual({ baseBranch: null, syncBeforeStart: true, version: 1 });
  expect((await settings(x, { baseBranch: 'main', syncBeforeStart: false, version: 1 })).status).toBe(200);
  await errorCode(await settings(x, { baseBranch: 'other', syncBeforeStart: true, version: 1 }), 409, 'conflict');
  await x.heartbeat(3);
  const task = await x.create('override', { baseBranch: 'release' });
  expect(task.baseBranch).toBe('release');
  const edited = await read(c.webTaskMutationResponseSchema, await x.web(`/tasks/${task.id}`, { baseBranch: 'stable', version: task.version }, 'PATCH'));
  expect(edited.task.baseBranch).toBe('stable');
  await x.action(task.id, 'schedule');
  const attempt = await x.claimed();
  const input = request({ ...preparation, baseBranch: 'stable', syncBeforeStart: false, syncResult: 'disabled' });
  await errorCode(await x.agent(attempt.id, '/git/prepare', request({ ...input, repositoryPath: '/another' })), 409, 'conflict');
  await errorCode(await x.agent(attempt.id, '/git/prepare', request({ ...input, taskBranch: 'stable' })), 409, 'conflict');
  expect((await x.agent(attempt.id, '/git/prepare', input)).status).toBe(200);
  expect((await x.agent(attempt.id, '/git/prepare', input)).status).toBe(200);
  await errorCode(await x.agent(attempt.id, '/git/prepare', request({ ...input, baseCommit: commit })), 409, 'conflict');
  expect((await settings(x, { baseBranch: 'changed', syncBeforeStart: true, version: 2 })).status).toBe(200);
  const ctx = await context(x, attempt.id);
  expect(ctx.gitSettings).toEqual({ baseBranch: 'stable', syncBeforeStart: false });
  expect(ctx.git).toMatchObject({ baseCommit, syncResult: 'disabled', phase: 'prepared' });
  const current = (await x.detail(task.id)).task;
  await errorCode(await x.web(`/tasks/${task.id}`, { baseBranch: null, version: current.version }, 'PATCH'), 409, 'conflict');
  expect((await x.web(`/tasks/${task.id}`, { goal: 'still editable', version: current.version }, 'PATCH')).status).toBe(200);
});

it('首次领取即冻结基准与同步选择，prepare前修改项目默认也不能影响已开工任务', async () => {
  const x = await setup();
  await x.heartbeat(3);
  await settings(x, { baseBranch: 'main', syncBeforeStart: true, version: 1 });
  const task = await x.create();
  await x.action(task.id, 'schedule');
  const attempt = await x.claimed();
  await settings(x, { baseBranch: 'develop', syncBeforeStart: false, version: 2 });
  expect((await context(x, attempt.id)).gitSettings).toEqual({ baseBranch: 'main', syncBeforeStart: true });
  expect((await x.detail(task.id)).task.baseBranch).toBe('main');
  const running = (await x.detail(task.id)).task;
  await errorCode(await x.web(`/tasks/${task.id}`, { baseBranch: 'release', version: running.version }, 'PATCH'), 409, 'conflict');
  expect((await x.agent(attempt.id, '/git/prepare', request(preparation))).status).toBe(200);
  const next = await x.create();
  await x.action(next.id, 'schedule');
  const nextAttempt = await x.claimed();
  expect((await context(x, nextAttempt.id)).gitSettings).toEqual({ baseBranch: 'develop', syncBeforeStart: false });
});

it('领取时项目基准为null不自动继承后来默认；显式首次选择同时锁定当前同步，之后不可再改', async () => {
  const x = await setup();
  await x.heartbeat(3);
  const task = await x.create();
  await x.action(task.id, 'schedule');
  const attempt = await x.claimed();
  expect((await x.detail(task.id)).task.baseBranch).toBeNull();
  expect((await context(x, attempt.id)).gitSettings).toEqual({ baseBranch: null, syncBeforeStart: true });
  expect((await settings(x, { baseBranch: 'main', syncBeforeStart: false, version: 1 })).status).toBe(200);
  expect((await context(x, attempt.id)).gitSettings).toEqual({ baseBranch: null, syncBeforeStart: true });
  await errorCode(await x.agent(attempt.id, '/git/prepare', request(preparation)), 409, 'conflict');
  const current = (await x.detail(task.id)).task;
  expect((await x.web(`/tasks/${task.id}`, { baseBranch: 'main', version: current.version }, 'PATCH')).status).toBe(200);
  expect((await context(x, attempt.id)).gitSettings).toEqual({ baseBranch: 'main', syncBeforeStart: false });
  const chosen = (await x.detail(task.id)).task;
  await errorCode(await x.web(`/tasks/${task.id}`, { baseBranch: 'develop', version: chosen.version }, 'PATCH'), 409, 'conflict');
  await errorCode(await x.web(`/tasks/${task.id}`, { baseBranch: null, version: chosen.version }, 'PATCH'), 409, 'conflict');
  const input = request({ ...preparation, baseBranch: 'main', syncBeforeStart: false, syncResult: 'disabled' });
  expect((await x.agent(attempt.id, '/git/prepare', input)).status).toBe(200);
  expect((await context(x, attempt.id)).gitSettings).toEqual({ baseBranch: 'main', syncBeforeStart: false });
  expect((await settings(x, { baseBranch: 'changed', syncBeforeStart: true, version: 2 })).status).toBe(200);
  const preparedTask = (await x.detail(task.id)).task;
  await errorCode(await x.web(`/tasks/${task.id}`, { baseBranch: 'other', version: preparedTask.version }, 'PATCH'), 409, 'conflict');
  await errorCode(await x.web(`/tasks/${task.id}`, { baseBranch: null, version: preparedTask.version }, 'PATCH'), 409, 'conflict');
  expect((await context(x, attempt.id)).gitSettings).toEqual({ baseBranch: 'main', syncBeforeStart: false });
});

it.each(['running', 'interrupted'] as const)('升级前已有尝试的 %s 任务可显式首次补选基准并同事务锁定当前同步', async (status) => {
  const x = await setup();
  await x.heartbeat(3);
  const task = await x.create();
  await x.action(task.id, 'schedule');
  const attempt = await x.claimed();
  // 模拟升级前遗留数据形状：尝试已存在，冻结标记与基准为空，且没有 Git 快照。
  x.store.run('UPDATE tasks SET status=?, base_branch=NULL, git_sync_before_start=NULL WHERE id=?', status, task.id);
  if (status === 'interrupted') x.store.run("UPDATE attempts SET ended_at=?, result='interrupted' WHERE id=?", x.now(), attempt.id);
  expect(x.store.get('SELECT 1 FROM task_git WHERE task_id=?', task.id)).toBeUndefined();
  expect(x.store.get<{ base_branch: string | null; git_sync_before_start: number | null }>(
    'SELECT base_branch, git_sync_before_start FROM tasks WHERE id=?', task.id)).toEqual({ base_branch: null, git_sync_before_start: null });
  expect((await settings(x, { baseBranch: 'main', syncBeforeStart: false, version: 1 })).status).toBe(200);
  const stale = (await x.detail(task.id)).task;
  await errorCode(await x.web(`/tasks/${task.id}`, { baseBranch: 'main', version: stale.version - 1 }, 'PATCH'), 409, 'conflict');
  expect((await x.web(`/tasks/${task.id}`, { baseBranch: 'main', version: stale.version }, 'PATCH')).status).toBe(200);
  expect(x.store.get<{ base_branch: string | null; git_sync_before_start: number | null }>(
    'SELECT base_branch, git_sync_before_start FROM tasks WHERE id=?', task.id)).toEqual({ base_branch: 'main', git_sync_before_start: 0 });
  const chosen = (await x.detail(task.id)).task;
  await errorCode(await x.web(`/tasks/${task.id}`, { baseBranch: 'develop', version: chosen.version }, 'PATCH'), 409, 'conflict');
  await errorCode(await x.web(`/tasks/${task.id}`, { baseBranch: null, version: chosen.version }, 'PATCH'), 409, 'conflict');
  expect((await x.detail(task.id)).task.baseBranch).toBe('main');
});

it('始终未开始的任务保持原有基准编辑行为，不提前写入同步标记', async () => {
  const x = await setup();
  await x.heartbeat(3);
  const task = await x.create();
  const edited = await read(c.webTaskMutationResponseSchema, await x.web(`/tasks/${task.id}`, { baseBranch: 'release', version: task.version }, 'PATCH'));
  expect(edited.task.baseBranch).toBe('release');
  expect(x.store.get<{ git_sync_before_start: number | null }>('SELECT git_sync_before_start FROM tasks WHERE id=?', task.id)?.git_sync_before_start).toBeNull();
  const cleared = await read(c.webTaskMutationResponseSchema, await x.web(`/tasks/${task.id}`, { baseBranch: null, version: edited.task.version }, 'PATCH'));
  expect(cleared.task.baseBranch).toBeNull();
});

it('prepare拒绝未配置/讨论任务与重复分支，现场必须专属linked根且交付精确匹配冻结base', async () => {
  const x = await setup();
  await x.heartbeat(3);
  const legacy = await x.create(); await x.action(legacy.id, 'schedule'); const a = await x.claimed();
  await errorCode(await x.agent(a.id, '/git/prepare', request(preparation)), 409, 'conflict');
  await settings(x, { baseBranch: 'main', syncBeforeStart: true, version: 1 });
  // 领取时项目未配置基准，之后不能自动采用新默认；须由用户显式首次选择。
  expect((await context(x, a.id)).gitSettings).toEqual({ baseBranch: null, syncBeforeStart: true });
  await errorCode(await x.agent(a.id, '/git/prepare', request(preparation)), 409, 'conflict');
  const legacyTask = (await x.detail(legacy.id)).task;
  expect((await x.web(`/tasks/${legacy.id}`, { baseBranch: 'main', version: legacyTask.version }, 'PATCH')).status).toBe(200);
  expect((await x.agent(a.id, '/git/prepare', request(preparation))).status).toBe(200);
  for (const invalid of [{ ...workspace, gitKind: 'primary' }, { ...workspace, gitBranch: 'main' },
    { ...workspace, gitRoot: project.path }, { ...workspace, path: '/unrelated' }]) {
    await errorCode(await x.agent(a.id, '/workspace', request({ workspace: invalid })), 409, 'conflict');
  }
  await errorCode(await x.agent(a.id, '/deliveries', request({ ...delivery, baseCommit, commit })), 409, 'conflict');
  expect((await x.agent(a.id, '/workspace', request({ workspace }))).status).toBe(200);
  for (const invalid of [delivery, { ...delivery, baseCommit: commit, commit }, { ...delivery, baseCommit, commit: 'short' }]) {
    await errorCode(await x.agent(a.id, '/deliveries', request(invalid)), 409, 'conflict');
  }
  const other = await x.create(); await x.action(other.id, 'schedule'); const b = await x.claimed();
  await errorCode(await x.agent(b.id, '/git/prepare', request(preparation)), 409, 'conflict');
  expect((await x.agent(b.id, '/git/prepare', request({ ...preparation, taskBranch: 'feature/other' }))).status).toBe(200);
  await errorCode(await x.agent(b.id, '/workspace', request({ workspace: { ...workspace, gitBranch: 'feature/other' } })), 409, 'conflict');
  const discussion = await x.create('discussion', { type: 'discussion' }); await x.action(discussion.id, 'schedule'); const d = await x.claimed();
  await errorCode(await x.agent(d.id, '/git/prepare', request({ ...preparation, taskBranch: 'feature/discussion' })), 409, 'conflict');
});

it('精确accept后仍review；lease过期不能授权，退出后仅新能力heartbeat发权；merged与complete分阶段且旧重放不发旧权限', async () => {
  const { x, task, attempt, deliveryId } = await accepted();
  let detail = await x.detail(task.id);
  const operationId = detail.task.git!.operationId!;
  expect(detail.task).toMatchObject({ status: 'review', git: { phase: 'awaiting_merge', approvedCommit: commit, deliveryId } });
  expect((await poll(x)).gitOperations).toEqual([]);
  x.advance(c.LEASE_DURATION_MS + 1);
  expect((await poll(x)).gitOperations).toEqual([]);
  await errorCode(await report(x, operationId, request({ outcome: 'merged', mergedCommit: commit })), 409, 'conflict');
  for (const action of ['cancel', 'accept', 'rework']) await errorCode(await x.action(task.id, action, action === 'cancel' ? {} : { deliveryId, ...(action === 'rework' ? { feedback: 'rework' } : {}) }), 409, 'conflict');
  await x.exit(attempt.id);
  expect((await read(c.launcherHeartbeatResponseSchema, await x.heartbeat())).gitOperations).toBeUndefined();
  const heartbeat = pollBody();
  expect((await poll(x, heartbeat)).gitOperations).toMatchObject([{ id: operationId, phase: 'merge', approvedCommit: commit }]);
  await errorCode(await report(x, operationId, request({ outcome: 'merged', mergedCommit: commit }), x.otherToken), 403, 'forbidden');
  await errorCode(await report(x, operationId, request({ outcome: 'complete', mergedCommit: commit })), 409, 'conflict');
  await errorCode(await report(x, operationId, request({ outcome: 'merged' })), 409, 'conflict');
  await errorCode(await report(x, operationId, request({ outcome: 'merged', mergedCommit: baseCommit })), 409, 'conflict');
  const merged = request({ outcome: 'merged', mergedCommit: commit });
  expect((await report(x, operationId, merged)).status).toBe(200);
  expect((await report(x, operationId, merged)).status).toBe(200);
  expect((await poll(x, heartbeat)).gitOperations).toEqual([]);
  expect((await poll(x)).gitOperations).toMatchObject([{ id: operationId, phase: 'cleanup', mergedCommit: commit }]);
  await errorCode(await report(x, operationId, request({ outcome: 'merged', mergedCommit: commit })), 409, 'conflict');
  await errorCode(await report(x, operationId, request({ outcome: 'needs_rework' })), 409, 'conflict');
  expect((await x.detail(task.id)).task.status).toBe('review');
  expect((await report(x, operationId, request({ outcome: 'complete', mergedCommit: commit }))).status).toBe(200);
  detail = await x.detail(task.id);
  expect(detail.task).toMatchObject({ status: 'done', git: { phase: 'complete', mergedCommit: commit } });
  expect(detail.deliveries[0]?.review).toBe('accepted');
  expect((await poll(x, heartbeat)).gitOperations).toEqual([]);
  await errorCode(await x.action(task.id, 'retry-git'), 409, 'conflict');
});

it('阻塞重试换授权ID，旧报告/heartbeat不能推进新操作，cleanup重试保留durable mergedCommit且不再merge', async () => {
  const { x, task, attempt } = await accepted();
  await x.exit(attempt.id);
  const heartbeat = pollBody(); const first = (await poll(x, heartbeat)).gitOperations![0]!;
  expect((await report(x, first.id, request({ outcome: 'blocked', message: 'dirty target' }))).status).toBe(200);
  expect((await x.detail(task.id)).task.git?.phase).toBe('merge_blocked');
  expect((await x.action(task.id, 'retry-git')).status).toBe(200);
  const second = (await poll(x)).gitOperations![0]!;
  expect(second.id).not.toBe(first.id);
  expect(second.phase).toBe('merge');
  expect((await poll(x, heartbeat)).gitOperations).toEqual([]);
  await errorCode(await report(x, first.id, request({ outcome: 'merged', mergedCommit: commit })), 409, 'conflict');
  expect((await report(x, second.id, request({ outcome: 'merged', mergedCommit: commit }))).status).toBe(200);
  expect((await report(x, second.id, request({ outcome: 'blocked', message: 'locked tree' }))).status).toBe(200);
  expect((await x.detail(task.id)).task.git).toMatchObject({ phase: 'cleanup_blocked', mergedCommit: commit });
  expect((await x.action(task.id, 'retry-git')).status).toBe(200);
  const cleanup = (await poll(x)).gitOperations![0]!;
  expect(cleanup).toMatchObject({ phase: 'cleanup', mergedCommit: commit, approvedCommit: commit });
  await errorCode(await report(x, second.id, request({ outcome: 'complete', mergedCommit: commit })), 409, 'conflict');
  expect((await report(x, cleanup.id, request({ outcome: 'complete', mergedCommit: commit }))).status).toBe(200);
  expect((await x.detail(task.id)).task.status).toBe('done');
});

it('needs_rework保留旧验收，原机原会话/root继承，登记后再次context仍定位原现场并携带feedback，重新交付须重新accept', async () => {
  const { x, task, attempt, deliveryId } = await accepted();
  await x.exit(attempt.id);
  const op = (await poll(x)).gitOperations![0]!;
  expect((await report(x, op.id, request({ outcome: 'needs_rework', message: 'base diverged: resolve on original task branch' }))).status).toBe(200);
  expect((await x.detail(task.id)).deliveries[0]).toMatchObject({ id: deliveryId, review: 'accepted' });
  const rework = await x.claimed();
  expect(rework).toMatchObject({ kind: 'rework', restoreSession: true, sessionLocator: { path: workspace.path, sessionId: workspace.sessionId } });
  const first = await context(x, rework.id);
  expect(first.workspace.previous).toMatchObject({ attemptId: attempt.id, sameMachine: true, workspace });
  expect(first.git).toMatchObject({ baseCommit, message: 'base diverged: resolve on original task branch' });
  expect(x.store.get<{ confirmed_git_root: string }>('SELECT confirmed_git_root FROM attempts WHERE id=?', rework.id)?.confirmed_git_root).toBe(workspace.gitRoot);
  await errorCode(await x.agent(rework.id, '/workspace', request({ workspace: { ...workspace, sessionId: 'different' } })), 409, 'conflict');
  expect((await x.agent(rework.id, '/workspace', request({ workspace }))).status).toBe(200);
  const second = await context(x, rework.id);
  expect(second.workspace.previous).toEqual(first.workspace.previous);
  expect(second.git?.phase).toBe('ready');
  expect((await x.agent(rework.id, '/git/prepare', request(preparation))).status).toBe(200);
  const nextCommit = 'c'.repeat(40);
  const next = await read(c.agentDeliveryResponseSchema, await x.agent(rework.id, '/deliveries', request({ ...delivery, baseCommit, commit: nextCommit })));
  await x.exit(rework.id);
  await errorCode(await x.action(task.id, 'accept', { deliveryId }), 409, 'conflict');
  await errorCode(await report(x, op.id, request({ outcome: 'merged', mergedCommit: commit })), 409, 'conflict');
  expect((await poll(x)).gitOperations).toEqual([]);
  expect((await x.action(task.id, 'accept', { deliveryId: next.deliveryId })).status).toBe(200);
  expect((await poll(x)).gitOperations).toMatchObject([{ deliveryId: next.deliveryId, approvedCommit: nextCommit }]);
  expect((await x.detail(task.id)).deliveries.map((d) => d.review)).toEqual(['accepted', 'accepted']);
});

it.each(['restart', 'restore'] as const)('Git任务 %s 替代尝试继承完整工作树证明，无需重新登记即可交付', async (mode) => {
  const { x, task, attempt } = await prepared();
  await x.launcher('/heartbeat', { ...pollBody(), sessionControl: true });
  expect((await x.launcher(`/attempts/${attempt.id}/started`, request({ startedAt: x.now(), tmuxSession: `steward-${attempt.id}` }))).status).toBe(200);
  expect((await x.agent(attempt.id, '/workspace', request({ workspace }))).status).toBe(200);
  if (mode === 'restore') expect((await x.exit(attempt.id)).status).toBe(200);
  const operation = request({ attemptId: attempt.id, mode });
  expect((await x.action(task.id, 'session-operation', operation)).status).toBe(200);
  expect((await x.launcher(`/session-operations/${operation.requestId}/report`, request({ step: 'stop', result: 'stopped' }))).status).toBe(200);
  const resumed = (await x.detail(task.id)).attempts.at(-1)!;
  expect(resumed.kind).toBe('resume');
  expect(x.store.get<{ confirmed_git_root: string }>('SELECT confirmed_git_root FROM attempts WHERE id=?', resumed.id)?.confirmed_git_root).toBe(workspace.gitRoot);
  expect((await x.launcher(`/attempts/${resumed.id}/started`, request({ startedAt: x.now(), tmuxSession: `steward-${resumed.id}` }))).status).toBe(200);
  expect((await x.agent(resumed.id, '/session', request({ locator: { path: workspace.path, sessionId: workspace.sessionId, sessionFile: workspace.sessionFile } }))).status).toBe(200);
  expect((await x.agent(resumed.id, '/deliveries', request({ ...delivery, baseCommit, commit }))).status).toBe(200);
});

it('session操作未完成时不发Git授权且禁止重试，不因超时猜测进程已退出', async () => {
  const { x, task, attempt } = await accepted();
  await x.exit(attempt.id);
  const id = randomUUID();
  x.store.run(`INSERT INTO session_operations (id,task_id,machine_id,source_attempt_id,replacement_id,mode,locator,step,deadline_at)
    VALUES (?,?,?,?,?,'restore',?,'cleanup',?)`, id, task.id, x.machineId, attempt.id, attempt.id,
  JSON.stringify({ path: workspace.path, sessionId: workspace.sessionId, sessionFile: workspace.sessionFile }), x.now() - 1);
  expect((await poll(x)).gitOperations).toEqual([]);
  await errorCode(await x.web(`/tasks/${task.id}/session-operation`, request({ attemptId: attempt.id, mode: 'restore' })), 409, 'conflict');
  x.store.run("UPDATE session_operations SET step='failed', failure='session_timeout' WHERE id=?", id);
  const op = (await poll(x)).gitOperations![0]!;
  await report(x, op.id, request({ outcome: 'blocked' }));
  x.store.run("UPDATE session_operations SET step='cleanup', failure=NULL WHERE id=?", id);
  await errorCode(await x.action(task.id, 'retry-git'), 409, 'conflict');
});
