import { expect, it } from 'vitest';
import * as c from '@pi-steward/contract';
import { delivery, errorCode, project, request, useFixture } from './fixture.js';

const setup = useFixture();
type Fixture = Awaited<ReturnType<typeof setup>>;
const locator = { path: '/work/实际 checkout', sessionId: 'actual-session', sessionFile: '/sessions/actual.jsonl' };
const alternate = { path: '/work/迁移 checkout', sessionId: 'moved-session', sessionFile: '/sessions/moved.jsonl' };
const heartbeatBody = (slots = 1) => request({ launcherVersion: 'test', slots, projects: [project], attempts: [], sessionControl: true });

async function ok(response: Promise<Response>) {
  const result = await response;
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ ok: true });
}
const beat = async (x: Fixture, body = heartbeatBody(), token = x.token) =>
  c.launcherHeartbeatResponseSchema.parse(await (await x.launcher('/heartbeat', body, token)).json());
const startedBody = (x: Fixture, attemptId: string) => request({ startedAt: x.now(), tmuxSession: `steward-${attemptId}` });
const started = (x: Fixture, id: string, body = startedBody(x, id)) => x.launcher(`/attempts/${id}/started`, body);
const session = (x: Fixture, id: string, actual = locator) => x.agent(id, '/session', request({ locator: actual }));
const operation = (x: Fixture, taskId: string, body: object) => x.action(taskId, 'session-operation', body);
const intent = (attemptId: string, mode: 'restart' | 'restore' = 'restart') => ({ ...request(), attemptId, mode });
const report = (x: Fixture, id: string, body: object, token = x.token) => x.launcher(`/session-operations/${id}/report`, body, token);
const stopped = () => request({ step: 'stop', result: 'stopped' });
const failed = (step: 'stop' | 'launch' | 'cleanup', failure: c.SessionOperationFailure) => request({ step, result: 'failed', failure });

async function queue(x: Fixture, type: c.TaskType = 'implementation') {
  const task = await x.create(undefined, { type });
  expect((await x.action(task.id, 'schedule')).status).toBe(200);
  return task.id;
}

async function running(x: Fixture, options: { saved?: boolean; type?: c.TaskType } = {}) {
  await beat(x);
  const taskId = await queue(x, options.type);
  const source = await x.claimed();
  const firstStart = startedBody(x, source.id);
  await ok(started(x, source.id, firstStart));
  if (options.saved !== false) await ok(session(x, source.id));
  return { taskId, source, firstStart };
}

async function replacement(x: Fixture, taskId: string, body: ReturnType<typeof intent>) {
  await ok(operation(x, taskId, body));
  await ok(report(x, body.requestId, stopped()));
  const visible = await x.detail(taskId);
  const next = visible.attempts.at(-1)!;
  expect(next).toMatchObject({ kind: 'resume', machineId: x.machineId });
  expect(visible.sessionOperation).toEqual({ id: body.requestId, attemptId: body.attemptId, mode: body.mode, status: 'pending', failure: null });
  return next.id;
}

it.each(['restart', 'restore'] as const)('resume 交付后的返修继承精确 locator，并可再次 %s', async (mode) => {
  const x = await setup();
  const { taskId, source } = await running(x);
  const moved = { ...alternate, gitKind: 'linked', gitBranch: 'feature/worktree' };
  await ok(x.agent(source.id, '/workspace', request({ workspace: moved })));
  const resumed = await replacement(x, taskId, intent(source.id));
  await ok(started(x, resumed));
  await ok(session(x, resumed, alternate));
  const delivered = c.agentDeliveryResponseSchema.parse(await (await x.agent(resumed, '/deliveries', request(delivery))).json());
  await ok(x.exit(resumed));
  expect((await x.action(taskId, 'rework', { deliveryId: delivered.deliveryId, feedback: '补测' })).status).toBe(200);
  const rework = await x.claimed();
  expect(rework).toMatchObject({ kind: 'rework', sessionId: alternate.sessionId, sessionLocator: alternate, restoreSession: true });
  expect(x.store.get('SELECT workspace_path, confirmed_session_id FROM attempts WHERE id=?', rework.id)).toMatchObject({
    workspace_path: alternate.path, confirmed_session_id: alternate.sessionId,
  });
  await ok(started(x, rework.id));
  await ok(session(x, rework.id, alternate));
  if (mode === 'restore') await ok(x.exit(rework.id));
  const next = intent(rework.id, mode);
  await replacement(x, taskId, next);
  expect((await beat(x)).sessionOperations).toMatchObject([{ step: 'launch', locator: alternate }]);
});

