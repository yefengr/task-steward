import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import * as c from '@pi-steward/contract';
import { openStore, Store } from '../src/store.js';
import { delivery, errorCode, origin, project, request, useFixture } from './fixture.js';

const setup = useFixture();
type Fixture = Awaited<ReturnType<typeof setup>>;

async function control(x: Fixture, id: string) {
  const response = await x.agent(id, '/control');
  expect(response.status).toBe(200);
  return c.agentControlResponseSchema.parse(await response.json());
}

async function ask(x: Fixture, id: string, text: string) {
  const response = await x.agent(id, '/questions', request({ text, context: '背景' }));
  expect(response.status).toBe(200);
  return c.agentCreateQuestionResponseSchema.parse(await response.json());
}

it('从版本 2 升级时保留旧任务与显式问题，旧问题不进入回复等待', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-discussion-migration-'));
  const path = join(directory, 'steward.sqlite');
  try {
    const prior = new Store(new DatabaseSync(path));
    try {
      for (const file of ['0001-initial.sql', '0002-machine-pairing.sql']) {
        prior.connection.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
      }
      prior.connection.exec('PRAGMA user_version=2; PRAGMA foreign_keys=ON');
      prior.run("INSERT INTO projects (id,name,created_at) VALUES ('project','Project',100)");
      prior.run("INSERT INTO machines (id,name,token_hash,created_at) VALUES ('machine','Machine','hash',100)");
      prior.run(`INSERT INTO tasks (id,project_id,title,goal,acceptance,notes,agent,status,position,created_by,created_at,updated_at)
        VALUES ('task','project','原任务','','','','pi','running',1,'user',100,100)`);
      prior.run(`INSERT INTO attempts (id,task_id,machine_id,agent,kind,session_id,workspace_path,claimed_at,lease_expires_at)
        VALUES ('attempt','task','machine','pi','new','session','/work',100,200)`);
      prior.run("INSERT INTO questions VALUES ('question','task','attempt','原问题','原背景','open',100,100)");
    } finally { prior.connection.close(); }
    const upgraded = openStore(path);
    try {
      expect(upgraded.get('PRAGMA user_version')).toEqual({ user_version: 8 });
      expect(upgraded.get('SELECT title,status,type FROM tasks')).toEqual({ title: '原任务', status: 'running', type: 'implementation' });
      expect(upgraded.get('SELECT discussion_end_requested_at FROM attempts')).toEqual({ discussion_end_requested_at: null });
      expect(upgraded.get('SELECT text,context,status,wait_id,wait_since FROM questions')).toEqual({
        text: '原问题', context: '原背景', status: 'open', wait_id: null, wait_since: null,
      });
      expect(() => upgraded.run("UPDATE tasks SET type='other'")).toThrow(/CHECK constraint failed/);
    } finally { upgraded.connection.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('Web 和 Pi 都能创建 discussion，省略类型时写入 implementation，创建后不能改类型', async () => {
  const x = await setup();
  await x.heartbeat();
  const webTask = await x.create('Web 讨论', { type: 'discussion' });
  const webDefault = await x.create('Web 默认');
  const auth = { machine: x.token };
  const pi = (title: string, type?: c.TaskType) => x.send('/task-management/tasks', request({
    projectId: project.id, title, type, sessionId: 'test-session',
  }), auth);
  const piResponse = await pi('Pi 讨论', 'discussion');
  expect(piResponse.status).toBe(201);
  const piTask = c.webTaskMutationResponseSchema.parse(await piResponse.json()).task;
  expect(piTask).toMatchObject({ type: 'discussion', createdBy: 'agent', status: 'unscheduled', discussionEndRequested: false });
  const piDefault = await pi('Pi 默认');
  expect(piDefault.status).toBe(201);
  expect(await piDefault.json()).toMatchObject({ task: { type: 'implementation', discussionEndRequested: false } });
  expect(await x.detail(webDefault.id)).toMatchObject({ task: { type: 'implementation', discussionEndRequested: false } });
  expect(await x.detail(webTask.id)).toMatchObject({ task: { type: 'discussion', discussionEndRequested: false } });
  await errorCode(await x.web(`/tasks/${webTask.id}`, { version: webTask.version, type: 'implementation' }, 'PATCH'), 400, 'invalid_request');
  await errorCode(await x.send(`/task-management/tasks/${piTask.id}`, request({
    version: piTask.version, sessionId: 'test-session', title: '重命名', type: 'implementation',
  }), { ...auth, method: 'PATCH' }), 400, 'invalid_request');
});

it('同一等待组保留首问时间，精确满三分钟提醒，且旧回复与重放不清除后继组', async () => {
  const x = await setup();
  await x.heartbeat();
  const task = await x.create();
  await x.action(task.id, 'schedule');
  const { id } = await x.claimed();
  const due = c.REPLY_REMINDER_DELAY_MS;
  expect(due).toBe(3 * 60 * 1000);
  x.store.run(`INSERT INTO questions (id,task_id,attempt_id,text,context,status,created_at,updated_at)
    VALUES (?,?,?,?,?,'open',?,?)`, randomUUID(), task.id, id, '历史显式问题', '', x.now() - due, x.now() - due);
  expect((await x.detail(task.id)).task.needsResponse).toBe(false);
  expect(await control(x, id)).toEqual({ type: 'implementation', discussionEndRequested: false, deliverySaved: false, waitId: null });

  const firstRequest = request({ text: '首问', context: '背景' });
  const first = c.agentCreateQuestionResponseSchema.parse(await (await x.agent(id, '/questions', firstRequest)).json());
  expect(first.waitId).toBe(first.questionId);
  expect(await (await x.agent(id, '/questions', firstRequest)).json()).toEqual(first);
  x.advance(due - 1);
  const second = await ask(x, id, '补问');
  expect(second.questionId).not.toBe(first.questionId);
  expect(second.waitId).toBe(first.waitId);
  expect((await x.agent(id, `/questions/${first.questionId}`, request({ status: 'withdrawn' }), 'PATCH')).status).toBe(200);
  expect((await x.detail(task.id)).task.needsResponse).toBe(false);
  x.advance(1);
  expect((await x.detail(task.id)).task.needsResponse).toBe(true);
  const list = c.webProjectTasksResponseSchema.parse(await (await x.web(`/projects/${project.id}/tasks`)).json());
  expect(list.tasks).toEqual([expect.objectContaining({ id: task.id, needsResponse: true })]);
  expect((await control(x, id)).waitId).toBe(first.waitId);

  const lateReply = request({ waitId: first.waitId });
  expect(await (await x.agent(id, '/reply', lateReply)).json()).toEqual({ ok: true });
  expect((await control(x, id)).waitId).toBeNull();
  expect((await x.detail(task.id)).task.needsResponse).toBe(false);
  expect((await x.detail(task.id)).questions.map(({ text, status }) => [text, status])).toEqual([
    ['历史显式问题', 'open'], ['首问', 'withdrawn'], ['补问', 'open'],
  ]);

  const next = await ask(x, id, '新一轮');
  expect(next.waitId).toBe(next.questionId);
  expect(next.waitId).not.toBe(first.waitId);
  expect(await (await x.agent(id, '/reply', lateReply)).json()).toEqual({ ok: true });
  expect(await (await x.agent(id, '/reply', request({ waitId: first.waitId }))).json()).toEqual({ ok: true });
  await errorCode(await x.agent(id, '/reply', { ...lateReply, waitId: next.waitId }), 409, 'conflict');
  expect((await control(x, id)).waitId).toBe(next.waitId);
  expect(await (await x.agent(id, '/reply', request({ waitId: next.waitId }))).json()).toEqual({ ok: true });
  x.advance(due);
  expect((await x.detail(task.id)).task.needsResponse).toBe(false);
  const closing = await ask(x, id, '直接处理');
  expect((await x.agent(id, `/questions/${closing.questionId}`, request({ status: 'resolved' }), 'PATCH')).status).toBe(200);
  expect((await control(x, id)).waitId).toBeNull();
  expect((await ask(x, id, '最后一问')).waitId).not.toBe(closing.waitId);
});

it('电脑离线且租约过期时仍可持久请求收尾，交付及退出前不释放当前尝试', async () => {
  const x = await setup();
  await x.heartbeat();
  const task = await x.create('讨论', { type: 'discussion' });
  const ordinary = await x.create('普通');
  await x.action(task.id, 'schedule');
  await x.action(ordinary.id, 'schedule');
  const { id } = await x.claimed();
  const report = request(delivery);
  await errorCode(await x.agent(id, '/deliveries', report), 409, 'conflict');
  const beforeContext = c.agentContextResponseSchema.parse(await (await x.agent(id, '/context')).json());
  expect(beforeContext.task.type).toBe('discussion');
  const question = await ask(x, id, '未回复');
  x.advance(c.REPLY_REMINDER_DELAY_MS);
  const before = (await x.detail(task.id)).task;
  expect(before).toMatchObject({ status: 'running', discussionEndRequested: false, needsResponse: true, needsVerification: true });
  expect((await x.detail(ordinary.id)).task.waiting).toBe('machine_offline');
  await errorCode(await x.action(task.id, 'end-discussion', { attemptId: randomUUID() }), 409, 'conflict');
  const mutation = await x.action(task.id, 'end-discussion', { attemptId: id });
  expect(mutation.status).toBe(200);
  const marked = c.webTaskMutationResponseSchema.parse(await mutation.json()).task;
  expect(marked).toEqual({ ...before, discussionEndRequested: true, needsResponse: false });
  expect(await (await x.action(task.id, 'end-discussion', { attemptId: id })).json()).toEqual({ task: marked });
  expect(await (await x.agent(id, '/end-discussion', request())).json()).toEqual({ ok: true });
  expect((await x.detail(task.id)).events.filter(({ kind }) => kind === 'discussion_end_requested')).toEqual([
    expect.objectContaining({ actor: 'user', attemptId: id }),
  ]);
  expect(await control(x, id)).toEqual({ type: 'discussion', discussionEndRequested: true, deliverySaved: false, waitId: question.waitId });
  expect(await ask(x, id, '收尾备注')).not.toHaveProperty('waitId');

  expect(await (await x.heartbeat(1, [project], [{ id, tmuxSession: `steward-${id}`, running: true }])).json()).toEqual({
    directives: [{ attemptId: id, tmuxSession: `steward-${id}`, action: 'continue' }],
  });
  expect(await (await x.claim()).json()).toEqual({ attempt: null });
  const result = await x.agent(id, '/deliveries', report);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ version: 1 });
  expect(await control(x, id)).toMatchObject({ discussionEndRequested: true, deliverySaved: true });
  expect((await x.detail(task.id)).task).toMatchObject({ status: 'review', discussionEndRequested: false, needsResponse: false });
  expect(await (await x.claim()).json()).toEqual({ attempt: null });
  expect((await x.exit(id)).status).toBe(200);
  expect((await x.detail(task.id)).attempts[0]?.result).toBe('delivered');
  expect((await x.claimed()).taskId).toBe(ordinary.id);
});

it('Pi 本地收尾可重放，返修需要新请求且只能人工验收最新交付', async () => {
  const x = await setup();
  await x.heartbeat();
  const task = await x.create('讨论返修', { type: 'discussion' });
  await x.action(task.id, 'schedule');
  const first = await x.claimed();
  expect((await x.agent(first.id, '/session', request({ locator: {
    path: project.path, sessionId: first.sessionId, sessionFile: '/sessions/discussion.jsonl',
  } }))).status).toBe(200);
  const old = await ask(x, first.id, '上一尝试的问题');
  const end = request();
  expect(await (await x.agent(first.id, '/end-discussion', end)).json()).toEqual({ ok: true });
  expect(await (await x.agent(first.id, '/end-discussion', end)).json()).toEqual({ ok: true });
  const firstDelivery = c.agentDeliveryResponseSchema.parse(await (await x.agent(first.id, '/deliveries', request(delivery))).json());
  expect((await x.action(task.id, 'rework', { deliveryId: firstDelivery.deliveryId, feedback: '还需补充' })).status).toBe(200);
  expect((await x.exit(first.id)).status).toBe(200);
  const retry = await x.claimed();
  expect(retry).toMatchObject({ kind: 'rework', restoreSession: true, sessionId: first.sessionId });
  expect(await control(x, retry.id)).toEqual({ type: 'discussion', discussionEndRequested: false, deliverySaved: false, waitId: null });
  expect((await x.detail(task.id)).questions).toEqual([expect.objectContaining({ id: old.questionId, status: 'open' })]);
  await errorCode(await x.action(task.id, 'end-discussion', { attemptId: first.id }), 409, 'conflict');
  await errorCode(await x.agent(retry.id, '/deliveries', request(delivery)), 409, 'conflict');
  expect(await (await x.agent(retry.id, '/end-discussion', request())).json()).toEqual({ ok: true });
  const second = c.agentDeliveryResponseSchema.parse(await (await x.agent(retry.id, '/deliveries', request(delivery))).json());
  expect(second.version).toBe(2);
  expect((await x.exit(retry.id)).status).toBe(200);
  await errorCode(await x.action(task.id, 'accept', { deliveryId: firstDelivery.deliveryId }), 409, 'conflict');
  expect((await x.action(task.id, 'accept', { deliveryId: second.deliveryId })).status).toBe(200);
  const detail = await x.detail(task.id);
  expect(detail.task.status).toBe('done');
  expect(detail.deliveries.map(({ review }) => review)).toEqual(['rework', 'accepted']);
  expect(detail.events.filter(({ kind }) => kind === 'discussion_end_requested').map(({ actor, attemptId }) => [actor, attemptId]))
    .toEqual([['agent', first.id], ['agent', retry.id]]);
});

it('控制仅给认证的所属机器，取消优先于已有的收尾请求', async () => {
  const x = await setup();
  await x.heartbeat();
  const task = await x.create('取消讨论', { type: 'discussion' });
  await x.action(task.id, 'schedule');
  const { id } = await x.claimed();
  const path = `/web/tasks/${task.id}/end-discussion`;
  await errorCode(await x.send(path, { attemptId: id }, { headers: { Origin: origin } }), 401, 'unauthorized');
  await errorCode(await x.send('/agent/control', undefined, { attempt: id }), 401, 'unauthorized');
  await errorCode(await x.send('/agent/control', undefined, { machine: x.token }), 401, 'unauthorized');
  await errorCode(await x.send('/agent/control', undefined, { machine: x.otherToken, attempt: id }), 403, 'forbidden');
  await errorCode(await x.send('/agent/end-discussion', request(), { machine: x.otherToken, attempt: id }), 403, 'forbidden');
  expect((await x.agent(id, '/end-discussion', request())).status).toBe(200);
  expect((await x.action(task.id, 'cancel')).status).toBe(200);
  await errorCode(await x.agent(id, '/control'), 409, 'attempt_ended');
  await errorCode(await x.agent(id, '/deliveries', request(delivery)), 409, 'attempt_ended');
  await errorCode(await x.agent(id, '/end-discussion', request()), 409, 'attempt_ended');
  await errorCode(await x.action(task.id, 'end-discussion', { attemptId: id }), 409, 'conflict');
  expect((await x.exit(id)).status).toBe(200);
  const detail = await x.detail(task.id);
  expect(detail.task).toMatchObject({ status: 'cancelled', discussionEndRequested: false, needsResponse: false });
  expect(detail.attempts[0]?.result).toBe('cancelled');
});
