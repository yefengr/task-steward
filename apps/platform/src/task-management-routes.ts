import { Hono } from 'hono';
import type { Context } from 'hono';
import * as c from '@pi-steward/contract';
import { jsonInput, routeParam } from './app.js';
import { requireMachineAuth } from './auth.js';
import { startForeground, validateForegroundBinding } from './foreground.js';
import type { Store } from './store.js';
import { createTask, updateTask } from './tasks.js';
import { projectViews, requireProject, taskDetail, taskView } from './views.js';
import type { TaskRow } from './views.js';

export function mountTaskManagement(store: Store, now: () => number) {
  const management = new Hono();
  const authenticate = (context: Context) => requireMachineAuth(store, context.req.header('Authorization'));
  management.post('/foreground/start', async (context) => {
    authenticate(context);
    const body = await jsonInput(context, c.foregroundStartRequestSchema);
    const response = store.immediate(() => {
      const machineId = authenticate(context);
      const time = now();
      const saved = store.request({ machineId, actor: 'agent', operation: 'foreground_start', target: body.goalId }, body, time,
        () => c.foregroundStartResponseSchema.parse(startForeground(store, machineId, body, time)));
      validateForegroundBinding(store, machineId, body, saved.binding, time);
      return saved;
    });
    return context.json(response);
  });
  management.get('/foreground/:goalId', (context) => {
    const machineId = authenticate(context);
    const goalId = routeParam(context.req.param('goalId'), c.uuidSchema);
    const attempt = store.get<{ id: string; task_id: string; owner_pid: number }>(`SELECT a.id,a.task_id,a.owner_pid FROM foreground_goals g
      JOIN attempts a ON a.task_id=g.task_id WHERE g.machine_id=? AND g.goal_id=? AND a.execution_mode='foreground'
      ORDER BY a.claimed_at DESC,a.rowid DESC LIMIT 1`, machineId, goalId);
    return context.json(c.foregroundLookupResponseSchema.parse({ binding: attempt ? {
      goalId, pid: attempt.owner_pid, taskId: attempt.task_id, attemptId: attempt.id,
    } : null }));
  });
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
    // 旧版 Pi 扩展严格解析执行类型和会话标识。仅网页详情返回操作状态和实际 Pi 会话标识。
    return context.json(c.webTaskDetailResponseSchema.parse(taskDetail(store, id, now(), { includeSessionControl: false })));
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
