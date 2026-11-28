import { expect, it } from 'vitest';
import * as c from '@pi-steward/contract';
import { project, request, errorCode, useFixture, delivery } from './fixture.js';

const setup = useFixture();
const responseOf = async <T>(schema: { parse: (data: unknown) => T }, response: Response) => schema.parse(await response.json());
const workspace: c.AttemptWorkspace = {
  path: '/private/first/worktree', gitKind: 'linked', gitBranch: 'feature/local',
  sessionId: 'actual-pi-session', sessionFile: '/private/first/pi/session.jsonl',
};

async function returnForRework(x: Awaited<ReturnType<typeof setup>>, taskId: string, attemptId: string) {
  const { deliveryId } = await responseOf(c.agentDeliveryResponseSchema, await x.agent(attemptId, '/deliveries', request(delivery)));
  expect((await x.exit(attemptId)).status).toBe(200);
  expect((await x.action(taskId, 'rework', { deliveryId, feedback: '补充验收' })).status).toBe(200);
}

it.each([false, true])('未准备 Git 且未登记现场的后台返修可直接接续原会话，原进程保留=%s', async (retained) => {
  const x = await setup(); await x.heartbeat();
  const title = '包含标点「A～F」的任务';
  const task = await x.create(title); await x.action(task.id, 'schedule');
  const first = await x.claimed(); expect(first).not.toHaveProperty('title');
  const locator = { path: project.path, sessionId: first.sessionId, sessionFile: '/sessions/no-git.jsonl' };
  expect((await x.agent(first.id, '/session', request({ locator }))).status).toBe(200);
  const submitted = await responseOf(c.agentDeliveryResponseSchema, await x.agent(first.id, '/deliveries', request(delivery)));
  expect((await x.agent(first.id, '/settle', request())).status).toBe(200);
  if (!retained) await x.exit(first.id);
  await x.action(task.id, 'rework', { deliveryId: submitted.deliveryId, feedback: '补充分析' });
  const response = await responseOf(c.launcherClaimResponseSchema, await x.claim());
  if (retained) {
    expect(response.attempt).toBeNull();
    expect(await (await x.agent(first.id, '/context')).json()).toMatchObject({ implementationAllowed: true, workRevision: 1 });
  } else {
    expect(response.attempt).toMatchObject({ kind: 'rework', sessionLocator: locator });
  }
});

it.each([undefined, '0'])('未声明标题能力时保持 0.4.1 严格领取响应，升级重放仍只领取一次（%s）', async (capability) => {
  const x = await setup(); await x.heartbeat();
  const title = '任务原始标题「A～F」';
  const task = await x.create(title); await x.action(task.id, 'schedule');
  const input = request();
  const headers: Record<string, string> = capability === undefined ? {} : { [c.LAUNCHER_TASK_TITLE_HEADER]: capability };
  const oldSchema = c.launcherClaimResponseSchema.extend({ attempt: c.claimedAttemptSchema.omit({ title: true }).nullable() });
  const legacy = await x.send('/launcher/claim', input, { machine: x.token, headers });
  expect(legacy.status).toBe(200);
  const saved = oldSchema.parse(await legacy.json());
  expect(saved.attempt).not.toHaveProperty('title');
  const upgraded = await x.send('/launcher/claim', input, { machine: x.token, headers: { [c.LAUNCHER_TASK_TITLE_HEADER]: '1' } });
  expect(upgraded.status).toBe(200);
  expect(c.launcherClaimResponseSchema.parse(await upgraded.json()).attempt).toEqual({ ...saved.attempt, title });
  const replay = await x.send('/launcher/claim', input, { machine: x.token });
  expect(oldSchema.parse(await replay.json())).toEqual(saved);
  expect((await x.detail(task.id)).attempts).toHaveLength(1);
});

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
  expect(await responseOf(c.launcherHeartbeatResponseSchema, await x.heartbeat())).toEqual({ directives: [{ attemptId: attempt.id, tmuxSession, action: 'unknown', occupiesSlot: true, workSettled: false }] });
  expect((await x.detail(first.id)).task.needsVerification).toBe(true);
  await x.heartbeat(1, [project], [{ id: attempt.id, tmuxSession, running: false }]);
  expect((await x.detail(first.id)).task.needsVerification).toBe(true);
  expect(await responseOf(c.launcherHeartbeatResponseSchema, await x.heartbeat(1, [project], [{ id: attempt.id, tmuxSession, running: true }])))
    .toEqual({ directives: [{ attemptId: attempt.id, tmuxSession, action: 'continue', occupiesSlot: true, workSettled: false }] });
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

