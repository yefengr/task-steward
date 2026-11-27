import { expect, it } from 'vitest';
import * as c from '@pi-steward/contract';
import { delivery, errorCode, project, request, useFixture } from './fixture.js';

const setup = useFixture();
const taskOf = async (response: Response) => c.webTaskMutationResponseSchema.parse(await response.json()).task;

it('web 与 managed 属性创建、独立更新、省略保留、重放和非法枚举', async () => {
  const f = await setup();
  await f.heartbeat();
  const defaults = await f.create();
  expect(defaults).toMatchObject({ priority: 'normal', difficulty: 'unassessed' });
  const web = await f.create('Web', { priority: 'high', difficulty: 'complex', machineId: f.machineId });
  const auth = { machine: f.token };
  const input = request({ projectId: project.id, title: 'Managed', priority: 'low', difficulty: 'simple', sessionId: 'session' });
  const managed = await taskOf(await f.send('/task-management/tasks', input, auth));
  expect(managed).toMatchObject({ priority: 'low', difficulty: 'simple', status: 'unscheduled' });
  expect(await taskOf(await f.send('/task-management/tasks', input, auth))).toEqual(managed);
  const path = `/tasks/${web.id}`;
  const changed = await taskOf(await f.web(path, { version: web.version, difficulty: 'medium' }, 'PATCH'));
  expect(changed).toMatchObject({ priority: 'high', difficulty: 'medium', createdAt: web.createdAt, machineId: web.machineId });
  const patch = request({ version: changed.version, priority: 'low', sessionId: 'session' });
  const updated = await taskOf(await f.send(`/task-management${path}`, patch, { ...auth, method: 'PATCH' }));
  expect(updated).toMatchObject({ priority: 'low', difficulty: 'medium', status: 'unscheduled', agent: 'pi', machineId: f.machineId });
  expect(await taskOf(await f.send(`/task-management${path}`, patch, { ...auth, method: 'PATCH' }))).toEqual(updated);
  await errorCode(await f.web(path, { version: changed.version, priority: 'high' }, 'PATCH'), 409, 'conflict');
  const renamed = await taskOf(await f.web(path, { version: updated.version, title: 'Renamed' }, 'PATCH'));
  expect(renamed).toMatchObject({ priority: 'low', difficulty: 'medium' });
  for (const bad of [{ priority: 'urgent' }, { difficulty: 'hard' }]) {
    await errorCode(await f.web('/tasks', { projectId: project.id, title: 'Bad', ...bad }), 400, 'invalid_request');
    await errorCode(await f.web(path, { version: renamed.version, ...bad }, 'PATCH'), 400, 'invalid_request');
    await errorCode(await f.send('/task-management/tasks', { ...input, ...bad, requestId: request().requestId }, auth), 400, 'invalid_request');
    await errorCode(await f.send(`/task-management${path}`, request({ version: renamed.version, sessionId: 's', ...bad }),
      { ...auth, method: 'PATCH' }), 400, 'invalid_request');
  }
  expect((await f.detail(web.id)).attempts).toEqual([]);
  expect(c.launcherClaimResponseSchema.parse(await (await f.claim()).json()).attempt).toBeNull();
});

