import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { delivery, project, request, useFixture } from './fixture.js';

const setup = useFixture();
const locator = { path: project.path, sessionId: 'pause-races', sessionFile: '/sessions/pause-races.jsonl' };

it('普通前台旧恢复不得绕过暂停中或已暂停；必须走原现场continue', async () => {
  const x = await setup();
  await x.launcher('/heartbeat', request({ launcherVersion: 'test', slots: 1, projects: [project], attempts: [],
    sessionControl: true, foregroundControl: true }));
  const body = { ...request(), goalId: randomUUID(), ownerId: randomUUID(), pid: 12345, projectId: project.id,
    projectName: project.name, registeredPath: project.path, title: '暂停前台', goal: '', acceptance: '', notes: '', type: 'discussion', locator };
  const first = await x.send('/task-management/foreground/start', body, { machine: x.token });
  expect(first.status).toBe(200);
  const { binding } = await first.json();
  const pause = request({ mode: 'pause', attemptId: binding.attemptId });
  expect((await x.action(binding.taskId, 'session-operation', pause)).status).toBe(200);
  const recovery = { ...body, ...request(), ownerId: randomUUID(), pid: 23456,
    previousAttemptId: binding.attemptId, previousOwnerPid: body.pid };
  expect((await x.send('/task-management/foreground/start', recovery, { machine: x.token })).status).toBe(409);
  expect((await x.launcher(`/session-operations/${pause.requestId}/report`, request({ step: 'stop', result: 'stopped' }))).status).toBe(200);
  expect((await x.send('/task-management/foreground/start', { ...recovery, ...request() }, { machine: x.token })).status).toBe(409);
  const detail = await x.detail(binding.taskId);
  expect(detail.attempts).toHaveLength(1);
  expect(detail.task).toMatchObject({ status: 'interrupted', lifecycle: { phase: 'paused' } });
});

it('首次确认现场之前暂停，continue仍可按原launch定位首次确认，不能改路径', async () => {
  const x = await setup();
  await x.launcher('/heartbeat', request({ launcherVersion: 'test', slots: 1, projects: [project], attempts: [], sessionControl: true }));
  const task = await x.create('尚未确认现场'); await x.action(task.id, 'schedule'); const source = await x.claimed();
  expect((await x.agent(source.id, '/session', request({ locator }))).status).toBe(200);
  const pause = request({ attemptId: source.id, mode: 'pause' });
  await x.action(task.id, 'session-operation', pause);
  await x.launcher(`/session-operations/${pause.requestId}/report`, request({ step: 'stop', result: 'stopped' }));
  const resume = request({ attemptId: source.id, mode: 'continue' }); await x.action(task.id, 'session-operation', resume);
  await x.launcher(`/session-operations/${resume.requestId}/report`, request({ step: 'stop', result: 'stopped' }));
  const replacement = (await x.detail(task.id)).attempts.at(-1)!;
  await x.launcher(`/attempts/${replacement.id}/started`, request({ tmuxSession: `steward-${replacement.id}`, startedAt: x.now() }));
  expect((await x.agent(replacement.id, '/session', request({ locator }))).status).toBe(200);
  const workspace = { ...locator, gitKind: 'non_git', gitBranch: null };
  expect((await x.agent(replacement.id, '/workspace', request({ workspace: { ...workspace, path: '/other' } }))).status).toBe(409);
  expect((await x.agent(replacement.id, '/workspace', request({ workspace }))).status).toBe(200);
  expect((await x.agent(replacement.id, '/workspace', request({ workspace: { ...workspace, path: '/other' } }))).status).toBe(409);
});

it('finalize的进程退出先到，迟到stop回执仍幂等成功且不重复推进清理', async () => {
  const x = await setup();
  await x.launcher('/heartbeat', request({ launcherVersion: 'test', slots: 1, projects: [project], attempts: [], sessionControl: true }));
  const task = await x.create('退出与停止回执交错');
  await x.action(task.id, 'schedule'); const attempt = await x.claimed();
  expect((await x.agent(attempt.id, '/session', request({ locator }))).status).toBe(200);
  const saved = await (await x.agent(attempt.id, '/deliveries', request(delivery))).json();
  expect((await x.agent(attempt.id, '/settle', request())).status).toBe(200);
  expect((await x.action(task.id, 'accept', { deliveryId: saved.deliveryId })).status).toBe(200);
  const operation = x.store.get<{ id: string }>("SELECT id FROM session_operations WHERE task_id=? AND mode='finalize'", task.id)!;
  expect((await x.exit(attempt.id)).status).toBe(200);
  const before = await x.detail(task.id);
  expect(before.task.status).toBe('done');
  const stopped = request({ step: 'stop', result: 'stopped' });
  expect((await x.launcher(`/session-operations/${operation.id}/report`, stopped)).status).toBe(200);
  expect((await x.launcher(`/session-operations/${operation.id}/report`, stopped)).status).toBe(200);
  expect((await x.detail(task.id)).task.version).toBe(before.task.version);
});