it.each(['started first', 'loaded first'])('同机替换需要 started 和严格匹配的 loaded，顺序：%s', async (order) => {
  const x = await setup();
  const { taskId, source, firstStart } = await running(x);
  // 模拟迁移前确认的 Git 工作区；没有自动定位时，实际定位仍能从旧记录取得。
  x.store.run(`UPDATE attempts SET session_locator=NULL, confirmed_workspace_path=?, confirmed_session_id=?, confirmed_session_file=?,
    confirmed_git_kind='linked', confirmed_git_branch='feature/task' WHERE id=?`, locator.path, locator.sessionId, locator.sessionFile, source.id);
  const body = intent(source.id);
  await ok(operation(x, taskId, body));
  await ok(operation(x, taskId, body));
  await errorCode(await operation(x, taskId, intent(source.id)), 409, 'conflict');
  await errorCode(await operation(x, taskId, { ...body, mode: 'restore' }), 409, 'conflict');
  await errorCode(await x.action(taskId, 'cancel'), 409, 'conflict');
  await errorCode(await x.agent(source.id, '/deliveries', request(delivery)), 409, 'conflict');
  expect((await x.agent(source.id, '/control')).status).toBe(200);
  expect((await x.agent(source.id, '/context')).status).toBe(200);
  expect(await beat(x)).toMatchObject({ sessionOperations: [{ id: body.requestId, step: 'stop', locator, sourceEnded: false, validForMs: 40_000 }] });
  expect((await beat(x, heartbeatBody(), x.otherToken)).sessionOperations).toEqual([]);
  const stopReport = stopped();
  await errorCode(await report(x, body.requestId, stopReport, x.otherToken), 403, 'forbidden');
  // 自然退出先于 stopped，上报和已有旧请求重放不能改变替代执行。
  const sourceExit = request({ exitCode: null, endedAt: x.now() });
  await ok(x.exit(source.id, sourceExit));
  expect((await x.detail(taskId)).task.status).toBe('interrupted');
  await errorCode(await x.action(taskId, 'reschedule'), 409, 'conflict');
  expect((await beat(x)).sessionOperations).toMatchObject([{ step: 'stop', sourceEnded: true }]);
  await ok(report(x, body.requestId, stopReport));
  await ok(report(x, body.requestId, stopReport));
  await ok(started(x, source.id, firstStart));
  await ok(x.exit(source.id, sourceExit));
  await errorCode(await x.exit(source.id), 409, 'attempt_ended');
  const afterStop = await x.detail(taskId);
  expect(afterStop.attempts).toHaveLength(2);
  expect(afterStop.task.status).toBe('running');
  const next = afterStop.attempts.at(-1)!;
  expect(next).toMatchObject({ kind: 'resume', sessionId: locator.sessionId, machineId: x.machineId });
  expect(x.store.get('SELECT kind, session_id, confirmed_git_kind FROM attempts WHERE id=?', next.id)).toMatchObject({
    kind: 'new', session_id: locator.sessionId, confirmed_git_kind: 'linked',
  });
  const context = await x.agent(next.id, '/context');
  expect(context.status).toBe(200);
  expect(c.agentContextResponseSchema.parse(await context.json())).toMatchObject({ attempt: { kind: 'resume' }, workspace: { path: locator.path } });
  expect((await x.agent(next.id, '/control')).status).toBe(200);
  expect(await beat(x)).toMatchObject({ directives: [], sessionOperations: [{ step: 'launch', replacementId: next.id, locator, validForMs: 55_000 }] });
  await errorCode(await x.agent(next.id, '/progress', request({ text: '还未恢复' })), 409, 'conflict');
  for (const mismatch of [{ path: '/wrong' }, { sessionId: 'wrong-id' }, { sessionFile: '/wrong.jsonl' }]) {
    await errorCode(await session(x, next.id, { ...locator, ...mismatch }), 409, 'conflict');
  }
  const acks = order === 'started first' ? [() => started(x, next.id), () => session(x, next.id)]
    : [() => session(x, next.id), () => started(x, next.id)];
  await ok(acks[0]!());
  expect((await x.detail(taskId)).sessionOperation?.status).toBe('pending');
  await ok(acks[1]!());
  await ok(session(x, next.id, alternate));
  const completed = await x.detail(taskId);
  expect(completed.sessionOperation).toMatchObject({ status: 'succeeded', failure: null });
  expect(completed.attempts.at(-1)?.sessionId).toBe(alternate.sessionId);
  const machineDetail = await (await x.send(`/task-management/tasks/${taskId}`, undefined, { machine: x.token })).json();
  expect(machineDetail).not.toHaveProperty('sessionOperation');
  expect(machineDetail.attempts.at(-1)).toMatchObject({ kind: 'new', sessionId: alternate.sessionId });
  await ok(x.agent(next.id, '/progress', request({ text: '已恢复' })));
  expect((await beat(x)).sessionOperations).toEqual([]);
  expect((await beat(x)).directives).toMatchObject([{ attemptId: next.id }]);
  x.advance(120_001);
  expect((await x.detail(taskId)).sessionOperation).toBeUndefined();
  expect((await x.agent(next.id, '/deliveries', request(delivery))).status).toBe(200);
  expect((await x.detail(taskId)).sessionOperation).toBeUndefined();
});