it('两属性与基准分支共同创建编辑，开工冻结 Git 后仍可独立改属性', async () => {
  const f = await setup();
  await f.heartbeat();
  expect((await f.web(`/projects/${project.id}/git`, {
    baseBranch: 'main', syncBeforeStart: false, version: 1,
  }, 'PATCH')).status).toBe(200);
  const auth = { machine: f.token };
  const task = await taskOf(await f.send('/task-management/tasks', request({
    projectId: project.id, title: 'Coexist', sessionId: 'session',
    baseBranch: 'release', priority: 'low', difficulty: 'simple',
  }), auth));
  expect(task).toMatchObject({ baseBranch: 'release', priority: 'low', difficulty: 'simple' });
  const path = `/tasks/${task.id}`;
  const changed = await taskOf(await f.send(`/task-management${path}`, request({
    version: task.version, sessionId: 'session', baseBranch: 'stable', priority: 'high', difficulty: 'medium',
  }), { ...auth, method: 'PATCH' }));
  expect(changed).toMatchObject({ baseBranch: 'stable', priority: 'high', difficulty: 'medium' });
  await f.action(task.id, 'schedule');
  const attempt = await f.claimed();
  expect((await f.agent(attempt.id, '/git/prepare', request({
    baseBranch: 'stable', baseCommit: 'a'.repeat(40), taskBranch: 'feature/coexist',
    repositoryPath: project.path, syncBeforeStart: false, syncResult: 'disabled',
  }))).status).toBe(200);
  const before = await f.detail(task.id);
  expect(before.task.git).toMatchObject({ baseBranch: 'stable', syncBeforeStart: false, phase: 'prepared' });
  const gitContext = c.agentContextResponseSchema.parse(await (await f.agent(attempt.id, '/context')).json());
  const updated = await taskOf(await f.web(path, {
    version: before.task.version, priority: 'normal', difficulty: 'complex',
  }, 'PATCH'));
  expect(updated).toMatchObject({ baseBranch: 'stable', priority: 'normal', difficulty: 'complex', createdAt: task.createdAt });
  const managed = await taskOf(await f.send(`/task-management${path}`, request({
    version: updated.version, sessionId: 'session', priority: 'low',
  }), { ...auth, method: 'PATCH' }));
  expect(managed).toMatchObject({ baseBranch: 'stable', priority: 'low', difficulty: 'complex' });
  await errorCode(await f.send(`/task-management${path}`, request({
    version: managed.version, sessionId: 'session', baseBranch: 'other', priority: 'high',
  }), { ...auth, method: 'PATCH' }), 409, 'conflict');
  const after = await f.detail(task.id);
  expect(after.task).toEqual(managed);
  expect(after.task.git).toEqual(before.task.git);
  expect(after.attempts).toEqual(before.attempts);
  const context = c.agentContextResponseSchema.parse(await (await f.agent(attempt.id, '/context')).json());
  expect(context.gitSettings).toEqual(gitContext.gitSettings);
  expect(context.git).toEqual(gitContext.git);
});

it('领取比较优先级，同级保留 position、created_at、id 兜底，列表顺序不变', async () => {
  const f = await setup();
  await f.heartbeat(10);
  const low = await f.create('Low', { priority: 'low' });
  const normal = await f.create('Normal');
  const high = await f.create('High', { priority: 'high', difficulty: 'complex' });
  for (const task of [low, normal, high]) await f.action(task.id, 'schedule');
  const list = c.webProjectTasksResponseSchema.parse(await (await f.web(`/projects/${project.id}/tasks`)).json());
  expect(list.tasks.map((t) => t.id)).toEqual([low.id, normal.id, high.id]);
  for (const task of [high, normal, low]) expect((await f.claimed()).taskId).toBe(task.id);
  const projects = ['A', 'B', 'C', 'D'].map((name) => ({ id: `tie-${name}`, name, path: `/work/${name}` }));
  await f.heartbeat(10, [project, ...projects]);
  const tied = await Promise.all(projects.map((p) => f.create(p.name, { projectId: p.id })));
  const ids = tied.map((t) => t.id).sort();
  for (const task of tied) await f.action(task.id, 'schedule');
  for (const id of ids) f.store.run('UPDATE tasks SET position=10, created_at=200 WHERE id=?', id);
  f.store.run('UPDATE tasks SET position=9, created_at=999 WHERE id=?', ids[3]!);
  f.store.run('UPDATE tasks SET created_at=100 WHERE id=?', ids[2]!);
  for (const id of [ids[3], ids[2], ids[0], ids[1]]) expect((await f.claimed()).taskId).toBe(id);
});

it('排队后提高优先级会改变下一次领取，更新本身不启动任务', async () => {
  const f = await setup();
  await f.heartbeat(3);
  const first = await f.create('Earlier normal');
  const promoted = await f.create('Later low', { priority: 'low' });
  for (const task of [first, promoted]) expect((await f.action(task.id, 'schedule')).status).toBe(200);
  const queued = await f.detail(promoted.id);
  const updated = await taskOf(await f.web(`/tasks/${promoted.id}`, {
    version: queued.task.version, priority: 'high',
  }, 'PATCH'));
  expect(updated).toMatchObject({ status: 'queued', priority: 'high', position: promoted.position });
  expect((await f.detail(promoted.id)).attempts).toEqual([]);
  expect((await f.claimed()).taskId).toBe(promoted.id);
  expect((await f.claimed()).taskId).toBe(first.id);
});

