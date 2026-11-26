import { z } from 'zod';
import { okResponseSchema, projectIdSchema, requestIdSchema, timestampSchema, tmuxSessionSchema, uuidSchema } from './core.js';
import { slotsSchema } from './models.js';
import { launcherSessionDirectiveSchema, piSessionIdSchema, piSessionLocatorSchema } from './session-control.js';
import { launcherGitOperationSchema } from './git-lifecycle.js';

export const launcherHeartbeatRequestSchema = requestIdSchema.extend({
  launcherVersion: z.string().trim().min(1).max(128), slots: slotsSchema,
  sessionControl: z.literal(true).optional(), gitLifecycle: z.literal(true).optional(),
  projects: z.array(z.strictObject({
    id: projectIdSchema, name: z.string().trim().min(1).max(500),
    path: z.string().max(4096).regex(/^\/[^\0]*$/),
  })).max(1000).refine((items) => new Set(items.map(({ id }) => id)).size === items.length),
  attempts: z.array(z.strictObject({ id: uuidSchema, tmuxSession: tmuxSessionSchema, running: z.boolean() }))
    .max(1000).refine((items) => new Set(items.map(({ id }) => id)).size === items.length),
});
export const launcherHeartbeatResponseSchema = z.strictObject({
  directives: z.array(z.strictObject({
    attemptId: uuidSchema, tmuxSession: tmuxSessionSchema, action: z.enum(['continue', 'cancel', 'unknown']),
  })),
  sessionOperations: z.array(launcherSessionDirectiveSchema).optional(),
  gitOperations: z.array(launcherGitOperationSchema).optional(),
});
export const launcherClaimRequestSchema = requestIdSchema;
export const claimedAttemptSchema = z.strictObject({
  id: uuidSchema, taskId: uuidSchema, projectId: projectIdSchema, agent: z.literal('pi'),
  sessionId: piSessionIdSchema, restoreSession: z.boolean(), sessionLocator: piSessionLocatorSchema.optional(),
  displayName: z.string().min(1).max(80), kind: z.enum(['new', 'rework']),
});
export const launcherClaimResponseSchema = z.strictObject({ attempt: claimedAttemptSchema.nullable() });
export const launcherStartedRequestSchema = requestIdSchema.extend({ tmuxSession: tmuxSessionSchema, startedAt: timestampSchema });
export const launcherExitedRequestSchema = requestIdSchema.extend({ exitCode: z.int().nullable(), endedAt: timestampSchema });
export const launcherStartedResponseSchema = okResponseSchema;
export const launcherExitedResponseSchema = okResponseSchema;

export type ClaimedAttempt = z.infer<typeof claimedAttemptSchema>;
export type LauncherHeartbeatRequest = z.infer<typeof launcherHeartbeatRequestSchema>;
export type LauncherHeartbeatResponse = z.infer<typeof launcherHeartbeatResponseSchema>;
export type LauncherClaimResponse = z.infer<typeof launcherClaimResponseSchema>;
export type LauncherStartedRequest = z.infer<typeof launcherStartedRequestSchema>;
export type LauncherExitedRequest = z.infer<typeof launcherExitedRequestSchema>;
