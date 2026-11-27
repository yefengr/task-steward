import { z } from 'zod';
import { projectIdSchema, requestIdSchema, textSchema, uuidSchema } from './core.js';
import { taskTypeSchema, titleSchema } from './models.js';
import { absoluteWorkspacePathSchema, piSessionLocatorSchema } from './session-control.js';

export const processIdSchema = z.int().min(2).max(0x7fffffff);
export const foregroundOwnerSchema = z.strictObject({ goalId: uuidSchema, pid: processIdSchema });
export const foregroundBindingSchema = foregroundOwnerSchema.extend({ taskId: uuidSchema, attemptId: uuidSchema });
export type ForegroundBinding = z.infer<typeof foregroundBindingSchema>;
export const foregroundStartRequestSchema = requestIdSchema.extend({
  goalId: uuidSchema, ownerId: uuidSchema, pid: processIdSchema, projectId: projectIdSchema,
  projectName: z.string().trim().min(1).max(500), registeredPath: absoluteWorkspacePathSchema,
  title: titleSchema, goal: textSchema, acceptance: textSchema, notes: textSchema,
  type: taskTypeSchema.default('implementation'), locator: piSessionLocatorSchema,
  previousAttemptId: uuidSchema.optional(), previousOwnerPid: processIdSchema.optional(),
});
export type ForegroundStartRequest = z.infer<typeof foregroundStartRequestSchema>;
export const foregroundStartResponseSchema = z.strictObject({ binding: foregroundBindingSchema });
// 仅返回定位元数据，不返回 ownerId，也不授予执行权限。
export const foregroundLookupResponseSchema = z.strictObject({ binding: foregroundBindingSchema.nullable() });
export const foregroundHeartbeatRequestSchema = requestIdSchema;
export const foregroundSettleRequestSchema = requestIdSchema;
export const foregroundInterruptRequestSchema = requestIdSchema;
