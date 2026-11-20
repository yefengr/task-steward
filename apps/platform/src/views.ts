import { MACHINE_ONLINE_WINDOW_MS, taskStatusSchema } from '@pi-steward/contract';
import type { Agent, Attempt, Delivery, Task, TaskStatus, WaitingReason, WebMachine, WebProject, WebTaskDetailResponse } from '@pi-steward/contract';
import { reject } from './errors.js';
import type { Store } from './store.js';

export interface TaskRow {
  id: string; project_id: string; title: string; goal: string; acceptance: string; notes: string; agent: Agent;
  machine_id: string | null; status: TaskStatus; rework_pending: number; position: number;
  created_by: 'user' | 'agent'; version: number; created_at: number; updated_at: number;
}
export interface AttemptRow {
  id: string; task_id: string; machine_id: string; agent: Agent; kind: Attempt['kind']; session_id: string;
  tmux_session: string | null; claimed_at: number; started_at: number | null; lease_expires_at: number;
  cancel_requested: number; ended_at: number | null; exit_code: number | null; result: Attempt['result']; workspace_path: string;
}
interface MachineRow {
  id: string; name: string; revoked_at: number | null; slots: number; last_seen_at: number | null;
  launcher_version: string | null;
}
interface ProjectRow { id: string; name: string; last_machine_id: string | null; created_at: number }
interface DeliveryRow {
  id: string; taskId: string; attemptId: string; version: number; summary: string; done: string; notCovered: string;
  verification: string; howTo: string; issues: string; baseCommit: string | null; commit: string | null;
  reportRef: string | null; review: Delivery['review']; feedback: string | null; reviewedAt: number | null; createdAt: number;
}

export function requireTask(store: Store, id: string) {
  return store.get<TaskRow>('SELECT * FROM tasks WHERE id=?', id) ?? reject('not_found', 'Task not found');
}
export function ownedAttempt(store: Store, id: string, machineId: string) {
  const attempt = store.get<AttemptRow>('SELECT * FROM attempts WHERE id=?', id) ?? reject('not_found', 'Attempt not found');
  if (attempt.machine_id !== machineId) reject('forbidden', 'Attempt belongs to a different machine');
  return attempt;
}
export function requireLiveAttempt(store: Store, attempt: AttemptRow) {
  if (attempt.ended_at !== null || attempt.cancel_requested || requireTask(store, attempt.task_id).status === 'cancelled') {
    reject('attempt_ended', 'Attempt has ended or was cancelled');
  }
}
export function requireProject(store: Store, id: string) {
  return store.get<ProjectRow>('SELECT * FROM projects WHERE id=?', id) ?? reject('not_found', 'Project not found');
}
export function requireMachine(store: Store, id: string) {
  return store.get<MachineRow>('SELECT * FROM machines WHERE id=?', id) ?? reject('not_found', 'Machine not found');
}

