import { expect, it } from 'vitest';
import { delivery, project, request, useFixture } from './fixture.js';

const setup = useFixture();
type Fixture = Awaited<ReturnType<typeof setup>>;
const locator = { path: project.path, sessionId: 'native', sessionFile: '/sessions/native.jsonl' };
async function running(x: Fixture, discussion = false) {
  await beat(x);
  const task = await x.create('生命周期', { type: discussion ? 'discussion' : 'implementation' });
  await x.action(task.id, 'schedule');
  const attempt = await x.claimed();
  expect((await x.agent(attempt.id, '/session', request({ locator }))).status).toBe(200);
  if (!discussion) expect((await x.agent(attempt.id, '/workspace', request({ workspace: { ...locator, gitKind: 'non_git', gitBranch: null } }))).status).toBe(200);
  return { task, attempt };
}
const beat = (x: Fixture, body = request({ launcherVersion: 'test', slots: 1, projects: [project], attempts: [], sessionControl: true, gitLifecycle: true })) => x.launcher('/heartbeat', body);
const slots = (x: Fixture) => x.store.get<{ count: number }>("SELECT COUNT(*) count FROM attempts WHERE ended_at IS NULL AND settled_at IS NULL AND COALESCE(work_mode,execution_mode)='background'")!.count;
const agent = (x: Fixture, id: string, path: string, body?: object, revision = 0) => x.send(`/agent${path}`, body, { machine: x.token, attempt: id, headers: { 'X-Steward-Work-Revision': String(revision) } });
async function delivered(x: Fixture, id: string, revision = 0) {
  const response = await agent(x, id, '/deliveries', request(delivery), revision);
  expect(response.status).toBe(200);
  return await response.json() as { deliveryId: string; version: number };
}

it('settle保留进程释放槽；心跳重放不恢复旧占位；只重放精确结算回执', async () => {
  const x = await setup(); const { task, attempt } = await running(x);
  const hb = request({ launcherVersion: 'test', slots: 1, projects: [project], attempts: [], sessionControl: true });
  expect((await (await beat(x, hb)).json()).directives[0].occupiesSlot).toBe(true);
  await delivered(x, attempt.id);
  expect(slots(x)).toBe(1);
  const settle = request();
  expect((await x.agent(attempt.id, '/settle', settle)).status).toBe(200);
  expect((await x.agent(attempt.id, '/settle', settle)).status).toBe(200);
  expect((await x.agent(attempt.id, '/settle', request())).status).toBe(409);
  expect(slots(x)).toBe(0);
  expect((await x.detail(task.id)).task.lifecycle?.phase).toBe('settled');
  expect((await (await beat(x, hb)).json()).directives[0]).toMatchObject({ occupiesSlot: false, workSettled: true });
  expect((await (await beat(x)).json()).directives[0].occupiesSlot).toBe(false);
  expect(x.store.get('SELECT ended_at FROM attempts WHERE id=?', attempt.id)).toEqual({ ended_at: null });
  expect(await (await x.agent(attempt.id, '/control')).json()).toMatchObject({ implementationAllowed: false, recordAllowed: true, settled: true, workRevision: 0 });
});

it('记录独立版本且SHA不变，旧版本不能验收；原nonce重放不授予实施权', async () => {
  const x = await setup(); const { task, attempt } = await running(x);
  const first = await delivered(x, attempt.id);
  await x.agent(attempt.id, '/settle', request());
  const revision = request({ ...delivery, deliveryId: first.deliveryId, reason: '补充验证', authorizedByUser: true });
  expect((await x.agent(attempt.id, '/delivery-revisions', { ...revision, requestId: request().requestId, commit: 'changed' })).status).toBe(409);
  const saved = await (await x.agent(attempt.id, '/delivery-revisions', revision)).json();
  expect(saved.version).toBe(2);
  expect(await (await x.agent(attempt.id, '/delivery-revisions', revision)).json()).toEqual(saved);
  expect((await x.agent(attempt.id, '/progress', request({ text: '不得实施' }))).status).toBe(409);
  expect((await x.action(task.id, 'accept', { deliveryId: first.deliveryId })).status).toBe(409);
  expect((await x.action(task.id, 'accept', { deliveryId: saved.deliveryId })).status).toBe(200);
  expect((await x.agent(attempt.id, '/delivery-revisions', request({ ...revision, deliveryId: saved.deliveryId }))).status).toBe(409);
  expect(await (await x.agent(attempt.id, '/delivery-revisions', revision)).json()).toEqual(saved);
  const history = (await x.detail(task.id)).deliveries;
  expect(history).toHaveLength(2);
  expect(history[1]).toMatchObject({ sourceDeliveryId: first.deliveryId, kind: 'record', revisionReason: '补充验证', commit: delivery.commit });
});

