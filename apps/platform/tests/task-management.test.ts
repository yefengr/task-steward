import { describe, expect, it } from 'vitest';
import * as c from '@pi-steward/contract';
import { revokeMachine } from '../src/auth.js';
import { errorCode, origin, project, request, useFixture } from './fixture.js';

const management = '/task-management';
const sourceSession = 'pi-session-123';
const setup = useFixture();

async function mutation(response: Response, status: 200 | 201) {
  expect(response.status).toBe(status);
  return c.webTaskMutationResponseSchema.parse(await response.json()).task;
}

describe('task management', () => {
  it('uses the same projects, task order and details as the web console across machines', async () => {
    const f = await setup();
    const otherProject = { id: 'other', name: 'Other', path: '/work/other' };
    expect((await f.heartbeat()).status).toBe(200);
    expect((await f.heartbeat(1, [otherProject], [], f.otherToken)).status).toBe(200);
    const first = await f.create('First', { projectId: otherProject.id });
    const second = await f.create('Second', { projectId: otherProject.id });
    const auth = { machine: f.token };

    const projects = await f.send(`${management}/projects`, undefined, auth);
    expect(projects.status).toBe(200);
    const projectsBody = c.webProjectsResponseSchema.parse(await projects.json());
    expect(projectsBody.projects.map(({ id }) => id)).toEqual([otherProject.id, project.id]);
    expect(projectsBody).toEqual(await (await f.web('/projects')).json());

    const listPath = `/projects/${otherProject.id}/tasks`;
    const list = await f.send(`${management}${listPath}`, undefined, auth);
    expect(list.status).toBe(200);
    const listBody = c.webProjectTasksResponseSchema.parse(await list.json());
    expect(listBody.tasks.map(({ id }) => id)).toEqual([first.id, second.id]);
    expect(listBody).toEqual(await (await f.web(listPath)).json());

    const detail = await f.send(`${management}/tasks/${first.id}`, undefined, auth);
    expect(detail.status).toBe(200);
    expect(c.webTaskDetailResponseSchema.parse(await detail.json())).toEqual(await f.detail(first.id));
    await errorCode(await f.send(`${management}/projects/missing/tasks`, undefined, auth), 404, 'not_found');
  });

  it('creates an unassigned Pi task, replays the result and leaves the ready launcher queue empty', async () => {
    const f = await setup();
    expect((await f.heartbeat()).status).toBe(200);
    const input = request({ projectId: project.id, title: 'New', goal: 'Goal', acceptance: 'Criteria', notes: 'Notes', sessionId: sourceSession });
    const auth = { machine: f.token };
    const task = await mutation(await f.send(`${management}/tasks`, input, auth), 201);
    expect(task).toMatchObject({ projectId: project.id, title: 'New', goal: 'Goal', acceptance: 'Criteria', notes: 'Notes',
      type: 'implementation', status: 'unscheduled', agent: 'pi', machineId: null, createdBy: 'agent', version: 1 });
    expect(await mutation(await f.send(`${management}/tasks`, input, auth), 201)).toEqual(task);
    await errorCode(await f.send(`${management}/tasks`, { ...input, title: 'Changed' }, auth), 409, 'conflict');

    const { tasks } = c.webProjectTasksResponseSchema.parse(await (await f.web(`/projects/${project.id}/tasks`)).json());
    expect(tasks).toEqual([task]);
    const detail = await f.detail(task.id);
    expect(detail.attempts).toEqual([]);
    expect(detail.events).toEqual([expect.objectContaining({ actor: 'agent', kind: 'created', attemptId: null,
      payload: { to: 'unscheduled', machineId: f.machineId, sessionId: sourceSession } })]);
    const claim = await f.claim();
    expect(claim.status).toBe(200);
    expect(c.launcherClaimResponseSchema.parse(await claim.json()).attempt).toBeNull();
  });

  it('retains execution settings and web audit data when updating, and applies a replay only once', async () => {
    const f = await setup();
    expect((await f.heartbeat()).status).toBe(200);
    const original = await f.create('Web task', { machineId: f.machineId });
    expect((await f.action(original.id, 'schedule')).status).toBe(200);
    const path = `/tasks/${original.id}`;
    const scheduled = await f.detail(original.id);
    const webUpdated = await mutation(await f.web(path, { version: scheduled.task.version, notes: 'Web notes' }, 'PATCH'), 200);
    const input = request({ version: webUpdated.version, title: 'Renamed', goal: 'New goal', acceptance: 'New criteria', notes: '',
      sessionId: sourceSession });
    const auth = { machine: f.otherToken, method: 'PATCH' };
    const managedPath = `${management}${path}`;
    const updated = await mutation(await f.send(managedPath, input, auth), 200);
    expect(updated).toMatchObject({ title: 'Renamed', goal: 'New goal', acceptance: 'New criteria', notes: '', agent: 'pi',
      machineId: f.machineId, status: 'queued', createdBy: 'user', version: webUpdated.version + 1 });
    expect(await mutation(await f.send(managedPath, input, auth), 200)).toEqual(updated);
    await errorCode(await f.send(managedPath, request({ version: webUpdated.version, title: 'Stale', sessionId: sourceSession }), auth), 409, 'conflict');

    const detail = await f.detail(original.id);
    expect(detail.task).toEqual(updated);
    expect(detail.events.filter((event) => event.kind === 'created' || event.kind === 'updated')).toEqual([
      expect.objectContaining({ actor: 'user', kind: 'created', attemptId: null, payload: { to: 'unscheduled' } }),
      expect.objectContaining({ actor: 'user', kind: 'updated', attemptId: null, payload: { fields: ['notes'] } }),
      expect.objectContaining({ actor: 'agent', kind: 'updated', attemptId: null, payload: {
        fields: ['title', 'goal', 'acceptance', 'notes'], machineId: f.otherId, sessionId: sourceSession,
      } }),
    ]);
  });

  it('rejects extra fields and requires a version and editable content on update', async () => {
    const f = await setup();
    expect((await f.heartbeat()).status).toBe(200);
    const task = await f.create();
    const auth = { machine: f.token };
    const patch = { ...auth, method: 'PATCH' };
    const path = `${management}/tasks/${task.id}`;
    const createInput = request({ projectId: project.id, title: 'New', sessionId: sourceSession });
    const updateInput = request({ version: task.version, title: 'Updated', sessionId: sourceSession });
    for (const extra of [{ agent: 'pi' }, { machineId: f.machineId }, { status: 'queued' }, { unknown: true }]) {
      await errorCode(await f.send(`${management}/tasks`, { ...createInput, ...extra }, auth), 400, 'invalid_request');
      await errorCode(await f.send(path, { ...updateInput, ...extra }, patch), 400, 'invalid_request');
    }
    await errorCode(await f.send(path, { ...updateInput, projectId: project.id }, patch), 400, 'invalid_request');
    await errorCode(await f.send(path, { ...updateInput, version: undefined }, patch), 400, 'invalid_request');
    await errorCode(await f.send(path, { ...updateInput, title: undefined }, patch), 400, 'invalid_request');
    expect((await f.detail(task.id)).task).toEqual(task);
  });

  it('requires an active machine token for management and keeps web actions behind web authentication', async () => {
    const f = await setup();
    expect((await f.heartbeat()).status).toBe(200);
    const input = request({ projectId: project.id, title: 'Authenticated task', sessionId: sourceSession });
    const auth = { machine: f.token };
    const task = await mutation(await f.send(`${management}/tasks`, input, auth), 201);
    const path = `/tasks/${task.id}`;
    const update = request({ version: task.version, notes: 'After auth', sessionId: sourceSession });
    // 未认证请求即使请求体无效也先被认证拦截。
    await errorCode(await f.send(`${management}/tasks`, {}, { headers: { 'Content-Type': 'text/plain' } }), 401, 'unauthorized');
    expect((await f.web('/projects')).status).toBe(200);
    expect(revokeMachine(f.store, 'Other Mac', f.now())).toBe(true);
    for (const credentials of [{}, { web: true }, { machine: f.otherToken }]) {
      for (const read of ['/projects', `/projects/${project.id}/tasks`, path]) {
        await errorCode(await f.send(`${management}${read}`, undefined, credentials), 401, 'unauthorized');
      }
      await errorCode(await f.send(`${management}/tasks`, input, credentials), 401, 'unauthorized');
      await errorCode(await f.send(`${management}${path}`, update, { ...credentials, method: 'PATCH' }), 401, 'unauthorized');
    }
    for (const action of ['schedule', 'accept']) {
      await errorCode(await f.send(`/web${path}/${action}`, {}, { ...auth, headers: { Origin: origin } }), 401, 'unauthorized');
      await errorCode(await f.send(`${management}${path}/${action}`, {}, auth), 404, 'not_found');
    }
    expect(revokeMachine(f.store, 'Mac', f.now())).toBe(true);
    await errorCode(await f.send(`${management}/tasks`, input, auth), 401, 'unauthorized');
  });
});
