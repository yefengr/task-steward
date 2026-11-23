import { expect, it } from 'vitest';
import * as c from '@pi-steward/contract';
import { project, request, errorCode, useFixture, delivery } from './fixture.js';

const setup = useFixture();
const responseOf = async <T>(schema: { parse: (data: unknown) => T }, response: Response) => schema.parse(await response.json());

it('按显式、上次、单机选路，拒绝未登记项目和 Claude', async () => {
  const x = await setup();
  await x.heartbeat(3);
  await x.heartbeat(3, [project], [], x.otherToken);
  const ambiguous = await x.create('未指定');
  await errorCode(await x.action(ambiguous.id, 'schedule'), 409, 'machine_required');
  const second = await x.create('指定', { machineId: x.otherId });
  await x.action(second.id, 'schedule');
  expect(await responseOf(c.launcherClaimResponseSchema, await x.claim())).toEqual({ attempt: null });
  const { attempt } = await responseOf(c.launcherClaimResponseSchema, await x.claim(request(), x.otherToken));
  expect(attempt?.taskId).toBe(second.id);
  expect((await x.action(ambiguous.id, 'schedule')).status).toBe(200);
  await x.heartbeat(3, [], [], x.otherToken);
  expect((await x.detail(ambiguous.id)).task.waiting).toBe('machine_project_unregistered');
  expect(await responseOf(c.launcherClaimResponseSchema, await x.claim(request(), x.otherToken))).toEqual({ attempt: null });
  expect(await responseOf(c.launcherClaimResponseSchema, await x.claim())).toEqual({ attempt: null });
  await x.heartbeat(3, [project], [], x.otherToken);
  x.advance(c.MACHINE_ONLINE_WINDOW_MS + 1);
  expect((await x.detail(ambiguous.id)).task.waiting).toBe('machine_offline');
  expect(await responseOf(c.launcherClaimResponseSchema, await x.claim(request(), x.otherToken))).toEqual({ attempt: null });
  const projects = await responseOf(c.webProjectsResponseSchema, await x.web('/projects'));
  expect(projects.projects[0]).toMatchObject({ id: project.id, lastMachineId: x.otherId, counts: { queued: 1, running: 1, cancelled: 0 } });
  const machines = await responseOf(c.webMachinesResponseSchema, await x.web('/machines'));
  expect(machines.machines.find(({ id }) => id === x.otherId)).toMatchObject({ online: false, slots: 3, occupiedSlots: 1,
    projects: [{ id: project.id, name: project.name }], activeTasks: [{ id: second.id, attemptId: attempt?.id }] });
  await errorCode(await x.web('/tasks', { projectId: project.id, title: 'Claude', agent: 'claude' }), 400, 'invalid_request');
  x.store.run("UPDATE tasks SET agent='claude' WHERE id=?", ambiguous.id);
  expect(await responseOf(c.launcherClaimResponseSchema, await x.claim(request(), x.otherToken))).toEqual({ attempt: null });
});

it('并发领取只有一次成功，重放领取原结果，保持名额与租约约束', async () => {
  const x = await setup();
  await x.heartbeat(2);
  const first = await x.create();
  await x.action(first.id, 'schedule');
  const ids = [request(), request()];
  const responses = await Promise.all(ids.map(async (r) => ({ r, body: await responseOf(c.launcherClaimResponseSchema, await x.claim(r)) })));
  expect(responses.filter(({ body }) => body.attempt !== null)).toHaveLength(1);
  const winner = responses.find(({ body }) => body.attempt !== null)!;
  const attempt = winner.body.attempt!;
  const tmuxSession = `steward-${attempt.id}`;
  expect(await responseOf(c.launcherClaimResponseSchema, await x.claim(winner.r))).toEqual(winner.body);
  x.advance(c.LEASE_DURATION_MS + 1);
  expect((await x.detail(first.id)).task).toMatchObject({ status: 'running', needsVerification: true });
  expect(await responseOf(c.launcherHeartbeatResponseSchema, await x.heartbeat())).toEqual({ directives: [{ attemptId: attempt.id, tmuxSession, action: 'unknown' }] });
  expect((await x.detail(first.id)).task.needsVerification).toBe(true);
  await x.heartbeat(1, [project], [{ id: attempt.id, tmuxSession, running: false }]);
  expect((await x.detail(first.id)).task.needsVerification).toBe(true);
  expect(await responseOf(c.launcherHeartbeatResponseSchema, await x.heartbeat(1, [project], [{ id: attempt.id, tmuxSession, running: true }])))
    .toEqual({ directives: [{ attemptId: attempt.id, tmuxSession, action: 'continue' }] });
  expect((await x.detail(first.id)).task.needsVerification).toBe(false);
  const second = await x.create('第二个');
  await x.action(second.id, 'schedule');
  expect(await responseOf(c.launcherClaimResponseSchema, await x.claim())).toEqual({ attempt: null });
  await x.exit(attempt.id);
  expect(await responseOf(c.launcherClaimResponseSchema, await x.claim(winner.r))).toEqual(winner.body);
  expect((await x.claimed()).taskId).toBe(second.id);
});