it('没有能力、机器离线、定位缺失均不创建操作；旧启动器不收到新字段', async () => {
  const x = await setup();
  const { taskId, source } = await running(x, { saved: false });
  const body = intent(source.id);
  const legacy = await x.heartbeat();
  expect(await legacy.json()).not.toHaveProperty('sessionOperations');
  await errorCode(await operation(x, taskId, body), 409, 'session_unsupported');
  await beat(x);
  await errorCode(await operation(x, taskId, body), 409, 'session_record_missing');
  await ok(session(x, source.id));
  x.advance(c.MACHINE_ONLINE_WINDOW_MS + 1);
  await beat(x, heartbeatBody(), x.otherToken);
  await errorCode(await operation(x, taskId, body), 409, 'session_machine_offline');
  expect((await x.detail(taskId)).sessionOperation).toBeUndefined();
  await beat(x);
  await ok(operation(x, taskId, body));
});

it('stop 失败保留运行任务；launch 失败中断替代执行，保留原定位供同机恢复和槽位预约', async () => {
  const x = await setup();
  const { taskId, source } = await running(x);
  await ok(x.agent(source.id, '/workspace', request({ workspace: { ...locator, gitKind: 'linked', gitBranch: 'feature/task' } })));
  expect((await x.detail(taskId)).attempts.at(-1)?.sessionId).toBe(locator.sessionId);
  await ok(session(x, source.id, alternate));
  const first = intent(source.id);
  await ok(operation(x, taskId, first));
  await ok(report(x, first.requestId, failed('stop', 'session_stop_failed')));
  expect(await x.detail(taskId)).toMatchObject({ task: { status: 'running' }, sessionOperation: { status: 'failed', failure: 'session_stop_failed' } });
  await ok(x.agent(source.id, '/progress', request({ text: '仍然可用' })));
  const second = intent(source.id);
  const next = await replacement(x, taskId, second);
  expect(x.store.get('SELECT confirmed_git_kind FROM attempts WHERE id=?', next)).toMatchObject({ confirmed_git_kind: null });
  await errorCode(await x.exit(source.id), 409, 'attempt_ended');
  await ok(report(x, second.requestId, failed('launch', 'session_config_unsupported')));
  expect(await x.detail(taskId)).toMatchObject({ task: { status: 'interrupted' }, sessionOperation: { status: 'failed', failure: 'session_config_unsupported' } });
  const retry = intent(next, 'restore');
  const otherTask = await queue(x);
  const other = await x.claimed();
  expect(other.taskId).toBe(otherTask);
  await errorCode(await operation(x, taskId, retry), 409, 'session_slots_full');
  await ok(x.exit(other.id));
  await ok(operation(x, taskId, retry));
  const machines = c.webMachinesResponseSchema.parse(await (await x.web('/machines')).json());
  expect(machines.machines.find(({ id }) => id === x.machineId)).toMatchObject({ occupiedSlots: 1, activeTasks: [{ id: taskId, attemptId: next }] });
  await queue(x);
  const noClaim = await x.claim();
  expect(await noClaim.json()).toEqual({ attempt: null });
  expect((await beat(x)).sessionOperations).toMatchObject([{ id: retry.requestId, step: 'stop', locator: alternate, sourceEnded: true }]);
  await ok(report(x, retry.requestId, stopped()));
  const restored = (await x.detail(taskId)).attempts.at(-1)!;
  expect(restored.sessionId).toBe(alternate.sessionId);
  await ok(started(x, restored.id));
  await ok(session(x, restored.id, alternate));
  expect((await x.detail(taskId)).sessionOperation?.status).toBe('succeeded');
});