it.each(['machine_mismatch', 'project_unregistered', 'active_attempt'] as const)(
  '高优先级不能绕过现有资格过滤，低优先级可领取：%s', async (reason) => {
    const f = await setup();
    const extra = { id: 'extra', name: 'Extra', path: '/work/extra' };
    await f.heartbeat(3, [project, extra]);
    await f.heartbeat(3, [project], [], f.otherToken);
    const high = await f.create('Ineligible high', {
      priority: 'high', projectId: reason === 'project_unregistered' ? extra.id : project.id,
      machineId: reason === 'machine_mismatch' ? f.otherId : f.machineId,
    });
    expect((await f.action(high.id, 'schedule')).status).toBe(200);
    if (reason === 'project_unregistered') await f.heartbeat(3, [project]);
    if (reason === 'active_attempt') {
      const old = await f.claimed();
      expect(old.taskId).toBe(high.id);
      const { deliveryId } = c.agentDeliveryResponseSchema.parse(
        await (await f.agent(old.id, '/deliveries', request(delivery))).json());
      // 交付被退回但进程尚未退出时，任务已排队，原尝试仍占用名额。
      expect((await f.action(high.id, 'rework', { deliveryId, feedback: 'Fix' })).status).toBe(200);
    }
    const before = await f.detail(high.id);
    expect(before.task.status).toBe('queued');
    const low = await f.create('Eligible low', { priority: 'low', machineId: f.machineId });
    expect((await f.action(low.id, 'schedule')).status).toBe(200);
    expect((await f.claimed()).taskId).toBe(low.id);
    expect(c.launcherClaimResponseSchema.parse(await (await f.claim()).json()).attempt).toBeNull();
    const after = await f.detail(high.id);
    expect(after.task).toEqual(before.task);
    expect(after.attempts).toEqual(before.attempts);
  },
);

it('属性更新不抢占、不路由、不改变运行尝试；原名额限制保持', async () => {
  const f = await setup();
  await f.heartbeat();
  const running = await f.create('Running', { priority: 'low', machineId: f.machineId });
  await f.action(running.id, 'schedule');
  const attempt = await f.claimed();
  const before = await f.detail(running.id);
  const updated = await taskOf(await f.web(`/tasks/${running.id}`, {
    version: before.task.version, priority: 'high', difficulty: 'complex',
  }, 'PATCH'));
  expect(updated).toMatchObject({ status: 'running', machineId: f.machineId, agent: 'pi' });
  expect((await f.detail(running.id)).attempts).toEqual(before.attempts);
  const next = await f.create('Next', { priority: 'high', difficulty: 'simple' });
  await f.action(next.id, 'schedule');
  expect(c.launcherClaimResponseSchema.parse(await (await f.claim()).json()).attempt).toBeNull();
  expect((await f.detail(running.id)).attempts[0]?.id).toBe(attempt.id);
});

it.each([true, false])('低优先级返修优先于高新任务，但无可用现场的高优先级返修不阻塞，现场=%s', async (recorded) => {
  const f = await setup();
  await f.heartbeat(3);
  const rework = await f.create('Rework', { priority: recorded ? 'low' : 'high' });
  await f.action(rework.id, 'schedule');
  const a = await f.claimed();
  if (recorded) expect((await f.agent(a.id, '/session', request({ locator: {
    path: '/work/actual', sessionId: 'original', sessionFile: '/sessions/original.jsonl',
  } }))).status).toBe(200);
  const { deliveryId } = c.agentDeliveryResponseSchema.parse(await (await f.agent(a.id, '/deliveries', request(delivery))).json());
  await f.exit(a.id);
  await f.action(rework.id, 'rework', { deliveryId, feedback: 'Fix' });
  const next = await f.create('New', { priority: recorded ? 'high' : 'low' });
  await f.action(next.id, 'schedule');
  expect((await f.claimed()).taskId).toBe(recorded ? rework.id : next.id);
});
