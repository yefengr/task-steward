import { z } from 'zod';
import { nonEmptyTextSchema, okResponseSchema, projectIdSchema, requestIdSchema, textSchema, uuidSchema } from './core.js';
import { attemptKindSchema, decisionSchema, deliveryContentSchema, deliverySchema, questionSchema, taskContentSchema } from './models.js';

export const agentContextResponseSchema = z.strictObject({
  task: taskContentSchema.pick({ title: true, goal: true, acceptance: true, notes: true }).extend({
    id: uuidSchema, projectId: projectIdSchema,
  }),
  attempt: z.strictObject({ id: uuidSchema, kind: attemptKindSchema }),
  workspace: z.strictObject({ path: z.string(), requirements: z.array(nonEmptyTextSchema) }),
  decisions: z.array(decisionSchema.extend({ confirmedByUser: z.literal(true) })),
  deliveries: z.array(deliverySchema), questions: z.array(questionSchema.extend({ status: z.literal('open') })),
});
export const agentProgressRequestSchema = requestIdSchema.extend({ text: nonEmptyTextSchema });
export const agentProgressResponseSchema = okResponseSchema;
export const agentCreateQuestionRequestSchema = agentProgressRequestSchema.extend({ context: textSchema });
export const agentCreateQuestionResponseSchema = z.strictObject({ questionId: uuidSchema });
export const agentUpdateQuestionRequestSchema = requestIdSchema.extend({ status: z.enum(['resolved', 'withdrawn']) });
export const agentUpdateQuestionResponseSchema = okResponseSchema;
export const agentDecisionRequestSchema = agentProgressRequestSchema.extend({ confirmedByUser: z.boolean() });
export const agentDecisionResponseSchema = okResponseSchema;
export const agentDeliveryRequestSchema = deliveryContentSchema.extend(requestIdSchema.shape);
export const agentDeliveryResponseSchema = z.strictObject({ deliveryId: uuidSchema, version: z.int().positive() });

export type AgentContextResponse = z.infer<typeof agentContextResponseSchema>;
export type AgentDeliveryRequest = z.infer<typeof agentDeliveryRequestSchema>;
export type AgentDeliveryResponse = z.infer<typeof agentDeliveryResponseSchema>;
