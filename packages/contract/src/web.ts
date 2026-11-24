import { z } from 'zod';
import { emptyRequestSchema, nonEmptyTextSchema, okResponseSchema, projectIdSchema, taskStatusSchema, timestampSchema, uuidSchema } from './core.js';
import { attemptSchema, decisionSchema, deliverySchema, progressSchema, questionSchema, slotsSchema, taskContentSchema, taskEventSchema, taskSchema } from './models.js';
import { webSessionOperationSchema } from './session-control.js';

export const webLoginRequestSchema = z.strictObject({ password: z.string().min(1).max(1024) });
export const webLoginResponseSchema = okResponseSchema;
export const webLogoutRequestSchema = emptyRequestSchema;
export const webLogoutResponseSchema = okResponseSchema;
export const webMeResponseSchema = z.strictObject({ authenticated: z.boolean() });
export const webProjectSchema = z.strictObject({
  id: projectIdSchema, name: z.string(), lastMachineId: uuidSchema.nullable(), createdAt: timestampSchema,
  counts: z.record(taskStatusSchema, z.int().nonnegative()),
});
export const webProjectsResponseSchema = z.strictObject({ projects: z.array(webProjectSchema) });
export const webProjectTasksResponseSchema = z.strictObject({ tasks: z.array(taskSchema) });
export const webTaskDetailResponseSchema = z.strictObject({
  task: taskSchema, decisions: z.array(decisionSchema), progress: z.array(progressSchema),
  questions: z.array(questionSchema), deliveries: z.array(deliverySchema), attempts: z.array(attemptSchema),
  events: z.array(taskEventSchema), sessionOperation: webSessionOperationSchema.optional(),
});
export const webCreateTaskRequestSchema = taskContentSchema.partial().required({ title: true }).extend({
  projectId: projectIdSchema,
});
export const webUpdateTaskRequestSchema = taskContentSchema.omit({ type: true }).partial().extend({ version: z.int().positive() })
  .refine((input) => Object.keys(input).some((key) => key !== 'version'));
export const webTaskMutationResponseSchema = z.strictObject({ task: taskSchema });
export const webTaskActionRequestSchema = emptyRequestSchema;
export const webEndDiscussionRequestSchema = z.strictObject({ attemptId: uuidSchema });
export const webAcceptRequestSchema = z.strictObject({ deliveryId: uuidSchema });
export const webReworkRequestSchema = webAcceptRequestSchema.extend({ feedback: nonEmptyTextSchema });
export const webMachineSchema = z.strictObject({
  id: uuidSchema, name: z.string(), online: z.boolean(), slots: slotsSchema, occupiedSlots: z.int().nonnegative(),
  lastSeenAt: timestampSchema.nullable(), launcherVersion: z.string().nullable(), revokedAt: timestampSchema.nullable(),
  projects: z.array(z.strictObject({ id: projectIdSchema, name: z.string() })),
  activeTasks: z.array(z.strictObject({ id: uuidSchema, projectId: projectIdSchema, title: z.string(), attemptId: uuidSchema })),
});
export const webMachinesResponseSchema = z.strictObject({ machines: z.array(webMachineSchema) });

export type WebCreateTaskRequest = z.infer<typeof webCreateTaskRequestSchema>;
export type WebUpdateTaskRequest = z.infer<typeof webUpdateTaskRequestSchema>;
export type WebTaskDetailResponse = z.infer<typeof webTaskDetailResponseSchema>;
export type WebTaskMutationResponse = z.infer<typeof webTaskMutationResponseSchema>;
export type WebProject = z.infer<typeof webProjectSchema>;
export type WebMachine = z.infer<typeof webMachineSchema>;