it('原进程continue增加revision并重置讨论结束；unknown回执可重放而迟到实施写拒绝', async () => {
  const x = await setup(); const { task, attempt } = await running(x, true);
  await x.agent(attempt.id, '/end-discussion', request());
  const first = await delivered(x, attempt.id);
  const late = request({ text: '旧段' });
  expect((await x.agent(attempt.id, '/progress', late)).status).toBe(200);
  await x.agent(attempt.id, '/settle', request());
  const next = request({ deliveryId: first.deliveryId, reason: '用户继续', authorizedByUser: true });
  expect(await (await x.agent(attempt.id, '/continue', next)).json()).toEqual({ workRevision: 1 });
  expect(await (await x.agent(attempt.id, '/continue', next)).json()).toEqual({ workRevision: 1 });
  expect((await x.agent(attempt.id, '/progress', late)).status).toBe(409);
  expect((await agent(x, attempt.id, '/progress', request({ text: '新段' }), 1)).status).toBe(200);
  expect((await agent(x, attempt.id, '/session', request({ locator: { ...locator, path: '/moved' } }), 1)).status).toBe(409);
  expect(slots(x)).toBe(0);
  expect((await x.detail(task.id)).attempts).toHaveLength(1);
  expect(await (await x.agent(attempt.id, '/control')).json()).toMatchObject({ workRevision: 1, discussionEndRequested: false });
  expect((await agent(x, attempt.id, '/deliveries', request(delivery), 1)).status).toBe(409);
  expect((await (await beat(x)).json()).directives[0]).toMatchObject({ occupiesSlot: false, workSettled: false });
});

it('正式返修受额度限制，在原attempt原现场开新段并提供feedback和稳定ready', async () => {
  const x = await setup(); const { task, attempt } = await running(x);
  const d = await delivered(x, attempt.id);
  await x.agent(attempt.id, '/settle', request());
  const other = await x.create('占额'); await x.action(other.id, 'schedule'); await x.claimed();
  await x.action(task.id, 'rework', { deliveryId: d.deliveryId, feedback: '请补充' });
  expect(await (await x.claim()).json()).toEqual({ attempt: null });
  expect((await x.detail(task.id)).attempts[0]!.workRevision).toBe(0);
  await x.heartbeat(2);
  expect(await (await x.claim()).json()).toEqual({ attempt: null });
  const detail = await x.detail(task.id);
  expect(detail.attempts).toHaveLength(1);
  expect(detail.attempts[0]).toMatchObject({ workRevision: 1, executionMode: 'background' });
  expect(await (await x.agent(attempt.id, '/context')).json()).toMatchObject({ workspace: { previous: { workspace: { ...locator } } }, deliveries: [expect.objectContaining({ feedback: '请补充' })] });
  expect((await (await x.agent(attempt.id, '/control')).json()).continuationReady).toBe(true);
  // 控制读取丢失后可安全重读；真正发送去重由扩展原生工作段意图保证。
  expect((await (await x.agent(attempt.id, '/control')).json()).continuationReady).toBe(true);
});

