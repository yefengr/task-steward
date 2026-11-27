import { z } from 'zod';
import { projectIdSchema, requestIdSchema, textSchema, uuidSchema } from './core.js';

// 这里只校验浏览器可用的 ref 语法；执行端仍须用 git check-ref-format 复核。
export const gitBranchSchema = z.string().min(1).max(255).refine((value) =>
  !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.') &&
  !value.includes('..') && !value.includes('@{') && !value.includes('//') && value !== '@' &&
  !/[\x00-\x20\x7f~^:?*\[\\]/u.test(value) &&
  value.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock')));
export const gitCommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
export const gitPathSchema = z.string().max(4096).regex(/^\/[^\0\r\n]+$/u);
export const gitSyncResultSchema = z.enum(['disabled', 'no_upstream', 'synced']);
export const projectGitSettingsSchema = z.strictObject({
  baseBranch: gitBranchSchema.nullable(), syncBeforeStart: z.boolean(), version: z.int().positive(),
});
export const webUpdateProjectGitRequestSchema = projectGitSettingsSchema;
export const webProjectGitResponseSchema = z.strictObject({ settings: projectGitSettingsSchema });
export const resolvedGitSettingsSchema = z.strictObject({
  baseBranch: gitBranchSchema.nullable(), syncBeforeStart: z.boolean(),
});
export const taskGitPhaseSchema = z.enum([
  'prepared', 'ready', 'awaiting_merge', 'merge_blocked', 'needs_rework',
  'cleanup_pending', 'cleanup_blocked', 'complete',
]);
export const taskGitSchema = z.strictObject({
  baseBranch: gitBranchSchema, baseCommit: gitCommitSchema, taskBranch: gitBranchSchema,
  repositoryPath: gitPathSchema, worktreePath: gitPathSchema.nullable(), machineId: uuidSchema,
  syncBeforeStart: z.boolean(), syncResult: gitSyncResultSchema, phase: taskGitPhaseSchema,
  operationId: uuidSchema.nullable(), deliveryId: uuidSchema.nullable(),
  approvedCommit: gitCommitSchema.nullable(), mergedCommit: gitCommitSchema.nullable(), message: textSchema.nullable(),
});
export const agentPrepareGitRequestSchema = requestIdSchema.extend({
  baseBranch: gitBranchSchema, baseCommit: gitCommitSchema, taskBranch: gitBranchSchema,
  repositoryPath: gitPathSchema, syncBeforeStart: z.boolean(), syncResult: gitSyncResultSchema,
});
export const agentPrepareGitResponseSchema = z.strictObject({ git: taskGitSchema });
export const launcherGitOperationSchema = z.strictObject({
  id: uuidSchema, taskId: uuidSchema, projectId: projectIdSchema, deliveryId: uuidSchema,
  baseBranch: gitBranchSchema, baseCommit: gitCommitSchema, taskBranch: gitBranchSchema,
  repositoryPath: gitPathSchema, worktreePath: gitPathSchema, approvedCommit: gitCommitSchema,
  mergedCommit: gitCommitSchema.nullable(), phase: z.enum(['merge', 'cleanup']),
});
export const launcherGitReportSchema = requestIdSchema.extend({
  outcome: z.enum(['merged', 'complete', 'blocked', 'needs_rework']),
  mergedCommit: gitCommitSchema.optional(), message: textSchema.optional(),
});
export type ProjectGitSettings = z.infer<typeof projectGitSettingsSchema>;
export type TaskGit = z.infer<typeof taskGitSchema>;
export type AgentPrepareGitRequest = z.infer<typeof agentPrepareGitRequestSchema>;
export type LauncherGitOperation = z.infer<typeof launcherGitOperationSchema>;
export type LauncherGitReport = z.infer<typeof launcherGitReportSchema>;
