import { z } from 'zod';
import { machineTokenSchema } from './core.js';
import { launcherHeartbeatRequestSchema } from './launcher.js';
import { slotsSchema } from './models.js';

const absolutePath = z.string().max(4096).regex(/^\/[^\0]*$/);
const tmuxArgument = z.string().max(4096).refine((arg) => !arg.includes('\0') && !arg.endsWith(';'));

export const localConfigSchema = z.strictObject({
  platformUrl: z.url(),
  allowHttpLoopback: z.literal(true).optional(),
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
