import { randomUUID } from 'node:crypto';
import type { TaskStatus, WebCreateTaskRequest, WebUpdateTaskRequest } from '@pi-steward/contract';
import { reject } from './errors.js';
import { acceptGit, gitLocked, gitState, projectGitSettings } from './git-lifecycle.js';
import { requireNoPendingSessionOperation } from './session-control.js';
import type { Store } from './store.js';
import { activeAttempt, executionMachine, requireMachine, requireProject, requireTask, taskView } from './views.js';

type TaskMutationSource = { machineId: string; sessionId: string };

export function createTask(store: Store, input: WebCreateTaskRequest, now: number, source?: TaskMutationSource) {
  requireProject(store, input.projectId);
  if (input.agent === 'claude') reject('invalid_request', 'Claude tasks are not supported');
  if (input.machineId) requireMachine(store, input.machineId);
  const id = randomUUID();
  const actor = source ? 'agent' : 'user';
  store.run(`INSERT INTO tasks (id, project_id, title, goal, acceptance, notes, agent, machine_id, type,
    status, position, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'unscheduled',
      (SELECT COALESCE(MAX(position),0)+1 FROM tasks WHERE project_id=?),?,?,?)`,
  id, input.projectId, input.title, input.goal ?? '', input.acceptance ?? '', input.notes ?? '',
  input.agent ?? 'pi', input.machineId ?? null, input.type ?? 'implementation', input.projectId, actor, now, now);
  store.run('UPDATE tasks SET base_branch=? WHERE id=?', input.baseBranch ?? null, id);
  store.event(id, actor, null, 'created', { to: 'unscheduled', ...source }, now);
  return { task: taskView(store, requireTask(store, id), now) };
}

export function requestDiscussionEnd(store: Store, taskId: string, attemptId: string, actor: 'user' | 'agent', now: number) {
  const task = requireTask(store, taskId);
  requireNoPendingSessionOperation(store, taskId, now);
  const active = activeAttempt(store, taskId);
  if (task.type !== 'discussion' || active?.id !== attemptId || active.cancel_requested ||
      (task.status !== 'running' && (actor === 'user' || active.discussion_end_requested_at === null))) {
    reject('conflict', 'Only the active discussion attempt can be ended');
  }
  if (active.discussion_end_requested_at === null) {
    store.run('UPDATE attempts SET discussion_end_requested_at=? WHERE id=?', now, active.id);
    store.event(task.id, actor, active.id, 'discussion_end_requested', {}, now);
  }
  return task;
}

export function updateTask(store: Store, id: string, input: WebUpdateTaskRequest, now: number, source?: TaskMutationSource) {
  const task = requireTask(store, id);
  if (task.status === 'cancelled' || task.status === 'done' || task.version !== input.version) {
    reject('conflict', 'Task is closed or its version changed');
  }
  if (input.agent === 'claude') reject('invalid_request', 'Claude tasks are not supported');
  if (input.machineId) requireMachine(store, input.machineId);
  if (input.baseBranch !== undefined && input.baseBranch !== task.base_branch) {
    const snapshot = gitState(store, id);
    // 已领取（冻结标记非空）或升级前已有尝试的任务都视为已开始；无快照且基准仍为 null 时，
    // 允许用户显式补选第一个非空基准，并同时采纳当前项目同步设置，避免基准与同步来自不同时点。
    const started = task.git_sync_before_start !== null || !!store.get('SELECT 1 FROM attempts WHERE task_id=?', id);
    const firstChoice = started && task.base_branch === null && input.baseBranch !== null && !snapshot;
    if ((started && !firstChoice) || snapshot) reject('conflict', 'Base branch is frozen after execution starts');
    store.run('UPDATE tasks SET base_branch=? WHERE id=?', input.baseBranch, id);
    if (firstChoice) {
      store.run('UPDATE tasks SET git_sync_before_start=? WHERE id=?',
        Number(projectGitSettings(store, task.project_id).syncBeforeStart), id);
    }
  }
  const fields = Object.keys(input).filter((key) => key !== 'version');
  store.run(`UPDATE tasks SET title=?, goal=?, acceptance=?, notes=?, agent=?, machine_id=?,
    version=version+1, updated_at=? WHERE id=?`, input.title ?? task.title, input.goal ?? task.goal,
  input.acceptance ?? task.acceptance, input.notes ?? task.notes, input.agent ?? task.agent,
  input.machineId === undefined ? task.machine_id : input.machineId, now, id);
  store.event(id, source ? 'agent' : 'user', null, 'updated', { fields, ...source }, now);
  return { task: taskView(store, requireTask(store, id), now) };
}

export type TaskAction = 'schedule' | 'unschedule' | 'reschedule' | 'cancel' | 'accept' | 'rework';
const allowed: Record<TaskAction, TaskStatus[]> = {
  schedule: ['unscheduled'], unschedule: ['queued'], reschedule: ['interrupted'],
  cancel: ['unscheduled', 'queued', 'running', 'review', 'interrupted'], accept: ['review'], rework: ['review'],
};
const nextStatus: Record<TaskAction, TaskStatus> = {
  schedule: 'queued', unschedule: 'unscheduled', reschedule: 'queued', cancel: 'cancelled', accept: 'done', rework: 'queued',
};
export function taskAction(store: Store, id: string, action: TaskAction, now: number,
  review?: { deliveryId: string; feedback?: string }) {
  const task = requireTask(store, id);
  requireNoPendingSessionOperation(store, id, now, action === 'cancel');
  if (gitLocked(store, id)) reject('conflict', 'Accepted Git integration must finish or retry before task actions');
  if ((action === 'accept' || action === 'rework') && !review) reject('invalid_request', 'An exact delivery is required');
  if (!allowed[action].includes(task.status) || (action === 'unschedule' && task.rework_pending)) {
    reject('conflict', 'This action is not allowed for the current task state');
  }
  if (action === 'schedule' || action === 'reschedule' || action === 'rework') {
    if (task.agent === 'claude') reject('conflict', 'Claude tasks cannot be scheduled');
    if (action !== 'rework' && !executionMachine(store, id)) reject('machine_required', 'Select an execution machine first');
  }
  if (review) {
    const latest = store.get<{ id: string; review: string | null }>('SELECT id, review FROM deliveries WHERE task_id=? ORDER BY version DESC LIMIT 1', id);
    if (latest?.id !== review.deliveryId || latest.review !== null) reject('conflict', 'Only the latest unreviewed delivery can be reviewed');
    store.run('UPDATE deliveries SET review=?, feedback=?, reviewed_at=? WHERE id=?',
      action === 'accept' ? 'accepted' : 'rework', review.feedback ?? null, now, latest.id);
  }
  if (action === 'cancel') store.run('UPDATE attempts SET cancel_requested=1 WHERE task_id=? AND ended_at IS NULL', id);
  const trackedAcceptance = action === 'accept' && review && acceptGit(store, id, review.deliveryId);
  const to = trackedAcceptance ? 'review' : nextStatus[action];
  store.run('UPDATE tasks SET status=?, rework_pending=?, version=version+1, updated_at=? WHERE id=?',
    to, Number(action === 'rework'), now, id);
  store.event(id, 'user', null, action, { from: task.status, to, ...(review ?? {}) }, now);
  return { task: taskView(store, requireTask(store, id), now) };
}
