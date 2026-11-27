import { randomUUID } from 'node:crypto';
import { gitCommitSchema } from '@pi-steward/contract';
import type { AgentPrepareGitRequest, AttemptWorkspace, LauncherGitOperation, LauncherGitReport, ProjectGitSettings, TaskGit } from '@pi-steward/contract';
import { reject } from './errors.js';
import { requestFinalization } from './session-control.js';
import { attemptLocator, confirmedLocator, isContinuedWork, sameLocator } from './session-locator.js';
import type { Store } from './store.js';
import { requireMachine, requireProject, requireTask, taskView } from './views.js';
import type { AttemptRow } from './views.js';

export function gitState(store: Store, taskId: string): TaskGit | null {
  const row = store.get<{ snapshot: string }>('SELECT snapshot FROM task_git WHERE task_id=?', taskId);
  return row ? JSON.parse(row.snapshot) as TaskGit : null;
}
function save(store: Store, taskId: string, git: TaskGit) {
  store.run('INSERT INTO task_git VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET snapshot=excluded.snapshot', taskId, JSON.stringify(git));
}
export function projectGitSettings(store: Store, projectId: string): ProjectGitSettings {
  requireProject(store, projectId);
  const row = store.get<{ git_base_branch: string | null; git_sync_before_start: number; git_version: number }>('SELECT * FROM projects WHERE id=?', projectId)!;
  return { baseBranch: row.git_base_branch, syncBeforeStart: !!row.git_sync_before_start, version: row.git_version };
}
export function updateProjectGit(store: Store, projectId: string, input: ProjectGitSettings) {
  if (projectGitSettings(store, projectId).version !== input.version) reject('conflict', 'Project Git settings changed');
  store.run('UPDATE projects SET git_base_branch=?, git_sync_before_start=?, git_version=git_version+1 WHERE id=?', input.baseBranch, Number(input.syncBeforeStart), projectId);
  return { settings: projectGitSettings(store, projectId) };
}
export function resolvedGitSettings(store: Store, taskId: string) {
  const task = requireTask(store, taskId);
  const frozen = gitState(store, taskId);
  if (frozen) return { baseBranch: frozen.baseBranch, syncBeforeStart: frozen.syncBeforeStart };
  // git_sync_before_start 非 null 表示领取时已冻结；基准保留当时选择（可能是 null），不继承后来修改的项目默认。
  if (task.git_sync_before_start !== null) {
    return { baseBranch: task.base_branch, syncBeforeStart: !!task.git_sync_before_start };
  }
  const settings = projectGitSettings(store, task.project_id);
  return { baseBranch: task.base_branch ?? settings.baseBranch, syncBeforeStart: settings.syncBeforeStart };
}
export function freezeGitSettings(store: Store, taskId: string) {
  const task = requireTask(store, taskId);
  if (task.git_sync_before_start !== null) return;
  const settings = resolvedGitSettings(store, taskId);
  // 领取即锁定已选目标；同步完成后的具体起点提交由 prepare 再记录。
  store.run('UPDATE tasks SET base_branch=?, git_sync_before_start=? WHERE id=?',
    settings.baseBranch, Number(settings.syncBeforeStart), taskId);
}
export function prepareGit(store: Store, attempt: AttemptRow, input: AgentPrepareGitRequest) {
  const task = requireTask(store, attempt.task_id);
  if (task.type !== 'implementation' || task.status !== 'running') reject('conflict', 'Only running implementation work can prepare Git');
  const existing = gitState(store, task.id);
  if (existing) {
    if (existing.machineId !== attempt.machine_id || existing.repositoryPath !== input.repositoryPath || existing.baseBranch !== input.baseBranch ||
        existing.baseCommit !== input.baseCommit || existing.taskBranch !== input.taskBranch || existing.syncBeforeStart !== input.syncBeforeStart || existing.syncResult !== input.syncResult) {
      reject('conflict', 'Prepared Git snapshot is immutable');
    }
    return { git: existing };
  }
  const settings = resolvedGitSettings(store, task.id);
  const project = store.get<{ local_path: string }>('SELECT local_path FROM machine_projects WHERE machine_id=? AND project_id=?', attempt.machine_id, task.project_id);
  if (!project || project.local_path !== input.repositoryPath || !settings.baseBranch || input.baseBranch !== settings.baseBranch ||
      input.taskBranch === input.baseBranch || input.syncBeforeStart !== settings.syncBeforeStart ||
      (input.syncBeforeStart ? input.syncResult === 'disabled' : input.syncResult !== 'disabled')) reject('conflict', 'Git preparation does not match project configuration');
  for (const row of store.all<{ task_id: string; snapshot: string }>('SELECT * FROM task_git')) {
    const other = JSON.parse(row.snapshot) as TaskGit;
    if (other.machineId === attempt.machine_id && other.repositoryPath === input.repositoryPath && other.taskBranch === input.taskBranch) reject('conflict', 'Task branch is already assigned');
  }
  const git: TaskGit = { baseBranch: input.baseBranch, baseCommit: input.baseCommit, taskBranch: input.taskBranch,
    repositoryPath: input.repositoryPath, machineId: attempt.machine_id, syncBeforeStart: input.syncBeforeStart, syncResult: input.syncResult,
    worktreePath: null, phase: 'prepared', operationId: null, deliveryId: null, approvedCommit: null, mergedCommit: null, message: null };
  save(store, task.id, git);
  return { git };
}
export function confirmGitWorkspace(store: Store, attempt: AttemptRow, workspace: AttemptWorkspace) {
  const git = gitState(store, attempt.task_id);
  if (!git) return;
  if ((attempt.kind === 'rework' || isContinuedWork(store, attempt)) &&
      !sameLocator(confirmedLocator(attempt) ?? attemptLocator(attempt), workspace)) {
    reject('conflict', 'Git rework must retain the original confirmed session and workspace');
  }
  if (git.machineId !== attempt.machine_id || workspace.gitKind !== 'linked' || workspace.gitBranch !== git.taskBranch ||
      !workspace.gitRoot || workspace.gitRoot === git.repositoryPath ||
      (workspace.path !== workspace.gitRoot && !workspace.path.startsWith(`${workspace.gitRoot}/`)) ||
      (git.worktreePath !== null && git.worktreePath !== workspace.gitRoot) || !['prepared', 'ready', 'needs_rework'].includes(git.phase)) {
    reject('conflict', 'Workspace does not match the dedicated prepared Git branch');
  }
  for (const row of store.all<{ task_id: string; snapshot: string }>('SELECT * FROM task_git WHERE task_id<>?', attempt.task_id)) {
    const other = JSON.parse(row.snapshot) as TaskGit;
    if (other.machineId === git.machineId && other.worktreePath === workspace.gitRoot) reject('conflict', 'Worktree belongs to another task');
  }
  save(store, attempt.task_id, { ...git, worktreePath: workspace.gitRoot, phase: 'ready' });
  store.run('UPDATE attempts SET confirmed_git_root=? WHERE id=?', workspace.gitRoot, attempt.id);
}
export function checkGitDelivery(store: Store, attempt: AttemptRow, input: { baseCommit?: string; commit?: string }) {
  const git = gitState(store, attempt.task_id);
  if (!git) return;
  if (!['ready', 'needs_rework'].includes(git.phase) || !git.worktreePath || git.machineId !== attempt.machine_id ||
      attempt.confirmed_git_root !== git.worktreePath || attempt.confirmed_git_branch !== git.taskBranch ||
      !attempt.confirmed_session_id || !attempt.confirmed_session_file || !attempt.confirmed_workspace_path ||
      (attempt.confirmed_workspace_path !== git.worktreePath && !attempt.confirmed_workspace_path.startsWith(`${git.worktreePath}/`)) || input.baseCommit !== git.baseCommit || !gitCommitSchema.safeParse(input.commit).success) {
    reject('conflict', 'Delivery requires the prepared workspace and exact Git commits');
  }
}
export function gitLocked(store: Store, taskId: string) {
  const git = gitState(store, taskId);
  return !!git && ['awaiting_merge', 'merge_blocked', 'cleanup_pending', 'cleanup_blocked', 'complete'].includes(git.phase);
}
function idle(store: Store, taskId: string, merging = false) {
  return !store.get(`SELECT 1 FROM attempts WHERE task_id=? AND ended_at IS NULL
    AND (?=0 OR execution_mode='foreground' OR settled_at IS NULL)`, taskId, Number(merging)) &&
    !store.get("SELECT 1 FROM session_operations WHERE task_id=? AND step IN ('stop','launch','cleanup')", taskId);
}
export function acceptGit(store: Store, taskId: string, deliveryId: string) {
  const git = gitState(store, taskId);
  if (!git) return false;
  const task = requireTask(store, taskId);
  const delivery = store.get<{ commit: string; attempt_id: string }>('SELECT "commit", attempt_id FROM deliveries WHERE id=? AND task_id=?', deliveryId, taskId)!;
  if (!git.worktreePath || !['ready', 'needs_rework'].includes(git.phase)) reject('conflict', 'Git task is not ready for acceptance');
  const id = randomUUID();
  const operation: LauncherGitOperation = { id, taskId, projectId: task.project_id, deliveryId, baseBranch: git.baseBranch,
    baseCommit: git.baseCommit, taskBranch: git.taskBranch, repositoryPath: git.repositoryPath, worktreePath: git.worktreePath,
    approvedCommit: delivery.commit, mergedCommit: null, phase: 'merge' };
  const source = store.get<AttemptRow>('SELECT * FROM attempts WHERE task_id=? AND id=(SELECT attempt_id FROM deliveries WHERE id=?)', taskId, deliveryId);
  if (source?.execution_mode === 'foreground' && source.goal_id && source.owner_pid) {
    operation.foregroundOwner = { goalId: source.goal_id, pid: source.owner_pid };
  }
  store.run('INSERT INTO git_operations VALUES (?,?,?,?,?)', id, taskId, git.machineId, JSON.stringify(operation), 'merge');
  save(store, taskId, { ...git, operationId: id, deliveryId, approvedCommit: delivery.commit, mergedCommit: null, phase: 'awaiting_merge', message: null });
  store.run("UPDATE tasks SET lifecycle_phase='merging',lifecycle_message=NULL WHERE id=?", taskId);
  return true;
}
export function gitDirectives(store: Store, machineId: string): LauncherGitOperation[] {
  return store.all<{ authorization: string; phase: 'merge' | 'cleanup'; task_id: string; id: string }>("SELECT * FROM git_operations WHERE machine_id=? AND phase IN ('merge','cleanup')", machineId).flatMap((row) => {
    const git = gitState(store, row.task_id);
    if (!git || git.operationId !== row.id || !idle(store, row.task_id, row.phase === 'merge') ||
        (row.phase === 'merge' ? git.phase !== 'awaiting_merge' : git.phase !== 'cleanup_pending')) return [];
    const operation = JSON.parse(row.authorization) as LauncherGitOperation;
    if (operation.foregroundOwner && !requireMachine(store, machineId).foreground_control) return [];
    return [{ ...operation, phase: row.phase, mergedCommit: git.mergedCommit }];
  });
}
export function reportGit(store: Store, machineId: string, id: string, input: LauncherGitReport, now: number) {
  const row = store.get<{ machine_id: string; task_id: string; phase: string }>('SELECT * FROM git_operations WHERE id=?', id) ?? reject('not_found', 'Git operation not found');
  if (row.machine_id !== machineId) reject('forbidden', 'Git operation belongs to another machine');
  const git = gitState(store, row.task_id)!;
  if (git.operationId !== id || !gitDirectives(store, machineId).some((operation) => operation.id === id)) reject('conflict', 'Git operation is no longer authorized');
  let next: TaskGit = { ...git, message: input.message ?? null };
  let phase = row.phase;
  if (input.outcome === 'merged' || input.outcome === 'complete') {
    if (input.mergedCommit !== git.approvedCommit || (input.outcome === 'merged' ? phase !== 'merge' : phase !== 'cleanup' || git.mergedCommit !== git.approvedCommit)) reject('conflict', 'Successful report must match the exact accepted commit and stage');
    next = { ...next, mergedCommit: input.mergedCommit, phase: input.outcome === 'merged' ? 'cleanup_pending' : 'complete' };
    phase = input.outcome === 'merged' ? 'cleanup' : 'complete';
    if (phase === 'complete') store.run("UPDATE tasks SET status='done',lifecycle_phase='complete',lifecycle_message=NULL, version=version+1, updated_at=? WHERE id=?", now, row.task_id);
    else store.run("UPDATE tasks SET accepted_at=?,lifecycle_phase='cleanup_pending' WHERE id=?", now, row.task_id);
  } else if (input.outcome === 'needs_rework') {
    if (phase !== 'merge') reject('conflict', 'Merged work can only retry cleanup');
    next.phase = 'needs_rework'; phase = 'stopped';
    store.run('UPDATE tasks SET lifecycle_phase=NULL,lifecycle_message=NULL WHERE id=? AND accepted_at IS NULL', row.task_id);
    store.run("UPDATE tasks SET status='queued', machine_id=?, rework_pending=1, version=version+1, updated_at=? WHERE id=?", machineId, now, row.task_id);
  } else {
    next.phase = phase === 'merge' ? 'merge_blocked' : 'cleanup_blocked'; phase = 'stopped';
  }
  store.run('UPDATE git_operations SET phase=? WHERE id=?', phase, id);
  save(store, row.task_id, next);
  if (input.outcome === 'merged') requestFinalization(store, row.task_id, now);
  else if (input.outcome === 'blocked') store.run('UPDATE tasks SET lifecycle_phase=?,lifecycle_message=? WHERE id=?', row.phase === 'merge' ? 'merge_blocked' : 'cleanup_blocked', next.message, row.task_id);
  store.event(row.task_id, 'launcher', null, 'git_report', { operationId: id, ...input }, now);
  return { ok: true } as const;
}
export function retryGit(store: Store, taskId: string, now: number) {
  const git = gitState(store, taskId);
  const task = requireTask(store, taskId);
  if (task.accepted_at !== null && task.lifecycle_phase === 'cleanup_blocked' && (!git || store.get('SELECT 1 FROM attempts WHERE task_id=? AND ended_at IS NULL', taskId))) {
    requestFinalization(store, taskId, now);
    return { task: taskView(store, requireTask(store, taskId), now) };
  }
  if (!git || !git.operationId || !['merge_blocked', 'cleanup_blocked'].includes(git.phase) || !idle(store, taskId, !git.mergedCommit)) reject('conflict', 'Only an idle blocked Git operation can retry');
  const previous = store.get<{ authorization: string; phase: string }>('SELECT * FROM git_operations WHERE id=? AND task_id=?', git.operationId, taskId);
  if (!previous || previous.phase !== 'stopped') reject('conflict', 'Git operation changed');
  const id = randomUUID();
  const phase = git.mergedCommit ? 'cleanup' : 'merge';
  const operation = { ...JSON.parse(previous.authorization) as LauncherGitOperation, id, phase, mergedCommit: git.mergedCommit };
  store.run('INSERT INTO git_operations VALUES (?,?,?,?,?)', id, taskId, git.machineId, JSON.stringify(operation), phase);
  save(store, taskId, { ...git, operationId: id, phase: phase === 'merge' ? 'awaiting_merge' : 'cleanup_pending', message: null });
  store.run('UPDATE tasks SET lifecycle_phase=?,lifecycle_message=NULL WHERE id=?', phase === 'merge' ? 'merging' : 'cleanup_pending', taskId);
  store.event(taskId, 'user', null, 'git_retry', { operationId: id }, now);
  return { task: taskView(store, requireTask(store, taskId), now) };
}