// 安排、等待提示和领取共用同一执行电脑选择规则。
export const executionMachineSql = `COALESCE(t.machine_id, p.last_machine_id, (
  SELECT MIN(mp.machine_id) FROM machine_projects mp JOIN machines m ON m.id=mp.machine_id
  WHERE mp.project_id=t.project_id AND m.revoked_at IS NULL HAVING COUNT(*)=1
))`;
export function executionMachine(store: Store, taskId: string) {
  return store.get<{ machineId: string | null }>(`SELECT ${executionMachineSql} AS machineId
    FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?`, taskId)?.machineId ?? null;
}
export function occupiedSlots(store: Store, machineId: string) {
  return store.get<{ count: number }>('SELECT COUNT(*) count FROM attempts WHERE machine_id=? AND ended_at IS NULL', machineId)!.count;
}
export function activeAttempt(store: Store, taskId: string) {
  return store.get<AttemptRow>('SELECT * FROM attempts WHERE task_id=? AND ended_at IS NULL', taskId);
}
export function isOnline(machine: MachineRow, now: number) {
  return machine.revoked_at === null && machine.last_seen_at !== null && now - machine.last_seen_at <= MACHINE_ONLINE_WINDOW_MS;
}
function waiting(store: Store, task: TaskRow, active: AttemptRow | undefined, now: number): WaitingReason | null {
  if (task.status !== 'queued') return null;
  if (active) return 'previous_attempt_active';
  const machineId = executionMachine(store, task.id);
  if (!machineId) return 'machine_unassigned';
  const machine = requireMachine(store, machineId);
  if (!store.get('SELECT 1 FROM machine_projects WHERE machine_id=? AND project_id=?', machineId, task.project_id)) {
    return 'machine_project_unregistered';
  }
  if (!isOnline(machine, now)) return 'machine_offline';
  if (occupiedSlots(store, machineId) >= machine.slots) return 'slots_full';
  return null;
}
export function taskView(store: Store, task: TaskRow, now: number): Task {
  const active = activeAttempt(store, task.id);
  return {
    id: task.id, projectId: task.project_id, title: task.title, goal: task.goal, acceptance: task.acceptance,
    notes: task.notes, agent: task.agent, machineId: task.machine_id, status: task.status,
    reworkPending: Boolean(task.rework_pending), position: task.position, createdBy: task.created_by,
    version: task.version, createdAt: task.created_at, updatedAt: task.updated_at,
    waiting: waiting(store, task, active, now), needsVerification: active !== undefined && active.lease_expires_at < now,
    needsResponse: !!store.get("SELECT 1 FROM questions WHERE task_id=? AND status='open'", task.id),
  };
}
export function deliveryViews(store: Store, taskId: string): Delivery[] {
  const rows = store.all<DeliveryRow>(`SELECT id, task_id taskId, attempt_id attemptId, version, summary, done,
    not_covered notCovered, verification, how_to howTo, issues, base_commit baseCommit, "commit", report_ref reportRef,
    review, feedback, reviewed_at reviewedAt, created_at createdAt FROM deliveries WHERE task_id=? ORDER BY version`, taskId);
  return rows.map(({ done, notCovered, verification, howTo, issues, baseCommit, commit, reportRef, ...row }) => ({
    ...row, done: JSON.parse(done), notCovered: JSON.parse(notCovered), verification: JSON.parse(verification),
    howTo: JSON.parse(howTo), issues: JSON.parse(issues), ...(baseCommit === null ? {} : { baseCommit }),
    ...(commit === null ? {} : { commit }), ...(reportRef === null ? {} : { reportRef }),
  }));
}
export function decisionViews(store: Store, taskId: string) {
  return store.all<Omit<WebTaskDetailResponse['decisions'][number], 'confirmedByUser'> & { confirmedByUser: number }>(
    `SELECT id, task_id taskId, attempt_id attemptId, text, confirmed_by_user confirmedByUser, created_at createdAt
    FROM decisions WHERE task_id=? ORDER BY created_at, rowid`, taskId)
    .map((row) => ({ ...row, confirmedByUser: Boolean(row.confirmedByUser) }));
}
export function questionViews(store: Store, taskId: string) {
  return store.all<WebTaskDetailResponse['questions'][number]>(`SELECT id, task_id taskId, attempt_id attemptId, text,
    context, status, created_at createdAt, updated_at updatedAt FROM questions WHERE task_id=? ORDER BY created_at, rowid`, taskId);
}
function attemptViews(store: Store, taskId: string, now: number): Attempt[] {
  return store.all<AttemptRow & { name: string }>(`SELECT a.*, m.name FROM attempts a JOIN machines m ON m.id=a.machine_id
    WHERE a.task_id=? ORDER BY a.claimed_at, a.rowid`, taskId).map((a) => ({
    id: a.id, taskId: a.task_id, machineId: a.machine_id, machineName: a.name, agent: a.agent, kind: a.kind,
    sessionId: a.session_id, tmuxSession: a.tmux_session, claimedAt: a.claimed_at, startedAt: a.started_at,
    leaseExpiresAt: a.lease_expires_at, cancelRequested: Boolean(a.cancel_requested), endedAt: a.ended_at,
    exitCode: a.exit_code, result: a.result, needsVerification: a.ended_at === null && a.lease_expires_at < now,
  }));
}
export function taskDetail(store: Store, id: string, now: number): WebTaskDetailResponse {
  const task = taskView(store, requireTask(store, id), now);
  const progress = store.all<WebTaskDetailResponse['progress'][number]>(`SELECT id, task_id taskId, attempt_id attemptId,
    text, created_at createdAt FROM progress WHERE task_id=? ORDER BY created_at, rowid`, id);
  const events = store.all<Omit<WebTaskDetailResponse['events'][number], 'payload'> & { payload: string }>(
    `SELECT id, task_id taskId, attempt_id attemptId, actor, kind, payload, created_at createdAt
    FROM task_events WHERE task_id=? ORDER BY created_at, rowid`, id).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  return { task, progress, events, attempts: attemptViews(store, id, now), deliveries: deliveryViews(store, id),
    decisions: decisionViews(store, id), questions: questionViews(store, id) };
}
export function projectViews(store: Store): WebProject[] {
  const projects = store.all<ProjectRow>('SELECT * FROM projects ORDER BY name, id');
  const totals = store.all<{ project_id: string; status: TaskStatus; count: number }>(
    'SELECT project_id, status, COUNT(*) count FROM tasks GROUP BY project_id, status');
  return projects.map((p) => ({ id: p.id, name: p.name, lastMachineId: p.last_machine_id, createdAt: p.created_at,
    counts: Object.fromEntries(taskStatusSchema.options.map((s) => [s, 0]).concat(
      totals.filter((row) => row.project_id === p.id).map((row) => [row.status, row.count]))) as WebProject['counts'],
  }));
}
export function machineViews(store: Store, now: number): WebMachine[] {
  return store.all<MachineRow>('SELECT * FROM machines ORDER BY name').map((machine) => {
    const activeTasks = store.all<WebMachine['activeTasks'][number]>(`SELECT t.id, t.title, t.project_id projectId,
      a.id attemptId FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE a.machine_id=? AND a.ended_at IS NULL
      ORDER BY a.claimed_at, a.rowid`, machine.id);
    return { id: machine.id, name: machine.name, online: isOnline(machine, now), slots: machine.slots,
      occupiedSlots: activeTasks.length, launcherVersion: machine.launcher_version, lastSeenAt: machine.last_seen_at,
      revokedAt: machine.revoked_at, activeTasks, projects: store.all<WebMachine['projects'][number]>(
        `SELECT p.id, p.name FROM projects p JOIN machine_projects mp ON mp.project_id=p.id
        WHERE mp.machine_id=? ORDER BY p.name, p.id`, machine.id) };
  });
}
