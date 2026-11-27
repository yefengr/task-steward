import { z } from 'zod';
import { nonEmptyTextSchema, requestIdSchema, timestampSchema, uuidSchema } from './core.js';

export const lifecyclePhaseSchema = z.enum([
  'working', 'delivered', 'settled', 'pausing', 'paused', 'merging', 'merge_blocked',
  'cleanup_pending', 'cleanup_blocked', 'complete',
]);
export const taskLifecycleSchema = z.strictObject({
  phase: lifecyclePhaseSchema, acceptedAt: timestampSchema.nullable(), message: z.string().nullable(),
});
export const workPermissionSchema = z.strictObject({
  workRevision: z.int().nonnegative().optional(), settled: z.boolean().optional(),
  implementationAllowed: z.boolean().optional(), recordAllowed: z.boolean().optional(),
  phase: lifecyclePhaseSchema.optional(), latestDeliveryId: uuidSchema.nullable().optional(),
});
export const agentSettleRequestSchema = requestIdSchema;
export const agentContinueRequestSchema = requestIdSchema.extend({
  deliveryId: uuidSchema, reason: nonEmptyTextSchema, authorizedByUser: z.literal(true),
});
export const agentContinueResponseSchema = z.strictObject({ workRevision: z.int().nonnegative() });
export type TaskLifecycle = z.infer<typeof taskLifecycleSchema>;
export type AgentContinueRequest = z.infer<typeof agentContinueRequestSchema>;
