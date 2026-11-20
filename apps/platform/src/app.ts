import { Hono } from 'hono';
import type { Context } from 'hono';
import type { z } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import * as contract from '@pi-steward/contract';
import { ApiError, reject } from './errors.js';
import type { Store } from './store.js';
import { mountWeb } from './web-routes.js';
import { mountMachineRoutes } from './machine-routes.js';
import { mountStaticWeb } from './static-web.js';

export interface AppOptions {
  store: Store;
  accessPasswordHash: string;
  publicOrigin: string;
  allowLocalHttp?: boolean;
  trustProxyClientIp?: boolean;
  peerIp?: (context: Context) => string | undefined;
  now?: () => number;
  onInternalError?: () => void;
  webDir?: string;
}
export const routeParam = <T>(value: unknown, schema: z.ZodType<T>) => {
  const result = schema.safeParse(value);
  if (!result.success) reject('invalid_request', 'Invalid route parameter');
  return result.data;
};
const contentType = (context: Context) => context.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
export async function jsonInput<T>(context: Context, schema: z.ZodType<T>) {
  if (contentType(context) !== 'application/json') reject('invalid_request', 'Expected application/json');
  let input: unknown;
  try { input = await context.req.json(); } catch { reject('invalid_request', 'Malformed JSON'); }
  const result = schema.safeParse(input);
  if (!result.success) reject('invalid_request', 'Request does not match the API schema');
  return result.data;
}
export const errorBody = (code: contract.ErrorCode, message: string) => contract.errorResponseSchema.parse({ error: { code, message } });

export function createApp(options: AppOptions) {
  const app = new Hono();
  const now = options.now ?? Date.now;
  app.get('/health', (context) => {
    options.store.get('SELECT 1');
    return context.json(contract.okResponseSchema.parse({ ok: true }));
  });
  app.use('/api/v1/*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('/api/v1/*', bodyLimit({ maxSize: 2 * 1024 * 1024,
    onError: (context) => context.json(errorBody('invalid_request', 'Request body too large'), 400) }));
  app.route('/api/v1/web', mountWeb(options, now));
  app.route('/api/v1', mountMachineRoutes(options.store, now));
  if (options.webDir) mountStaticWeb(app, options.webDir);
  app.notFound((context) => context.req.path === '/api' || context.req.path.startsWith('/api/')
    ? context.json(errorBody('not_found', 'Route not found'), 404)
    : options.webDir ? context.text('Not found', 404) : context.json(errorBody('not_found', 'Route not found'), 404));
  app.onError((error, context) => {
    if (error instanceof ApiError) return context.json(errorBody(error.code, error.message), error.status);
    if (error instanceof HTTPException && error.status === 400) {
      return context.json(errorBody('invalid_request', 'Malformed request body'), 400);
    }
    options.onInternalError?.();
    return context.json(errorBody('internal_error', 'Internal server error'), 500);
  });
  return app;
}
