import { z } from 'zod';
import { projectIdSchema, uuidSchema } from './core.js';
import { taskContentSchema } from './models.js';

const editableContent = taskContentSchema.pick({ title: true, goal: true, acceptance: true, notes: true });
const creatableContent = editableContent.extend({ type: taskContentSchema.shape.type });
const mutationSource = { requestId: uuidSchema, sessionId: z.string().trim().min(1).max(200) };

export const managedCreateTaskRequestSchema = creatableContent.partial().required({ title: true }).extend({
  projectId: projectIdSchema, ...mutationSource,
});
export const managedUpdateTaskRequestSchema = editableContent.partial().extend({
  version: z.int().positive(), ...mutationSource,
}).refine(({ title, goal, acceptance, notes }) => [title, goal, acceptance, notes].some((value) => value !== undefined));