it('暂停只在精确stop成功后释放，原机continue继承现场并等待started和loaded', async () => {
  const x = await setup(); const { task, attempt } = await running(x);
  const pause = request({ attemptId: attempt.id, mode: 'pause' });
  expect((await x.action(task.id, 'session-operation', pause)).status).toBe(200);
  expect(slots(x)).toBe(1);
  expect((await (await x.agent(attempt.id, '/control')).json()).pauseRequested).toBe(true);
  expect((await x.launcher(`/session-operations/${pause.requestId}/report`, request({ step: 'stop', result: 'stopped' }))).status).toBe(200);
  expect(slots(x)).toBe(0);
  expect((await x.detail(task.id)).task.lifecycle?.phase).toBe('paused');
  expect((await x.action(task.id, 'reschedule')).status).toBe(409);
  const resume = request({ attemptId: attempt.id, mode: 'continue' });
  expect((await x.action(task.id, 'session-operation', resume)).status).toBe(200);
  expect((await x.launcher(`/session-operations/${resume.requestId}/report`, request({ step: 'stop', result: 'stopped' }))).status).toBe(200);
  const replacement = (await x.detail(task.id)).attempts.at(-1)!;
  await x.launcher(`/attempts/${replacement.id}/started`, request({ tmuxSession: `steward-${replacement.id}`, startedAt: x.now() }));
  expect((await (await x.agent(replacement.id, '/control')).json()).continuationReady).toBe(false);
  expect((await x.agent(replacement.id, '/session', request({ locator }))).status).toBe(200);
  expect((await (await x.agent(replacement.id, '/control')).json()).continuationReady).toBe(true);
  expect((await x.agent(replacement.id, '/session', request({ locator: { ...locator, path: '/replacement' } }))).status).toBe(409);
  expect((await x.agent(replacement.id, '/workspace', request({ workspace: { ...locator, path: '/replacement', gitKind: 'non_git', gitBranch: null } }))).status).toBe(409);
});

it('暂停超时不释放或假报暂停，迟到stop拒绝，取消仍fence；离线不发暂停权限', async () => {
  const x = await setup(); const { task, attempt } = await running(x);
  const pause = request({ attemptId: attempt.id, mode: 'pause' });
  await x.action(task.id, 'session-operation', pause);
  x.advance(46_000); await beat(x);
  expect(slots(x)).toBe(1);
  expect((await x.detail(task.id)).task.lifecycle).toMatchObject({ phase: 'pausing', message: 'session_timeout' });
  expect((await x.launcher(`/session-operations/${pause.requestId}/report`, request({ step: 'stop', result: 'stopped' }))).status).toBe(409);
  expect((await x.action(task.id, 'cancel')).status).toBe(200);
  expect((await x.agent(attempt.id, '/progress', request({ text: '迟到' }))).status).toBe(409);
  const y = await setup(); const live = await running(y); y.advance(300_000);
  expect((await y.action(live.task.id, 'session-operation', request({ attemptId: live.attempt.id, mode: 'pause' }))).status).toBe(409);
});

it('无Git验收封闭业务权，finalize失败只重试退出；确认退出才done', async () => {
  const x = await setup(); const { task, attempt } = await running(x);
  const d = await delivered(x, attempt.id); await x.agent(attempt.id, '/settle', request());
  expect((await x.action(task.id, 'accept', { deliveryId: d.deliveryId })).status).toBe(200);
  expect((await x.detail(task.id)).task.status).toBe('review');
  expect((await x.agent(attempt.id, '/continue', request({ deliveryId: d.deliveryId, authorizedByUser: true, reason: '关闭后' }))).status).toBe(409);
  const stop = (await (await beat(x)).json()).sessionOperations[0];
  expect(stop.mode).toBe('finalize');
  await x.launcher(`/session-operations/${stop.id}/report`, request({ step: 'stop', result: 'failed', failure: 'session_source_alive' }));
  expect((await x.detail(task.id)).task.lifecycle?.phase).toBe('cleanup_blocked');
  expect((await x.action(task.id, 'retry-git')).status).toBe(200);
  const retry = (await (await beat(x)).json()).sessionOperations[0];
  expect(retry.id).not.toBe(stop.id); expect(retry.mode).toBe('finalize');
  expect((await x.launcher(`/session-operations/${retry.id}/report`, request({ step: 'stop', result: 'stopped' }))).status).toBe(200);
  expect((await x.detail(task.id)).task.lifecycle?.phase).toBe('complete');
  expect((await x.detail(task.id)).task.status).toBe('done');
});

