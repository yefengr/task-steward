import type { TaskGit } from '@pi-steward/contract';

// 已验收交付的集成阶段与核心 review 状态并存；前者才是用户当前需要理解的状态。
const integrationPhases = new Set<TaskGit['phase']>([
  'awaiting_merge', 'merge_blocked', 'needs_rework', 'cleanup_pending', 'cleanup_blocked', 'complete',
]);
const activeOperationPhases = new Set<TaskGit['phase']>([
  'awaiting_merge', 'merge_blocked', 'cleanup_pending', 'cleanup_blocked',
]);

export const isIntegrationPhase = (phase: TaskGit['phase']) => integrationPhases.has(phase);
export const isGitOperationActive = (git?: Pick<TaskGit, 'phase'> | null) =>
  Boolean(git && activeOperationPhases.has(git.phase));
export const isGitRetryBlocked = (git?: Pick<TaskGit, 'phase'> | null) =>
  git?.phase === 'merge_blocked' || git?.phase === 'cleanup_blocked';
