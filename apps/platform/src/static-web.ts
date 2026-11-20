import type { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { projectIdSchema, uuidSchema } from '@pi-steward/contract';

export function mountStaticWeb(app: Hono, root: string) {
  const entry = serveStatic({ root, path: 'index.html', onFound: (_path, context) => {
    context.header('Cache-Control', 'no-cache');
  } });
  app.get('/', entry);
  app.get('/login', entry);
  app.get('/machines', entry);
  app.get('/pair', entry);
  app.get('/projects/:projectId', (context, next) => {
    if (!projectIdSchema.safeParse(context.req.param('projectId')).success) return next();
    return entry(context, next);
  });
  app.get('/tasks/:taskId', (context, next) => {
    if (!uuidSchema.safeParse(context.req.param('taskId')).success) return next();
    return entry(context, next);
  });
  const asset = serveStatic({ root });
  app.get('/assets/*', asset);
  app.get('/steward.svg', asset);
  app.get('/steward-192.png', asset);
  app.get('/steward-512.png', asset);
  app.get('/manifest.webmanifest', serveStatic({ root, onFound: (_path, context) => {
    context.header('Content-Type', 'application/manifest+json');
  } }));
}
