import { z } from 'zod';

export const taskStatusSchema = z.enum([
  'unscheduled', 'queued', 'running', 'review', 'done', 'interrupted', 'cancelled',
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const agentSchema = z.enum(['pi', 'claude']);
export type Agent = z.infer<typeof agentSchema>;

export const errorCodeSchema = z.enum([
  'unauthorized', 'forbidden', 'not_found', 'invalid_request', 'conflict', 'attempt_ended', 'rate_limited',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorResponseSchema = z.strictObject({
  error: z.strictObject({ code: errorCodeSchema, message: z.string() }),
});

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const LEASE_DURATION_MS = 90_000;
export const MACHINE_ONLINE_WINDOW_MS = 45_000;
