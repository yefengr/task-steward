import { z } from 'zod';
import { agentSchema, nonEmptyTextSchema, projectIdSchema, taskStatusSchema, textSchema, timestampSchema, tmuxSessionSchema, uuidSchema } from './core.js';
import { piSessionIdSchema } from './session-control.js';

export const titleSchema = z.string().trim().min(1).max(500);
export const taskTypeSchema = z.enum(['discussion', 'implementation']);
export type TaskType = z.infer<typeof taskTypeSchema>;
export const taskPrioritySchema = z.enum(['high', 'normal', 'low']);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export const taskDifficultySchema = z.enum(['unassessed', 'simple', 'medium', 'complex']);
export type TaskDifficulty = z.infer<typeof taskDifficultySchema>;
export const attemptKindSchema = z.enum(['new', 'rework', 'resume']);
export const attemptResultSchema = z.enum(['delivered', 'interrupted', 'cancelled']);
export const waitingReasonSchema = z.enum([
  'previous_attempt_active', 'machine_unassigned', 'machine_project_unregistered', 'machine_offline', 'slots_full',
]);
export const questionStatusSchema = z.enum(['open', 'resolved', 'withdrawn']);
export const slotsSchema = z.int().min(0).max(1000);
export const taskContentSchema = z.strictObject({
  title: titleSchema, goal: textSchema, acceptance: textSchema, notes: textSchema,
  agent: agentSchema, machineId: uuidSchema.nullable(), type: taskTypeSchema,
  priority: taskPrioritySchema, difficulty: taskDifficultySchema,
});
export const taskSchema = taskContentSchema.extend({
  id: uuidSchema, projectId: projectIdSchema, status: taskStatusSchema, reworkPending: z.boolean(),
  position: z.int().positive(), createdBy: z.enum(['user', 'agent']), version: z.int().positive(),
  createdAt: timestampSchema, updatedAt: timestampSchema, waiting: waitingReasonSchema.nullable(),
  needsVerification: z.boolean(), needsResponse: z.boolean(), discussionEndRequested: z.boolean().default(false),
  type: taskTypeSchema.default('implementation'),
  priority: taskPrioritySchema.default('normal'), difficulty: taskDifficultySchema.default('unassessed'),
});
export const attemptSchema = z.strictObject({
  id: uuidSchema, taskId: uuidSchema, machineId: uuidSchema, machineName: z.string(), agent: agentSchema,
  kind: attemptKindSchema, sessionId: piSessionIdSchema, tmuxSession: tmuxSessionSchema.nullable(),
  claimedAt: timestampSchema, startedAt: timestampSchema.nullable(), leaseExpiresAt: timestampSchema,
  cancelRequested: z.boolean(), endedAt: timestampSchema.nullable(),
  exitCode: z.int().nullable(), result: attemptResultSchema.nullable(), needsVerification: z.boolean(),
});
export const deliveryContentSchema = z.strictObject({
  summary: nonEmptyTextSchema, done: z.array(textSchema), notCovered: z.array(textSchema),
  verification: z.array(textSchema), howTo: z.array(textSchema), issues: z.array(textSchema),
  baseCommit: textSchema.optional(), commit: textSchema.optional(), reportRef: textSchema.optional(),
});
export const deliverySchema = deliveryContentSchema.extend({
  id: uuidSchema, taskId: uuidSchema, attemptId: uuidSchema, version: z.int().positive(),
  review: z.enum(['accepted', 'rework']).nullable(), feedback: textSchema.nullable(),
  reviewedAt: timestampSchema.nullable(), createdAt: timestampSchema,
});
export const decisionSchema = z.strictObject({
  id: uuidSchema, taskId: uuidSchema, attemptId: uuidSchema.nullable(), text: nonEmptyTextSchema,
  confirmedByUser: z.boolean(), createdAt: timestampSchema,
});
export const progressSchema = z.strictObject({
  id: uuidSchema, taskId: uuidSchema, attemptId: uuidSchema, text: nonEmptyTextSchema, createdAt: timestampSchema,
});
export const questionSchema = progressSchema.extend({
  context: textSchema, status: questionStatusSchema, updatedAt: timestampSchema,
});
export const taskEventSchema = z.strictObject({
  id: uuidSchema, taskId: uuidSchema, attemptId: uuidSchema.nullable(),
  actor: z.enum(['user', 'launcher', 'agent']), kind: z.string(),
  payload: z.record(z.string(), z.json()), createdAt: timestampSchema,
});

export type Task = z.infer<typeof taskSchema>;
export type Attempt = z.infer<typeof attemptSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
export type WaitingReason = z.infer<typeof waitingReasonSchema>;
