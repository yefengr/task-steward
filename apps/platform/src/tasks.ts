import { randomUUID } from 'node:crypto';
import type { TaskStatus, WebCreateTaskRequest, WebUpdateTaskRequest } from '@pi-steward/contract';
import { reject } from './errors.js';
import type { Store } from './store.js';
import { executionMachine, requireMachine, requireProject, requireTask, taskView } from './views.js';

export function createTask(store: Store, input: WebCreateTaskRequest, now: number) {
  requireProject(store, input.projectId);
  if (input.agent === 'claude') reject('invalid_request', 'Claude tasks are not supported');
  if (input.machineId) requireMachine(store, input.machineId);
  const id = randomUUID();
  store.run(`INSERT INTO tasks (id, project_id, title, goal, acceptance, notes, agent, machine_id,
    status, position, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,'unscheduled',
      (SELECT COALESCE(MAX(position),0)+1 FROM tasks WHERE project_id=?),'user',?,?)`,
  id, input.projectId, input.title, input.goal ?? '', input.acceptance ?? '', input.notes ?? '',
  input.agent ?? 'pi', input.machineId ?? null, input.projectId, now, now);
  store.event(id, 'user', null, 'created', { to: 'unscheduled' }, now);
  return { task: taskView(store, requireTask(store, id), now) };
}

export function updateTask(store: Store, id: string, input: WebUpdateTaskRequest, now: number) {
  const task = requireTask(store, id);
  if (task.status === 'cancelled' || task.status === 'done' || task.version !== input.version) {
    reject('conflict', 'Task is closed or its version changed');
  }
  if (input.agent === 'claude') reject('invalid_request', 'Claude tasks are not supported');
  if (input.machineId) requireMachine(store, input.machineId);
  const fields = Object.keys(input).filter((key) => key !== 'version');
  store.run(`UPDATE tasks SET title=?, goal=?, acceptance=?, notes=?, agent=?, machine_id=?,
    version=version+1, updated_at=? WHERE id=?`, input.title ?? task.title, input.goal ?? task.goal,
  input.acceptance ?? task.acceptance, input.notes ?? task.notes, input.agent ?? task.agent,
  input.machineId === undefined ? task.machine_id : input.machineId, now, id);
  store.event(id, 'user', null, 'updated', { fields }, now);
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
  const to = nextStatus[action];
  store.run('UPDATE tasks SET status=?, rework_pending=?, version=version+1, updated_at=? WHERE id=?',
    to, Number(action === 'rework'), now, id);
  store.event(id, 'user', null, action, { from: task.status, to, ...(review ?? {}) }, now);
  return { task: taskView(store, requireTask(store, id), now) };
}