it('Git验收只授权merge，merged后finalize确认退出才cleanup；退出重试不重复merge', async () => {
  const x = await setup(); await beat(x);
  await x.web(`/projects/${project.id}/git`, { baseBranch: 'main', syncBeforeStart: false, version: 1 }, 'PATCH');
  const task = await x.create(); await x.action(task.id, 'schedule'); const attempt = await x.claimed();
  const baseCommit = 'a'.repeat(40), commit = 'b'.repeat(40);
  const workspace = { path: '/work/task/sub', gitRoot: '/work/task', gitKind: 'linked', gitBranch: 'feature/task', sessionId: locator.sessionId, sessionFile: locator.sessionFile };
  expect((await x.agent(attempt.id, '/git/prepare', request({ baseBranch: 'main', baseCommit, taskBranch: 'feature/task', repositoryPath: project.path, syncBeforeStart: false, syncResult: 'disabled' }))).status).toBe(200);
  expect((await x.agent(attempt.id, '/workspace', request({ workspace }))).status).toBe(200);
  const d = await (await x.agent(attempt.id, '/deliveries', request({ ...delivery, baseCommit, commit }))).json();
  expect((await x.action(task.id, 'accept', { deliveryId: d.deliveryId })).status).toBe(200);
  expect((await (await beat(x)).json()).gitOperations).toEqual([]);
  expect((await x.agent(attempt.id, '/settle', request())).status).toBe(200);
  const merge = (await (await beat(x)).json()).gitOperations[0];
  expect(merge).toMatchObject({ phase: 'merge', sourceAttemptId: attempt.id });
  expect((await x.detail(task.id)).task.lifecycle?.acceptedAt).toBeNull();
  expect((await x.launcher(`/git-operations/${merge.id}/report`, request({ outcome: 'blocked', message: 'merge blocked' }))).status).toBe(200);
  expect((await x.detail(task.id)).task.lifecycle?.phase).toBe('merge_blocked');
  expect((await x.action(task.id, 'retry-git')).status).toBe(200);
  const retryMerge = (await (await beat(x)).json()).gitOperations[0];
  expect(retryMerge.phase).toBe('merge');
  expect((await x.launcher(`/git-operations/${retryMerge.id}/report`, request({ outcome: 'merged', mergedCommit: commit }))).status).toBe(200);
  const pending = await (await beat(x)).json();
  expect(pending.gitOperations).toEqual([]);
  expect((await x.detail(task.id)).task.lifecycle?.acceptedAt).toBe(x.now());
  const finalizer = pending.sessionOperations[0]; expect(finalizer.mode).toBe('finalize');
  await x.launcher(`/session-operations/${finalizer.id}/report`, request({ step: 'stop', result: 'failed', failure: 'session_source_alive' }));
  expect((await x.action(task.id, 'retry-git')).status).toBe(200);
  const retry = await (await beat(x)).json(); expect(retry.gitOperations).toEqual([]);
  expect(retry.sessionOperations[0].mode).toBe('finalize');
  await x.launcher(`/session-operations/${retry.sessionOperations[0].id}/report`, request({ step: 'stop', result: 'stopped' }));
  const cleanup = (await (await beat(x)).json()).gitOperations[0];
  expect(cleanup).toMatchObject({ phase: 'cleanup', sourceAttemptId: attempt.id });
  expect((await x.launcher(`/git-operations/${cleanup.id}/report`, request({ outcome: 'complete', mergedCommit: commit }))).status).toBe(200);
  expect((await x.detail(task.id)).task.lifecycle?.phase).toBe('complete');
});

it('离线验收保存等待原机原因，退出已确认后无Git清理可重试完成', async () => {
  const x = await setup(); const { task, attempt } = await running(x);
  const d = await delivered(x, attempt.id); await x.agent(attempt.id, '/settle', request());
  x.advance(300_000);
  expect((await x.action(task.id, 'accept', { deliveryId: d.deliveryId })).status).toBe(200);
  expect((await x.detail(task.id)).task.lifecycle).toMatchObject({ phase: 'cleanup_blocked', message: expect.stringContaining('offline') });
  expect((await x.action(task.id, 'retry-git')).status).toBe(200);
  expect((await x.detail(task.id)).task.lifecycle?.phase).toBe('cleanup_blocked');
  x.store.run("UPDATE attempts SET ended_at=?,result='delivered' WHERE id=?", x.now(), attempt.id);
  expect((await x.action(task.id, 'retry-git')).status).toBe(200);
  expect((await x.detail(task.id)).task).toMatchObject({ status: 'done', lifecycle: { phase: 'complete' } });
});
