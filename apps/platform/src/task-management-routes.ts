import { Hono } from 'hono';
import type { Context } from 'hono';
import * as c from '@pi-steward/contract';
import { jsonInput, routeParam } from './app.js';
import { requireMachineAuth } from './auth.js';
import type { Store } from './store.js';
import { createTask, updateTask } from './tasks.js';
import { projectViews, requireProject, taskDetail, taskView } from './views.js';
import type { TaskRow } from './views.js';

export function mountTaskManagement(store: Store, now: () => number) {
  const management = new Hono();
  const authenticate = (context: Context) => requireMachineAuth(store, context.req.header('Authorization'));
  management.get('/projects', (context) => {
    authenticate(context);
    return context.json(c.webProjectsResponseSchema.parse({ projects: projectViews(store) }));
  });
  management.get('/projects/:id/tasks', (context) => {
    authenticate(context);
    const id = routeParam(context.req.param('id'), c.projectIdSchema);
    requireProject(store, id);
    const time = now();
    const tasks = store.all<TaskRow>('SELECT * FROM tasks WHERE project_id=? ORDER BY position', id)
      .map((task) => taskView(store, task, time));
    return context.json(c.webProjectTasksResponseSchema.parse({ tasks }));
  });
  management.get('/tasks/:id', (context) => {
    authenticate(context);
    const id = routeParam(context.req.param('id'), c.uuidSchema);
    return context.json(c.webTaskDetailResponseSchema.parse(taskDetail(store, id, now())));
  });
  management.post('/tasks', async (context) => {
    authenticate(context);
    const body = await jsonInput(context, c.managedCreateTaskRequestSchema);
    const { requestId, sessionId, ...input } = body;
    const replayBody = { requestId, sessionId, ...input };
    const response = store.immediate(() => {
      const machineId = authenticate(context);
      const time = now();
      return store.request({ machineId, actor: 'agent', operation: 'managed_create_task', target: '' }, replayBody, time,
        () => c.webTaskMutationResponseSchema.parse(createTask(store, input, time, { machineId, sessionId })));
    });
    return context.json(response, 201);
  });
  management.patch('/tasks/:id', async (context) => {
    authenticate(context);
    const id = routeParam(context.req.param('id'), c.uuidSchema);
    const body = await jsonInput(context, c.managedUpdateTaskRequestSchema);
    const { requestId, sessionId, ...input } = body;
    const replayBody = { requestId, sessionId, ...input };
    const response = store.immediate(() => {
      const machineId = authenticate(context);
      const time = now();
      return store.request({ machineId, actor: 'agent', operation: 'managed_update_task', target: id }, replayBody, time,
        () => c.webTaskMutationResponseSchema.parse(updateTask(store, id, input, time, { machineId, sessionId })));
    });
    return context.json(response);
  });
  return management;
}
