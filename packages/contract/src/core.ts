import { z } from 'zod';

export const taskStatusSchema = z.enum([
  'unscheduled', 'queued', 'running', 'review', 'done', 'interrupted', 'cancelled',
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export const agentSchema = z.enum(['pi', 'claude']);
export type Agent = z.infer<typeof agentSchema>;
export const errorCodeSchema = z.enum([
  'unauthorized', 'forbidden', 'not_found', 'invalid_request', 'conflict', 'machine_required',
  'attempt_ended', 'rate_limited', 'internal_error',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export const errorResponseSchema = z.strictObject({
  error: z.strictObject({ code: errorCodeSchema, message: z.string() }),
});
export const uuidSchema = z.uuid();
export const projectIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const timestampSchema = z.int().nonnegative();
export const textSchema = z.string().max(100_000);
export const nonEmptyTextSchema = textSchema.refine((value) => value.trim().length > 0);
export const machineTokenSchema = z.string().regex(/^stm_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const tmuxSessionSchema = z.string().startsWith('steward-')
  .refine((value) => uuidSchema.safeParse(value.slice('steward-'.length)).success);
export const emptyRequestSchema = z.strictObject({});
export const okResponseSchema = z.strictObject({ ok: z.literal(true) });
export const requestIdSchema = z.strictObject({ requestId: uuidSchema });

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const LEASE_DURATION_MS = 90_000;
export const MACHINE_ONLINE_WINDOW_MS = 45_000;
