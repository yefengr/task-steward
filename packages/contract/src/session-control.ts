import { z } from 'zod';
import { requestIdSchema, uuidSchema } from './core.js';

export const absoluteWorkspacePathSchema = z.string().max(4096).regex(/^\/[^\0]*$/u);
export const piSessionIdSchema = z.string().max(256).regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u);
export const piSessionLocatorSchema = z.strictObject({
  path: absoluteWorkspacePathSchema, sessionId: piSessionIdSchema, sessionFile: absoluteWorkspacePathSchema,
});
export type PiSessionLocator = z.infer<typeof piSessionLocatorSchema>;
export const agentSessionRequestSchema = requestIdSchema.extend({ locator: piSessionLocatorSchema });

export const sessionOperationModeSchema = z.enum(['restart', 'restore', 'background']);
export const sessionOperationFailureSchema = z.enum([
  'session_workspace_unavailable', 'session_record_missing', 'session_config_unsupported',
  'session_stop_failed', 'session_launch_failed', 'session_timeout', 'session_source_alive', 'session_ownership_unavailable',
]);
export type SessionOperationFailure = z.infer<typeof sessionOperationFailureSchema>;
const operation = z.strictObject({ id: uuidSchema, attemptId: uuidSchema, mode: sessionOperationModeSchema });
export const webSessionOperationSchema = operation.extend({
  status: z.enum(['pending', 'succeeded', 'failed']), failure: sessionOperationFailureSchema.nullable(),
  needsExitVerification: z.literal(true).optional(),
});
export type WebSessionOperation = z.infer<typeof webSessionOperationSchema>;
export const webSessionOperationRequestSchema = requestIdSchema.extend({ attemptId: uuidSchema, mode: sessionOperationModeSchema });
export type WebSessionOperationRequest = z.infer<typeof webSessionOperationRequestSchema>;

const permission = operation.extend({ locator: piSessionLocatorSchema, validForMs: z.int().positive(),
  foregroundOwner: z.strictObject({ goalId: uuidSchema, pid: z.int().min(2).max(0x7fffffff) }).optional(),
  foregroundGit: z.strictObject({ kind: z.enum(['non_git', 'primary', 'linked']), branch: z.string().nullable() }).optional(),
});
export const launcherSessionDirectiveSchema = z.discriminatedUnion('step', [
  permission.extend({ step: z.literal('stop'), sourceEnded: z.boolean() }),
  permission.extend({ step: z.literal('launch'), replacementId: uuidSchema }),
  operation.extend({ step: z.literal('cleanup'), replacementId: uuidSchema,
    foregroundOwner: permission.shape.foregroundOwner, foregroundGit: permission.shape.foregroundGit }),
]);
export type LauncherSessionDirective = z.infer<typeof launcherSessionDirectiveSchema>;
export const launcherSessionReportSchema = z.discriminatedUnion('result', [
  requestIdSchema.extend({ result: z.literal('stopped'), step: z.literal('stop') }),
  requestIdSchema.extend({ result: z.literal('failed'), step: z.enum(['stop', 'launch', 'cleanup']), failure: sessionOperationFailureSchema }),
]);
export type LauncherSessionReport = z.infer<typeof launcherSessionReportSchema>;
