import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { foregroundStartResponseSchema, launcherHeartbeatResponseSchema, type ForegroundStartRequest } from '@pi-steward/contract';
import { delivery, project, request, useFixture } from './fixture.js';
const setup = useFixture();
type Fixture = Awaited<ReturnType<typeof setup>>;
const input = (): ForegroundStartRequest => ({ ...request(), goalId: randomUUID(), ownerId: randomUUID(), pid: 12345, projectId: project.id,
  projectName: project.name, registeredPath: project.path, title: '前台目标', goal: '执行', acceptance: '', notes: '',
  type: 'discussion', locator: { path: project.path, sessionId: 'native', sessionFile: '/sessions/native.jsonl' } });
const start = (x: Fixture, body: object, token = x.token) => x.send('/task-management/foreground/start', body, { machine: token });
async function bind(x: Fixture, body: ForegroundStartRequest = input()) {
  const response = await start(x, body);
  expect(response.status).toBe(200);
  return { body, ...foregroundStartResponseSchema.parse(await response.json()).binding };
}
function agent(x: Fixture, b: Awaited<ReturnType<typeof bind>>, path: string, body?: object, owner = b.body.ownerId) {
  return x.send(`/agent${path}`, body, { machine: x.token, attempt: b.attemptId, headers: { 'X-Steward-Owner-Id': owner } });
}
it('离线 start 永久去重，同进程多轮复用绑定，前台不占槽且心跳不接管', async () => {
  const x = await setup(); const b = await bind(x);
  x.advance(8 * 86400_000);
  const retry = await bind(x, { ...b.body, ...request(), title: '不覆盖' });
  expect(retry.attemptId).toBe(b.attemptId);
  expect((await x.detail(b.taskId)).task).toMatchObject({ title: '前台目标', origin: 'foreground', executionMode: 'foreground', needsVerification: true });
  const heartbeat = await x.heartbeat(); expect((await heartbeat.json()).directives).toEqual([]);
  const machines = await (await x.web('/machines')).json();
  expect(machines.machines.find((m: { id: string }) => m.id === x.machineId).occupiedSlots).toBe(0);
  expect(x.store.get('SELECT workspace_path FROM attempts WHERE id=?', b.attemptId)).toMatchObject({ workspace_path: b.body.locator.path });
  expect((await x.agent(b.attemptId, '/context')).status).toBe(403);
  expect((await agent(x, b, '/context')).status).toBe(200);
  expect(JSON.stringify(await x.detail(b.taskId))).not.toContain(b.body.ownerId);
});
it('前台任务使用属性默认值，重绑保留已编辑属性和创建时间', async () => {
  const x = await setup(); const b = await bind(x);
  const task = (await x.detail(b.taskId)).task;
  expect(task).toMatchObject({ priority: 'normal', difficulty: 'unassessed' });
  expect((await x.web(`/tasks/${b.taskId}`, { version: task.version, priority: 'high', difficulty: 'complex' }, 'PATCH')).status).toBe(200);
  x.advance(1_000);
  const next = await bind(x, { ...b.body, ...request(), previousAttemptId: b.attemptId, previousOwnerPid: b.pid });
  expect(next.taskId).toBe(b.taskId);
  expect((await x.detail(b.taskId)).task).toMatchObject({ priority: 'high', difficulty: 'complex', createdAt: task.createdAt, origin: 'foreground' });
});
it('精确源 CAS 恢复拒绝不同 owner 和机器历史权限，缓存不复活旧 attempt', async () => {
  const x = await setup(); const b = await bind(x);
  const progress = request({ text: '进展' });
  expect((await agent(x, b, '/progress', progress)).status).toBe(200);
  expect((await start(x, { ...b.body, ownerId: randomUUID() })).status).toBe(409);
  expect((await x.send('/agent/context', undefined, { machine: x.otherToken, attempt: b.attemptId, headers: { 'X-Steward-Owner-Id': b.body.ownerId } })).status).toBe(403);
  const recovery = { ...b.body, ...request(), ownerId: randomUUID(), pid: 23456, previousAttemptId: b.attemptId, previousOwnerPid: b.pid };
  const next = await bind(x, recovery);
  expect(next.attemptId).not.toBe(b.attemptId);
  expect((await agent(x, b, '/progress', progress)).status).not.toBe(200);
  expect((await start(x, { ...recovery, ownerId: randomUUID(), pid: 34567 })).status).toBe(409);
  expect((await agent(x, next, '/foreground/interrupt', request())).status).toBe(200);
  expect((await agent(x, next, '/context')).status).not.toBe(200);
});
it('后台交接保留槽、封锁前台写回，alive 失败不替换，重试成功只建一个后台源', async () => {
  const x = await setup(); const b = await bind(x);
  await x.launcher('/heartbeat', request({ launcherVersion: 'test', slots: 1, projects: [project], attempts: [], sessionControl: true, foregroundControl: true }));
  const op = request({ attemptId: b.attemptId, mode: 'background' });
  expect((await x.action(b.taskId, 'session-operation', op)).status).toBe(200);
  expect((await x.action(b.taskId, 'session-operation', request({ attemptId: b.attemptId, mode: 'background' }))).status).toBe(409);
  const blocked = [
    await agent(x, b, '/control'),
    await agent(x, b, '/foreground/heartbeat', request()),
    await agent(x, b, '/progress', request({ text: '迟到' })),
    await start(x, b.body),
    await start(x, { ...b.body, ...request() }),
    await agent(x, b, '/foreground/settle', request()),
    await agent(x, b, '/foreground/interrupt', request()),
  ];
  for (const response of blocked) {
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('session_handover_pending');
  }
  expect((await x.detail(b.taskId)).progress).toHaveLength(0);
  expect((await x.detail(b.taskId)).attempts).toHaveLength(1);
  const hb = await x.launcher('/heartbeat', request({ launcherVersion: 'test', slots: 1, projects: [project], attempts: [], sessionControl: true, foregroundControl: true }));
  expect((await hb.json()).sessionOperations[0]).toMatchObject({ mode: 'background', step: 'stop', foregroundOwner: { goalId: b.goalId, pid: b.pid } });
  expect((await x.launcher(`/session-operations/${op.requestId}/report`, request({ step: 'stop', result: 'failed', failure: 'session_source_alive' }))).status).toBe(200);
  expect((await agent(x, b, '/context')).status).toBe(200);
  expect((await agent(x, b, '/foreground/heartbeat', request())).status).toBe(200);
  expect((await agent(x, b, '/progress', request({ text: '仍由原执行继续' }))).status).toBe(200);
  expect((await x.detail(b.taskId)).attempts).toMatchObject([{ id: b.attemptId }]);
  expect((await x.detail(b.taskId)).attempts).toHaveLength(1);
  expect(x.store.get('SELECT goal_id,owner_id,ended_at FROM attempts WHERE id=?', b.attemptId))
    .toMatchObject({ goal_id: b.goalId, owner_id: b.body.ownerId, ended_at: null });
  const retry = request({ attemptId: b.attemptId, mode: 'background' });
  expect((await x.action(b.taskId, 'session-operation', retry)).status).toBe(200);
  const report = request({ step: 'stop', result: 'stopped' });
  expect((await x.launcher(`/session-operations/${retry.requestId}/report`, report)).status).toBe(200);
  expect((await x.launcher(`/session-operations/${retry.requestId}/report`, report)).status).toBe(200);
  const detail = await x.detail(b.taskId);
  expect(detail.attempts).toHaveLength(2);
  expect(detail.task).toMatchObject({ executionMode: 'background', origin: 'foreground' });
  const replacement = detail.attempts.at(-1)!;
  expect((await (await x.agent(replacement.id, '/control')).json()).continuationReady).toBe(false);
  expect((await x.launcher(`/attempts/${replacement.id}/started`, request({ tmuxSession: `steward-${replacement.id}`, startedAt: 100 }))).status).toBe(200);
  expect((await (await x.agent(replacement.id, '/control')).json()).continuationReady).toBe(false);
  expect((await x.agent(replacement.id, '/session', request({ locator: b.body.locator }))).status).toBe(200);
  expect((await (await x.agent(replacement.id, '/control')).json()).continuationReady).toBe(true);
  expect((await agent(x, b, '/context')).status).not.toBe(200);
});
it('lookup 仅返回本机恢复定位，不返回 owner 或授予权限', async () => {
  const x = await setup(); const b = await bind(x);
  const lookup = (machine = x.token) => x.send(`/task-management/foreground/${b.goalId}`, undefined, { machine });
  const response = await lookup(); expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ binding: { goalId: b.goalId, taskId: b.taskId, attemptId: b.attemptId, pid: b.pid } });
  expect(await (await lookup(x.otherToken)).json()).toEqual({ binding: null });
  expect((await x.send(`/task-management/foreground/${b.goalId}`)).status).toBe(401);
  const next = await bind(x, { ...b.body, ...request(), ownerId: randomUUID(), pid: 23456, previousAttemptId: b.attemptId, previousOwnerPid: b.pid });
  expect(await (await lookup()).json()).toMatchObject({ binding: { attemptId: next.attemptId, pid: next.pid } });
  await agent(x, next, '/foreground/interrupt', request());
  expect((await lookup()).status).toBe(200);
  expect((await start(x, next.body)).status).toBe(409);
  expect((await x.agent(next.attemptId, '/context')).status).not.toBe(200);
});
it('start requestId 冲突不创建新目标，旧缓存不授予已结束或已替换权限', async () => {
  const x = await setup(); const b = await bind(x);
  expect((await start(x, b.body)).status).toBe(200);
  expect((await start(x, { ...b.body, goalId: randomUUID() })).status).toBe(409);
  expect((await start(x, { ...b.body, title: '改变正文' })).status).toBe(409);
  expect(x.store.get<{ count: number }>('SELECT COUNT(*) count FROM tasks')?.count).toBe(1);
  const next = await bind(x, { ...b.body, ...request(), ownerId: randomUUID(), pid: 23456, previousAttemptId: b.attemptId, previousOwnerPid: b.pid });
  expect((await start(x, b.body)).status).toBe(409);
  await agent(x, next, '/foreground/interrupt', request());
  expect((await start(x, next.body)).status).toBe(409);
});
it.each(['interrupt', 'settle'] as const)('前台 %s 只允许同 owner 精确关闭回执重放', async (action) => {
  const x = await setup(); const b = await bind(x);
  const progress = request({ text: '关闭前进度' });
  expect((await agent(x, b, '/progress', progress)).status).toBe(200);
  if (action === 'settle') {
    await agent(x, b, '/end-discussion', request());
    expect((await agent(x, b, '/deliveries', request(delivery))).status).toBe(200);
  }
  const close = request();
  expect((await agent(x, b, `/foreground/${action}`, close)).status).toBe(200);
  expect((await agent(x, b, `/foreground/${action}`, close)).status).toBe(200);
  expect((await agent(x, b, `/foreground/${action}`, close, randomUUID())).status).toBe(403);
  expect((await agent(x, b, `/foreground/${action}`, request())).status).toBe(409);
  expect((await agent(x, b, `/foreground/${action === 'settle' ? 'interrupt' : 'settle'}`, close)).status).toBe(409);
  expect((await agent(x, b, `/foreground/${action}`, { ...close, extra: true })).status).toBe(400);
  expect((await agent(x, b, '/progress', progress)).status).toBe(409);
  expect((await agent(x, b, '/context')).status).toBe(action === 'settle' ? 200 : 409);
  if (action === 'settle') expect(await (await agent(x, b, '/context')).json()).toMatchObject({ implementationAllowed: false, recordAllowed: true });
});
it('已确认结束讨论不得改为后台继续', async () => {
  const x = await setup(); const b = await bind(x);
  await x.launcher('/heartbeat', request({ launcherVersion: 'test', slots: 1, projects: [project], attempts: [], sessionControl: true, foregroundControl: true }));
  expect((await agent(x, b, '/end-discussion', request())).status).toBe(200);
  expect((await x.action(b.taskId, 'session-operation', request({ attemptId: b.attemptId, mode: 'background' }))).status).toBe(409);
});
it('未准备 Git 的实施交接不要求手工现场，stop/launch/cleanup 保留 owner', async () => {
  const x = await setup(); const b = await bind(x, { ...input(), type: 'implementation' });
  const beat = () => x.launcher('/heartbeat', request({ launcherVersion: 'test', slots: 1, projects: [project], attempts: [], sessionControl: true, foregroundControl: true }));
  await beat();
  const op = request({ attemptId: b.attemptId, mode: 'background' });
  expect((await x.action(b.taskId, 'session-operation', op)).status).toBe(200);
  const permission = { foregroundOwner: { goalId: b.goalId, pid: b.pid } };
  const stop = launcherHeartbeatResponseSchema.parse(await (await beat()).json());
  expect(stop.sessionOperations?.[0]).toMatchObject({ ...permission, step: 'stop' });
  expect(stop.sessionOperations?.[0]).not.toHaveProperty('foregroundGit');
  expect((await x.launcher(`/session-operations/${op.requestId}/report`, request({ step: 'stop', result: 'stopped' }))).status).toBe(200);
  const launch = launcherHeartbeatResponseSchema.parse(await (await beat()).json());
  expect(launch.sessionOperations?.[0]).toMatchObject({ ...permission, step: 'launch' });
  x.advance(61_000);
  const cleanup = launcherHeartbeatResponseSchema.parse(await (await beat()).json());
  expect(cleanup.sessionOperations?.[0]).toMatchObject({ ...permission, step: 'cleanup' });
});
it('同 PID、同对话 reload 显式替换尝试，旧代回报不能进入新的运行阶段', async () => {
  const x = await setup(); const b = await bind(x);
  const next = await bind(x, { ...b.body, ...request(), previousAttemptId: b.attemptId, previousOwnerPid: b.pid });
  expect(next.taskId).toBe(b.taskId); expect(next.attemptId).not.toBe(b.attemptId);
  expect((await agent(x, b, '/progress', request({ text: '迟到的旧代回报' }))).status).not.toBe(200);
  expect((await start(x, b.body)).status).toBe(409);
  expect((await x.detail(b.taskId)).progress).toHaveLength(0);
});
it('前台迁移使用新尝试封闭旧定位写回，延迟旧 start 或 session 回报不能搬回原目录', async () => {
  const x = await setup(); const b = await bind(x);
  const moved = { ...b.body, ...request(), locator: { path: '/work/linked', sessionId: randomUUID(), sessionFile: '/sessions/linked.jsonl' },
    previousAttemptId: b.attemptId, previousOwnerPid: b.pid };
  const next = await bind(x, moved);
  expect(next.taskId).toBe(b.taskId); expect(next.attemptId).not.toBe(b.attemptId);
  expect((await start(x, { ...b.body, ...request() })).status).toBe(409);
  expect((await start(x, b.body)).status).toBe(409);
  expect((await agent(x, b, '/session', request({ locator: b.body.locator }))).status).not.toBe(200);
  expect(x.store.get('SELECT workspace_path,session_locator FROM attempts WHERE id=?', next.attemptId))
    .toMatchObject({ workspace_path: moved.locator.path, session_locator: JSON.stringify(moved.locator) });
});
it('前台恢复在相同 locator 下继承已确认现场，可再次安全请求后台接续', async () => {
  const x = await setup(); const b = await bind(x, { ...input(), type: 'implementation' });
  const workspace = { ...b.body.locator, gitKind: 'linked', gitBranch: 'feature/foreground' };
  expect((await agent(x, b, '/workspace', request({ workspace }))).status).toBe(200);
  const next = await bind(x, { ...b.body, ...request(), ownerId: randomUUID(), pid: 23456,
    previousAttemptId: b.attemptId, previousOwnerPid: b.pid });
  expect(x.store.get('SELECT confirmed_git_kind,confirmed_git_branch FROM attempts WHERE id=?', next.attemptId))
    .toMatchObject({ confirmed_git_kind: 'linked', confirmed_git_branch: 'feature/foreground' });
  await x.launcher('/heartbeat', request({ launcherVersion: 'test', slots: 1, projects: [project], attempts: [], sessionControl: true, foregroundControl: true }));
  expect((await x.action(b.taskId, 'session-operation', request({ attemptId: next.attemptId, mode: 'background' }))).status).toBe(200);
});
it('前台交付后的后台返修也先核对原进程，失败不自动循环派发，可手动重试', async () => {
  const x = await setup(); const b = await bind(x);
  await agent(x, b, '/end-discussion', request());
  const submitted = await agent(x, b, '/deliveries', request(delivery));
  const delivered = await submitted.json();
  await agent(x, b, '/foreground/settle', request());
  expect((await x.action(b.taskId, 'rework', { deliveryId: delivered.deliveryId, feedback: '继续核对' })).status).toBe(200);
  await x.launcher('/heartbeat', request({ launcherVersion: 'test', slots: 1, projects: [project], attempts: [], sessionControl: true, foregroundControl: true }));
  const claim = await x.launcher('/claim', request());
  expect(await claim.json()).toEqual({ attempt: null });
  expect((await x.detail(b.taskId)).attempts).toHaveLength(1);
  const op = x.store.get<{ id: string }>('SELECT id FROM session_operations WHERE source_attempt_id=?', b.attemptId)!;
  expect((await x.launcher(`/session-operations/${op.id}/report`, request({ step: 'stop', result: 'failed', failure: 'session_source_alive' }))).status).toBe(200);
  await x.launcher('/claim', request());
  expect(x.store.get<{ n: number }>('SELECT COUNT(*) n FROM session_operations')?.n).toBe(1);
  const retry = request({ attemptId: b.attemptId, mode: 'background' });
  expect((await x.action(b.taskId, 'session-operation', retry)).status).toBe(200);
  expect((await x.launcher(`/session-operations/${retry.requestId}/report`, request({ step: 'stop', result: 'stopped' }))).status).toBe(200);
  const detail = await x.detail(b.taskId);
  expect(detail.task).toMatchObject({ status: 'running', executionMode: 'background', origin: 'foreground', reworkPending: false });
  expect(detail.attempts.at(-1)).toMatchObject({ kind: 'rework', sessionId: b.body.locator.sessionId });
  expect((await (await x.agent(detail.attempts.at(-1)!.id, '/context')).json()).attempt.kind).toBe('rework');
});
it('未准备 Git 的前台返修无需手工登记即可进入原会话交接，不阻塞其它任务', async () => {
  const x = await setup(); const b = await bind(x, { ...input(), type: 'implementation' });
  const submitted = await (await agent(x, b, '/deliveries', request(delivery))).json();
  await agent(x, b, '/foreground/settle', request());
  await x.action(b.taskId, 'rework', { deliveryId: submitted.deliveryId, feedback: '继续' });
  await x.launcher('/heartbeat', request({ launcherVersion: 'test', slots: 2, projects: [project], attempts: [], sessionControl: true, foregroundControl: true }));
  const other = await x.create('不受阻的独立任务', { machineId: x.machineId });
  await x.action(other.id, 'schedule');
  const response = await x.launcher('/claim', request());
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ attempt: null });
  const operation = x.store.get<{ source_attempt_id: string; step: string }>('SELECT * FROM session_operations WHERE task_id=?', b.taskId);
  expect(operation).toMatchObject({ source_attempt_id: b.attemptId, step: 'stop' });
  expect((await (await x.launcher('/claim', request())).json()).attempt.taskId).toBe(other.id);
  expect((await x.detail(b.taskId)).task.status).toBe('queued');
});
it('真实失权状态优先于临时交接错误，返修排队不能被 stop 核对遮蔽', async () => {
  const x = await setup(); const b = await bind(x);
  await agent(x, b, '/end-discussion', request());
  const submitted = await (await agent(x, b, '/deliveries', request(delivery))).json();
  expect((await x.action(b.taskId, 'rework', { deliveryId: submitted.deliveryId, feedback: '只允许新一轮返修' })).status).toBe(200);
  await x.launcher('/heartbeat', request({ launcherVersion: 'test', slots: 1, projects: [project], attempts: [], sessionControl: true, foregroundControl: true }));
  expect((await x.action(b.taskId, 'session-operation', request({ attemptId: b.attemptId, mode: 'background' }))).status).toBe(200);
  for (const response of [await agent(x, b, '/control'), await agent(x, b, '/progress', request({ text: '旧轮不得实施' })),
    await start(x, { ...b.body, ...request() })]) {
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('conflict');
  }
  expect((await x.detail(b.taskId)).attempts).toHaveLength(1);
});
it.each(['accept', 'rework'] as const)('用户先%s也允许原 owner 仅结算关闭，不重新开放实施权限', async (action) => {
  const x = await setup(); const b = await bind(x);
  await agent(x, b, '/end-discussion', request());
  const submitted = await (await agent(x, b, '/deliveries', request(delivery))).json();
  expect((await x.action(b.taskId, action, { deliveryId: submitted.deliveryId, ...(action === 'rework' ? { feedback: '再核对' } : {}) })).status).toBe(200);
  const status = (await x.detail(b.taskId)).task.status;
  expect((await agent(x, b, '/foreground/settle', request())).status).toBe(200);
  const detail = await x.detail(b.taskId);
  expect(detail.task.status).toBe(status);
  expect(detail.attempts[0]?.result).toBe('delivered');
  expect((await agent(x, b, '/context')).status).not.toBe(200);
});
it('取消后的原 owner 只能确认关闭，不能修改任务或恢复实施', async () => {
  const x = await setup(); const b = await bind(x);
  expect((await x.action(b.taskId, 'cancel')).status).toBe(200);
  expect((await agent(x, b, '/progress', request({ text: '不允许' }))).status).not.toBe(200);
  expect((await agent(x, b, '/foreground/interrupt', request())).status).toBe(200);
  const detail = await x.detail(b.taskId);
  expect(detail.task.status).toBe('cancelled'); expect(detail.attempts[0]?.result).toBe('cancelled');
});
it('更换 goalId 不能在另一任务仍占用的原生对话中取得第二份执行权', async () => {
  const x = await setup(); const b = await bind(x);
  const conflict = await start(x, { ...b.body, ...request(), goalId: randomUUID() });
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).error.code).toBe('session_in_use');
  expect(x.store.get<{ n: number }>('SELECT COUNT(*) n FROM tasks')?.n).toBe(1);
});
it('交接窗口预留整个原生会话，不能换目标绕过；失败后旧关联仍保留', async () => {
  const x = await setup(); const b = await bind(x);
  await agent(x, b, '/foreground/interrupt', request());
  await x.launcher('/heartbeat', request({ launcherVersion: 'test', slots: 1, projects: [project], attempts: [], sessionControl: true, foregroundControl: true }));
  const op = request({ attemptId: b.attemptId, mode: 'background' });
  expect((await x.action(b.taskId, 'session-operation', op)).status).toBe(200);
  const blocked = await start(x, { ...b.body, ...request(), goalId: randomUUID() });
  expect(blocked.status).toBe(409); expect((await blocked.json()).error.code).toBe('session_in_use');
  await x.launcher(`/session-operations/${op.requestId}/report`, request({ step: 'stop', result: 'failed', failure: 'session_source_alive' }));
  const other = await bind(x, { ...b.body, ...request(), goalId: randomUUID() });
  const restoreOld = await start(x, { ...b.body, ...request(), previousAttemptId: b.attemptId, previousOwnerPid: b.pid });
  expect(restoreOld.status).toBe(409); expect((await restoreOld.json()).error.code).toBe('session_in_use');
  expect((await x.detail(other.taskId)).attempts).toHaveLength(1);
});
it('定位或现场更新不能指向另一项活跃任务使用的原生会话', async () => {
  const x = await setup(); const a = await bind(x);
  const second = input(); second.locator = { ...second.locator, sessionId: randomUUID(), sessionFile: '/sessions/other.jsonl' };
  await bind(x, second);
  expect((await agent(x, a, '/session', request({ locator: second.locator }))).status).toBe(409);
  expect((await agent(x, a, '/workspace', request({ workspace: { ...second.locator, gitKind: 'non_git', gitBranch: null } }))).status).toBe(409);
  expect(x.store.get<{ session_locator: string }>('SELECT session_locator FROM attempts WHERE id=?', a.attemptId)?.session_locator).toBe(JSON.stringify(a.body.locator));
});
it('交付后的前台只能 settle，不可用 start 复活，待验收不变', async () => {
  const x = await setup(); const b = await bind(x);
  expect((await agent(x, b, '/deliveries', request(delivery))).status).toBe(409);
  expect((await agent(x, b, '/end-discussion', request())).status).toBe(200);
  expect((await agent(x, b, '/deliveries', request(delivery))).status).toBe(200);
  expect((await start(x, b.body)).status).toBe(409);
  expect((await agent(x, b, '/foreground/settle', request())).status).toBe(200);
  expect((await x.detail(b.taskId)).task.status).toBe('review');
});
