import { z } from 'zod';
import { machineTokenSchema } from './core.js';
import { launcherHeartbeatRequestSchema } from './launcher.js';
import { slotsSchema } from './models.js';

export const DEFAULT_LOCAL_CONFIG = 'pi-steward/config.json';
export const LEGACY_LOCAL_CONFIG = '.config/pi-steward/config.json';

export const platformProxySchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('system') }),
  z.strictObject({ mode: z.literal('direct') }),
  z.strictObject({ mode: z.literal('custom'), url: z.url().max(2048).refine((value) => {
    if (!/^http:\/\/(?:\[[\da-f:]+\]|[\w.-]+):[1-9]\d{0,4}\/?$/iu.test(value)) return false;
    try { return new URL(value).protocol === 'http:'; } catch { return false; }
  }) }),
]);

const absolutePath = z.string().max(4096).regex(/^\/[^\0]*$/);
const tmuxArgument = z.string().max(4096).refine((arg) => !arg.includes('\0') && !arg.endsWith(';'));

export const localConfigSchema = z.strictObject({
  platformUrl: z.url(),
  allowHttpLoopback: z.literal(true).optional(),
  proxy: platformProxySchema.optional(),
  machineToken: machineTokenSchema,
  slots: slotsSchema,
  projects: launcherHeartbeatRequestSchema.shape.projects,
  pi: z.strictObject({ command: tmuxArgument.pipe(z.string().min(1)), extraArgs: z.array(tmuxArgument).max(64) }),
  path: z.array(absolutePath.refine((path) => !path.includes(':'))).min(1).max(128),
}).refine(({ platformUrl, allowHttpLoopback }) => {
  let url: URL;
  try { url = new URL(platformUrl); } catch { return false; }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
  return url.protocol === 'https:' || (allowHttpLoopback === true && url.protocol === 'http:' &&
    ['127.0.0.1', '[::1]'].includes(url.hostname));
}, { path: ['platformUrl'] });

export type LocalConfig = z.infer<typeof localConfigSchema>;
export type PlatformProxy = z.infer<typeof platformProxySchema>;
