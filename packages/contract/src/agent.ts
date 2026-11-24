import { z } from 'zod';
import { nonEmptyTextSchema, okResponseSchema, projectIdSchema, requestIdSchema, textSchema, uuidSchema } from './core.js';
import { attemptKindSchema, decisionSchema, deliveryContentSchema, deliverySchema, questionSchema, taskContentSchema, taskTypeSchema } from './models.js';

import { piSessionLocatorSchema } from './session-control.js';

const gitBranch = z.string().min(1).max(1024).regex(/^[^\0\r\n]+$/u);
export const attemptWorkspaceSchema = piSessionLocatorSchema.extend({
  gitKind: z.enum(['non_git', 'primary', 'linked']),
  gitBranch: gitBranch.nullable(),
}).refine(({ gitKind, gitBranch }) => gitKind !== 'non_git' || gitBranch === null);
export type AttemptWorkspace = z.infer<typeof attemptWorkspaceSchema>;
export const agentWorkspaceRequestSchema = requestIdSchema.extend({ workspace: attemptWorkspaceSchema });
export type AgentWorkspaceRequest = z.infer<typeof agentWorkspaceRequestSchema>;

export const agentContextResponseSchema = z.strictObject({
  task: taskContentSchema.pick({ title: true, goal: true, acceptance: true, notes: true }).extend({
    id: uuidSchema, projectId: projectIdSchema, type: taskTypeSchema.default('implementation'),
  }),
  attempt: z.strictObject({ id: uuidSchema, kind: attemptKindSchema }),
  workspace: z.strictObject({
    path: z.string(), requirements: z.array(nonEmptyTextSchema),
    previous: z.strictObject({
      attemptId: uuidSchema, machineId: uuidSchema, sameMachine: z.boolean(), workspace: attemptWorkspaceSchema.nullable(),
    }).nullable().optional(),
  }),
  decisions: z.array(decisionSchema.extend({ confirmedByUser: z.literal(true) })),
  deliveries: z.array(deliverySchema), questions: z.array(questionSchema.extend({ status: z.literal('open') })),
});
export const agentControlResponseSchema = z.strictObject({
  type: taskTypeSchema, discussionEndRequested: z.boolean(), deliverySaved: z.boolean(), waitId: uuidSchema.nullable(),
});
export const agentEndDiscussionRequestSchema = requestIdSchema;
export const agentReplyRequestSchema = requestIdSchema.extend({ waitId: uuidSchema });
export type AgentControlResponse = z.infer<typeof agentControlResponseSchema>;

export const agentProgressRequestSchema = requestIdSchema.extend({ text: nonEmptyTextSchema });
export const agentProgressResponseSchema = okResponseSchema;
export const agentCreateQuestionRequestSchema = agentProgressRequestSchema.extend({ context: textSchema });
export const agentCreateQuestionResponseSchema = z.strictObject({ questionId: uuidSchema, waitId: uuidSchema.optional() });
export const agentUpdateQuestionRequestSchema = requestIdSchema.extend({ status: z.enum(['resolved', 'withdrawn']) });
export const agentUpdateQuestionResponseSchema = okResponseSchema;
export const agentDecisionRequestSchema = agentProgressRequestSchema.extend({ confirmedByUser: z.boolean() });
export const agentDecisionResponseSchema = okResponseSchema;
export const agentDeliveryRequestSchema = deliveryContentSchema.extend(requestIdSchema.shape);
export const agentDeliveryResponseSchema = z.strictObject({ deliveryId: uuidSchema, version: z.int().positive() });

export type AgentContextResponse = z.infer<typeof agentContextResponseSchema>;
export type AgentDeliveryRequest = z.infer<typeof agentDeliveryRequestSchema>;
export type AgentDeliveryResponse = z.infer<typeof agentDeliveryResponseSchema>;