it('实际现场仅由所属机器的运行中实施尝试确认，可更新且重放不回滚', async () => {
  const x = await setup();
  await x.heartbeat(2);
  const task = await x.create();
  await x.action(task.id, 'schedule');
  const a = await x.claimed();
  const first = request({ workspace });
  const updated = { ...workspace, path: '/private/updated/worktree' };
  await errorCode(await x.send('/agent/workspace', first, { machine: x.otherToken, attempt: a.id }), 403, 'forbidden');
  await errorCode(await x.agent(a.id, '/workspace', request({ workspace: { ...workspace, path: 'relative' } })), 400, 'invalid_request');
  expect(await responseOf(c.okResponseSchema, await x.agent(a.id, '/workspace', first))).toEqual({ ok: true });
  expect((await x.agent(a.id, '/workspace', request({ workspace: updated }))).status).toBe(200);
  expect((await x.agent(a.id, '/workspace', first)).status).toBe(200);
  await errorCode(await x.agent(a.id, '/workspace', { ...first, workspace: updated }), 409, 'conflict');
  expect(x.store.get('SELECT * FROM attempts WHERE id=?', a.id)).toMatchObject({ workspace_path: updated.path, session_id: updated.sessionId,
    confirmed_workspace_path: updated.path, confirmed_git_kind: updated.gitKind, confirmed_git_branch: updated.gitBranch,
    confirmed_session_id: updated.sessionId, confirmed_session_file: updated.sessionFile });
  const context = await responseOf(c.agentContextResponseSchema, await x.agent(a.id, '/context'));
  expect(context.workspace.path).toBe(updated.path);
  expect(context.workspace).not.toHaveProperty('previous');
  expect(context.workspace.requirements.join(' ')).toContain('Do not create a branch or worktree for read-only work.');
  const web = await (await x.web(`/tasks/${task.id}`)).text();
  const { sessionId, ...privateWorkspace } = updated;
  for (const value of Object.values(privateWorkspace)) expect(web).not.toContain(value);
  const detail = await x.detail(task.id);
  expect(detail.attempts[0]?.sessionId).toBe(sessionId);
  expect(detail.events.map(({ kind }) => kind)).not.toContain('workspace');

  expect((await x.agent(a.id, '/deliveries', request(delivery))).status).toBe(200);
  await errorCode(await x.agent(a.id, '/workspace', request({ workspace })), 409, 'conflict');
  await errorCode(await x.agent(a.id, '/workspace', first), 409, 'conflict');
  expect((await x.exit(a.id)).status).toBe(200);
  await errorCode(await x.agent(a.id, '/workspace', request({ workspace })), 409, 'attempt_ended');
  await errorCode(await x.agent(a.id, '/workspace', first), 409, 'attempt_ended');

  const discussion = await x.create('讨论', { type: 'discussion' });
  await x.action(discussion.id, 'schedule');
  const b = await x.claimed();
  await errorCode(await x.agent(b.id, '/workspace', request({ workspace })), 409, 'conflict');
  const discussionContext = await responseOf(c.agentContextResponseSchema, await x.agent(b.id, '/context'));
  expect(discussionContext.workspace).not.toHaveProperty('previous');
  expect(discussionContext.workspace.requirements.join(' ')).not.toContain('worktree');
});

