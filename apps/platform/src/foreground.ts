import { randomUUID } from 'node:crypto';
import { LEASE_DURATION_MS } from '@pi-steward/contract';
import type { ForegroundBinding, ForegroundStartRequest } from '@pi-steward/contract';
import { reject } from './errors.js';
import { freezeGitSettings, gitLocked } from './git-lifecycle.js';
import { requireNoPendingSessionOperation } from './session-control.js';
import { attemptLocator, confirmedLocator, sameLocator, sessionInUse } from './session-locator.js';
import type { Store } from './store.js';
import { requireLiveAttempt, requireTask } from './views.js';
import type { AttemptRow } from './views.js';

export function requireForegroundOwner(store: Store, attempt: AttemptRow, owner: string | undefined, now: number) {
  if (attempt.execution_mode !== 'foreground') return;
  if (!owner || owner !== attempt.owner_id) reject('forbidden', 'Foreground owner credentials required');
  requireLiveAttempt(store, attempt);
  // 临时交接不能遮蔽已经失效的实施权限；专用关闭回执另走原有路径。
  const status = requireTask(store, attempt.task_id).status;
  if (status !== 'running' && status !== 'review') reject('conflict', 'Foreground task is not active');
  requireNoPendingSessionOperation(store, attempt.task_id, now, false, 'session_handover_pending');
  if (store.get("SELECT 1 FROM session_operations WHERE task_id=? AND step IN ('stop','launch','cleanup')", attempt.task_id)) reject('session_handover_pending', 'Foreground handover is pending');
}

export function validateForegroundBinding(store: Store, machineId: string, input: ForegroundStartRequest, binding: ForegroundBinding, now: number) {
  const attempt = store.get<AttemptRow>('SELECT * FROM attempts WHERE id=?', binding.attemptId);
  const latest = store.get<{ id: string }>('SELECT id FROM attempts WHERE task_id=? ORDER BY claimed_at DESC,rowid DESC LIMIT 1', binding.taskId);
  if (!attempt || attempt.machine_id !== machineId || attempt.task_id !== binding.taskId || attempt.execution_mode !== 'foreground' ||
      attempt.goal_id !== input.goalId || attempt.owner_pid !== input.pid || latest?.id !== attempt.id ||
      requireTask(store, binding.taskId).status !== 'running' || gitLocked(store, binding.taskId) ||
      store.get('SELECT 1 FROM deliveries WHERE task_id=?', binding.taskId)) reject('conflict', 'Cached foreground binding is no longer current');
  requireForegroundOwner(store, attempt, input.ownerId, now);
}