it('幂等绑定操作、载荷、尝试和问题，保留七天', async () => {
  const x = await setup();
  await x.heartbeat(2);
  const task = await x.create('标题', { goal: '目标', acceptance: '验收', notes: '说明' });
  const other = await x.create('其他');
  await x.action(task.id, 'schedule');
  await x.action(other.id, 'schedule');
  const a = await x.claimed();
  const b = await x.claimed();
  const progress = request({ text: '前进' });
  expect((await x.agent(a.id, '/progress', progress)).status).toBe(200);
  expect((await x.agent(a.id, '/progress', progress)).status).toBe(200);
  await errorCode(await x.agent(a.id, '/progress', { ...progress, text: '已更改' }), 409, 'conflict');
  await errorCode(await x.agent(b.id, '/progress', progress), 409, 'conflict');
  await errorCode(await x.claim({ requestId: progress.requestId }), 409, 'conflict');
  await errorCode(await x.agent(a.id, '/decisions', { ...progress, confirmedByUser: true }), 409, 'conflict');
  const question = await responseOf(c.agentCreateQuestionResponseSchema, await x.agent(a.id, '/questions', request({ text: '问题', context: '背景' })));
  const question2 = await responseOf(c.agentCreateQuestionResponseSchema, await x.agent(a.id, '/questions', request({ text: '问题二', context: '背景二' })));
  const closeQuestion = request({ status: 'resolved' });
  await errorCode(await x.agent(b.id, `/questions/${question.questionId}`, closeQuestion, 'PATCH'), 403, 'forbidden');
  expect((await x.agent(a.id, `/questions/${question.questionId}`, closeQuestion, 'PATCH')).status).toBe(200);
  await errorCode(await x.agent(a.id, `/questions/${question2.questionId}`, closeQuestion, 'PATCH'), 409, 'conflict');
  expect((await x.agent(a.id, `/questions/${question.questionId}`, closeQuestion, 'PATCH')).status).toBe(200);
  for (const confirmedByUser of [true, false]) expect((await x.agent(a.id, '/decisions', request({ text: '决定', confirmedByUser }))).status).toBe(200);
  await x.heartbeat(2, []);
  const context = await responseOf(c.agentContextResponseSchema, await x.agent(a.id, '/context'));
  expect(context).toMatchObject({ task: { title: '标题', goal: '目标', acceptance: '验收', notes: '说明' }, workspace: { path: project.path },
    decisions: [{ text: '决定', confirmedByUser: true }], questions: [{ id: question2.questionId }] });
  expect(context.workspace.requirements).not.toHaveLength(0);
  expect((await x.detail(task.id)).task.needsResponse).toBe(false);
  x.advance(c.REPLY_REMINDER_DELAY_MS);
  expect((await x.detail(task.id)).task.needsResponse).toBe(true);
  expect((await x.agent(a.id, `/questions/${question2.questionId}`, request({ status: 'withdrawn' }), 'PATCH')).status).toBe(200);
  expect((await x.detail(task.id)).task.needsResponse).toBe(false);
  expect((await x.detail(task.id)).progress).toHaveLength(1);
  x.advance(7 * 24 * 60 * 60 * 1000);
  expect((await x.agent(a.id, '/progress', progress)).status).toBe(200);
  expect((await x.detail(task.id)).progress).toHaveLength(2);
  expect((await x.agent(a.id, '/deliveries', request(delivery))).status).toBe(200);
});