it('同机返修和中断后重排均指向被退回的交付，不使用中断尝试的现场', async () => {
  const x = await setup();
  await x.heartbeat();
  const task = await x.create();
  await x.action(task.id, 'schedule');
  const a = await x.claimed();
  const detached = { ...workspace, gitBranch: null };
  expect((await x.agent(a.id, '/workspace', request({ workspace: detached }))).status).toBe(200);
  await returnForRework(x, task.id, a.id);
  const b = await x.claimed();
  expect(b).toMatchObject({ kind: 'rework', sessionId: detached.sessionId, sessionLocator: {
    path: detached.path, sessionId: detached.sessionId, sessionFile: detached.sessionFile,
  }, restoreSession: true });
  const previous = { attemptId: a.id, machineId: x.machineId, sameMachine: true, workspace: detached };
  expect((await responseOf(c.agentContextResponseSchema, await x.agent(b.id, '/context'))).workspace.previous).toEqual(previous);
  expect((await x.agent(b.id, '/workspace', request({ workspace: { ...workspace, path: '/interrupted/worktree' } }))).status).toBe(200);
  expect((await x.exit(b.id)).status).toBe(200);
  expect((await x.action(task.id, 'reschedule')).status).toBe(200);
  const resumed = await x.claimed();
  expect(resumed).toMatchObject({ kind: 'new', restoreSession: false });
  expect((await responseOf(c.agentContextResponseSchema, await x.agent(resumed.id, '/context'))).workspace.previous).toEqual(previous);

  expect((await x.agent(resumed.id, '/deliveries', request(delivery))).status).toBe(200);
  expect((await responseOf(c.agentContextResponseSchema, await x.agent(resumed.id, '/context'))).workspace).not.toHaveProperty('previous');
});

it('最新交付 locator 优先于旧 confirmed，不从更早交付猜测缺失定位', async () => {
  const x = await setup();
  await x.heartbeat();
  const task = await x.create();
  await x.action(task.id, 'schedule');
  const a = await x.claimed();
  expect((await x.agent(a.id, '/workspace', request({ workspace }))).status).toBe(200);
  const actual = { path: '/actual/worktree', sessionId: 'forked-session', sessionFile: '/sessions/forked.jsonl' };
  expect((await x.agent(a.id, '/session', request({ locator: actual }))).status).toBe(200);
  await returnForRework(x, task.id, a.id);
  const b = await x.claimed();
  expect(b).toMatchObject({ sessionLocator: actual, sessionId: actual.sessionId });
  expect(x.store.get('SELECT confirmed_session_id FROM attempts WHERE id=?', b.id)).toEqual({ confirmed_session_id: null });
  // 最新交付缺失定位时，即使上一轮完整，也不允许回退。
  x.store.run('UPDATE attempts SET session_locator=NULL WHERE id=?', b.id);
  await returnForRework(x, task.id, b.id);
  await errorCode(await x.claim(), 409, 'session_record_missing');
});

it.each([{ sameMachine: true, recorded: false }, { sameMachine: false, recorded: true }])(
  '没有可用本机现场时只返回尝试与机器归属：%j', async ({ sameMachine, recorded }) => {
    const x = await setup();
    const otherProject = { ...project, path: '/other/registered/project' };
    await x.heartbeat();
    await x.heartbeat(1, [otherProject], [], x.otherToken);
    const task = await x.create('返修', { machineId: x.machineId });
    await x.action(task.id, 'schedule');
    const a = await x.claimed();
    if (recorded) expect((await x.agent(a.id, '/workspace', request({ workspace }))).status).toBe(200);
    await returnForRework(x, task.id, a.id);
    if (!sameMachine) {
      const { version } = (await x.detail(task.id)).task;
      expect((await x.web(`/tasks/${task.id}`, { machineId: x.otherId, version }, 'PATCH')).status).toBe(200);
    }
    const machine = sameMachine ? x.token : x.otherToken;
    await errorCode(await x.claim(request(), machine), 409, 'session_record_missing');
    expect((await x.detail(task.id)).task.status).toBe('queued');
    const ordinary = await x.create('不被缺定位返修阻塞', { machineId: sameMachine ? x.machineId : x.otherId });
    expect((await x.action(ordinary.id, 'schedule')).status).toBe(200);
    const result = await responseOf(c.launcherClaimResponseSchema, await x.claim(request(), machine));
    expect(result.attempt).toMatchObject({ taskId: ordinary.id, kind: 'new', restoreSession: false });
    expect(result.attempt).not.toHaveProperty('sessionLocator');
    expect((await x.detail(task.id)).attempts).toHaveLength(1);
    expect((await x.detail(task.id)).task.status).toBe('queued');
  },
);