export function startForeground(store: Store, machineId: string, input: ForegroundStartRequest, now: number) {
  const existing = store.get<{ task_id: string }>('SELECT task_id FROM foreground_goals WHERE machine_id=? AND goal_id=?', machineId, input.goalId);
  if (sessionInUse(store, machineId, input.locator, existing?.task_id)) reject('session_in_use', 'The Pi session belongs to another active task or handover');
  let taskId: string;
  let source: AttemptRow | undefined;
  if (existing) {
    taskId = existing.task_id;
    const task = requireTask(store, taskId);
    source = store.get<AttemptRow>('SELECT * FROM attempts WHERE task_id=? ORDER BY claimed_at DESC, rowid DESC LIMIT 1', taskId);
    if (!source || source.execution_mode !== 'foreground' || source.cancel_requested || gitLocked(store, taskId) ||
        !['running', 'interrupted'].includes(task.status) || store.get('SELECT 1 FROM deliveries WHERE task_id=?', taskId)) {
      reject('conflict', 'Goal cannot grant foreground ownership in its current state');
    }
    requireNoPendingSessionOperation(store, taskId, now, false, 'session_handover_pending');
    if (store.get("SELECT 1 FROM session_operations WHERE task_id=? AND step IN ('stop','launch','cleanup')", taskId)) reject('session_handover_pending', 'Foreground handover is pending');
    if (source.owner_id === input.ownerId && source.owner_pid === input.pid && source.ended_at === null && task.status === 'running' && input.previousAttemptId === undefined &&
        sameLocator(attemptLocator(source), input.locator)) {
      store.run('UPDATE attempts SET session_locator=?, session_id=?, workspace_path=? WHERE id=?', JSON.stringify(input.locator), input.locator.sessionId, input.locator.path, source.id);
      return { binding: { goalId: input.goalId, pid: input.pid, taskId, attemptId: source.id } };
    }
    if (source.id !== input.previousAttemptId || source.owner_pid !== input.previousOwnerPid || source.goal_id !== input.goalId) {
      reject('conflict', 'Recovery requires the exact previous foreground owner');
    }
    // 机器客户端已经确认旧进程退出并持有 goal 锁；事务保护源快照和替换不被并发改变。
    store.run("UPDATE attempts SET ended_at=?, result='interrupted' WHERE id=? AND ended_at IS NULL", now, source.id);
  } else {
    store.run('INSERT INTO projects (id,name,created_at) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING', input.projectId, input.projectName, now);
    store.run('INSERT INTO machine_projects (machine_id,project_id,local_path,updated_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING', machineId, input.projectId, input.registeredPath, now);
    taskId = randomUUID();
    store.run(`INSERT INTO tasks (id,project_id,title,goal,acceptance,notes,agent,machine_id,type,status,position,created_by,created_at,updated_at,origin)
      VALUES (?,?,?,?,?,?,'pi',?,?,'running',(SELECT COALESCE(MAX(position),0)+1 FROM tasks WHERE project_id=?),'agent',?,?,'foreground')`,
    taskId, input.projectId, input.title, input.goal, input.acceptance, input.notes, machineId, input.type, input.projectId, now, now);
    freezeGitSettings(store, taskId);
    store.run('INSERT INTO foreground_goals VALUES (?,?,?)', machineId, input.goalId, taskId);
  }
  const id = randomUUID();
  store.run(`INSERT INTO attempts (id,task_id,machine_id,agent,kind,session_id,workspace_path,claimed_at,started_at,lease_expires_at,
    execution_mode,goal_id,owner_id,owner_pid,session_locator,resumed_from_attempt_id)
    VALUES (?,?,?,'pi','new',?,?,?,?,?,'foreground',?,?,?,?,?)`, id, taskId, machineId, input.locator.sessionId,
  input.locator.path, now, now, now + LEASE_DURATION_MS, input.goalId, input.ownerId, input.pid, JSON.stringify(input.locator), source?.id ?? null);
  if (source && sameLocator(confirmedLocator(source), input.locator)) {
    store.run(`UPDATE attempts SET confirmed_workspace_path=?,confirmed_git_kind=?,confirmed_git_branch=?,
      confirmed_session_id=?,confirmed_session_file=?,confirmed_git_root=? WHERE id=?`, source.confirmed_workspace_path,
    source.confirmed_git_kind, source.confirmed_git_branch, source.confirmed_session_id, source.confirmed_session_file,
    source.confirmed_git_root, id);
  }
  store.run("UPDATE tasks SET status='running',version=version+1,updated_at=? WHERE id=?", now, taskId);
  store.event(taskId, 'agent', id, 'foreground_started', { resumedFromAttemptId: source?.id ?? null }, now);
  return { binding: { goalId: input.goalId, pid: input.pid, taskId, attemptId: id } };
}

export function foregroundAction(store: Store, attempt: AttemptRow, action: 'heartbeat' | 'settle' | 'interrupt', now: number) {
  if (attempt.execution_mode !== 'foreground') reject('conflict', 'A foreground attempt is required');
  const task = requireTask(store, attempt.task_id);
  if (action === 'heartbeat') store.run('UPDATE attempts SET lease_expires_at=? WHERE id=?', now + LEASE_DURATION_MS, attempt.id);
  else {
    const delivered = !!store.get('SELECT 1 FROM deliveries WHERE attempt_id=?', attempt.id);
    if (action === 'settle' && !delivered) reject('conflict', 'Settle requires a saved delivery');
    if (action === 'interrupt' && (!['running', 'cancelled'].includes(task.status) || delivered)) reject('conflict', 'Only undelivered work can be interrupted');
    const result = attempt.cancel_requested || task.status === 'cancelled' ? 'cancelled' : action === 'settle' ? 'delivered' : 'interrupted';
    store.run('UPDATE attempts SET ended_at=?,result=? WHERE id=? AND ended_at IS NULL', now, result, attempt.id);
    if (action === 'interrupt' && task.status === 'running') store.run("UPDATE tasks SET status='interrupted',version=version+1,updated_at=? WHERE id=?", now, task.id);
    store.event(task.id, 'agent', attempt.id, `foreground_${action}`, {}, now);
  }
  return { ok: true } as const;
}