it('停止权限随心跳重放缩短，stop 超时后迟到报告不能创建替代执行', async () => {
  const x = await setup();
  const { taskId, source } = await running(x);
  const body = intent(source.id);
  await ok(operation(x, taskId, body));
  const heartbeat = heartbeatBody();
  expect((await beat(x, heartbeat)).sessionOperations).toMatchObject([{ step: 'stop', validForMs: 40_000 }]);
  x.advance(39_000);
  expect((await beat(x, heartbeat)).sessionOperations).toMatchObject([{ step: 'stop', validForMs: 1_000 }]);
  x.advance(6_000);
  expect((await beat(x, heartbeat)).sessionOperations).toEqual([]);
  await errorCode(await report(x, body.requestId, stopped()), 409, 'conflict');
  expect((await x.detail(taskId)).sessionOperation).toMatchObject({ status: 'failed', failure: 'session_timeout' });
  await ok(x.exit(source.id));
  const detail = await x.detail(taskId);
  expect(detail.task.status).toBe('interrupted');
  expect(detail.attempts).toHaveLength(1);
  expect((await x.action(taskId, 'reschedule')).status).toBe(200);
  expect((await x.detail(taskId)).sessionOperation).toBeUndefined();
});

it('启动超时只授予 cleanup，清理确认前保留互斥，迟到 ack 不会产生成功', async () => {
  const x = await setup();
  const { taskId, source } = await running(x);
  const body = intent(source.id);
  const next = await replacement(x, taskId, body);
  const oldHeartbeat = heartbeatBody();
  expect((await beat(x, oldHeartbeat)).sessionOperations).toMatchObject([{ step: 'launch' }]);
  await ok(started(x, next));
  x.advance(60_000);
  expect((await beat(x, oldHeartbeat)).sessionOperations).toEqual([]);
  expect(await beat(x)).toMatchObject({ directives: [], sessionOperations: [{ step: 'cleanup', replacementId: next }] });
  // cleanup 一旦入库，时钟回拨也不恢复 launch 权限。
  x.advance(-10_000);
  expect((await beat(x)).sessionOperations).toMatchObject([{ step: 'cleanup', replacementId: next }]);
  await errorCode(await session(x, next), 409, 'conflict');
  await errorCode(await report(x, body.requestId, failed('launch', 'session_launch_failed')), 409, 'conflict');
  await errorCode(await x.action(taskId, 'reschedule'), 409, 'conflict');
  const cleanup = failed('cleanup', 'session_timeout');
  await ok(report(x, body.requestId, cleanup));
  await ok(report(x, body.requestId, cleanup));
  await errorCode(await started(x, next), 409, 'attempt_ended');
  expect(await x.detail(taskId)).toMatchObject({ task: { status: 'interrupted' }, sessionOperation: { status: 'failed', failure: 'session_timeout' } });
});

it('替代进程去向未知且原 Mac 离线时仍可取消任务，不释放未确认的执行名额', async () => {
  const x = await setup();
  const { taskId, source } = await running(x);
  const body = intent(source.id);
  const next = await replacement(x, taskId, body);
  await errorCode(await x.action(taskId, 'cancel'), 409, 'conflict');
  x.advance(60_000);
  expect((await x.detail(taskId)).sessionOperation).toMatchObject({ status: 'pending', needsExitVerification: true });
  expect((await x.action(taskId, 'cancel')).status).toBe(200);
  expect(await x.detail(taskId)).toMatchObject({ task: { status: 'cancelled' } });
  expect(x.store.get('SELECT cancel_requested, ended_at FROM attempts WHERE id=?', next)).toEqual({ cancel_requested: 1, ended_at: null });
  expect(await beat(x)).toMatchObject({ directives: [], sessionOperations: [{ step: 'cleanup', replacementId: next }] });
  await queue(x);
  expect(await (await x.claim()).json()).toEqual({ attempt: null });
  await ok(report(x, body.requestId, failed('cleanup', 'session_timeout')));
  const detail = await x.detail(taskId);
  expect(detail.task.status).toBe('cancelled');
  expect(detail.attempts.at(-1)?.result).toBe('cancelled');
  expect(await x.claimed()).toBeDefined();
});

