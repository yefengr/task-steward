import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { zValidator } from '@hono/zod-validator';
import * as c from '@pi-steward/contract';
import { jsonInput, routeParam } from './app.js';
import type { AppOptions } from './app.js';
import { createWebSession, deleteWebSession, LoginLimiter, loginSource, originConfig, passwordVerifier, SESSION_COOKIE, webSessionValid } from './auth.js';
import { reject } from './errors.js';
import { mountWebPairing } from './pairing-routes.js';
import { createTask, requestDiscussionEnd, taskAction, updateTask } from './tasks.js';
import { machineViews, projectViews, requireProject, taskDetail, taskView } from './views.js';
import type { TaskRow } from './views.js';

export function mountWeb(options: AppOptions, now: () => number) {
  const web = new Hono();
  const store = options.store;
  const { origin, secure } = originConfig(options.publicOrigin, options.allowLocalHttp ?? false);
  const checkPassword = passwordVerifier(options.accessPasswordHash);
  const limiter = new LoginLimiter();
  const cookie = { path: '/api/v1/web', secure, httpOnly: true, sameSite: 'Strict' } as const;
  web.use('*', async (context, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(context.req.method) && context.req.header('Origin') !== origin) {
      reject('forbidden', 'Request origin is not allowed');
    }
    await next();
  });
  web.post('/auth/login', zValidator('json', c.webLoginRequestSchema, (result) => {
    if (!result.success) reject('invalid_request', 'Expected an application/json login request');
  }), async (context) => {
    if (context.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      reject('invalid_request', 'Expected application/json');
    }
    const { password } = context.req.valid('json');
    const release = limiter.reserve(loginSource(context.req.raw, options.trustProxyClientIp ?? false, options.peerIp?.(context)), now());
    if (!await checkPassword(password)) reject('unauthorized', 'Incorrect access password');
    release();
    const { token, maxAge } = createWebSession(store, now());
    setCookie(context, SESSION_COOKIE, token, { ...cookie, maxAge });
    return context.json(c.webLoginResponseSchema.parse({ ok: true }));
  });
  web.get('/auth/me', (context) => context.json(c.webMeResponseSchema.parse({
    authenticated: webSessionValid(store, getCookie(context, SESSION_COOKIE), now()),
  })));
  web.use('*', async (context, next) => {
    if (!webSessionValid(store, getCookie(context, SESSION_COOKIE), now())) reject('unauthorized', 'Web session required');
    await next();
  });
  web.route('/pairing', mountWebPairing(store, now));
  web.post('/auth/logout', async (context) => {
    await jsonInput(context, c.webLogoutRequestSchema);
    deleteWebSession(store, getCookie(context, SESSION_COOKIE));
    deleteCookie(context, SESSION_COOKIE, cookie);
    return context.json(c.webLogoutResponseSchema.parse({ ok: true }));
  });
  web.get('/projects', (context) => context.json(c.webProjectsResponseSchema.parse({ projects: projectViews(store) })));
  web.get('/projects/:id/tasks', (context) => {
    const id = routeParam(context.req.param('id'), c.projectIdSchema);
    requireProject(store, id);
    const time = now();
    const tasks = store.all<TaskRow>('SELECT * FROM tasks WHERE project_id=? ORDER BY position', id).map((task) => taskView(store, task, time));
    return context.json(c.webProjectTasksResponseSchema.parse({ tasks }));
  });
  web.get('/machines', (context) => context.json(c.webMachinesResponseSchema.parse({ machines: machineViews(store, now()) })));
  web.get('/tasks/:id', (context) => {
    const id = routeParam(context.req.param('id'), c.uuidSchema);
    return context.json(c.webTaskDetailResponseSchema.parse(taskDetail(store, id, now())));
  });
  web.post('/tasks', async (context) => {
    const input = await jsonInput(context, c.webCreateTaskRequestSchema);
    const response = store.immediate(() => c.webTaskMutationResponseSchema.parse(createTask(store, input, now())));
    return context.json(response, 201);
  });
  web.patch('/tasks/:id', async (context) => {
    const id = routeParam(context.req.param('id'), c.uuidSchema);
    const input = await jsonInput(context, c.webUpdateTaskRequestSchema);
    return context.json(store.immediate(() => c.webTaskMutationResponseSchema.parse(updateTask(store, id, input, now()))));
  });
  web.post('/tasks/:id/end-discussion', async (context) => {
    const id = routeParam(context.req.param('id'), c.uuidSchema);
    const { attemptId } = await jsonInput(context, c.webEndDiscussionRequestSchema);
    return context.json(store.immediate(() => {
      const time = now();
      const task = requestDiscussionEnd(store, id, attemptId, 'user', time);
      return c.webTaskMutationResponseSchema.parse({ task: taskView(store, task, time) });
    }));
  });
  for (const action of ['schedule', 'unschedule', 'reschedule', 'cancel', 'accept', 'rework'] as const) {
    web.post(`/tasks/:id/${action}`, async (context) => {
      const id = routeParam(context.req.param('id'), c.uuidSchema);
      let review: { deliveryId: string; feedback?: string } | undefined;
      if (action === 'accept') review = await jsonInput(context, c.webAcceptRequestSchema);
      else if (action === 'rework') review = await jsonInput(context, c.webReworkRequestSchema);
      else await jsonInput(context, c.webTaskActionRequestSchema);
      return context.json(store.immediate(() => c.webTaskMutationResponseSchema.parse(taskAction(store, id, action, now(), review))));
    });
  }
  return web;
}