it('替代进程正常 exited 已证明进程离开，未加载时直接中断', async () => {
  const x = await setup();
  const { taskId, source } = await running(x);
  const body = intent(source.id);
  const next = await replacement(x, taskId, body);
  await ok(x.exit(next));
  expect(await x.detail(taskId)).toMatchObject({ task: { status: 'interrupted' }, sessionOperation: { status: 'failed', failure: 'session_launch_failed' } });
  await errorCode(await report(x, body.requestId, failed('launch', 'session_launch_failed')), 409, 'conflict');
});

it('讨论结束、已交付、已取消均拒绝开启重启；操作先发生时两端都不能结束讨论', async () => {
  const x = await setup();
  const discussion = await running(x, { type: 'discussion' });
  const body = intent(discussion.source.id);
  const end = () => x.action(discussion.taskId, 'end-discussion', { attemptId: discussion.source.id });
  await ok(operation(x, discussion.taskId, body));
  await errorCode(await end(), 409, 'conflict');
  await errorCode(await x.agent(discussion.source.id, '/end-discussion', request()), 409, 'conflict');
  await ok(report(x, body.requestId, failed('stop', 'session_stop_failed')));
  expect((await end()).status).toBe(200);
  await errorCode(await operation(x, discussion.taskId, intent(discussion.source.id)), 409, 'conflict');
  expect((await x.agent(discussion.source.id, '/deliveries', request(delivery))).status).toBe(200);
  await ok(x.exit(discussion.source.id));
  const delivered = await running(x);
  expect((await x.agent(delivered.source.id, '/deliveries', request(delivery))).status).toBe(200);
  await errorCode(await operation(x, delivered.taskId, intent(delivered.source.id)), 409, 'conflict');
  await ok(x.exit(delivered.source.id));
  const cancelled = await running(x);
  expect((await x.action(cancelled.taskId, 'cancel')).status).toBe(200);
  await errorCode(await operation(x, cancelled.taskId, intent(cancelled.source.id)), 409, 'conflict');
});

it('已中断且未交付的讨论可以恢复，但不继承上一执行的结束请求', async () => {
  const x = await setup();
  const { taskId, source } = await running(x, { type: 'discussion' });
  expect((await x.action(taskId, 'end-discussion', { attemptId: source.id })).status).toBe(200);
  await ok(x.exit(source.id));
  const next = await replacement(x, taskId, intent(source.id, 'restore'));
  await ok(started(x, next));
  await ok(session(x, next));
  const control = c.agentControlResponseSchema.parse(await (await x.agent(next, '/control')).json());
  expect(control.discussionEndRequested).toBe(false);
  expect((await x.detail(taskId)).sessionOperation?.status).toBe('succeeded');
});

it('恢复历史返修的中断尝试仍用 resume 上下文，不触发返修工作区流程', async () => {
  const x = await setup();
  const { taskId, source } = await running(x);
  const response = await x.agent(source.id, '/deliveries', request(delivery));
  const saved = c.agentDeliveryResponseSchema.parse(await response.json());
  await ok(x.exit(source.id));
  expect((await x.action(taskId, 'rework', { deliveryId: saved.deliveryId, feedback: '补充验证' })).status).toBe(200);
  const rework = await x.claimed();
  expect(rework.kind).toBe('rework');
  await ok(session(x, rework.id));
  await ok(x.exit(rework.id));
  const next = await replacement(x, taskId, intent(rework.id, 'restore'));
  const context = c.agentContextResponseSchema.parse(await (await x.agent(next, '/context')).json());
  expect(context.attempt.kind).toBe('resume');
  expect(context.workspace).toMatchObject({ path: locator.path });
  expect(context.workspace).not.toHaveProperty('previous');
  expect(context.deliveries.at(-1)?.review).toBe('rework');
});
